import type { ApprovalRecord } from "./approvals.js";
import { ControlPlane, type ControlPlaneOptions, type Decision, type RunOptions, type RunResult, type ToolDef } from "./control.js";
import type { DecisionModel } from "./model.js";
import type { Verdict } from "./policy.js";
import type { AgentState } from "./types.js";
import type { TraceEvent } from "./trace.js";

export interface FleetClientOptions extends Omit<ControlPlaneOptions, "model" | "policy" | "onApproval"> {
  /** Fleet server, e.g. http://localhost:8787 */
  url: string;
  /** Shared fleet token (FLEET_TOKEN on the server). */
  token?: string;
  agentId: string;
  /** How long a review request waits for `acp approve` before it counts as denied. Default 15 min. */
  approvalTimeoutMs?: number;
  pollMs?: number;
  /** Called when a review request has been parked on the server (for printing its id). */
  onPending?: (record: ApprovalRecord) => void;
  fetch?: typeof fetch;
}

/** Placeholder: the fleet server owns the decision model; this client never calls one. */
const REMOTE: DecisionModel = { name: "fleet", evaluate: async () => { throw new Error("FleetControlPlane does not evaluate locally"); } };

export class FleetHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * Runs an agent under a shared fleet server: every decision, approval and
 * trace line goes to the server, which applies one policy over all agents,
 * enforces fleet-wide budgets and keeps the single hash-chained audit log.
 * Same interface as ControlPlane, so an agent file does not change.
 */
export class FleetControlPlane extends ControlPlane {
  private readonly fleet: FleetClientOptions;
  private readonly fetchImpl: typeof fetch;
  private remoteModel = "fleet";

  constructor(opts: FleetClientOptions) {
    super({ ...opts, model: REMOTE });
    this.fleet = opts;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.fleet.url.replace(/\/$/, "")}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(this.fleet.token ? { authorization: `Bearer ${this.fleet.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new FleetHttpError(res.status, `fleet server ${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  override async evaluate(state: AgentState): Promise<Decision> {
    const started = performance.now();
    let decision: Decision;
    try {
      const r = await this.call<Decision & { model?: string }>("POST", "/v1/fleet/decide", { agent_id: this.agentId, state, counters: this.counters(state) });
      decision = { signals: r.signals, verdict: r.verdict, latencyMs: r.latencyMs, cost: r.cost, modelError: r.modelError };
      if (r.model) this.remoteModel = r.model;
    } catch (err) {
      // Fail closed: the fleet server is the authority, and it cannot be reached.
      const reason = err instanceof Error ? err.message : String(err);
      decision = { signals: {}, verdict: state.currentAction ? { action: "HUMAN_REVIEW", rule: "fleet_unavailable", reason } : { action: "STOP", rule: "fleet_unavailable", reason }, latencyMs: 0, cost: 0, modelError: reason };
    }
    this.modelCalls++;
    this.cost += decision.cost;
    this.latencyMs += Math.round(performance.now() - started);
    // The server already logged this decision; mirror it to the local sink (the terminal) only.
    const action = state.currentAction;
    await this.opts.sink?.write({ timestamp: new Date().toISOString(), agent_id: this.agentId, model: this.remoteModel, step: state.history.length, phase: action ? "gate" : "check", decision: decision.verdict.action, rule: decision.verdict.rule, reason: decision.verdict.reason, signals: decision.signals, tool: action?.tool, args: action?.args, latency_ms: decision.latencyMs, cost: decision.cost });
    return decision;
  }

  protected override async approve(state: AgentState, decision: Decision): Promise<boolean> {
    const action = state.currentAction!;
    const started = performance.now();
    let record: ApprovalRecord;
    try {
      record = await this.call<ApprovalRecord>("POST", "/v1/fleet/approvals", { agent_id: this.agentId, task: state.task, action, rule: decision.verdict.rule, reason: decision.verdict.reason, signals: decision.signals });
    } catch {
      return false;
    }
    this.fleet.onPending?.(record);
    const deadline = Date.now() + (this.fleet.approvalTimeoutMs ?? 15 * 60_000);
    let approved = false, by: string | undefined = "timeout";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.fleet.pollMs ?? 1000));
      const current = await this.call<ApprovalRecord>("GET", `/v1/fleet/approvals/${record.id}`).catch(() => undefined);
      if (current?.status === "approved" || current?.status === "denied") { approved = current.status === "approved"; by = current.resolvedBy; break; }
    }
    if (by === "timeout") await this.call("POST", `/v1/fleet/approvals/${record.id}/deny`, { by: "timeout" }).catch(() => {});
    await this.trace(state, { phase: "gate", decision: approved ? "APPROVED" : "DENIED", rule: decision.verdict.rule, tool: action.tool, args: action.args, actor: by, latency_ms: Math.round(performance.now() - started), cost: 0 });
    return approved;
  }

  protected override async trace(state: AgentState, event: Omit<TraceEvent, "timestamp" | "agent_id" | "model" | "step"> & { step?: number }): Promise<void> {
    const full: TraceEvent = { timestamp: new Date().toISOString(), agent_id: this.agentId, model: this.remoteModel, step: state.history.length, ...event };
    // The fleet log is the record; a local sink (e.g. the terminal) may mirror it.
    await Promise.all([this.call("POST", "/v1/fleet/traces", full).catch(() => {}), this.opts.sink?.write(full)]);
  }

  override async run(opts: RunOptions): Promise<RunResult> {
    const start = await this.call<{ ok: boolean; verdict?: Verdict }>("POST", "/v1/fleet/runs/start", { agent_id: this.agentId, tools: opts.tools.map((t) => t.name) }).catch((err) => ({ ok: false, verdict: { action: "STOP", rule: "fleet_unavailable", reason: String(err) } as Verdict }));
    if (!start.ok) {
      const v = start.verdict!;
      const state = { task: opts.task, goal: { description: opts.goal ?? opts.task, status: "failed" as const }, history: [], tools: opts.tools.map(({ name, description, category }) => ({ name, description, category })), context: [] };
      return { status: v.action === "BLOCK" ? "escalated" : "halted", reason: v.reason, state, stats: { steps: 0, plannerCalls: 0, discardedPlannerCalls: 0, plannerCost: 0, plannerTokens: 0, modelCalls: 0, skippedGates: 0, quarantinedResults: 0, controlCost: 0, controlLatencyMs: 0 } };
    }
    try {
      return await super.run(opts);
    } finally {
      await this.call("POST", "/v1/fleet/runs/end", { agent_id: this.agentId, plannerCostUsd: this.planner.cost }).catch(() => {});
    }
  }

  /** Ask the fleet whether this agent may hand a task to another agent. */
  async handoff(to: string, task: string): Promise<Verdict> {
    return this.call<Verdict>("POST", "/v1/fleet/handoff", { from: this.agentId, to, task });
  }

  /** Gate one tool call through the fleet (same as ControlPlane.tool). */
  override tool(def: ToolDef) { return super.tool(def); }
}
