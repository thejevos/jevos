// Browser copy of core's default policy order, used only by the "try a situation" explainer.
// The real enforcement lives in @jevos/core (packages/core/src/policy.ts).

export const DEFAULT_POLICY = {
  maxSteps: 30,
  blockedTools: ["delete_database"],
  approvalRequired: ["refund"],
  thresholds: { riskBlock: 0.8, riskReview: 0.6, humanApproval: 0.6, relevance: 0.5, goalComplete: 0.8, stuck: 0.8 },
};

export const POLICY_PATH = [
  { rule: "max_steps", label: "Step and cost limits" },
  { rule: "goal_complete", label: "Goal already complete?" },
  { rule: "blocked_tool", label: "Tool on the block list?" },
  { rule: "approval_required", label: "Tool always needs approval?" },
  { rule: "risk_block", label: "Risky and irrelevant to the task?" },
  { rule: "risk_review", label: "Risk above review threshold?" },
  { rule: "needs_human", label: "Operator would want a look?" },
  { rule: "stuck", label: "Agent stuck in a loop?" },
  { rule: "irrelevant_action", label: "Action relevant to the goal?" },
  { rule: "default_allow", label: "No objection — allow" },
];

export function decide(sig, tool, step = 0, policy = DEFAULT_POLICY) {
  const t = policy.thresholds;
  const f = (n) => Number(n ?? 0).toFixed(2);
  if (step >= policy.maxSteps) return { decision: "STOP", rule: "max_steps", reason: `step limit ${policy.maxSteps} reached` };
  if (sig.goalComplete >= t.goalComplete) return { decision: "STOP", rule: "goal_complete", reason: `goal complete (p=${f(sig.goalComplete)})` };
  if (policy.blockedTools.includes(tool)) return { decision: "BLOCK", rule: "blocked_tool", reason: `tool "${tool}" is blocked by policy` };
  if (policy.approvalRequired.includes(tool)) return { decision: "HUMAN_REVIEW", rule: "approval_required", reason: `tool "${tool}" always requires approval` };
  if (sig.actionRisky >= t.riskBlock && sig.actionRelevant < t.relevance) return { decision: "BLOCK", rule: "risk_block", reason: `risk ${f(sig.actionRisky)} ≥ ${t.riskBlock} and relevance ${f(sig.actionRelevant)} < ${t.relevance}` };
  if (sig.actionRisky >= t.riskReview) return { decision: "HUMAN_REVIEW", rule: "risk_review", reason: `risk ${f(sig.actionRisky)} ≥ ${t.riskReview}` };
  if (sig.needsHuman >= t.humanApproval) return { decision: "HUMAN_REVIEW", rule: "needs_human", reason: `needs_human ${f(sig.needsHuman)} ≥ ${t.humanApproval}` };
  if (sig.stuck >= t.stuck) return { decision: "REPLAN", rule: "stuck", reason: `stuck (p=${f(sig.stuck)})` };
  if (sig.actionRelevant < t.relevance) return { decision: "REPLAN", rule: "irrelevant_action", reason: `relevance ${f(sig.actionRelevant)} < ${t.relevance}` };
  return { decision: "ALLOW", rule: "default_allow", reason: "no policy objected" };
}

export const SCENARIOS = {
  safe: { label: "A harmless search", say: "I'll search the web for Globex's 2026 pricing.", tool: "web_search", args: { query: "Globex pricing 2026" }, sig: { actionRelevant: 0.97, actionRisky: 0.04, needsHuman: 0.05, goalComplete: 0.12, stuck: 0.06 }, next: "The tool runs immediately. No person involved, no extra LLM call." },
  risky: { label: "Moving money", say: "The customer seems upset. I'll refund $480 to be safe.", tool: "refund", args: { order: "ord_48121", amount: 480 }, sig: { actionRelevant: 0.91, actionRisky: 0.88, needsHuman: 0.9, goalComplete: 0.3, stuck: 0.05 }, next: "The agent pauses at the gate. Your terminal shows the action, the signals and the reason, and asks approve? [y/N]." },
  blocked: { label: "A destructive tool", say: "I'll delete the scratch database to tidy up first.", tool: "delete_database", args: { target: "scratch_research" }, sig: { actionRelevant: 0.22, actionRisky: 0.98, needsHuman: 0.97, goalComplete: 0.2, stuck: 0.04 }, next: "Never executes. The block list is checked before any model signal, so no confidence score can override it." },
  loop: { label: "Going in circles", say: "Let me search for that again…", tool: "web_search", args: { query: "Initech funding round" }, sig: { actionRelevant: 0.71, actionRisky: 0.03, needsHuman: 0.04, goalComplete: 0.18, stuck: 0.93 }, next: "The agent is told its recent actions aren't adding information and must change strategy." },
  done: { label: "Already finished", say: "I'll run one more search to double-check.", tool: "web_search", args: { query: "laptops under 80000" }, sig: { actionRelevant: 0.55, actionRisky: 0.02, needsHuman: 0.03, goalComplete: 0.97, stuck: 0.1 }, next: "The loop ends here. The agent doesn't pay for another LLM turn it doesn't need." },
};
