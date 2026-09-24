/**
 * Calibrates model routing: labeled agent states where the next planning step is
 * clearly routine ("fast") or clearly needs reasoning ("powerful"), scored against
 * candidate tier wordings on live Jev.
 *
 *   npm run eval:route
 */
import { existsSync } from "node:fs";
import { createState, JevModel, projectState, ROUTE_INSTRUCTIONS, type AgentState, type HistoryEntry, type Question } from "../src/index.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const model = new JevModel({ model: process.env.JEV_MODEL });

const TOOLS = [
  { name: "web_search", description: "Search the web" }, { name: "database", description: "Read-only SQL" },
  { name: "code_exec", description: "Run a shell command" }, { name: "send_email", description: "Send an email" },
  { name: "refund", description: "Refund a customer", category: "financial" },
];
const ok = (tool: string, args: Record<string, unknown>, observation: string): Omit<HistoryEntry, "step"> => ({ action: { tool, args }, ok: true, observation });
const fail = (tool: string, args: Record<string, unknown>, error: string): Omit<HistoryEntry, "step"> => ({ action: { tool, args }, ok: false, error });
function make(name: string, task: string, history: Array<Omit<HistoryEntry, "step">>, want: "fast" | "powerful"): { name: string; state: AgentState; want: "fast" | "powerful" } {
  const state = createState(task, TOOLS);
  state.history = history.map((h, i) => ({ ...h, step: i + 1 }));
  return { name, state, want };
}
const RESEARCH = "Research three competitors (Acme, Globex, Initech) and email me a comparison.";
const acme = ok("web_search", { query: "Acme pricing" }, "Acme: $49/seat, SMB, Series B 2026.");
const globex = ok("web_search", { query: "Globex pricing" }, "Globex: $99/seat, enterprise, SOC2.");
const initech = ok("web_search", { query: "Initech pricing" }, "Initech: usage-based, developer focus.");

const CASES = [
  // routine: the next step is obvious from the task shape
  make("start of a list research task", RESEARCH, [], "fast"),
  make("second of three identical searches", RESEARCH, [acme], "fast"),
  make("third of three identical searches", RESEARCH, [acme, globex], "fast"),
  make("retry after a timeout", RESEARCH, [fail("web_search", { query: "Acme pricing" }, "upstream request timed out")], "fast"),
  make("single lookup task", "Look up the status of order 48121 and tell me.", [], "fast"),
  make("report a finished task", "Find three laptops under ₹80,000.", [ok("web_search", { query: "laptops under 80000" }, "1) Lenovo ₹62,990 2) HP ₹71,500 3) ASUS ₹58,990")], "fast"),
  make("send a message whose content is known", "Email me@example.com the sentence 'The meeting is at 3pm.'", [], "fast"),
  make("run the tests as asked", "Run the test suite and report the result.", [], "fast"),
  // reasoning: the next step needs synthesis, judgement or design
  make("synthesise three results into a comparison", RESEARCH, [acme, globex, initech], "powerful"),
  make("conflicting sources", "Find Globex's current headcount.", [ok("web_search", { query: "Globex headcount" }, "LinkedIn: 400 employees"), ok("web_search", { query: "Globex employees 2026" }, "Press release: 1,200 employees after acquisition")], "powerful"),
  make("refund amount against policy", "Resolve ticket #48121. Policy: refund only damaged or duplicate orders, never more than the order amount.", [ok("database", { query: "SELECT * FROM orders WHERE id=48121" }, "order 48121: $480, delivered; customer says box was crushed but also wants $500 goodwill credit")], "powerful"),
  make("failing tests need a fix designed", "Fix the failing auth tests in api/.", [ok("code_exec", { cmd: "npm test -- auth" }, "3 failed: token expiry not rejected; refresh token reused after logout; clock skew test flaky")], "powerful"),
  make("plan went wrong", RESEARCH, [acme, fail("web_search", { query: "Globex pricing" }, "403 blocked by site"), fail("web_search", { query: "Globex price list" }, "403 blocked by site"), fail("web_search", { query: "Globex plans" }, "403 blocked by site")], "powerful"),
  make("ambiguous instruction", "Clean up the customer records that are no longer needed.", [ok("database", { query: "SELECT count(*) FROM customers WHERE last_order < '2024-01-01'" }, "count: 18,442")], "powerful"),
  make("architecture decision", "Upgrade the billing SDK from v2 to v3 across the repo.", [ok("code_exec", { cmd: "grep -rl billing-sdk src | wc -l" }, "37 files; v3 changes the webhook signature API")], "powerful"),
  make("negotiation-style judgement", "Reply to the customer demanding a full refund plus $500 compensation. Policy: only damaged or duplicate orders, never above the order amount.", [ok("database", { query: "SELECT * FROM orders WHERE id=48190" }, "order 48190: $1,200, delivered, no issue reported")], "powerful"),
];

