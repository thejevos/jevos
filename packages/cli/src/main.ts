import { ControlPlane, DEFAULT_THRESHOLDS, JevModel, JsonlSink, MockModel, decide, requestFileApproval, resolvePolicy, type MockResponder, type Planner, type Policy, type ToolDef, type TraceEvent, type VerdictAction } from "@agent-control/core";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CLAUDE_AGENT, EXAMPLE_AGENT } from "./template.js";
import { APPROVALS_DIR, approvals, evaluate, label, resolve as resolveCmd, verify, whoami } from "./review.js";
import { c, eventLine, table, verdict } from "./term.js";

const POLICY_FILE = "acp.policy.json";
const TRACE_FILE = ".acp/traces.jsonl";

const HELP = `${c.bold("acp")} — run AI agents under the Agent Control Plane

${c.bold("Usage")}
  acp init                       write ${POLICY_FILE} and an example agent
  acp run <agent-file> [opts]    run an agent under control, live trace in the terminal
  acp traces [opts]              inspect recorded decisions
  acp traces verify              check the audit log's hash chain for tampering
  acp approvals                  list actions waiting for a person
  acp approve|deny <id>          answer one, from any terminal
  acp label                      mark recorded decisions right or wrong -> eval cases
  acp eval                       score the current model + policy against your labeled cases
  acp policy check [opts]        replay a policy against recorded decisions
  acp doctor                     show which decision model and files will be used

${c.bold("run options")}
  --task <text>        override the task exported by the agent file
  --policy <file>      policy file (default ${POLICY_FILE})
  --traces <file>      where to append decisions (default ${TRACE_FILE})
  --agent-id <name>    name recorded in traces (default: file name)
  --auto-approve       approve every human-review request without asking ${c.red("(unsafe)")}
  --queue-approvals    park review requests in .acp/approvals and wait for "acp approve" (background, CI, server)
  --approval-timeout <s>  how long a queued request waits before it is denied (default 900)
  --speculative        ask the planner for the next step while the result check runs
  --quiet              only print the final summary

${c.bold("traces options")}
  --file <file>  --agent <id>  --verdict <ALLOW|BLOCK|HUMAN_REVIEW|REPLAN|STOP|...>  --last <n>  --json

${c.bold("policy check options")}
  --policy <file>  --traces <file>  --show-changes

Decisions come from Jev when TYPESAFE_API_KEY is set, otherwise from an offline mock.`;

/** What `acp run` expects an agent file to export (default export or named exports). */
export interface AgentModule {
  task?: string;
  goal?: string;
  planner: Planner;
  tools: ToolDef[];
  /** Only used with the offline mock, to script signals such as goal completion. */
  mockResponder?: MockResponder;
}

async function loadPolicy(file: string, required: boolean): Promise<Policy> {
  if (!existsSync(file)) {
    if (required) throw new Error(`policy file not found: ${file} (run \`acp init\`)`);
    return resolvePolicy();
  }
  try {
    return resolvePolicy(JSON.parse(await readFile(file, "utf8")));
  } catch (err) {
    throw new Error(`could not read ${file}: ${(err as Error).message}`);
  }
}

async function readTraces(file: string): Promise<TraceEvent[]> {
  if (!existsSync(file)) throw new Error(`no traces at ${file} — run an agent first with \`acp run\``);
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceEvent);
}

// ───────── init ─────────
async function init(): Promise<number> {
  const files: Array<[string, string]> = [
    [POLICY_FILE, `${JSON.stringify({ maxSteps: 30, maxCost: 1, maxRetries: 3, maxReplans: 3, readOnlyTools: ["web_search"], blockedTools: ["delete_database"], approvalRequired: ["send_email"], thresholds: DEFAULT_THRESHOLDS }, null, 2)}\n`],
    ["agent.example.ts", EXAMPLE_AGENT],
    ["agent.claude.ts", CLAUDE_AGENT],
  ];
  for (const [name, body] of files) {
    if (existsSync(name)) { console.log(`  ${c.gray("skip")}    ${name} ${c.gray("(already exists)")}`); continue; }
    await writeFile(name, body);
    console.log(`  ${c.green("create")}  ${name}`);
  }
  console.log(`\nNext:\n  ${c.cyan("acp run agent.example.ts")}\n\nagent.claude.ts is the same thing with a real LLM (Claude) as the planner.\nEdit ${POLICY_FILE} to change limits, blocked tools, approvals and thresholds.`);
  return 0;
}

