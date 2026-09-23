import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Signals } from "./signals.js";
import type { Action } from "./types.js";

/** One file per request, so an agent in the background and a person in another terminal never contend. */
export interface ApprovalRecord {
  id: string;
  agent_id: string;
  task: string;
  action: Action;
  rule: string;
  reason: string;
  signals: Signals;
  status: "pending" | "approved" | "denied" | "expired";
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  note?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  by?: string;
}

const file = (dir: string, id: string) => join(dir, `${id}.json`);
const read = async (path: string) => JSON.parse(await readFile(path, "utf8")) as ApprovalRecord;

export async function listApprovals(dir: string, status?: ApprovalRecord["status"]): Promise<ApprovalRecord[]> {
  if (!existsSync(dir)) return [];
  const records = await Promise.all((await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => read(join(dir, f))));
  return records.filter((r) => !status || r.status === status).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export async function resolveApproval(dir: string, id: string, approved: boolean, by: string, note?: string): Promise<ApprovalRecord> {
  const matches = (await listApprovals(dir)).filter((r) => r.id === id || r.id.startsWith(id));
  if (matches.length !== 1) throw new Error(matches.length ? `"${id}" matches ${matches.length} requests — use more characters` : `no approval request "${id}"`);
  const record = matches[0];
  if (record.status !== "pending") throw new Error(`request ${record.id} is already ${record.status}`);
  const resolved: ApprovalRecord = { ...record, status: approved ? "approved" : "denied", resolvedAt: new Date().toISOString(), resolvedBy: by, note };
  await writeFile(file(dir, record.id), JSON.stringify(resolved, null, 2));
  return resolved;
}

/**
 * Parks a review request on disk and waits for `acp approve` / `acp deny` (or
 * `resolveApproval`) from anywhere. Lets agents run in the background, in CI
 * or on a server. Times out to a denial: no answer never means yes.
 */
export async function createApproval(dir: string, request: Omit<ApprovalRecord, "id" | "status" | "requestedAt">): Promise<ApprovalRecord> {
  await mkdir(dir, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const record: ApprovalRecord = { ...request, id, status: "pending", requestedAt: new Date().toISOString() };
  await writeFile(file(dir, id), JSON.stringify(record, null, 2));
  return record;
}

export async function getApproval(dir: string, id: string): Promise<ApprovalRecord | undefined> {
  return read(file(dir, id)).catch(() => undefined);
}

export async function requestFileApproval(
  dir: string,
  request: Omit<ApprovalRecord, "id" | "status" | "requestedAt">,
  opts: { timeoutMs?: number; pollMs?: number; onPending?: (record: ApprovalRecord) => void } = {},
): Promise<ApprovalDecision> {
  const record = await createApproval(dir, request);
  const id = record.id;
  opts.onPending?.(record);

  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
    const current = await read(file(dir, id)).catch(() => record);
    if (current.status === "approved" || current.status === "denied") return { approved: current.status === "approved", by: current.resolvedBy };
  }
  await writeFile(file(dir, id), JSON.stringify({ ...record, status: "expired", resolvedAt: new Date().toISOString() }, null, 2));
  return { approved: false, by: "timeout" };
}
