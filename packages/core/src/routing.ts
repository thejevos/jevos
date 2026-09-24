import type { Planner, Proposal } from "./control.js";
import type { DecisionModel } from "./model.js";
import { projectState, type ProjectionOptions } from "./state.js";
import type { AgentState } from "./types.js";

/** One model tier, cheapest first. `criteria` is what Jev reads to decide whether this tier is enough. */
export interface RouteTier {
  name: string;
  planner: Planner;
  criteria: string;
}

export interface RoutingPlannerOptions {
  model: DecisionModel;
  /** Ordered cheapest → most capable. The last tier is the fallback when Jev is unsure or unavailable. */
  tiers: RouteTier[];
  /** Route to a tier only if Jev is at least this decisive about it (see ChoiceAnswer.confidence); otherwise use the most capable tier. Default 0.6. */
  minConfidence?: number;
  projection?: ProjectionOptions;
  /** Override the question text (re-run `npm run eval` after changing it). */
  instructions?: string;
}

export interface RouteDecision {
  tier: string;
  confidence: number;
  probabilities: Record<string, number>;
  /** Set when Jev could not be asked and the fallback tier was used. */
  fallback?: string;
  latencyMs: number;
}

/**
 * Wording chosen by A/B on live jev-1.13.0 (`npm run eval:variants`). Tier criteria
 * from DEFAULT_TIER_CRITERIA are concrete and enumerated; Jev handles those far
 * better than "is this hard?".
 */
export const ROUTE_INSTRUCTIONS = "Which class of model is enough to choose the agent's next step well, given the task and the results so far.";

export const DEFAULT_TIER_CRITERIA = {
  fast: "The next step is routine: run a search or lookup with an obvious query, retry or repeat a step already taken, read one result, send a message whose content is already known, or report that the task is done.",
  powerful: "The next step needs real reasoning: combining several results into a conclusion, deciding what to do about an ambiguous or conflicting situation, designing or fixing code, judging an amount or an exception against a policy, or recovering after a plan went wrong.",
};

/**
 * Sends each planning step to the cheapest model that can handle it.
 *
 * Jev scores the projected state against the tier criteria in one call; the
 * chosen tier's planner proposes the step. Works with any planners (two
 * ClaudePlanner instances on different models is the common case) and any
 * control plane, since it is itself just a Planner.
 */
export class RoutingPlanner implements Planner {
  readonly stats: Record<string, number> = {};
  private readonly tiers: RouteTier[];
  private readonly fallback: RouteTier;

  constructor(private readonly opts: RoutingPlannerOptions) {
    if (opts.tiers.length < 2) throw new Error("RoutingPlanner needs at least two tiers");
    this.tiers = opts.tiers;
    this.fallback = opts.tiers[opts.tiers.length - 1];
    for (const t of opts.tiers) this.stats[t.name] = 0;
  }

  async route(state: AgentState): Promise<RouteDecision> {
    const started = performance.now();
    const criteria = Object.fromEntries(this.tiers.map((t) => [t.name, t.criteria]));
    try {
      const { answers } = await this.opts.model.evaluate(projectState(state, this.opts.projection), {
        route: { type: "choice", instructions: this.opts.instructions ?? ROUTE_INSTRUCTIONS, criteria },
      });
      const a = answers.route;
      if (a?.type !== "choice") throw new Error("no route answer");
      const min = this.opts.minConfidence ?? 0.6;
      const tier = a.confidence >= min && this.tiers.some((t) => t.name === a.choice) ? a.choice : this.fallback.name;
      return { tier, confidence: a.confidence, probabilities: a.probabilities, fallback: tier === a.choice ? undefined : `confidence ${a.confidence.toFixed(2)} < ${min}`, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      // Never let a routing failure stall the agent: use the most capable tier.
      return { tier: this.fallback.name, confidence: 0, probabilities: {}, fallback: err instanceof Error ? err.message : String(err), latencyMs: Math.round(performance.now() - started) };
    }
  }

  async propose(state: AgentState, hint?: string, opts?: { signal?: AbortSignal }): Promise<Proposal> {
    const decision = await this.route(state);
    const tier = this.tiers.find((t) => t.name === decision.tier) ?? this.fallback;
    this.stats[tier.name]++;
    const proposal = await tier.planner.propose(state, hint, opts);
    return { ...proposal, route: decision };
  }
}
