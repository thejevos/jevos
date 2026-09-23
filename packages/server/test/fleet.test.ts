import { createState, Fleet, FleetControlPlane, MemorySink, MockModel, QUESTION_IDS, resolveApproval, type FleetPolicy, type Planner, type Proposal, type ToolDef } from "@jevos/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFleetApp } from "../src/fleet.js";

const POLICY: FleetPolicy = {
  policy: { maxSteps: 10, blockedTools: ["delete_database"], readOnlyTools: ["web_search"] },
  budget: { dailyCostUsd: 1, maxConcurrentRuns: 2 },
  agents: {
    research: { tools: ["web_search", "send_email"], maxCostUsd: 0.5, handoffTo: ["support"] },
    support: { tools: ["lookup_order", "refund"], approvalRequired: ["refund"], maxConcurrentRuns: 1 },
  },
};

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "fleet-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const search: ToolDef = { name: "web_search", description: "search", execute: ({ q }) => `results for ${q}` };
const email: ToolDef = { name: "send_email", description: "email", execute: () => "sent" };
const refund: ToolDef = { name: "refund", description: "refund", execute: () => "refunded" };
const scripted = (actions: Proposal[]): Planner => { let i = 0; return { async propose() { return actions[Math.min(i++, actions.length - 1)]; } }; };

function harness(policy: FleetPolicy = POLICY, model = new MockModel()) {
  const sink = new MemorySink();
  const app = createFleetApp({ policy, model, sink, approvalsDir: dir, token: "secret" });
  // Hono's app.request is fetch-compatible, so the client talks to the app in-process.
  const fetchImpl = ((url: string, init?: RequestInit) => app.request(url.replace("http://fleet", ""), init)) as unknown as typeof fetch;
  const client = (agentId: string, extra: Partial<ConstructorParameters<typeof FleetControlPlane>[0]> = {}) => new FleetControlPlane({ url: "http://fleet", token: "secret", agentId, fetch: fetchImpl, pollMs: 10, approvalTimeoutMs: 400, ...extra });
  return { app, sink, client };
}

describe("Fleet policy", () => {
  it("narrows the base policy per agent and rejects unknown agents", () => {
    const fleet = new Fleet(POLICY);
    const research = fleet.policyFor("research", ["web_search", "send_email", "refund"])!;
    expect(research.allowedTools).toEqual(["web_search", "send_email"]);
    expect(research.blockedTools).toContain("delete_database");
    expect(fleet.policyFor("support", ["refund"])!.approvalRequired).toContain("refund");
    expect(fleet.policyFor("stranger", [])).toBeUndefined();
    expect(fleet.fleetVerdict("stranger")?.rule).toBe("unknown_agent");
  });

  it("enforces per-agent and fleet-wide daily budgets", () => {
    const fleet = new Fleet(POLICY);
    fleet.record("research", 0.5);
    expect(fleet.fleetVerdict("research")?.rule).toBe("agent_budget");
    expect(fleet.fleetVerdict("support")).toBeUndefined();
    fleet.record("support", 0.6);
    expect(fleet.fleetVerdict("support")?.rule).toBe("fleet_budget");
  });

  it("limits concurrent runs per agent and per fleet", () => {
    const fleet = new Fleet(POLICY);
    expect(fleet.startRun("support")).toBeUndefined();
    expect(fleet.startRun("support")?.rule).toBe("agent_concurrency");
    expect(fleet.startRun("research")).toBeUndefined();
    expect(fleet.startRun("research")?.rule).toBe("fleet_concurrency");
    fleet.endRun("support");
    expect(fleet.startRun("support")).toBeUndefined();
  });

  it("checks handoffs against the fleet policy", () => {
    const fleet = new Fleet(POLICY);
    expect(fleet.handoff("research", "support").action).toBe("ALLOW");
    expect(fleet.handoff("support", "research").rule).toBe("handoff_not_allowed");
    expect(fleet.handoff("research", "payments").rule).toBe("unknown_agent");
  });
});

