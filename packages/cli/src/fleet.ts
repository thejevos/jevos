// Fleet commands: serve the control plane, and talk to one from any machine.
import type { ApprovalRecord, FleetPolicy, FleetStatus } from "@jevos/core";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { c, table, time, verdict } from "./term.js";
import { whoami } from "./review.js";

export const FLEET_FILE = "fleet.policy.json";

function client(argv: string[], extra: Record<string, { type: "string" | "boolean"; default?: string | boolean }> = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { fleet: { type: "string" }, token: { type: "string" }, ...extra } });
  const url = values.fleet as string | undefined;
  if (!url) throw new Error("--fleet <url> is required");
  const token = (values.token as string | undefined) ?? process.env.FLEET_TOKEN;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${url.replace(/\/$/, "")}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }).catch((e) => { throw new Error(`cannot reach fleet at ${url}: ${e.message}`); });
    if (!res.ok) throw new Error(`fleet ${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  return { values, positionals, url, call };
}

export async function fleetInit(example: FleetPolicy): Promise<number> {
  if (existsSync(FLEET_FILE)) { console.log(`  ${c.gray("skip")}    ${FLEET_FILE} ${c.gray("(already exists)")}`); return 0; }
  await writeFile(FLEET_FILE, `${JSON.stringify(example, null, 2)}\n`);
  console.log(`  ${c.green("create")}  ${FLEET_FILE}\n\nNext:\n  ${c.cyan("set FLEET_TOKEN=<a long random secret>")}\n  ${c.cyan(`acp serve --fleet ${FLEET_FILE}`)}\n  ${c.cyan("acp run agent.example.ts --fleet http://localhost:8787 --agent-id research")}`);
  return 0;
}

export async function serveCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { fleet: { type: "string" }, port: { type: "string" }, token: { type: "string" }, traces: { type: "string", default: ".acp/fleet-traces.jsonl" }, approvals: { type: "string", default: ".acp/approvals" } } });
  const { startServer } = await import("@jevos/server");
  startServer({ fleet: values.fleet, port: values.port ? Number(values.port) : undefined, token: values.token, traces: values.traces, approvalsDir: values.approvals });
  return await new Promise<number>(() => {}); // runs until killed
}

export async function fleetStatus(argv: string[]): Promise<number> {
  const { call, url } = client(argv);
  const s = await call<FleetStatus>("GET", "/v1/fleet/status");
  const money = (n: number, max?: number) => `$${n.toFixed(4)}${max !== undefined ? c.gray(` / $${max}`) : ""}`;
  console.log(`${c.bold("fleet")} ${c.gray(url)} ${c.gray("·")} ${s.day}`);
  console.log(table([["spend today", money(s.fleet.costUsd, s.fleet.dailyCostUsd)], ["active runs", `${s.fleet.activeRuns}${s.fleet.maxConcurrentRuns !== undefined ? c.gray(` / ${s.fleet.maxConcurrentRuns}`) : ""}`], ["pending approvals", String(s.fleet.pendingApprovals)]]));
  console.log(`\n${c.gray("agent               spend            runs   decisions  last seen")}`);
  for (const [id, a] of Object.entries(s.agents)) {
    console.log(`${(a.registered ? c.magenta(id.padEnd(19)) : c.gray(id.padEnd(19)))} ${money(a.costUsd, a.maxCostUsd).padEnd(28)} ${String(a.activeRuns).padStart(2)}${a.maxConcurrentRuns !== undefined ? c.gray(`/${a.maxConcurrentRuns}`) : "  "}   ${String(a.decisions).padStart(6)}     ${a.lastSeen ? time(a.lastSeen) : c.gray("never")}`);
  }
  return 0;
}

export async function fleetApprovals(argv: string[]): Promise<number> {
  const { call, url } = client(argv);
  const pending = await call<ApprovalRecord[]>("GET", "/v1/fleet/approvals");
  if (!pending.length) { console.log(c.gray("no fleet approvals waiting")); return 0; }
  for (const r of pending) {
    console.log(`${c.yellow(r.id)}  ${c.magenta(r.agent_id)}  ${c.bold(r.action.tool)} ${c.gray(JSON.stringify(r.action.args ?? {}))}`);
    console.log(`  ${r.reason} ${c.gray("· waiting since")} ${time(r.requestedAt)}\n  ${c.gray("task")} ${r.task}`);
  }
  console.log(`\n${c.cyan(`acp approve <id> --fleet ${url}`)} or ${c.cyan(`acp deny <id> --fleet ${url}`)}`);
  return 0;
}

export async function fleetResolve(argv: string[], approved: boolean): Promise<number> {
  const { call, positionals, values } = client(argv, { note: { type: "string" } });
  const id = positionals[0];
  if (!id) throw new Error(`usage: acp ${approved ? "approve" : "deny"} <id> --fleet <url>`);
  const pending = await call<ApprovalRecord[]>("GET", "/v1/fleet/approvals");
  const matches = pending.filter((r) => r.id === id || r.id.startsWith(id));
  if (matches.length !== 1) throw new Error(matches.length ? `"${id}" matches ${matches.length} requests` : `no pending fleet approval "${id}"`);
  const r = await call<ApprovalRecord>("POST", `/v1/fleet/approvals/${matches[0].id}/${approved ? "approve" : "deny"}`, { by: whoami(), note: (values as { note?: string }).note });
  console.log(`${approved ? c.green("approved") : c.red("denied")} ${r.action.tool} for ${c.magenta(r.agent_id)} ${c.gray(`as ${r.resolvedBy}`)} ${verdict(approved ? "APPROVED" : "DENIED", 0)}`);
  return 0;
}