// ───────── run ─────────
async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { task: { type: "string" }, policy: { type: "string", default: POLICY_FILE }, traces: { type: "string", default: TRACE_FILE }, "agent-id": { type: "string" }, "auto-approve": { type: "boolean", default: false }, "queue-approvals": { type: "boolean", default: false }, "approval-timeout": { type: "string", default: "900" }, speculative: { type: "boolean", default: false }, quiet: { type: "boolean", default: false } },
  });
  const file = positionals[0];
  if (!file) throw new Error("usage: acp run <agent-file>");
  if (!existsSync(file)) throw new Error(`agent file not found: ${file}`);

  const loaded = await import(pathToFileURL(resolve(file)).href);
  const mod: AgentModule = loaded.default?.planner ? loaded.default : loaded;
  if (!mod.planner?.propose || !Array.isArray(mod.tools)) throw new Error(`${file} must export { planner, tools } (see agent.example.ts from \`acp init\`)`);
  const task = values.task ?? mod.task;
  if (!task) throw new Error("no task: export `task` from the agent file or pass --task");

  const policy = await loadPolicy(values.policy!, values.policy !== POLICY_FILE);
  const model = process.env.TYPESAFE_API_KEY ? new JevModel({ model: process.env.JEV_MODEL }) : new MockModel(mod.mockResponder);
  const agentId = values["agent-id"] ?? file.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const jsonl = new JsonlSink(values.traces!, { chain: true });
  const say = (line: string) => { if (!values.quiet) console.log(line); };

  say(`${c.bold("acp")} ${c.gray("·")} agent ${c.magenta(agentId)} ${c.gray("·")} model ${model.name === "mock" ? c.yellow("mock (offline)") : c.cyan(model.name)} ${c.gray("·")} policy ${existsSync(values.policy!) ? values.policy : "defaults"}`);
  say(`${c.gray("task")} ${task}\n`);

  const control = new ControlPlane({
    model, policy, agentId, traceSnapshots: true, speculativePlanning: values.speculative,
    sink: { write: (e: TraceEvent) => { say(eventLine(e)); return jsonl.write(e); } },
    onApproval: async ({ state, action, verdict: v, signals }) => {
      console.log(`\n  ${c.yellow("┌ approval needed")}\n  ${c.yellow("│")} ${c.bold(action.tool)} ${c.gray(JSON.stringify(action.args ?? {}))}\n  ${c.yellow("│")} ${v.reason}${signals.actionRisky !== undefined ? ` ${c.gray("·")} risk ${signals.actionRisky.toFixed(2)}` : ""}`);
      if (values["auto-approve"]) { console.log(`  ${c.yellow("└")} ${c.red("auto-approved (--auto-approve)")}\n`); return { approved: true, by: "auto-approve" }; }
      if (values["queue-approvals"]) {
        const answer = await requestFileApproval(APPROVALS_DIR, { agent_id: agentId, task: state.task, action, rule: v.rule, reason: v.reason, signals }, {
          timeoutMs: Number(values["approval-timeout"]) * 1000,
          onPending: (r) => console.log(`  ${c.yellow("└")} waiting. From any terminal: ${c.cyan(`acp approve ${r.id}`)} or ${c.cyan(`acp deny ${r.id}`)}`),
        });
        console.log(`  ${answer.approved ? c.green("approved") : c.red("denied")} ${c.gray(`by ${answer.by}`)}`);
        console.log("");
        return answer;
      }
      // No terminal to ask: fail closed.
      if (!process.stdin.isTTY) { console.log(`  ${c.yellow("└")} ${c.red("denied — no interactive terminal to ask")}\n`); return false; }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`  ${c.yellow("└")} approve? [y/N] `);
      rl.close();
      console.log("");
      return { approved: /^y(es)?$/i.test(answer.trim()), by: whoami() };
    },
  });

  const result = await control.run({ task, goal: mod.goal, planner: mod.planner, tools: mod.tools });
  const color = result.status === "complete" ? c.green : result.status === "halted" ? c.yellow : c.red;
  console.log(`\n${color(result.status.toUpperCase())} ${c.gray("·")} ${result.reason}`);
  if (result.output) console.log(result.output);
  console.log(table([
    ["tool executions", result.stats.steps],
    ["planner (LLM) calls", `${result.stats.plannerCalls}${result.stats.discardedPlannerCalls ? c.gray(` (${result.stats.discardedPlannerCalls} speculative, discarded)`) : ""}${result.stats.plannerTokens ? c.gray(` · ${result.stats.plannerTokens} tokens · $${result.stats.plannerCost.toFixed(4)}`) : ""}`],
    ["control decisions", `${result.stats.modelCalls} ${c.gray(`(${result.stats.controlLatencyMs}ms total, est. $${result.stats.controlCost.toFixed(6)})`)}`],
    ...(result.stats.skippedGates ? [["gates skipped (read-only)", result.stats.skippedGates] as [string, number]] : []),
    ...(result.stats.quarantinedResults ? [["tool results withheld", `${result.stats.quarantinedResults} ${c.red("(prompt injection)")}`] as [string, string]] : []),
    ["traces", `${values.traces!} ${c.gray("(hash-chained)")}`],
  ]));
  return result.status === "complete" ? 0 : 2;
}