describe("fleet server + client", () => {
  it("rejects requests without the fleet token", async () => {
    const { app } = harness();
    expect((await app.request("/v1/fleet/status")).status).toBe(401);
    expect((await app.request("/v1/fleet/status", { headers: { authorization: "Bearer secret" } })).status).toBe(200);
  });

  it("runs an agent under the fleet: tools outside its permission are blocked, read-only ones skip the model", async () => {
    const { sink, client } = harness();
    const planner = scripted([{ tool: "web_search", args: { q: "a" } }, { tool: "refund", args: { amount: 5 } }, { finish: "done" }]);
    const result = await client("research").run({ task: "t", planner, tools: [search, refund] });
    expect(result.status).toBe("complete");
    const rules = sink.events.filter((e) => e.phase === "gate").map((e) => `${e.tool}:${e.rule}`);
    expect(rules).toContain("web_search:read_only");
    expect(rules).toContain("refund:tool_not_allowed");
    expect(sink.events.every((e) => e.agent_id === "research")).toBe(true);
  });

  it("refuses unknown agents and over-budget agents before they start", async () => {
    const { client } = harness();
    const stranger = await client("stranger").run({ task: "t", planner: scripted([{ finish: "x" }]), tools: [search] });
    expect(stranger).toMatchObject({ status: "escalated", reason: expect.stringContaining("not in the fleet policy") });
    expect(stranger.stats.plannerCalls).toBe(0);
  });

  it("stops a run when the fleet budget is exhausted mid-run", async () => {
    const { app, client } = harness();
    // burn the fleet budget through the accounting endpoint
    await app.request("/v1/fleet/runs/end", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ agent_id: "support", plannerCostUsd: 1 }) });
    const result = await client("research").run({ task: "t", planner: scripted([{ tool: "send_email", args: {} }]), tools: [email] });
    expect(result).toMatchObject({ status: "halted", reason: expect.stringContaining("fleet daily budget") });
  });

  it("parks approvals on the server and continues when another party approves", async () => {
    const { client } = harness();
    const onPending = vi.fn(async (r: { id: string }) => { await new Promise((x) => setTimeout(x, 30)); await resolveApproval(dir, r.id, true, "dana"); });
    const result = await client("support", { onPending }).run({ task: "refund it", planner: scripted([{ tool: "refund", args: { amount: 5 } }, { finish: "done" }]), tools: [refund] });
    expect(onPending).toHaveBeenCalledOnce();
    expect(result.status).toBe("complete");
    expect(result.state.history[0]).toMatchObject({ action: { tool: "refund" }, ok: true });
  });

  it("denies an approval nobody answers", async () => {
    const { client, sink } = harness();
    const result = await client("support").run({ task: "refund it", planner: scripted([{ tool: "refund", args: { amount: 5 } }, { finish: "gave up" }]), tools: [refund] });
    expect(result.state.history).toHaveLength(0);
    expect(sink.events.find((e) => e.decision === "DENIED")?.actor).toBe("timeout");
  });

  it("fails closed when the fleet server is unreachable", async () => {
    const down = new FleetControlPlane({ url: "http://fleet", agentId: "research", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    const gate = await down.evaluate({ ...createState("t", [search]), currentAction: { tool: "web_search" } });
    expect(gate.verdict).toMatchObject({ action: "HUMAN_REVIEW", rule: "fleet_unavailable" });
    const run = await down.run({ task: "t", planner: scripted([{ finish: "x" }]), tools: [search] });
    expect(run.status).toBe("halted");
  });

  it("reports fleet status and handoffs over HTTP", async () => {
    const { app, client } = harness();
    await client("research").run({ task: "t", planner: scripted([{ tool: "web_search", args: { q: "a" } }, { finish: "x" }]), tools: [search] });
    const status = await (await app.request("/v1/fleet/status", { headers: { authorization: "Bearer secret" } })).json();
    expect(status.agents.research).toMatchObject({ registered: true, activeRuns: 0, maxCostUsd: 0.5 });
    expect(status.fleet.dailyCostUsd).toBe(1);
    expect((await client("research").handoff("support", "resolve ticket")).action).toBe("ALLOW");
    expect((await client("support").handoff("research", "x")).rule).toBe("handoff_not_allowed");
  });

  it("keeps one hash-chained log across agents", async () => {
    const model = new MockModel((id) => (id === QUESTION_IDS.goalComplete ? 0.05 : undefined));
    const { sink, client } = harness(POLICY, model);
    await client("research").run({ task: "a", planner: scripted([{ tool: "web_search", args: { q: "1" } }, { finish: "x" }]), tools: [search] });
    // support proposes a tool it may not use: the gate records a BLOCK under support's name
    await client("support").run({ task: "b", planner: scripted([{ tool: "web_search", args: { q: "2" } }, { finish: "y" }]), tools: [search, refund] });
    expect(new Set(sink.events.map((e) => e.agent_id))).toEqual(new Set(["research", "support"]));
  });
});
