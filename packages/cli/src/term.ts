import type { Signals, TraceEvent } from "@agent-control/core";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: wrap("2"), bold: wrap("1"), red: wrap("31"), green: wrap("32"), yellow: wrap("33"),
  blue: wrap("34"), magenta: wrap("35"), cyan: wrap("36"), gray: wrap("90"),
};

const VERDICT_COLOR: Record<string, (s: string) => string> = {
  ALLOW: c.green, EXECUTED: c.green, APPROVED: c.green,
  HUMAN_REVIEW: c.yellow,
  BLOCK: c.red, FAILED: c.red, DENIED: c.red,
  REPLAN: c.blue, RETRY: c.blue,
  STOP: c.cyan,
};
export const verdict = (d: string, width = 12) => (VERDICT_COLOR[d] ?? ((s: string) => s))(d.padEnd(width));

const SHORT: Array<[keyof Signals, string]> = [
  ["actionRelevant", "rel"], ["actionRisky", "risk"], ["needsHuman", "human"],
  ["goalComplete", "goal"], ["stuck", "stuck"], ["retryUseful", "retry"],
];
export function signalSummary(s: Signals | undefined): string {
  if (!s) return "";
  return SHORT.filter(([k]) => typeof s[k] === "number").map(([k, label]) => `${c.gray(label)} ${(s[k] as number).toFixed(2)}`).join("  ");
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour12: false });

/** One trace event as one terminal line. Used by both `acp run` and `acp traces`. */
export function eventLine(e: TraceEvent, showAgent = false): string {
  const head = `${c.gray(time(e.timestamp))}  ${showAgent ? `${c.magenta(e.agent_id.padEnd(18))} ` : ""}${c.gray("step")} ${String(e.step).padStart(2)}  ${e.phase.padEnd(8)} ${verdict(e.decision)} ${(e.tool ?? "").padEnd(16)}`;
  if (e.phase === "tool") return `${head} ${c.gray(`${e.latency_ms}ms`)}${e.reason ? `  ${c.red(e.reason)}` : ""}`;
  return `${head} ${c.gray((e.rule ?? "").padEnd(18))} ${signalSummary(e.signals)}`;
}

export function table(rows: Array<[string, string | number]>): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${c.gray(k.padEnd(w))}  ${v}`).join("\n");
}
