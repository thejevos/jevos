import { MockModel } from "@jevos/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const app = createApp({ model: new MockModel() });
const post = (body: unknown) => app.request("/v1/decisions", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("POST /v1/decisions", () => {
  it("answers raw questions in the README wire shape", async () => {
    const res = await post({
      agent_id: "agent_123",
      state: { task: "Research competitors", history: [], current_action: "search" },
      questions: [
        { type: "noul", id: "goal_complete", question: "Is the task complete?" },
        { type: "choice", id: "tool", options: ["search", "browser", "database"] },
      ],
    });
    expect(res.status).toBe(200);
    const { decisions } = await res.json();
    expect(decisions.goal_complete).toEqual({ value: false, probability: 0.95 });
    expect(decisions.tool.value).toBe("search");
  });

  it("returns signals and a policy verdict for a full agent state", async () => {
    const res = await post({
      state: { task: "clean up", tools: [{ name: "delete_database", description: "drop" }], currentAction: { tool: "delete_database" } },
      policy: { blockedTools: ["delete_database"] },
    });
    const json = await res.json();
    expect(json.verdict).toMatchObject({ action: "BLOCK", rule: "blocked_tool" });
    expect(json.signals.actionRisky).toBeGreaterThan(0.8);
  });

  it("rejects malformed requests", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ state: {}, questions: [{ id: "x", type: "essay" }] })).status).toBe(400);
  });
});
