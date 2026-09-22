import { JevModel, JsonlSink, MockModel } from "@jevos/core";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const model = process.env.TYPESAFE_API_KEY ? new JevModel({ model: process.env.JEV_MODEL }) : new MockModel();
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: createApp({ model, sink: new JsonlSink("traces/decisions.jsonl") }).fetch, port }, () => {
  console.log(`agent-control server on http://localhost:${port} (model: ${model.name})`);
});
