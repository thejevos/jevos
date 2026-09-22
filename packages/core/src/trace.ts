import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { VerdictAction } from "./policy.js";
import type { Signals } from "./signals.js";
import type { AgentState } from "./types.js";

export interface TraceEvent {
  timestamp: string;
  agent_id: string;
  step: number;
  /** gate = before a tool runs, check = after a result, recovery = after a failure, tool = execution record */
  phase: "gate" | "check" | "recovery" | "tool";
  decision: VerdictAction | "EXECUTED" | "FAILED" | "APPROVED" | "DENIED";
  rule?: string;
  reason?: string;
  signals?: Signals;
  tool?: string;
  args?: Record<string, unknown>;
  model?: string;
  latency_ms: number;
  cost: number;
  /** Who approved or denied, for APPROVED / DENIED events. */
  actor?: string;
  /** Windowed copy of the state the decision was made on. Lets `acp label` turn real decisions into eval cases. */
  snapshot?: AgentState;
  /** Hash chain (JsonlSink with chain: true): hash of the previous line, and of this one. */
  prev?: string;
  hash?: string;
}

export interface TraceSink {
  write(event: TraceEvent): void | Promise<void>;
}

export class MemorySink implements TraceSink {
  readonly events: TraceEvent[] = [];
  write(event: TraceEvent): void {
    this.events.push(event);
  }
}

const GENESIS = "0".repeat(64);
const digest = (prev: string, body: Omit<TraceEvent, "hash">) => createHash("sha256").update(prev).update(JSON.stringify(body)).digest("hex");

/**
 * Append-only JSONL trace. With `chain: true` every line carries the hash of the
 * line before it, so an approval or a block cannot be edited or removed later
 * without `verifyChain` noticing. One writer per file: two processes appending
 * to the same chained file will fork the chain.
 */
export class JsonlSink implements TraceSink {
  private queue: Promise<unknown> = Promise.resolve();
  private last?: string;

  constructor(private readonly path: string, private readonly opts: { chain?: boolean } = {}) {}

  write(event: TraceEvent): Promise<void> {
    // Serialized: each line's hash depends on the one before it.
    const next = this.queue.then(() => this.append(event));
    this.queue = next.catch(() => {});
    return next;
  }

  private async append(event: TraceEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    if (!this.opts.chain) return appendFile(this.path, `${JSON.stringify(event)}\n`);
    this.last ??= await lastHash(this.path);
    const body = { ...event, prev: this.last };
    const hash = digest(this.last, body);
    await appendFile(this.path, `${JSON.stringify({ ...body, hash })}\n`);
    this.last = hash;
  }
}

async function lastHash(path: string): Promise<string> {
  if (!existsSync(path)) return GENESIS;
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n").filter(Boolean);
  const tail = lines.length ? (JSON.parse(lines[lines.length - 1]) as TraceEvent) : undefined;
  return tail?.hash ?? GENESIS;
}

export interface ChainReport {
  ok: boolean;
  events: number;
  /** Lines written without a hash (older, unchained traces). */
  unchained: number;
  /** 1-based line number of the first line that fails verification. */
  brokenAt?: number;
  reason?: string;
}

export async function verifyChain(path: string): Promise<ChainReport> {
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  let prev = GENESIS, unchained = 0;
  for (let i = 0; i < lines.length; i++) {
    let event: TraceEvent;
    try { event = JSON.parse(lines[i]); } catch { return { ok: false, events: lines.length, unchained, brokenAt: i + 1, reason: "line is not valid JSON" }; }
    if (!event.hash) {
      // Unchained lines are only acceptable before the chain starts.
      if (prev !== GENESIS) return { ok: false, events: lines.length, unchained, brokenAt: i + 1, reason: "unhashed line inside a chained log" };
      unchained++;
      continue;
    }
    const { hash, ...body } = event;
    if (body.prev !== prev) return { ok: false, events: lines.length, unchained, brokenAt: i + 1, reason: "a line was removed, inserted or reordered before this one" };
    if (digest(prev, body) !== hash) return { ok: false, events: lines.length, unchained, brokenAt: i + 1, reason: "this line was edited after it was written" };
    prev = hash;
  }
  return { ok: true, events: lines.length, unchained };
}
