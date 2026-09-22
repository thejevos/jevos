import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";

let dir: string;
const cwd = process.cwd();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acp-"));
  process.chdir(dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("acp", () => {
  it("prints help and rejects unknown commands", async () => {
    expect(await main(["help"])).toBe(0);
    expect(await main(["bogus"])).toBe(1);
  });

  it("init writes a policy and an example agent, and never overwrites", async () => {
    expect(await main(["init"])).toBe(0);
    const policy = JSON.parse(await readFile("acp.policy.json", "utf8"));
    expect(policy.blockedTools).toContain("delete_database");
    expect(await readFile("agent.example.ts", "utf8")).toContain("export const planner");
    expect(await main(["init"])).toBe(0);
  });

  it("fails clearly when there is nothing to read", async () => {
    expect(await main(["traces"])).toBe(1);
    expect(await main(["policy", "check"])).toBe(1);
    expect(await main(["run", "missing.ts"])).toBe(1);
  });
});
