// Commands that close the loop after a run: approvals from another terminal, audit
// verification, and turning real decisions into eval cases.
import { ControlPlane, JevModel, listApprovals, MockModel, resolveApproval, verifyChain, type AgentState, type Policy, type TraceEvent, type VerdictAction } from "@jevos/core";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { c, table, time, verdict } from "./term.js";

export const APPROVALS_DIR = ".acp/approvals";
export const CASES_FILE = ".acp/cases.jsonl";
export const whoami = () => { try { return userInfo().username; } catch { return "unknown"; } };

const VERDICTS: VerdictAction[] = ["ALLOW", "HUMAN_REVIEW", "BLOCK", "REPLAN", "STOP"];
const KEYS: Record<string, VerdictAction> = { a: "ALLOW", r: "HUMAN_REVIEW", b: "BLOCK", p: "REPLAN", s: "STOP" };

export interface LabeledCase {
  name: string;
  state: AgentState;
  expected: VerdictAction;
  recorded: string;
  labeledBy: string;
  labeledAt: string;
  note?: string;
}

// ───────── approvals ─────────
export async function approvals(): Promise<number> {
  const pending = await listApprovals(APPROVALS_DIR, "pending");
  if (!pending.length) { console.log(c.gray("no approvals waiting")); return 0; }
  for (const r of pending) {
    console.log(`${c.yellow(r.id)}  ${c.magenta(r.agent_id)}  ${c.bold(r.action.tool)} ${c.gray(JSON.stringify(r.action.args ?? {}))}`);
    console.log(`  ${r.reason}${r.signals.actionRisky !== undefined ? ` ${c.gray("·")} risk ${r.signals.actionRisky.toFixed(2)}` : ""} ${c.gray("· waiting since")} ${time(r.requestedAt)}\n  ${c.gray("task")} ${r.task}`);
  }
  console.log(`\n${c.cyan("acp approve <id>")} or ${c.cyan("acp deny <id>")} ${c.gray("(a unique prefix of the id is enough)")}`);
  return 0;
}

export async function resolve(argv: string[], approved: boolean): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { note: { type: "string" } } });
  if (!positionals[0]) throw new Error(`usage: acp ${approved ? "approve" : "deny"} <id> [--note "why"]`);
  const r = await resolveApproval(APPROVALS_DIR, positionals[0], approved, whoami(), values.note);
  console.log(`${approved ? c.green("approved") : c.red("denied")} ${r.action.tool} for ${c.magenta(r.agent_id)} ${c.gray(`as ${r.resolvedBy}`)}`);
  return 0;
}

// ───────── traces verify ─────────
export async function verify(file: string): Promise<number> {
  if (!existsSync(file)) throw new Error(`no traces at ${file}`);
  const report = await verifyChain(file);
  if (report.ok) {
    console.log(`${c.green("intact")} ${c.gray("·")} ${report.events} events, hash chain verified${report.unchained ? c.gray(` (${report.unchained} older lines were written before chaining was on)`) : ""}`);
    return 0;
  }
  console.log(`${c.red("TAMPERED")} ${c.gray("·")} line ${report.brokenAt} of ${report.events}: ${report.reason}`);
  return 3;
}

// ───────── label ─────────
async function decisions(file: string): Promise<Array<{ index: number; event: TraceEvent }>> {
  if (!existsSync(file)) throw new Error(`no traces at ${file} — run an agent first with \`acp run\``);
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line, i) => ({ index: i + 1, event: JSON.parse(line) as TraceEvent })).filter(({ event }) => event.snapshot && event.signals);
}

async function save(event: TraceEvent, index: number, expected: VerdictAction, note?: string): Promise<void> {
  const record: LabeledCase = { name: `${event.agent_id} #${index} ${event.tool ?? event.phase}`, state: event.snapshot!, expected, recorded: event.decision, labeledBy: whoami(), labeledAt: new Date().toISOString(), note };
  await mkdir(dirname(CASES_FILE), { recursive: true });
  await appendFile(CASES_FILE, `${JSON.stringify(record)}\n`);
}

