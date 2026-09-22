import type { Answer, DecisionModel, ModelResult, Question } from "./model.js";
import { QUESTION_IDS } from "./signals.js";
import type { ProjectedState } from "./state.js";

/**
 * Return a number for noul (probability) / score (0..1), a string for choice,
 * or undefined to fall through to the built-in heuristics.
 */
export type MockResponder = (id: string, state: ProjectedState, question: Question) => number | string | undefined;

const RISKY = /delete|drop|destroy|transfer|purchase|pay|refund|send|email|deploy|rm\b/i;

/**
 * Offline stand-in for Jev. Deterministic keyword/stat heuristics, overridable
 * per question with a responder. It is a test double, not a classifier: real
 * thresholds must be calibrated against real Jev output.
 */
export class MockModel implements DecisionModel {
  readonly name = "mock";
  calls = 0;

  constructor(private readonly responder?: MockResponder) {}

  async evaluate(state: unknown, questions: Record<string, Question>): Promise<ModelResult> {
    this.calls++;
    const s = state as ProjectedState;
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      const v = this.responder?.(id, s, q) ?? heuristic(id, s, q);
      answers[id] = toAnswer(q, v);
    }
    return { answers };
  }
}

function heuristic(id: string, s: ProjectedState, q: Question): number | string {
  const proposed = s?.proposed_action;
  switch (id) {
    case QUESTION_IDS.goalComplete:
      return 0.05;
    case QUESTION_IDS.stuck:
      return (s?.stats?.repeated_action_streak ?? 0) >= 3 ? 0.92 : 0.05;
    case QUESTION_IDS.progress:
      return (s?.stats?.consecutive_failures ?? 0) > 0 ? 0.2 : 0.7;
    case QUESTION_IDS.actionRelevant:
      return 0.95;
    case QUESTION_IDS.actionRisky:
    case QUESTION_IDS.needsHuman:
      return proposed && RISKY.test(`${proposed.tool} ${JSON.stringify(proposed.args ?? {})}`) ? 0.85 : 0.05;
    case QUESTION_IDS.retryUseful: {
      const last = s?.recent_actions?.[s.recent_actions.length - 1];
      return /timeout|timed out|rate limit|429|50\d|temporar|ECONN/i.test(last?.result ?? "") ? 0.9 : 0.2;
    }
    case QUESTION_IDS.nextTool:
      if (q.type === "choice" && proposed && proposed.tool in q.criteria) return proposed.tool;
  }
  if (q.type === "choice") return Object.keys(q.criteria)[0];
  return q.type === "score" ? 0.5 : 0.05;
}

function toAnswer(q: Question, v: number | string): Answer {
  if (q.type === "noul") return { type: "noul", noul: Number(v) };
  if (q.type === "score") return { type: "score", score: Number(v), confidence: 0.8 };
  const options = Object.keys(q.criteria);
  const choice = String(v);
  const rest = options.length > 1 ? 0.1 / (options.length - 1) : 0;
  const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? 0.9 : rest]));
  return { type: "choice", choice, probabilities, confidence: 0.9 };
}
