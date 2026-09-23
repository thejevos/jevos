import type { ApprovalDecision } from "./approvals.js";
import { estimateTokens, JEV_USD_PER_INPUT_TOKEN, type DecisionModel } from "./model.js";
import { decide, resolvePolicy, type Policy, type RuntimeCounters, type Thresholds, type Verdict } from "./policy.js";
import { decideRecovery } from "./recovery.js";
import { buildQuestions, toSignals, type QuestionOverrides, type Signals } from "./signals.js";
import { projectState, snapshotState, type ProjectionOptions } from "./state.js";
import type { TraceEvent, TraceSink } from "./trace.js";
import { createState, type Action, type AgentState, type Tool } from "./types.js";

export interface ToolDef extends Tool {
  /** JSON Schema for the arguments. Planners that call an LLM pass it through as the tool's input schema. */
  inputSchema?: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface ApprovalRequest {
  state: AgentState;
  action: Action;
  verdict: Verdict;
  signals: Signals;
  agentId: string;
}

export interface ControlPlaneOptions {
  model: DecisionModel;
  policy?: Partial<Omit<Policy, "thresholds">> & { thresholds?: Partial<Thresholds> };
  agentId?: string;
  sink?: TraceSink;
  projection?: ProjectionOptions;
  /** Replace the wording of any signal question by id (see QUESTION_IDS). Re-run the eval after changing these. */
  questions?: QuestionOverrides;
  /** Called on HUMAN_REVIEW. Absent or false means the action does not run. */
  onApproval?: (req: ApprovalRequest) => Promise<boolean | ApprovalDecision> | boolean | ApprovalDecision;
  /** Record a windowed copy of the state on every decision, so real decisions can become eval cases. */
  traceSnapshots?: boolean;
  /**
   * Ask the planner for its next action while the post-result check is still running.
   * Removes the check's latency from every step. The price: when the check says the
   * goal is complete (once per task) or the agent must replan, that planner call is
   * discarded. `stats.discardedPlannerCalls` reports how often that happened.
   */
  speculativePlanning?: boolean;
}

export interface Decision {
  signals: Signals;
  verdict: Verdict;
  latencyMs: number;
  cost: number;
  /** Set when the decision model failed and the verdict came from the fail-closed fallback. */
  modelError?: string;
}

export type GateResult =
  | { status: "executed"; result: string; decision: Decision }
  | { status: "failed"; error: string; decision: Decision }
  | { status: "blocked" | "denied" | "replan" | "stop"; decision: Decision };

/** What a planner may report about the LLM call it just made. Feeds maxCost / maxPlannerTokens. */
export interface PlannerUsage {
  costUsd?: number;
  tokens?: number;
}
export type Proposal = (Action | { finish: string }) & { usage?: PlannerUsage };

/** The reasoning side of the agent: an LLM, a graph, anything that proposes actions. */
export interface Planner {
  propose(state: AgentState, hint?: string, opts?: { signal?: AbortSignal }): Promise<Proposal>;
}

export interface RunOptions {
  task: string;
  goal?: string;
  planner: Planner;
  tools: ToolDef[];
}

export interface RunStats {
  steps: number;
  plannerCalls: number;
  discardedPlannerCalls: number;
  plannerCost: number;
  plannerTokens: number;
  modelCalls: number;
  skippedGates: number;
  quarantinedResults: number;
  controlCost: number;
  controlLatencyMs: number;
}

export interface RunResult {
  status: "complete" | "halted" | "escalated";
  reason: string;
  output?: string;
  state: AgentState;
  stats: RunStats;
}

const WITHHELD = "[withheld by the control plane: this tool result contained instructions aimed at the agent]";

export class ControlPlane {
  readonly policy: Policy;
  protected readonly model: DecisionModel;
  protected readonly agentId: string;
  protected readonly opts: ControlPlaneOptions;
  protected modelCalls = 0;
  protected skippedGates = 0;
  protected cost = 0;
  protected latencyMs = 0;
  /** Planner spend for the run in progress; counted against maxCost with control spend. */
  protected planner = { cost: 0, tokens: 0 };
  protected runStart = { cost: 0 };

  constructor(opts: ControlPlaneOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.policy = resolvePolicy(opts.policy);
    this.agentId = opts.agentId ?? "agent";
  }