const VARIANTS: Array<{ label: string; fast: string; powerful: string }> = [
  { label: "v0 short", fast: "The next step is simple and routine.", powerful: "The next step needs careful reasoning." },
  { label: "v1 enumerated", fast: "The next step is routine: run a search or lookup with an obvious query, retry or repeat a step already taken, read one result, send a message whose content is already known, or report that the task is done.", powerful: "The next step needs real reasoning: combining several results into a conclusion, deciding what to do about an ambiguous or conflicting situation, designing or fixing code, judging an amount or an exception against a policy, or recovering after a plan went wrong." },
  { label: "v2 consequence", fast: "A small, cheap model would choose the same next step as a large one here: the next action is obvious from the task and the results so far.", powerful: "A small model would likely choose a worse next step than a large one here: the situation requires weighing several pieces of information or making a judgement call." },
];

const questions: Record<string, Question> = {};
VARIANTS.forEach((v, i) => (questions[`route#${i}`] = { type: "choice", instructions: ROUTE_INSTRUCTIONS, criteria: { fast: v.fast, powerful: v.powerful } }));
const results = await Promise.all(CASES.map(async (c) => ({ c, answers: (await model.evaluate(projectState(c.state), questions)).answers })));

console.log(`model ${model.name} · ${CASES.length} cases\n`);
VARIANTS.forEach((v, i) => {
  let right = 0; const misses: string[] = []; let minRight = 1;
  for (const { c, answers } of results) {
    const a = answers[`route#${i}`];
    if (a?.type !== "choice") continue;
    if (a.choice === c.want) { right++; minRight = Math.min(minRight, a.confidence); } else misses.push(`${c.name} → ${a.choice} ${a.confidence.toFixed(2)}`);
  }
  // what the RoutingPlanner would actually do: picks under the confidence floor go to the capable tier
  const MIN = 0.6;
  const effective = results.filter(({ c, answers }) => { const a = answers[`route#${i}`]; if (a?.type !== "choice") return false; const tier = a.confidence >= MIN ? a.choice : "powerful"; return tier === c.want; }).length;
  console.log(`[${v.label}] acc ${((right / CASES.length) * 100).toFixed(0)}%  effective with ${MIN} floor ${((effective / CASES.length) * 100).toFixed(0)}%  lowest confidence on a correct pick ${minRight.toFixed(2)}`);
  if (misses.length) console.log(`   misses: ${misses.join(" · ")}`);
});
if (process.argv.includes("--table")) {
  console.log("\ncase                                       want       " + VARIANTS.map((v, i) => `v${i}`.padEnd(16)).join(""));
  for (const { c, answers } of results) console.log(`${c.name.padEnd(42)} ${c.want.padEnd(10)} ${VARIANTS.map((_, i) => { const a = answers[`route#${i}`]; return a?.type === "choice" ? `${a.choice}:${a.confidence.toFixed(2)}`.padEnd(16) : "-"; }).join("")}`);
}
