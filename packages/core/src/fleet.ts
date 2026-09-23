import { decide, resolvePolicy, type Policy, type Thresholds, type Verdict } from "./policy.js";
import type { Signals } from "./signals.js";
import type { AgentState } from "./types.js";

/**
 * Fleet policy: one policy over many agents.
 *
 * The base policy applies to every agent. Each agent entry narrows it: which
 * tools it may use, which of those always need a person, how much it may
 * spend, and which other agents it may hand work to. Fleet-wide limits sit
 * above all of that. As everywhere in JevOS, these are deterministic rules
 * checked before any model signal.
 */
export interface FleetAgentPolicy {
  /** Tools this agent may call. "*" means any tool it declares. */
  tools?: string[] | "*";
  /** Tools that always need a person for this agent, on top of the base policy's list. */
  approvalRequired?: string[];
  /** USD this agent may spend (control + planner) per fleet day. */
  maxCostUsd?: number;
  /** Runs this agent may have in flight at once. */
  maxConcurrentRuns?: number;
  /** Agents this one may hand a task to. Absent = no handoffs. */
  handoffTo?: string[];
  thresholds?: Partial<Thresholds>;
}

export interface FleetPolicy {
  /** Base policy every agent inherits. */
  policy: Partial<Omit<Policy, "thresholds">> & { thresholds?: Partial<Thresholds> };
  budget?: {
    /** USD the whole fleet may spend per day (UTC). */
    dailyCostUsd?: number;
    /** Runs in flight across the fleet. */
    maxConcurrentRuns?: number;
  };
  agents: Record<string, FleetAgentPolicy>;
  /** Let agents not listed under `agents` connect with the base policy only. Default false. */
  allowUnknownAgents?: boolean;
}

export const EXAMPLE_FLEET_POLICY: FleetPolicy = {
  policy: { maxSteps: 30, maxRetries: 3, blockedTools: ["delete_database"], readOnlyTools: ["web_search", "lookup_order"] },
  budget: { dailyCostUsd: 25, maxConcurrentRuns: 10 },
  agents: {
    research: { tools: ["web_search", "send_email"], maxCostUsd: 5, handoffTo: ["support"] },
    support: { tools: ["lookup_order", "refund", "send_email"], approvalRequired: ["refund"], maxCostUsd: 10, maxConcurrentRuns: 3 },
    payments: { tools: ["transfer_money"], approvalRequired: ["transfer_money"], maxCostUsd: 2, maxConcurrentRuns: 1 },
  },
  allowUnknownAgents: false,
};

export interface AgentUsage {
  costUsd: number;
  decisions: number;
  activeRuns: number;
  lastSeen: string;
}

export interface FleetStatus {
  day: string;
  fleet: { costUsd: number; dailyCostUsd?: number; activeRuns: number; maxConcurrentRuns?: number; pendingApprovals: number };
  agents: Record<string, AgentUsage & { maxCostUsd?: number; maxConcurrentRuns?: number; registered: boolean }>;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * In-memory fleet accounting. The server owns one of these; every decision
 * goes through it so budgets and concurrency are enforced fleet-wide.
 */
export class Fleet {
  readonly policy: FleetPolicy;
  private day = today();
  private usage = new Map<string, AgentUsage>();

  constructor(policy: FleetPolicy) {
    this.policy = policy;
  }

  private rollover(): void {
    if (this.day !== today()) { this.day = today(); this.usage.clear(); }
  }

  private use(agentId: string): AgentUsage {
    this.rollover();
    let u = this.usage.get(agentId);
    if (!u) { u = { costUsd: 0, decisions: 0, activeRuns: 0, lastSeen: new Date().toISOString() }; this.usage.set(agentId, u); }
    u.lastSeen = new Date().toISOString();
    return u;
  }

  agentPolicy(agentId: string): FleetAgentPolicy | undefined {
    const p = this.policy.agents[agentId];
    if (p) return p;
    return this.policy.allowUnknownAgents ? {} : undefined;
  }

  /** The effective Policy for one agent: base policy narrowed by the agent entry. */
  policyFor(agentId: string, declaredTools: string[]): Policy | undefined {
    const ap = this.agentPolicy(agentId);
    if (!ap) return undefined;
    const base = resolvePolicy(this.policy.policy);
    const allowed = ap.tools === undefined || ap.tools === "*" ? undefined : ap.tools;
    return {
      ...base,
      allowedTools: allowed ? allowed.filter((t) => declaredTools.includes(t)) : base.allowedTools,
      approvalRequired: [...new Set([...base.approvalRequired, ...(ap.approvalRequired ?? [])])],
      thresholds: { ...base.thresholds, ...ap.thresholds },
    };
  }