  /**
   * Evaluate a state: one parallel Jev call for every applicable signal, then
   * the deterministic policy. With `state.currentAction` set this gates that
   * action; without it, it checks goal / stuck / progress after a result.
   */
  async evaluate(state: AgentState): Promise<Decision> {
    const action = state.currentAction;
    const counters = () => this.counters(state);

    // Read-only tools cannot hurt anything, so their gate costs no model call. Hard rules still run.
    if (action && this.policy.readOnlyTools.includes(action.tool)) {
      let verdict = this.decideWith(state, {}, counters());
      if (verdict.action === "ALLOW") verdict = { action: "ALLOW", rule: "read_only", reason: `"${action.tool}" is marked read-only; gate skipped` };
      this.skippedGates++;
      await this.trace(state, { phase: "gate", decision: verdict.action, rule: verdict.rule, reason: verdict.reason, tool: action.tool, args: action.args, latency_ms: 0, cost: 0 });
      return { signals: {}, verdict, latencyMs: 0, cost: 0 };
    }

    const projected = projectState(state, this.opts.projection);
    const questions = buildQuestions(state, this.opts.questions);
    const started = performance.now();
    let signals: Signals = {};
    let cost = 0;
    let modelError: string | undefined;
    try {
      const result = await this.model.evaluate(projected, questions);
      signals = toSignals(result.answers);
      cost = (result.inputTokens ?? estimateTokens(projected, questions)) * JEV_USD_PER_INPUT_TOKEN;
    } catch (err) {
      modelError = err instanceof Error ? err.message : String(err);
    }
    const latencyMs = Math.round(performance.now() - started);
    this.modelCalls++;
    this.cost += cost;
    this.latencyMs += latencyMs;

    let verdict = this.decideWith(state, signals, counters());
    // Fail closed: with no signals, hard rules still apply but nothing gets auto-allowed.
    if (modelError && action && verdict.action === "ALLOW") {
      verdict = { action: "HUMAN_REVIEW", rule: "model_unavailable", reason: `decision model failed: ${modelError}` };
    }

    await this.trace(state, { phase: action ? "gate" : "check", decision: verdict.action, rule: verdict.rule, reason: verdict.reason, signals, tool: action?.tool, args: action?.args, latency_ms: latencyMs, cost }, true);
    return { signals, verdict, latencyMs, cost, modelError };
  }

  /**
   * Tool middleware for existing agents: every call passes through
   * state -> decision -> policy -> execution -> trace.
   */
  tool(def: ToolDef): (args: Record<string, unknown>, state: AgentState) => Promise<GateResult> {
    return async (args, state) => {
      const gated: AgentState = { ...state, currentAction: { tool: def.name, args } };
      const decision = await this.evaluate(gated);
      switch (decision.verdict.action) {
        case "STOP":
          return { status: "stop", decision };
        case "BLOCK":
          return { status: "blocked", decision };
        case "REPLAN":
        case "RETRY":
          return { status: "replan", decision };
        case "HUMAN_REVIEW":
          if (!(await this.approve(gated, decision))) return { status: "denied", decision };
      }
      const outcome = await this.execute(def, args, state);
      return outcome.ok
        ? { status: "executed", result: outcome.text, decision }
        : { status: "failed", error: outcome.text, decision };
    };
  }

