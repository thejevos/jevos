import type { Action, AgentState } from "./types.js";

export interface ProjectionOptions {
  /** How many most-recent history entries Jev sees. Default 6. */
  historyWindow?: number;
  /** Per-observation character cap. Default 1200. */
  maxObservationChars?: number;
}

/**
 * The trimmed view of agent state that is actually sent to Jev.
 *
 * Jev's accuracy drops when the state carries irrelevant content, and it
 * cannot count, so the projection keeps only what the control questions need
 * and precomputes every number in code.
 */
export interface ProjectedState {
  task: string;
  goal: string;
  proposed_action?: { tool: string; args?: Record<string, unknown>; rationale?: string };
  recent_actions: Array<{
    step: number;
    tool: string;
    args?: Record<string, unknown>;
    outcome: "succeeded" | "failed";
    result?: string;
  }>;
  stats: {
    steps_taken: number;
    repeated_action_streak: number;
    consecutive_failures: number;
  };
  pinned_context: string[];
}

function actionKey(a: Action): string {
  return `${a.tool}:${JSON.stringify(a.args ?? {})}`;
}

/** Length of the run of identical actions at the tail of history, including the proposed action. */
export function repeatedActionStreak(state: AgentState): number {
  const actions = state.history.map((h) => h.action);
  if (state.currentAction) actions.push(state.currentAction);
  if (actions.length === 0) return 0;
  const last = actionKey(actions[actions.length - 1]);
  let streak = 0;
  for (let i = actions.length - 1; i >= 0 && actionKey(actions[i]) === last; i--) streak++;
  return streak;
}

export function consecutiveFailures(state: AgentState): number {
  let n = 0;
  for (let i = state.history.length - 1; i >= 0 && !state.history[i].ok; i--) n++;
  return n;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

export function projectState(state: AgentState, opts: ProjectionOptions = {}): ProjectedState {
  const window = opts.historyWindow ?? 6;
  const maxChars = opts.maxObservationChars ?? 1200;
  return {
    task: state.task,
    goal: state.goal.description,
    proposed_action: state.currentAction && {
      tool: state.currentAction.tool,
      args: state.currentAction.args,
      rationale: state.currentAction.rationale,
    },
    recent_actions: state.history.slice(-window).map((h) => ({
      step: h.step,
      tool: h.action.tool,
      args: h.action.args,
      outcome: h.ok ? "succeeded" : "failed",
      result: clip(h.ok ? h.observation : h.error, maxChars),
    })),
    stats: {
      steps_taken: state.history.length,
      repeated_action_streak: repeatedActionStreak(state),
      consecutive_failures: consecutiveFailures(state),
    },
    pinned_context: state.context.filter((c) => c.pinned).map((c) => c.content),
  };
}

/**
 * Windowed, clipped copy of a state: small enough to store with every trace
 * line, complete enough to re-ask the same questions later (`acp label` / `acp eval`).
 */
export function snapshotState(state: AgentState, opts: ProjectionOptions = {}): AgentState {
  const window = opts.historyWindow ?? 6;
  const maxChars = opts.maxObservationChars ?? 1200;
  return {
    task: state.task,
    goal: { ...state.goal },
    history: state.history.slice(-window).map((h) => ({ ...h, observation: clip(h.observation, maxChars), error: clip(h.error, maxChars) })),
    currentAction: state.currentAction,
    tools: state.tools,
    context: state.context.filter((c) => c.pinned),
  };
}
