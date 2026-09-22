import { describe, expect, it } from "vitest";
import { createState, decide, decideRecovery, projectState, repeatedActionStreak, resolvePolicy, type AgentState } from "../src/index.js";

const tools = [
  { name: "search", description: "web search" },
  { name: "pay", description: "pay an invoice", category: "financial" },
  { name: "delete_database", description: "drop the db" },
];

function stateWith(tool?: string, args?: Record<string, unknown>): AgentState {
  const s = createState("do the thing", tools);
  if (tool) s.currentAction = { tool, args };
  return s;
}
const counters = { step: 0, costSoFar: 0 };

describe("decide", () => {
  it("allows a benign action", () => {
    const v = decide(stateWith("search"), { actionRelevant: 0.9, actionRisky: 0.05 }, resolvePolicy(), counters);
    expect(v.action).toBe("ALLOW");
  });

  it("blocked tools stay blocked however confident the model is", () => {
    const policy = resolvePolicy({ blockedTools: ["delete_database"] });
    const v = decide(stateWith("delete_database"), { actionRelevant: 1, actionRisky: 0, needsHuman: 0 }, policy, counters);
    expect(v).toMatchObject({ action: "BLOCK", rule: "blocked_tool" });
  });

  it("approvalRequired forces human review even at zero risk", () => {
    const policy = resolvePolicy({ approvalRequired: ["pay"] });
    expect(decide(stateWith("pay"), { actionRisky: 0 }, policy, counters).rule).toBe("approval_required");
  });

  it("sends risky-but-relevant actions to a person and blocks risky-and-irrelevant ones", () => {
    const p = resolvePolicy();
    expect(decide(stateWith("pay"), { actionRisky: 0.95, actionRelevant: 0.87 }, p, counters).rule).toBe("risk_review");
    expect(decide(stateWith("search"), { actionRisky: 0.97, actionRelevant: 0.02 }, p, counters).rule).toBe("risk_block");
    // without a relevance signal there is no evidence it is pointless, so it is reviewed, not blocked
    expect(decide(stateWith("search"), { actionRisky: 0.97 }, p, counters).action).toBe("HUMAN_REVIEW");
  });

  it("applies per-category thresholds", () => {
    const p = resolvePolicy({ categoryThresholds: { financial: { riskReview: 0.3 } } });
    expect(decide(stateWith("pay"), { actionRisky: 0.4 }, p, counters).action).toBe("HUMAN_REVIEW");
    expect(decide(stateWith("search"), { actionRisky: 0.4 }, p, counters).action).toBe("ALLOW");
  });

  it("stops on goal completion and on hard limits", () => {
    const p = resolvePolicy({ maxSteps: 5, maxCost: 0.01 });
    expect(decide(stateWith(), { goalComplete: 0.95 }, p, counters).rule).toBe("goal_complete");
    expect(decide(stateWith("search"), {}, p, { step: 5, costSoFar: 0 }).rule).toBe("max_steps");
    expect(decide(stateWith("search"), {}, p, { step: 0, costSoFar: 0.02 }).rule).toBe("max_cost");
  });

  it("replans on irrelevant actions, unknown tools and tool mismatch", () => {
    const p = resolvePolicy();
    expect(decide(stateWith("search"), { actionRelevant: 0.2 }, p, counters).rule).toBe("irrelevant_action");
    expect(decide(stateWith("nope"), {}, p, counters).rule).toBe("unknown_tool");
    const mismatch = decide(stateWith("search"), { actionRelevant: 0.9, nextTool: { choice: "pay", probabilities: {}, confidence: 0.95 } }, p, counters);
    expect(mismatch).toMatchObject({ action: "REPLAN", rule: "tool_mismatch" });
  });

  it("forces a replan on repeated identical actions without asking the model", () => {
    const s = stateWith("search", { q: "x" });
    for (let i = 1; i <= 3; i++) s.history.push({ step: i, action: { tool: "search", args: { q: "x" } }, ok: true, observation: "same" });
    expect(repeatedActionStreak(s)).toBe(4);
    expect(decide(s, { stuck: 0 }, resolvePolicy(), counters).rule).toBe("max_repeats");
  });
});

describe("decideRecovery", () => {
  const p = resolvePolicy({ maxRetries: 2, maxReplans: 1 });
  it("retries transient failures within budget", () => {
    expect(decideRecovery({ retryUseful: 0.9, retries: 0, replans: 0, error: "timeout" }, p).action).toBe("RETRY");
  });
  it("replans when retry is unlikely to help or retries are spent", () => {
    expect(decideRecovery({ retryUseful: 0.1, retries: 0, replans: 0, error: "404" }, p).action).toBe("REPLAN");
    expect(decideRecovery({ retryUseful: 0.9, retries: 2, replans: 0, error: "timeout" }, p).action).toBe("REPLAN");
  });
  it("escalates when everything is exhausted", () => {
    expect(decideRecovery({ retryUseful: 0.1, retries: 2, replans: 1, error: "404" }, p).action).toBe("HUMAN_REVIEW");
  });
});

describe("projectState", () => {
  it("windows history, clips observations and keeps only pinned context", () => {
    const s = stateWith("search");
    for (let i = 1; i <= 10; i++) s.history.push({ step: i, action: { tool: "search", args: { q: `q${i}` } }, ok: true, observation: "x".repeat(5000) });
    s.context.push({ id: "a", content: "budget: 50000", pinned: true }, { id: "b", content: "old result" });
    const p = projectState(s, { historyWindow: 3, maxObservationChars: 100 });
    expect(p.recent_actions.map((a) => a.step)).toEqual([8, 9, 10]);
    expect(p.recent_actions[0].result!.length).toBeLessThan(130);
    expect(p.pinned_context).toEqual(["budget: 50000"]);
    expect(p.stats.steps_taken).toBe(10);
  });
});
