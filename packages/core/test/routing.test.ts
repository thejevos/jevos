import { describe, expect, it } from "vitest";
import { ControlPlane, createState, MemorySink, MockModel, RoutingPlanner, type DecisionModel, type Planner, type ToolDef } from "../src/index.js";

const planner = (name: string): Planner & { calls: number } => ({ calls: 0, async propose() { (this as { calls: number }).calls++; return { tool: "web_search", args: { q: name }, usage: { costUsd: name === "fast" ? 0.001 : 0.01 } }; } });
const search: ToolDef = { name: "web_search", description: "search", execute: ({ q }) => `results for ${q}` };

/** A mock that answers the route question with a fixed choice and confidence. */
const router = (choice: string, confidence: number): DecisionModel => ({
  name: "mock-router",
  evaluate: async (_s, q) => ({ answers: Object.fromEntries(Object.entries(q).map(([id, question]) => [id, question.type === "choice" ? { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } : { type: "noul", noul: 0.05 }])) }),
});

describe("RoutingPlanner", () => {
  it("sends the step to the tier Jev picks when confidence is high enough", async () => {
    const fast = planner("fast"), powerful = planner("powerful");
    const rp = new RoutingPlanner({ model: router("fast", 0.9), tiers: [{ name: "fast", planner: fast, criteria: "routine" }, { name: "powerful", planner: powerful, criteria: "hard" }] });
    const p = await rp.propose(createState("t", [search]));
    expect(fast.calls).toBe(1); expect(powerful.calls).toBe(0);
    expect(p.route).toMatchObject({ tier: "fast", confidence: 0.9 });
    expect(rp.stats).toEqual({ fast: 1, powerful: 0 });
  });

  it("falls back to the most capable tier on low confidence or when Jev fails", async () => {
    const fast = planner("fast"), powerful = planner("powerful");
    const tiers = [{ name: "fast", planner: fast, criteria: "routine" }, { name: "powerful", planner: powerful, criteria: "hard" }];
    const unsure = await new RoutingPlanner({ model: router("fast", 0.55), tiers }).propose(createState("t", [search]));
    expect(unsure.route).toMatchObject({ tier: "powerful", fallback: expect.stringContaining("confidence") });
    const down: DecisionModel = { name: "down", evaluate: async () => { throw new Error("503"); } };
    const failed = await new RoutingPlanner({ model: down, tiers }).propose(createState("t", [search]));
    expect(failed.route).toMatchObject({ tier: "powerful", fallback: "503" });
    expect(powerful.calls).toBe(2); expect(fast.calls).toBe(0);
  });

  it("is traced by the control plane and counted in run stats", async () => {
    const fast = planner("fast"), powerful = planner("powerful");
    let n = 0;
    const finishing: Planner = { async propose() { return n++ < 2 ? { tool: "web_search", args: { q: n } } : { finish: "done" }; } };
    const rp = new RoutingPlanner({ model: router("fast", 0.95), tiers: [{ name: "fast", planner: finishing, criteria: "routine" }, { name: "powerful", planner: powerful, criteria: "hard" }] });
    const sink = new MemorySink();
    const result = await new ControlPlane({ model: new MockModel(), sink }).run({ task: "t", planner: rp, tools: [search] });
    expect(result.stats.routes).toEqual({ fast: 3 });
    expect(sink.events.filter((e) => e.phase === "route").map((e) => e.rule)).toEqual(["fast", "fast", "fast"]);
    expect(fast.calls + powerful.calls).toBe(0);
  });
});