  /** Fleet-level checks that run before the per-agent policy. Returns a verdict only when something objects. */
  fleetVerdict(agentId: string): Verdict | undefined {
    const ap = this.agentPolicy(agentId);
    if (!ap) return { action: "BLOCK", rule: "unknown_agent", reason: `agent "${agentId}" is not in the fleet policy` };
    const u = this.use(agentId);
    const fleetCost = this.fleetCost();
    if (this.policy.budget?.dailyCostUsd !== undefined && fleetCost >= this.policy.budget.dailyCostUsd) {
      return { action: "STOP", rule: "fleet_budget", reason: `fleet daily budget $${this.policy.budget.dailyCostUsd} reached ($${fleetCost.toFixed(4)} spent)` };
    }
    if (ap.maxCostUsd !== undefined && u.costUsd >= ap.maxCostUsd) {
      return { action: "STOP", rule: "agent_budget", reason: `agent daily budget $${ap.maxCostUsd} reached ($${u.costUsd.toFixed(4)} spent)` };
    }
    return undefined;
  }

  /** Full decision for one agent state: fleet checks, then the agent's effective policy. */
  decide(agentId: string, state: AgentState, signals: Signals, counters: { step: number; costSoFar: number; plannerTokens?: number }): Verdict {
    const fleet = this.fleetVerdict(agentId);
    if (fleet) return fleet;
    const policy = this.policyFor(agentId, state.tools.map((t) => t.name))!;
    const u = this.use(agentId);
    u.decisions++;
    return decide(state, signals, policy, counters);
  }

  record(agentId: string, costUsd: number): void {
    this.use(agentId).costUsd += costUsd;
  }

  startRun(agentId: string): Verdict | undefined {
    const ap = this.agentPolicy(agentId);
    if (!ap) return { action: "BLOCK", rule: "unknown_agent", reason: `agent "${agentId}" is not in the fleet policy` };
    const u = this.use(agentId);
    const active = [...this.usage.values()].reduce((n, x) => n + x.activeRuns, 0);
    if (this.policy.budget?.maxConcurrentRuns !== undefined && active >= this.policy.budget.maxConcurrentRuns) {
      return { action: "STOP", rule: "fleet_concurrency", reason: `fleet already has ${active} runs in flight (max ${this.policy.budget.maxConcurrentRuns})` };
    }
    if (ap.maxConcurrentRuns !== undefined && u.activeRuns >= ap.maxConcurrentRuns) {
      return { action: "STOP", rule: "agent_concurrency", reason: `agent already has ${u.activeRuns} runs in flight (max ${ap.maxConcurrentRuns})` };
    }
    u.activeRuns++;
    return undefined;
  }

  endRun(agentId: string): void {
    const u = this.use(agentId);
    u.activeRuns = Math.max(0, u.activeRuns - 1);
  }

  /** May `from` hand a task to `to`? */
  handoff(from: string, to: string): Verdict {
    const fp = this.agentPolicy(from);
    if (!fp) return { action: "BLOCK", rule: "unknown_agent", reason: `agent "${from}" is not in the fleet policy` };
    if (!this.agentPolicy(to)) return { action: "BLOCK", rule: "unknown_agent", reason: `agent "${to}" is not in the fleet policy` };
    if (!fp.handoffTo?.includes(to)) return { action: "BLOCK", rule: "handoff_not_allowed", reason: `"${from}" may not hand work to "${to}"` };
    return { action: "ALLOW", rule: "handoff_allowed", reason: `"${from}" → "${to}" permitted by fleet policy` };
  }

  fleetCost(): number {
    this.rollover();
    return [...this.usage.values()].reduce((n, u) => n + u.costUsd, 0);
  }

  status(pendingApprovals: number): FleetStatus {
    this.rollover();
    const agents: FleetStatus["agents"] = {};
    for (const [id, ap] of Object.entries(this.policy.agents)) {
      const u = this.usage.get(id);
      agents[id] = { costUsd: u?.costUsd ?? 0, decisions: u?.decisions ?? 0, activeRuns: u?.activeRuns ?? 0, lastSeen: u?.lastSeen ?? "", maxCostUsd: ap.maxCostUsd, maxConcurrentRuns: ap.maxConcurrentRuns, registered: Boolean(u) };
    }
    for (const [id, u] of this.usage) if (!agents[id]) agents[id] = { ...u, registered: true };
    return {
      day: this.day,
      fleet: { costUsd: this.fleetCost(), dailyCostUsd: this.policy.budget?.dailyCostUsd, activeRuns: [...this.usage.values()].reduce((n, u) => n + u.activeRuns, 0), maxConcurrentRuns: this.policy.budget?.maxConcurrentRuns, pendingApprovals },
      agents,
    };
  }
}
