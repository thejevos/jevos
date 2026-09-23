import { JevModel, JsonlSink, MockModel, type FleetPolicy } from "@jevos/core";
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { createApp } from "./app.js";
import { createFleetApp } from "./fleet.js";

export interface ServeOptions {
  port?: number;
  /** Path to a fleet policy JSON. With it, the server is a fleet control plane; without it, a plain decision API. */
  fleet?: string;
  token?: string;
  traces?: string;
  approvalsDir?: string;
}

export function startServer(opts: ServeOptions = {}) {
  const model = process.env.TYPESAFE_API_KEY ? new JevModel({ model: process.env.JEV_MODEL }) : new MockModel();
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const sink = new JsonlSink(opts.traces ?? "traces/decisions.jsonl", { chain: true });
  let app;
  if (opts.fleet) {
    if (!existsSync(opts.fleet)) throw new Error(`fleet policy not found: ${opts.fleet}`);
    const policy = JSON.parse(readFileSync(opts.fleet, "utf8")) as FleetPolicy;
    const token = opts.token ?? process.env.FLEET_TOKEN;
    if (!token) console.warn("warning: no FLEET_TOKEN set — anyone who can reach this port can approve actions and read traces");
    app = createFleetApp({ policy, model, sink, approvalsDir: opts.approvalsDir ?? ".acp/approvals", token });
    // the plain decision API stays available on the same server
    app.route("/", createApp({ model, sink }));
  } else {
    app = createApp({ model, sink });
  }
  return serve({ fetch: app.fetch, port }, () => {
    console.log(`JevOS ${opts.fleet ? "fleet control plane" : "decision API"} on http://localhost:${port} (model: ${model.name})`);
  });
}

if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1])) startServer({ fleet: process.env.FLEET_POLICY });
