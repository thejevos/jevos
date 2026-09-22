// UI primitives for the website: icons, badges, signal bars, toasts.
import { DEFAULT_POLICY, POLICY_PATH } from "./policy.js";

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const P = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  agents: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V4m-3 9v2m6-2v2M2 13v2m20-2v2"/><circle cx="12" cy="3.5" r="1"/>',
  decisions: '<path d="M6 3v6a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4M6 9v12"/><circle cx="6" cy="3" r="0.5"/><path d="m15 18 3 3 3-3"/>',
  approvals: '<path d="M12 3 4 6v6c0 4.5 3.2 8 8 9 4.800-1 8-4.500 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  policies: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  how: '<circle cx="12" cy="12" r="9"/><path d="M9.500 9.500a2.500 2.500 0 1 1 3.500 2.300c-.7.4-1 1-1 1.700M12 17h0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.300l2-1.500-2-3.400-2.300 1a7 7 0 0 0-2.200-1.300L14 3h-4l-.4 2.500a7 7 0 0 0-2.200 1.300l-2.300-1-2 3.400 2 1.500a7 7 0 0 0 0 2.600l-2 1.500 2 3.400 2.300-1a7 7 0 0 0 2.200 1.300L10 21h4l.4-2.500a7 7 0 0 0 2.200-1.300l2.300 1 2-3.400-2-1.500c.1-.4.1-.9.1-1.300z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.500-3.500"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 6 2.500 7 2.500 7h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12.500 4.500 4.500L19 7.500"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="M19 12H5m5 5-5-5 5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 4.500v15l12-7.500z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  gate: '<path d="M12 3 4 6v6c0 4.500 3.200 8 8 9 4.800-1 8-4.500 8-9V6z"/>',
  tool: '<path d="M14.500 6.500a4 4 0 0 0-5 5L3 18l3 3 6.500-6.500a4 4 0 0 0 5-5L15 12l-3-3z"/>',
  checkc: '<circle cx="12" cy="12" r="9"/><path d="m8.500 12.500 2.500 2.500 4.500-5"/>',
  recovery: '<path d="M4 12a8 8 0 0 1 14-5.300L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.300L4 15m0 5v-5h5"/>',
  alert: '<path d="M12 4 2.500 20h19zM12 10v4m0 3h0"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pulse: '<path d="M2 12h4l3-8 4 16 3-8h6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-3 3 3 3m-6 0 2 2"/>',
  inbox: '<path d="M3 13h5l1.500 3h5L16 13h5M5 5h14l2 8v6H3v-6z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
export const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.600" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] ?? ""}</svg>`;
export const logo = `<svg class="brand-mark" viewBox="0 0 32 32" fill="none"><rect x=".5" y=".5" width="31" height="31" rx="8.500" fill="#0b0d11" stroke="rgba(255,255,255,.12)"/><path d="M16 5.500 26.500 16 16 26.500 5.500 16Z" stroke="#67e8f9" stroke-width="1.600"/><path d="M16 10.500 21.500 16 16 21.500 10.500 16Z" stroke="#67e8f9" stroke-opacity=".4" stroke-width="1.200"/><circle cx="16" cy="16" r="2.400" fill="#67e8f9"/></svg>`;

export const VERDICT = {
  ALLOW: { label: "ALLOW", color: "var(--allow)", plain: "Allowed" },
  EXECUTED: { label: "EXECUTED", color: "var(--allow)", plain: "Executed" },
  APPROVED: { label: "APPROVED", color: "var(--allow)", plain: "Approved by a human" },
  HUMAN_REVIEW: { label: "REVIEW", color: "var(--review)", plain: "Sent for human review" },
  BLOCK: { label: "BLOCK", color: "var(--block)", plain: "Blocked" },
  FAILED: { label: "FAILED", color: "var(--block)", plain: "Tool failed" },
  DENIED: { label: "DENIED", color: "var(--block)", plain: "Denied by a human" },
  REPLAN: { label: "REPLAN", color: "var(--replan)", plain: "Asked the agent to replan" },
  RETRY: { label: "RETRY", color: "var(--replan)", plain: "Retrying" },
  STOP: { label: "STOP", color: "var(--plane)", plain: "Stopped — goal complete" },
};
export const badge = (d) => `<span class="badge ${d}"><i></i>${VERDICT[d]?.label ?? d}</span>`;

export const SIGNALS = {
  actionRelevant: { label: "Relevant to goal", color: "var(--plane)", tip: "Probability the proposed action moves the task forward.", th: "relevance" },
  actionRisky: { label: "Risk", color: "var(--block)", tip: "Probability the action is destructive, costly or hard to undo.", th: "riskReview" },
  needsHuman: { label: "Needs a human", color: "var(--review)", tip: "Probability a careful operator would want to approve this first.", th: "humanApproval" },
  goalComplete: { label: "Goal complete", color: "var(--allow)", tip: "Probability the task is already done.", th: "goalComplete" },
  stuck: { label: "Stuck", color: "var(--replan)", tip: "Probability the agent is looping without new information.", th: "stuck" },
  progress: { label: "Progress", color: "var(--agent)", tip: "How much recent actions advanced the task (0–1)." },
  retryUseful: { label: "Retry would help", color: "var(--replan)", tip: "Probability the failure was transient." },
};
export function signalRow(key, value, withThreshold = true) {
  const s = SIGNALS[key];
  if (!s || value === undefined) return "";
  const th = withThreshold && s.th ? DEFAULT_POLICY.thresholds[s.th] : null;
  return `<div class="sig" data-sig="${key}"><span class="name" data-tip="${esc(s.tip)}">${s.label}</span><span class="val mono">${value.toFixed(2)}</span>
    <div class="bar" style="--c:${s.color}"><i style="width:${value * 100}%"></i>${th !== null ? `<u style="left:${th * 100}%" title="policy threshold ${th}"></u>` : ""}</div></div>`;
}

// ───────── overlays ─────────
export function toast(title, sub = "", kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "ok" ? "checkc" : kind === "err" ? "alert" : "bolt")}<div>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  $("#toasts").append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 260); }, 3600);
}

export function policyPath(e) {
  const idx = POLICY_PATH.findIndex((p) => p.rule === e.rule);
  if (idx < 0) return "";
  const color = VERDICT[e.decision]?.color ?? "var(--t2)";
  return `<div class="path">${POLICY_PATH.map((p, i) => {
    const state = i < idx ? "pass" : i === idx ? "fired" : "skip";
    return `<div class="path-row ${state}" style="--c:${color}"><span class="m">${state === "skip" ? "" : icon(state === "pass" ? "check" : "arrow")}</span>${p.label}${state === "fired" ? `<span class="spacer"></span>${badge(e.decision)}` : ""}</div>`;
  }).join("")}</div>`;
}

export function copyText(text, label = "Copied to clipboard") {
  (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(() => toast(label), () => toast("Couldn't access the clipboard", "Select the text and copy it manually.", "err"));
}
