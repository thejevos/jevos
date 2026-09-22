import type { Answer, DecisionModel, ModelResult, Question } from "./model.js";

export interface JevOptions {
  apiKey?: string;
  /** Pin a version (e.g. "jev-1.13.0") so tuned thresholds stay valid. */
  model?: string;
  baseUrl?: string;
  maxRetries?: number;
  /** Per-request ceiling. A slow decision is treated as a failed one, and the control plane fails closed. Default 8000. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Raw HTTP client for Jev's System One endpoint.
 *
 * Verified against the live API with jev-1.13.0 (all three answer types).
 * All wire-format knowledge lives in this file (`toWire` / `fromWire`).
 */
export class JevModel implements DecisionModel {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JevOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error("JevModel: set TYPESAFE_API_KEY or pass apiKey");
    this.apiKey = apiKey;
    this.name = opts.model ?? "jev-latest";
    this.baseUrl = opts.baseUrl ?? "https://api.typesafe.ai";
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async evaluate(state: unknown, questions: Record<string, Question>): Promise<ModelResult> {
    const body = JSON.stringify({ model: this.name, state, questions: toWire(questions) });
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      }).catch((err: Error) => {
        throw new Error(err.name === "TimeoutError" ? `Jev did not answer within ${this.timeoutMs}ms` : `Jev request failed: ${err.message}`);
      });
      if (res.ok) return fromWire(await res.json(), questions);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        throw new Error(`Jev request failed: ${res.status} ${await res.text()}`);
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
}

function toWire(questions: Record<string, Question>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [
      id,
      q.type === "noul"
        ? { type: "noul", instructions: q.instructions }
        : { type: q.type, instructions: q.instructions, criteria: q.criteria },
    ]),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromWire(json: any, questions: Record<string, Question>): ModelResult {
  const raw = json.answers ?? json.results ?? json;
  const answers: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = raw[id];
    if (!a) throw new Error(`Jev response missing answer for "${id}"`);
    if (q.type === "noul") {
      answers[id] = { type: "noul", noul: Number(a.noul) };
    } else if (q.type === "choice") {
      answers[id] = {
        type: "choice",
        choice: String(a.choice),
        probabilities: a.probabilities ?? {},
        confidence: Number(a.confidence ?? a.probabilities?.[a.choice] ?? 0),
      };
    } else {
      answers[id] = {
        type: "score",
        score: normalizeScore(a.probabilities, q.criteria.length),
        confidence: Number(a.confidence ?? 0),
      };
    }
  }
  return { answers, inputTokens: json.usage?.input_tokens };
}

/** Expected level index / (levels - 1): avoids depending on whether raw scores are 0- or 1-based. */
function normalizeScore(probabilities: unknown, levels: number): number {
  const p = Array.isArray(probabilities) ? probabilities.map(Number) : Object.values(probabilities ?? {}).map(Number);
  if (p.length !== levels || levels < 2) return 0;
  const expected = p.reduce((sum, pi, i) => sum + pi * i, 0);
  return expected / (levels - 1);
}
