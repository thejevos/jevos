import { createState, type ToolDef } from "@jevos/core";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudePlanner } from "../src/index.js";

const tools: ToolDef[] = [{ name: "web_search", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, execute: () => "" }];
const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function fake(response: Record<string, unknown>) {
  const create = vi.fn(async () => ({ stop_reason: "tool_use", usage, ...response }));
  return { create, client: { messages: { create } } as unknown as Anthropic };
}

describe("ClaudePlanner", () => {
  it("turns a tool_use block into a proposal and reports spend", async () => {
    const { client, create } = fake({ content: [{ type: "text", text: "Start with Acme." }, { type: "tool_use", id: "t1", name: "web_search", input: { query: "Acme pricing" } }] });
    const state = createState("Research Acme", tools);
    state.history.push({ step: 1, action: { tool: "web_search", args: { query: "x" } }, ok: false, error: "timed out" });
    const p = await new ClaudePlanner({ tools, client }).propose(state, "Try a different query.");

    expect(p).toMatchObject({ tool: "web_search", args: { query: "Acme pricing" }, rationale: "Start with Acme." });
    expect(p.usage).toEqual({ tokens: 1200, costUsd: (1000 * 5 + 200 * 25) / 1_000_000 });

    const request = (create.mock.calls[0] as unknown[])[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(request.model).toBe("claude-opus-5");
    expect(request.tools!.map((t) => (t as Anthropic.Tool).name)).toEqual(["web_search", "finish"]);
    const prompt = request.messages[0].content as string;
    expect(prompt).toContain("FAILED: timed out");
    expect(prompt).toContain("<control_plane_note>\nTry a different query.");
  });

  it("maps the finish tool, plain text and refusals to a finish", async () => {
    const done = fake({ content: [{ type: "tool_use", id: "t", name: "finish", input: { summary: "All sent." } }] });
    expect(await new ClaudePlanner({ tools, client: done.client }).propose(createState("t", tools))).toMatchObject({ finish: "All sent." });

    const text = fake({ stop_reason: "end_turn", content: [{ type: "text", text: "Nothing more to do." }] });
    expect(await new ClaudePlanner({ tools, client: text.client }).propose(createState("t", tools))).toMatchObject({ finish: "Nothing more to do." });

    const refused = fake({ stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: "policy" }, content: [] });
    expect((await new ClaudePlanner({ tools, client: refused.client }).propose(createState("t", tools)) as { finish: string }).finish).toMatch(/declined.*policy/);
  });
});
