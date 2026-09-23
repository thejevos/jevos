import { ControlPlane, createApproval, Fleet, getApproval, listApprovals, resolveApproval, type AgentState, type DecisionModel, type FleetPolicy, type RuntimeCounters, type Signals, type TraceEvent, type TraceSink, type Verdict } from "@jevos/core";
import { Hono } from "hono";

/** One ControlPlane per agent whose policy step defers to the fleet. */
class FleetAgentPlane extends ControlPlane {
  constructor(private readonly fleet: Fleet, agentId: string, model: DecisionModel, sink: TraceSink, tools: string[]) {
    super({ model, agentId, sink, policy: fleet.policyFor(agentId, tools) ?? {}, traceSnapshots: true });
  }
  external?: RuntimeCounters;
  protected override counters(): RuntimeCounters {
    return this.external ?? { step: 0, costSoFar: 0 };
  }
  protected override decideWith(state: AgentState, signals: Signals, counters: RuntimeCounters): Verdict {
    return this.fleet.decide(this.agentId, state, signals, counters);
  }
}

export interface FleetAppOptions {
  policy: FleetPolicy;
  model: DecisionModel;
  sink: TraceSink;
  approvalsDir: string;
  /** Shared secret; every request must carry `Authorization: Bearer <token>`. Strongly recommended. */
  token?: string;
}

export function createFleetApp(opts: FleetAppOptions): Hono {
  const app = new Hono();
  const fleet = new Fleet(opts.policy);
  const planes = new Map<string, FleetAgentPlane>();
  const plane = (agentId: string, tools: string[]) => {
    let p = planes.get(agentId);
    if (!p) { p = new FleetAgentPlane(fleet, agentId, opts.model, opts.sink, tools); planes.set(agentId, p); }
    return p;
  };

  app.use("/v1/fleet/*", async (c, next) => {
    if (opts.token && c.req.header("authorization") !== `Bearer ${opts.token}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/v1/fleet/status", async (c) => c.json(fleet.status((await listApprovals(opts.approvalsDir, "pending")).length)));

  app.post("/v1/fleet/runs/start", async (c) => {
    const { agent_id, tools = [] } = await c.req.json<{ agent_id: string; tools?: string[] }>();
    if (!agent_id) return c.json({ error: "agent_id required" }, 400);
    const verdict = fleet.startRun(agent_id);
    if (verdict) return c.json({ ok: false, verdict });
    planes.delete(agent_id); // fresh plane per run so declared tools are current
    plane(agent_id, tools);
    return c.json({ ok: true });
  });

  app.post("/v1/fleet/runs/end", async (c) => {
    const { agent_id, plannerCostUsd = 0 } = await c.req.json<{ agent_id: string; plannerCostUsd?: number }>();
    fleet.endRun(agent_id);
    fleet.record(agent_id, Number(plannerCostUsd) || 0);
    return c.json({ ok: true });
  });

  app.post("/v1/fleet/decide", async (c) => {
    const { agent_id, state, counters } = await c.req.json<{ agent_id: string; state: AgentState; counters?: RuntimeCounters }>();
    if (!agent_id || !state?.task) return c.json({ error: "agent_id and state.task required" }, 400);
    const fleetVerdict = fleet.fleetVerdict(agent_id);
    if (fleetVerdict?.rule === "unknown_agent") return c.json({ signals: {}, verdict: fleetVerdict, latencyMs: 0, cost: 0, model: opts.model.name }, 403);
    const p = plane(agent_id, state.tools.map((t) => t.name));
    p.external = counters;
    const decision = await p.evaluate(state);
    fleet.record(agent_id, decision.cost);
    return c.json({ ...decision, model: opts.model.name });
  });

  app.post("/v1/fleet/approvals", async (c) => {
    const body = await c.req.json<{ agent_id: string; task: string; action: { tool: string; args?: Record<string, unknown> }; rule: string; reason: string; signals: Signals }>();
    if (!body.agent_id || !body.action?.tool) return c.json({ error: "agent_id and action required" }, 400);
    return c.json(await createApproval(opts.approvalsDir, { agent_id: body.agent_id, task: body.task, action: body.action, rule: body.rule, reason: body.reason, signals: body.signals ?? {} }));
  });
  app.get("/v1/fleet/approvals", async (c) => c.json(await listApprovals(opts.approvalsDir, c.req.query("all") ? undefined : "pending")));
  app.get("/v1/fleet/approvals/:id", async (c) => {
    const r = await getApproval(opts.approvalsDir, c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });
  for (const outcome of ["approve", "deny"] as const) {
    app.post(`/v1/fleet/approvals/:id/${outcome}`, async (c) => {
      const { by = "operator", note } = await c.req.json<{ by?: string; note?: string }>().catch(() => ({}) as { by?: string; note?: string });
      try {
        return c.json(await resolveApproval(opts.approvalsDir, c.req.param("id"), outcome === "approve", by, note));
      } catch (err) {
        return c.json({ error: (err as Error).message }, 409);
      }
    });
  }

  app.post("/v1/fleet/traces", async (c) => {
    const event = await c.req.json<TraceEvent>();
    if (!event?.agent_id || !event.timestamp) return c.json({ error: "trace event required" }, 400);
    await opts.sink.write(event);
    return c.json({ ok: true });
  });

  app.post("/v1/fleet/handoff", async (c) => {
    const { from, to } = await c.req.json<{ from: string; to: string; task?: string }>();
    if (!from || !to) return c.json({ error: "from and to required" }, 400);
    return c.json(fleet.handoff(from, to));
  });

  return app;
}