  /** Full controlled loop: planner proposes, Jev signals, policy decides, tools execute. */
  async run(opts: RunOptions): Promise<RunResult> {
    const state = createState(opts.task, opts.tools.map(({ name, description, category }) => ({ name, description, category })), opts.goal);
    const base = { calls: this.modelCalls, cost: this.cost, latency: this.latencyMs, skipped: this.skippedGates };
    this.runStart = { cost: this.cost };
    this.planner = { cost: 0, tokens: 0 };
    let plannerCalls = 0, discarded = 0, quarantined = 0, replans = 0;
    let hint: string | undefined;
    /** A proposal requested speculatively, before the post-result check finished. */
    let speculative: { promise: Promise<Proposal>; abort: AbortController } | undefined;

    const dropSpeculative = () => {
      if (!speculative) return;
      speculative.abort.abort();
      speculative.promise.catch(() => {});
      speculative = undefined;
      discarded++;
    };
    const finish = (status: RunResult["status"], reason: string, output?: string): RunResult => {
      dropSpeculative();
      state.currentAction = undefined;
      if (status === "complete") state.goal.status = "complete";
      return {
        status, reason, output, state,
        stats: {
          steps: state.history.length, plannerCalls, discardedPlannerCalls: discarded,
          plannerCost: this.planner.cost, plannerTokens: this.planner.tokens,
          modelCalls: this.modelCalls - base.calls, skippedGates: this.skippedGates - base.skipped, quarantinedResults: quarantined,
          controlCost: this.cost - base.cost, controlLatencyMs: this.latencyMs - base.latency,
        },
      };
    };
    const stopResult = (v: Verdict) => finish(v.rule === "goal_complete" ? "complete" : "halted", v.reason);
    /** Returns false once the replan budget is spent. */
    const replan = (v: Verdict): boolean => {
      hint = v.hint ?? v.reason;
      state.currentAction = undefined;
      dropSpeculative();
      return ++replans <= this.policy.maxReplans;
    };
    const ask = (h?: string) => {
      const abort = new AbortController();
      plannerCalls++;
      return { abort, promise: opts.planner.propose(structuredClone(state), h, { signal: abort.signal }) };
    };

    while (true) {
      const pending = speculative ?? ask(hint);
      speculative = undefined;
      hint = undefined;
      const proposal = await pending.promise;
      if (proposal.usage) { this.planner.cost += proposal.usage.costUsd ?? 0; this.planner.tokens += proposal.usage.tokens ?? 0; }
      if ("finish" in proposal) return finish("complete", "planner finished", proposal.finish);

      const action: Action = { tool: proposal.tool, args: proposal.args, rationale: proposal.rationale };
      state.currentAction = action;
      const gate = await this.evaluate(state);
      const v = gate.verdict;
      if (v.action === "STOP") return stopResult(v);
      if (v.action === "BLOCK" || v.action === "REPLAN" || v.action === "RETRY") {
        if (!replan(v)) return finish("escalated", `replan budget exhausted; last: ${v.reason}`);
        continue;
      }
      if (v.action === "HUMAN_REVIEW" && !(await this.approve(state, gate))) {
        if (!replan({ ...v, hint: `A human reviewer denied "${action.tool}". Choose a different approach.` })) {
          return finish("escalated", `replan budget exhausted; last: ${v.reason}`);
        }
        continue;
      }

      const def = opts.tools.find((t) => t.name === action.tool)!;
      for (let retries = 0; ; ) {
        const outcome = await this.execute(def, action.args ?? {}, state);
        state.history.push({ step: state.history.length + 1, action, ok: outcome.ok, ...(outcome.ok ? { observation: outcome.text } : { error: outcome.text }) });
        state.currentAction = undefined;

        // The post-result check runs before the planner is trusted again, so a finished or
        // looping agent never acts on another LLM turn. With speculativePlanning the next
        // proposal is requested in parallel and thrown away if the check objects.
        if (this.opts.speculativePlanning && outcome.ok) speculative = ask();
        const check = await this.evaluate(state);

        if (check.verdict.rule === "prompt_injection") {
          // The planner must never act on the raw text. A speculative call already saw it, so replan() discards that call.
          state.history[state.history.length - 1].observation = WITHHELD;
          quarantined++;
        }
        if (check.verdict.action === "STOP") return stopResult(check.verdict);

        if (outcome.ok) {
          if (check.verdict.action === "REPLAN" && !replan(check.verdict)) {
            return finish("escalated", `replan budget exhausted; last: ${check.verdict.reason}`);
          }
          break;
        }

        const recovery = decideRecovery({ retryUseful: check.signals.retryUseful, retries, replans, error: outcome.text }, this.policy);
        await this.trace(state, { phase: "recovery", decision: recovery.action, rule: recovery.rule, reason: recovery.reason, tool: action.tool, latency_ms: 0, cost: 0 });
        if (recovery.action === "RETRY") {
          retries++;
          continue;
        }
        if (recovery.action === "REPLAN" && replan(recovery)) break;
        return finish("escalated", recovery.reason);
      }
    }
  }

  /** Run-level counters the policy's hard limits are checked against. */
  protected counters(state: AgentState): RuntimeCounters {
    return { step: state.history.length, costSoFar: this.cost - this.runStart.cost + this.planner.cost, plannerTokens: this.planner.tokens };
  }

  /** The policy step. A fleet server overrides this to add fleet-wide budgets and per-agent permissions. */
  protected decideWith(state: AgentState, signals: Signals, counters: RuntimeCounters): Verdict {
    return decide(state, signals, this.policy, counters);
  }

  protected async approve(state: AgentState, decision: Decision): Promise<boolean> {
    const action = state.currentAction!;
    const started = performance.now();
    const answer = (await this.opts.onApproval?.({ state, action, verdict: decision.verdict, signals: decision.signals, agentId: this.agentId })) ?? false;
    const { approved, by } = typeof answer === "boolean" ? { approved: answer, by: undefined } : answer;
    await this.trace(state, { phase: "gate", decision: approved ? "APPROVED" : "DENIED", rule: decision.verdict.rule, tool: action.tool, args: action.args, actor: by, latency_ms: Math.round(performance.now() - started), cost: 0 });
    return approved;
  }

  protected async execute(def: ToolDef, args: Record<string, unknown>, state: AgentState): Promise<{ ok: boolean; text: string }> {
    const started = performance.now();
    let outcome: { ok: boolean; text: string };
    try {
      const result = await def.execute(args);
      outcome = { ok: true, text: typeof result === "string" ? result : JSON.stringify(result) };
    } catch (err) {
      outcome = { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
    await this.trace(state, { step: state.history.length + 1, phase: "tool", decision: outcome.ok ? "EXECUTED" : "FAILED", reason: outcome.ok ? undefined : outcome.text, tool: def.name, args, latency_ms: Math.round(performance.now() - started), cost: 0 });
    return outcome;
  }

  protected async trace(state: AgentState, event: Omit<TraceEvent, "timestamp" | "agent_id" | "model" | "step"> & { step?: number }, snapshot = false): Promise<void> {
    await this.opts.sink?.write({
      timestamp: new Date().toISOString(), agent_id: this.agentId, model: this.model.name, step: state.history.length,
      ...event,
      ...(snapshot && this.opts.traceSnapshots ? { snapshot: snapshotState(state, this.opts.projection) } : {}),
    });
  }
}
