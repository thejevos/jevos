/** Written by `acp init`. A real LLM planner; needs Anthropic credentials and `npm i @agent-control/planner-claude`. */
export const CLAUDE_AGENT = `// A real agent: Claude proposes each step, the control plane decides whether it runs.
//   acp run agent.claude.ts --task "Research Acme and email me one line about their pricing"
// Needs ANTHROPIC_API_KEY (put it in .env) and: npm i @agent-control/planner-claude
import type { ToolDef } from "@agent-control/core";
import { ClaudePlanner } from "@agent-control/planner-claude";

export const task = "Research Acme and email me one line about their pricing.";

// Replace these with your real tools. inputSchema is what Claude sees.
export const tools: ToolDef[] = [
  { name: "web_search", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: ({ query }) => \`Results for \${query}: Acme charges $49 per seat.\` },
  { name: "send_email", description: "Send an email", category: "communication",
    inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] },
    execute: ({ to }) => \`Email delivered to \${to}.\` },
];

// claude-opus-5 by default; the planner reports its token spend, which counts against maxCost in acp.policy.json.
export const planner = new ClaudePlanner({ tools });
`;

/** Written by `acp init`. Runs offline; swap ScriptedPlanner for your LLM. */
export const EXAMPLE_AGENT = `// Example agent for \`acp run agent.example.ts\`.
// An agent file exports { task, planner, tools }. The planner is your LLM:
// it proposes the next action. The control plane decides whether it runs.
import { QUESTION_IDS, type Action, type AgentState, type MockResponder, type Planner, type ToolDef } from "@agent-control/core";

export const task = "Research three competitors and email me a comparison.";

const competitors = ["Acme", "Globex", "Initech"];
let searches = 0;

export const tools: ToolDef[] = [
  {
    name: "web_search",
    description: "Search the web for public information about a company or topic",
    execute: ({ query }) => {
      if (++searches === 1) throw new Error("upstream request timed out"); // shows the recovery path
      return \`\${String(query).split(" ")[0]}: pricing from $49/seat, raised a round in 2026, positioned at mid-market teams.\`;
    },
  },
  { name: "send_email", description: "Send an email to the user with the final deliverable", category: "communication", execute: ({ to }) => \`Email delivered to \${to}.\` },
  { name: "delete_database", description: "Permanently delete the research database", execute: () => "deleted" },
];

// Stand-in for an LLM. It makes one bad proposal on purpose so the gate has something to catch.
class ScriptedPlanner implements Planner {
  private triedCleanup = false;
  async propose(state: AgentState, hint?: string): Promise<Action | { finish: string }> {
    if (hint) console.log(\`           planner hint: \${hint}\`);
    const done = state.history.filter((h) => h.ok && h.action.tool === "web_search").length;
    if (done < competitors.length) return { tool: "web_search", args: { query: \`\${competitors[done]} pricing and positioning\` } };
    if (!this.triedCleanup) { this.triedCleanup = true; return { tool: "delete_database", rationale: "tidy up before sending" }; }
    if (state.history.some((h) => h.ok && h.action.tool === "send_email")) return { finish: "Comparison sent." };
    const findings = state.history.filter((h) => h.ok && h.action.tool === "web_search").map((h) => h.observation).join(" | ");
    return { tool: "send_email", args: { to: "me@example.com", subject: "Competitor comparison: Acme vs Globex vs Initech", body: findings } };
  }
}
export const planner = new ScriptedPlanner();

// Offline mock only: tells the mock model when the goal is met. Real Jev judges this from the state.
export const mockResponder: MockResponder = (id, s) =>
  id === QUESTION_IDS.goalComplete ? (s.recent_actions.some((a) => a.tool === "send_email" && a.outcome === "succeeded") ? 0.97 : 0.04) : undefined;
`;
