/** Question and answer shapes mirror Jev's three typed decision primitives. */

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option -> description of when that option applies */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** 2-10 ordered level descriptions, lowest first */
  criteria: string[];
}

export interface NoulQuestion {
  type: "noul";
  /** A statement that is either true or false of the state. Phrase it positively. */
  instructions: string;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /**
   * Jev's decisiveness for this pick, not P(choice): a 52/48 split comes back with
   * confidence ~0.04. Use it to decide whether the pick is trustworthy at all.
   */
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Normalized to 0..1 (0 = lowest level, 1 = highest) regardless of level count. */
  score: number;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability that the statement is true. */
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface ModelResult {
  answers: Record<string, Answer>;
  /** Billed input tokens if the backend reports them. */
  inputTokens?: number;
}

/** Anything that can answer typed questions about a state: Jev, a mock, or a fallback. */
export interface DecisionModel {
  readonly name: string;
  evaluate(state: unknown, questions: Record<string, Question>): Promise<ModelResult>;
}

/** Jev pricing: $0.042 per million input tokens, output free. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** Rough token estimate (~4 chars/token) for when the backend does not report usage. */
export function estimateTokens(state: unknown, questions: Record<string, Question>): number {
  return Math.ceil((JSON.stringify(state).length + JSON.stringify(questions).length) / 4);
}
