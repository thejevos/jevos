import { describe, expect, it, vi } from "vitest";
import { ControlPlane, createState, MemorySink, MockModel, QUESTION_IDS, type Action, type DecisionModel, type Planner, type ToolDef } from "../src/index.js";

function scripted(actions: Array<Action | { finish: string }>): Planner & { hints: Array<string | undefined> } {
  const hints: Array<string | undefined> = [];
  let i = 0;
  return {
    hints,
    async propose(_state, hint) {
      hints.push(hint);
      return actions[Math.min(i++, actions.length - 1)];
    },
  };
}

const search: ToolDef = { name: "search", description: "web search", execute: ({ q }) => `results for ${q}` };

describe("ControlPlane.run", () => {
  it("stops on goal completion without another planner call", async () => {
    const model = new MockModel((id, s) => (id === QUESTION_IDS.goalComplete ? (s.recent_actions.length >= 2 ? 0.97 : 0.05) : undefined));
    const planner = scripted([{ tool: "search", args: { q: "a" } }, { tool: "search", args: { q: "b" } }, { tool: "search", args: { q: "c" } }]);
    const result = await new ControlPlane({ model }).run({ task: "find two things", planner, tools: [search] });
    expect(result.status).toBe("complete");
    expect(result.stats.steps).toBe(2);
    expect(result.stats.plannerCalls).toBe(2);
  });

  it("never executes a blocked tool and tells the planner why", async () => {
    const drop = { name: "delete_database", description: "drop db", execute: vi.fn() };
    const planner = scripted([{ tool: "delete_database" }, { finish: "gave up" }]);
    const result = await new ControlPlane({ model: new MockModel(), policy: { blockedTools: ["delete_database"] } }).run({ task: "clean up", planner, tools: [search, drop] });
    expect(drop.execute).not.toHaveBeenCalled();
    expect(planner.hints[1]).toMatch(/blocked/i);
    expect(result.status).toBe("complete");
  });

  it("fails closed on human review when no approver is configured", async () => {
    const email = { name: "send_email", description: "send an email", execute: vi.fn(() => "sent") };
    const planner = scripted([{ tool: "send_email", args: { to: "x@y.z" } }, { finish: "done" }]);
    await new ControlPlane({ model: new MockModel(), policy: { approvalRequired: ["send_email"] } }).run({ task: "mail it", planner, tools: [email] });
    expect(email.execute).not.toHaveBeenCalled();
    expect(planner.hints[1]).toMatch(/denied/i);
  });

  it("executes after human approval and traces it", async () => {
    const email = { name: "send_email", description: "send an email", execute: vi.fn(() => "sent") };
    const sink = new MemorySink();
    const onApproval = vi.fn(() => true);
    const planner = scripted([{ tool: "send_email" }, { finish: "done" }]);
    await new ControlPlane({ model: new MockModel(), policy: { approvalRequired: ["send_email"] }, onApproval, sink }).run({ task: "mail it", planner, tools: [email] });
    expect(onApproval).toHaveBeenCalledOnce();
    expect(email.execute).toHaveBeenCalledOnce();
    expect(sink.events.map((e) => e.decision)).toEqual(["HUMAN_REVIEW", "APPROVED", "EXECUTED", "ALLOW"]);
  });

  it("retries transient failures without calling the planner again", async () => {
    let calls = 0;
    const flaky: ToolDef = { name: "search", description: "web search", execute: () => { if (++calls === 1) throw new Error("request timed out"); return "ok"; } };
    const planner = scripted([{ tool: "search", args: { q: "a" } }, { finish: "done" }]);
    const result = await new ControlPlane({ model: new MockModel() }).run({ task: "t", planner, tools: [flaky] });
    expect(calls).toBe(2);
    expect(result.stats.plannerCalls).toBe(2);
    expect(result.state.history.map((h) => h.ok)).toEqual([false, true]);
  });

  it("replans on permanent failures and escalates when budgets run out", async () => {
    const broken: ToolDef = { name: "search", description: "web search", execute: () => { throw new Error("404 not found"); } };
    const planner = scripted([{ tool: "search", args: { q: "a" } }]);
    const result = await new ControlPlane({ model: new MockModel(), policy: { maxReplans: 1 } }).run({ task: "t", planner, tools: [broken] });
    expect(result.status).toBe("escalated");
    expect(planner.hints[1]).toMatch(/404/);
  });

  it("breaks loops: a planner that ignores replan hints gets escalated, not run forever", async () => {
    const planner = scripted([{ tool: "search", args: { q: "same" } }]);
    const result = await new ControlPlane({ model: new MockModel(), policy: { maxSteps: 20 } }).run({ task: "t", planner, tools: [search] });
    expect(planner.hints.some((h) => h && /different|strategy/i.test(h))).toBe(true);
    expect(result.status).toBe("escalated");
    expect(result.stats.steps).toBeLessThan(6);
  });
});

describe("ControlPlane.evaluate / tool", () => {
  it("fails closed when the decision model is down, but hard rules still apply", async () => {
    const down: DecisionModel = { name: "down", evaluate: async () => { throw new Error("503"); } };
    const control = new ControlPlane({ model: down, policy: { blockedTools: ["delete_database"] } });
    const tools = [{ name: "search", description: "s" }, { name: "delete_database", description: "d" }];
    const allow = await control.evaluate({ ...createState("t", tools), currentAction: { tool: "search" } });
    expect(allow.verdict).toMatchObject({ action: "HUMAN_REVIEW", rule: "model_unavailable" });
    const block = await control.evaluate({ ...createState("t", tools), currentAction: { tool: "delete_database" } });
    expect(block.verdict.action).toBe("BLOCK");
  });

  it("tool middleware gates a single call", async () => {
    const control = new ControlPlane({ model: new MockModel(), policy: { blockedTools: ["search"] } });
    const gated = control.tool(search);
    const result = await gated({ q: "x" }, createState("t", [search]));
    expect(result.status).toBe("blocked");
  });
});