function show(event: TraceEvent, index: number): void {
  const last = event.snapshot!.history.at(-1);
  console.log(`\n${c.gray(`#${index}`)} ${c.magenta(event.agent_id)} ${c.gray("·")} ${event.snapshot!.task}`);
  if (event.tool) console.log(`  ${c.gray("proposed")} ${c.bold(event.tool)} ${c.gray(JSON.stringify(event.args ?? {}))}`);
  else if (last) console.log(`  ${c.gray("after")} ${last.action.tool} ${c.gray("→")} ${(last.observation ?? last.error ?? "").slice(0, 160)}`);
  console.log(`  ${c.gray("verdict")} ${verdict(event.decision, 0)} ${c.gray(event.rule ?? "")}`);
}

export async function label(argv: string[], traceFile: string): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { traces: { type: "string", default: traceFile }, index: { type: "string" }, expect: { type: "string" }, note: { type: "string" }, last: { type: "string", default: "30" }, wrong: { type: "boolean", default: false } } });
  const all = await decisions(values.traces!);
  if (!all.length) throw new Error("no decisions with state snapshots yet — they are recorded by `acp run` from this version on");

  if (values.index) {
    const hit = all.find((d) => d.index === Number(values.index));
    const expected = values.expect?.toUpperCase() as VerdictAction;
    if (!hit) throw new Error(`line ${values.index} is not a decision with a snapshot`);
    if (!VERDICTS.includes(expected)) throw new Error(`--expect must be one of ${VERDICTS.join(", ")}`);
    await save(hit.event, hit.index, expected, values.note);
    console.log(`${c.green("labeled")} #${hit.index}: expected ${verdict(expected, 0)}, recorded ${verdict(hit.event.decision, 0)} ${c.gray(`→ ${CASES_FILE}`)}`);
    return 0;
  }
  if (!process.stdin.isTTY) throw new Error("labeling is interactive; in scripts use --index <line> --expect <VERDICT>");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let saved = 0;
  for (const { event, index } of all.slice(-Number(values.last))) {
    show(event, index);
    const answer = (await rl.question(`  ${c.cyan("right?")} [y]es  or should it be [a]llow [r]eview [b]lock re[p]lan [s]top  ${c.gray("· enter = skip · q = quit")} `)).trim().toLowerCase();
    if (answer === "q") break;
    const expected = answer === "y" ? (event.decision as VerdictAction) : KEYS[answer];
    if (!expected || !VERDICTS.includes(expected)) continue;
    if (values.wrong && answer === "y") continue;
    await save(event, index, expected);
    saved++;
  }
  rl.close();
  console.log(`\n${saved} case${saved === 1 ? "" : "s"} added to ${CASES_FILE}. Run ${c.cyan("acp eval")} to score the current model and policy against them.`);
  return 0;
}

// ───────── eval ─────────
export async function evaluate(policy: Policy): Promise<number> {
  if (!existsSync(CASES_FILE)) throw new Error(`no labeled cases at ${CASES_FILE} — create some with \`acp label\``);
  const cases = (await readFile(CASES_FILE, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as LabeledCase);
  const model = process.env.TYPESAFE_API_KEY ? new JevModel({ model: process.env.JEV_MODEL }) : new MockModel();
  if (model.name === "mock") console.log(`${c.yellow("warning")} no TYPESAFE_API_KEY: scoring against the offline mock, which uses keyword heuristics and cannot judge goals. Results only mean something on Jev.
`);
  const control = new ControlPlane({ model, policy });
  const results = await Promise.all(cases.map(async (k) => ({ k, got: (await control.evaluate(k.state)).verdict })));
  const wrong = results.filter((r) => r.got.action !== r.k.expected);
  console.log(`${c.bold(String(cases.length - wrong.length))}/${cases.length} labeled decisions reproduced ${c.gray(`· model ${model.name}`)}\n`);
  for (const r of wrong) console.log(`  ${c.red("✗")} ${r.k.name}: expected ${verdict(r.k.expected, 0)}, got ${verdict(r.got.action, 0)} ${c.gray(r.got.rule)}`);
  if (wrong.length) console.log(`\n${c.gray("Adjust thresholds or question wording, then run this again. Exit code 4 lets CI fail on regressions.")}`);
  console.log(table([["cases", CASES_FILE], ["accuracy", `${((1 - wrong.length / cases.length) * 100).toFixed(0)}%`]]));
  return wrong.length ? 4 : 0;
}
