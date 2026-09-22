import { ControlPlane, type AgentState, type DecisionModel, type Policy, type Question, type TraceSink } from "@jevos/core";
import { Hono } from "hono";

interface WireQuestion {
  id: string;
  type: "noul" | "choice" | "score";
  question?: string;
  /** choice: option names, or option -> description */
  options?: string[] | Record<string, string>;
  /** score: ordered level descriptions */
  levels?: string[];
}

interface DecisionsRequest {
  agent_id?: string;
  state: unknown;
  /** Raw mode: ask exactly these questions. Omit to get the standard signals + policy verdict. */
  questions?: WireQuestion[];
  policy?: Partial<Policy>;
}

function toQuestion(q: WireQuestion): Question {
  const instructions = q.question ?? q.id;
  if (q.type === "noul") return { type: "noul", instructions };
  if (q.type === "score") return { type: "score", instructions, criteria: q.levels ?? [] };
  const criteria = Array.isArray(q.options) ? Object.fromEntries(q.options.map((o) => [o, o])) : (q.options ?? {});
  return { type: "choice", instructions, criteria };
}

export function createApp(opts: { model: DecisionModel; sink?: TraceSink }): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ service: "JevOS decision API", model: opts.model.name, usage: "POST /v1/decisions", docs: "https://github.com/thejevos/jevos" }));
  app.get("/healthz", (c) => c.json({ ok: true, model: opts.model.name }));

  app.post("/v1/decisions", async (c) => {
    let body: DecisionsRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (body?.state === undefined) return c.json({ error: "`state` is required" }, 400);

    if (body.questions) {
      const bad = body.questions.find((q) => !q.id || !["noul", "choice", "score"].includes(q.type));
      if (bad) return c.json({ error: "each question needs an `id` and a `type` of noul | choice | score" }, 400);
      const questions = Object.fromEntries(body.questions.map((q) => [q.id, toQuestion(q)]));
      const { answers } = await opts.model.evaluate(body.state, questions);
      const decisions = Object.fromEntries(
        Object.entries(answers).map(([id, a]) => [
          id,
          a.type === "noul"
            ? { value: a.noul >= 0.5, probability: a.noul >= 0.5 ? a.noul : 1 - a.noul }
            : a.type === "choice"
              ? { value: a.choice, probabilities: a.probabilities }
              : { value: a.score, confidence: a.confidence },
        ]),
      );
      return c.json({ decisions });
    }

    const s = body.state as Partial<AgentState>;
    if (typeof s.task !== "string") return c.json({ error: "`state.task` is required when `questions` is omitted" }, 400);
    const state: AgentState = {
      task: s.task,
      goal: s.goal ?? { description: s.task, status: "active" },
      history: s.history ?? [],
      currentAction: s.currentAction,
      tools: s.tools ?? [],
      context: s.context ?? [],
    };
    const control = new ControlPlane({ model: opts.model, policy: body.policy, agentId: body.agent_id, sink: opts.sink });
    const decision = await control.evaluate(state);
    return c.json({ verdict: decision.verdict, signals: decision.signals, latency_ms: decision.latencyMs, cost: decision.cost });
  });

  return app;
}
