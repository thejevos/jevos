/**
 * Research agent demo: "Research three competitors and email me a comparison."
 *
 * Runs fully offline. The planner is scripted (swap in any LLM behind the
 * `Planner` interface) and decisions come from MockModel unless
 * TYPESAFE_API_KEY is set, in which case real Jev is used.
 *
 *   npm run demo
 */
import { ControlPlane, JevModel, JsonlSink, MemorySink, MockModel, QUESTION_IDS, type Action, type Planner, type ToolDef, type TraceEvent } from "@jevos/core";

const competitors = ["Acme", "Globex", "Initech"];
let searchCalls = 0;

const tools: ToolDef[] = [
  {
    name: "web_search",
    description: "Search the web for public information about a company or topic",
    execute: ({ query }) => {
      // First call fails to show the recovery path.
      if (++searchCalls === 1) throw new Error("upstream request timed out");
      return `${String(query).split(" ")[0]}: pricing from $49/seat, raised a round in 2026, positioned at mid-market teams.`;
    },
  },
  {
    name: "send_email",
    description: "Send an email to the user with the final deliverable",
    category: "communication",
    execute: ({ to }) => `Email delivered to ${to}.`,
  },
  {
    name: "delete_database",
    description: "Permanently delete the research database",
    execute: () => "deleted",
  },
];

/** Stand-in for an LLM. It makes one bad proposal on purpose so the gate has something to catch. */
class ScriptedPlanner implements Planner {
  private proposedCleanup = false;
  async propose(state: Parameters<Planner["propose"]>[0], hint?: string): Promise<Action | { finish: string }> {
    if (hint) console.log(`   planner received hint: ${hint}`);
    const researched = state.history.filter((h) => h.ok && h.action.tool === "web_search").length;
    if (researched < competitors.length) {
      return { tool: "web_search", args: { query: `${competitors[researched]} pricing and positioning` }, rationale: `Research ${competitors[researched]}` };
    }
    if (!this.proposedCleanup) {
      this.proposedCleanup = true;
      return { tool: "delete_database", rationale: "Clean up scratch data before sending" };
    }
    return { tool: "send_email", args: { to: "me@example.com", subject: "Competitor comparison", body: "Acme vs Globex vs Initech ..." } };
  }
}

// Mock-only: tell the offline model when the goal is met. Real Jev judges this from the state itself.
const mock = new MockModel((id, s) => {
  if (id !== QUESTION_IDS.goalComplete) return undefined;
  return s.recent_actions.some((a) => a.tool === "send_email" && a.outcome === "succeeded") ? 0.97 : 0.04;
});
const model = process.env.TYPESAFE_API_KEY ? new JevModel({ model: process.env.JEV_MODEL }) : mock;

const memory = new MemorySink();
const file = new JsonlSink("traces/research-agent.jsonl");
const control = new ControlPlane({
  model,
  agentId: "research-agent-01",
  policy: { maxSteps: 12, maxRetries: 2, blockedTools: ["delete_database"], approvalRequired: ["send_email"] },
  sink: { write: (e: TraceEvent) => { memory.write(e); printEvent(e); return file.write(e); } },
  onApproval: ({ action }) => {
    console.log(`   >> human approval requested for "${action.tool}" -> approved (demo auto-approver)`);
    return true;
  },
});

function printEvent(e: TraceEvent): void {
  const sig = e.signals
    ? Object.entries(e.signals)
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => `${k}=${(v as number).toFixed(2)}`)
        .join(" ")
    : "";
  console.log(`${e.timestamp.slice(11, 19)}  step ${String(e.step).padStart(2)}  ${e.phase.padEnd(8)} ${e.decision.padEnd(12)} ${(e.tool ?? "").padEnd(16)} ${e.rule ?? ""} ${sig}`);
}

console.log(`Decision model: ${model.name}\n`);
const result = await control.run({ task: "Research three competitors and email me a comparison.", planner: new ScriptedPlanner(), tools });

const controlDecisions = memory.events.filter((e) => e.signals).length;
console.log(`
Result:            ${result.status} (${result.reason})
Tool executions:   ${result.stats.steps}
Planner/LLM calls: ${result.stats.plannerCalls}
Control decisions: ${controlDecisions} in ${result.stats.modelCalls} Jev calls, est. $${result.stats.controlCost.toFixed(6)}
Trace written to:  traces/research-agent.jsonl`);