// ───────── traces ─────────
async function traces(argv: string[]): Promise<number> {
  if (argv[0] === "verify") return verify(parseArgs({ args: argv.slice(1), options: { file: { type: "string", default: TRACE_FILE } } }).values.file!);
  const { values } = parseArgs({ args: argv, options: { file: { type: "string", default: TRACE_FILE }, agent: { type: "string" }, verdict: { type: "string" }, last: { type: "string", default: "40" }, json: { type: "boolean", default: false } } });
  const all = await readTraces(values.file!);
  const want = values.verdict?.toUpperCase();
  const rows = all.filter((e) => (!values.agent || e.agent_id === values.agent) && (!want || e.decision === want)).slice(-Number(values.last));
  if (values.json) { rows.forEach((e) => console.log(JSON.stringify(e))); return 0; }
  if (!rows.length) { console.log(c.gray("no matching decisions")); return 0; }
  rows.forEach((e) => console.log(eventLine(e, true)));
  const counts = new Map<string, number>();
  all.filter((e) => e.signals).forEach((e) => counts.set(e.decision, (counts.get(e.decision) ?? 0) + 1));
  console.log(`\n${c.gray(`${rows.length} shown of ${all.length} events ·`)} ${[...counts].map(([d, n]) => `${verdict(d, 0)} ${n}`).join(c.gray(" · "))}`);
  return 0;
}

// ───────── policy check ─────────
async function policyCheck(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { policy: { type: "string", default: POLICY_FILE }, traces: { type: "string", default: TRACE_FILE }, "show-changes": { type: "boolean", default: false } } });
  const policy = await loadPolicy(values.policy!, true);
  const gates = (await readTraces(values.traces!)).filter((e) => e.phase === "gate" && e.signals && e.tool);
  if (!gates.length) { console.log(c.gray("no gate decisions recorded yet")); return 0; }

  const before = new Map<VerdictAction | string, number>(), after = new Map<string, number>();
  const changes: string[] = [];
  for (const e of gates) {
    // Replay the recorded signals through the candidate policy. Limits are per-run, so step is held at 0.
    const state = { task: "", goal: { description: "", status: "active" as const }, history: [], currentAction: { tool: e.tool!, args: e.args }, tools: [{ name: e.tool!, description: "" }], context: [] };
    const next = decide(state, { ...e.signals, goalComplete: 0 }, policy, { step: 0, costSoFar: 0 });
    before.set(e.decision, (before.get(e.decision) ?? 0) + 1);
    after.set(next.action, (after.get(next.action) ?? 0) + 1);
    if (next.action !== e.decision) changes.push(`  ${c.gray(e.agent_id.padEnd(18))} ${e.tool!.padEnd(16)} ${verdict(e.decision)} ${c.gray("→")} ${verdict(next.action)} ${c.gray(next.rule)}`);
  }
  console.log(`Replayed ${c.bold(String(gates.length))} gate decisions from ${values.traces} against ${values.policy}\n`);
  for (const d of ["ALLOW", "HUMAN_REVIEW", "REPLAN", "BLOCK"]) {
    const a = before.get(d) ?? 0, b = after.get(d) ?? 0, delta = b - a;
    console.log(`  ${verdict(d, 14)} ${String(a).padStart(5)} ${c.gray("→")} ${String(b).padStart(5)}  ${delta === 0 ? c.gray("no change") : (delta > 0 ? c.yellow : c.cyan)(`${delta > 0 ? "+" : ""}${delta}`)}`);
  }
  console.log(`\n${changes.length ? `${changes.length} decision${changes.length > 1 ? "s" : ""} would change.` : c.green("This policy reproduces every recorded decision.")}${changes.length && !values["show-changes"] ? c.gray("  (--show-changes to list them)") : ""}`);
  if (values["show-changes"]) changes.forEach((line) => console.log(line));
  return 0;
}

// ───────── doctor ─────────
async function doctor(): Promise<number> {
  const key = Boolean(process.env.TYPESAFE_API_KEY);
  console.log(table([
    ["decision model", key ? c.cyan(process.env.JEV_MODEL ?? "jev-latest") : `${c.yellow("mock (offline)")} ${c.gray("— set TYPESAFE_API_KEY to use Jev")}`],
    ["policy", existsSync(POLICY_FILE) ? POLICY_FILE : `${c.gray("defaults — run `acp init` to create")} ${POLICY_FILE}`],
    ["traces", existsSync(TRACE_FILE) ? TRACE_FILE : c.gray("none recorded yet")],
    ["node", process.version],
  ]));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "init": return await init();
      case "run": return await run(rest);
      case "traces": return await traces(rest);
      case "policy":
        if (rest[0] === "check") return await policyCheck(rest.slice(1));
        throw new Error("usage: acp policy check");
      case "approvals": return await approvals();
      case "approve": return await resolveCmd(rest, true);
      case "deny": return await resolveCmd(rest, false);
      case "label": return await label(rest, TRACE_FILE);
      case "eval": return await evaluate(await loadPolicy(POLICY_FILE, false));
      case "doctor": return await doctor();
      case undefined: case "help": case "--help": case "-h": console.log(HELP); return 0;
      default: throw new Error(`unknown command "${cmd}" — run \`acp help\``);
    }
  } catch (err) {
    console.error(`${c.red("error")} ${(err as Error).message}`);
    return 1;
  }
}
