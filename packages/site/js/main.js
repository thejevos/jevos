// JevOS — information + getting-started site.
// The product itself runs locally through the `acp` CLI; nothing here controls an agent.
import { POLICY_PATH, SCENARIOS, decide } from "./policy.js";
import { $, $$, VERDICT, badge, copyText, esc, icon, logo, policyPath, signalRow } from "./ui.js";

const NAV = [["", "Overview"], ["how", "How it works"], ["start", "Get started"], ["cli", "CLI reference"]];

// ───────── terminal replay (real `acp run agent.example.ts` output) ─────────
const g = (s) => `<span class="tg">${s}</span>`;
const sig = (rel, risk, human, goal, stuck) => `${g("rel")} ${rel}  ${g("risk")} ${risk}  ${g("human")} ${human}  ${g("goal")} ${goal}  ${g("stuck")} ${stuck}`;
const row = (t, step, phase, cls, verdict, tool, rule, rest = "") => `${g(t)}  ${g("step")} ${String(step).padStart(2)}  ${phase.padEnd(8)} <span class="${cls}">${verdict.padEnd(12)}</span> ${tool.padEnd(16)} ${g(rule.padEnd(18))} ${rest}`;
const RUN = [
  [`<span class="tp">$</span> acp run agent.example.ts`, 500],
  [`<b>acp</b> ${g("·")} agent <span class="tM">agent.example</span> ${g("·")} model <span class="tY">mock (offline)</span> ${g("·")} policy acp.policy.json`, 500],
  [`${g("task")} Research three competitors and email me a comparison.`, 300],
  ["", 300],
  [row("22:26:18", 0, "gate", "tG", "ALLOW", "web_search", "default_allow", sig("0.95", "0.05", "0.05", "0.04", "0.05")), 520],
  [row("22:26:18", 1, "tool", "tR", "FAILED", "web_search", "", `<span class="tR">upstream request timed out</span>`), 520],
  [row("22:26:18", 1, "recovery", "tB", "RETRY", "web_search", "retry_transient"), 520],
  [row("22:26:19", 2, "tool", "tG", "EXECUTED", "web_search", "", g("812ms")), 420],
  [row("22:26:19", 2, "check", "tG", "ALLOW", "", "default_allow", `${g("goal")} 0.04  ${g("stuck")} 0.05`), 420],
  [row("22:26:21", 4, "gate", "tR", "BLOCK", "delete_database", "blocked_tool", sig("0.95", "0.85", "0.85", "0.04", "0.05")), 700],
  [row("22:26:21", 4, "gate", "tY", "HUMAN_REVIEW", "send_email", "approval_required", sig("0.95", "0.85", "0.85", "0.04", "0.05")), 700],
  ["", 200],
  [`  <span class="tY">┌ approval needed</span>`, 120],
  [`  <span class="tY">│</span> <b>send_email</b> ${g('{"to":"me@example.com","subject":"Competitor comparison"}')}`, 120],
  [`  <span class="tY">│</span> tool "send_email" always requires approval ${g("·")} risk 0.85`, 120],
  [`  <span class="tY">└</span> approve? [y/N] <b>y</b>`, 1300],
  ["", 200],
  [row("22:26:24", 5, "tool", "tG", "EXECUTED", "send_email", "", g("640ms")), 480],
  [row("22:26:24", 5, "check", "tC", "STOP", "", "goal_complete", `${g("goal")} 0.97  ${g("stuck")} 0.05`), 600],
  ["", 200],
  [`<span class="tG">COMPLETE</span> ${g("·")} goal complete (p=0.97)`, 200],
  [`  ${g("tool executions    ")}  5\n  ${g("planner (LLM) calls")}  5\n  ${g("control decisions  ")}  10 ${g("(est. $0.000182)")}`, 4200],
];
const termWindow = (title, body, attrs = "") => `<div class="term"><div class="term-bar"><i></i><i></i><i></i><span>${title}</span></div><pre class="term-body" ${attrs}>${body}</pre></div>`;
function playTerminal(el) {
  let i = 0, timer;
  const step = () => {
    if (!el.isConnected) return;
    if (i === 0) el.innerHTML = "";
    const [html, wait] = RUN[i];
    el.insertAdjacentHTML("beforeend", `${html}\n`);
    el.scrollTop = el.scrollHeight;
    i = (i + 1) % RUN.length;
    timer = setTimeout(step, wait);
  };
  step();
  return () => clearTimeout(timer);
}

const code = (text, lang = "bash") => `<div class="snippet"><pre class="code">${lang === "raw" ? text : esc(text)}</pre><button class="btn ghost sm" data-copy="${esc(lang === "raw" ? text.replace(/<[^>]+>/g, "") : text)}" aria-label="Copy">${icon("copy")}</button></div>`;
const concept = `<svg viewBox="0 0 820 170" style="width:100%;height:auto" role="img" aria-label="Your agent proposes, the control plane decides, tools execute"><defs><linearGradient id="obp" x1="0" y1="0" x2="0" y2="1"><stop stop-color="rgba(103,232,249,.14)"/><stop offset="1" stop-color="rgba(103,232,249,.02)"/></linearGradient></defs>
  <path id="ob1" d="M190 85H320" stroke="rgba(255,255,255,.14)" stroke-dasharray="3 5"/><path id="ob2" d="M500 85H630" stroke="rgba(255,255,255,.14)" stroke-dasharray="3 5"/>
  <g font-family="Geist, sans-serif"><rect x="20" y="45" width="170" height="80" rx="16" fill="rgba(167,139,250,.06)" stroke="rgba(167,139,250,.35)"/><text x="105" y="81" text-anchor="middle" fill="#eceef2" font-size="15" font-weight="500">Your agent</text><text x="105" y="102" text-anchor="middle" fill="#a0a7b4" font-size="12">thinks and proposes</text>
  <rect x="320" y="25" width="180" height="120" rx="20" fill="url(#obp)" stroke="rgba(103,232,249,.55)"/><text x="410" y="78" text-anchor="middle" fill="#eceef2" font-size="15" font-weight="500">Control Plane</text><text x="410" y="99" text-anchor="middle" fill="#a0a7b4" font-size="12">checks and decides</text><text x="410" y="124" text-anchor="middle" fill="#67e8f9" font-size="10.500" font-family="Geist Mono, monospace" letter-spacing="1.500">RUNS LOCALLY</text>
  <rect x="630" y="45" width="170" height="80" rx="16" fill="rgba(247,162,94,.06)" stroke="rgba(247,162,94,.35)"/><text x="715" y="81" text-anchor="middle" fill="#eceef2" font-size="15" font-weight="500">Tools &amp; APIs</text><text x="715" y="102" text-anchor="middle" fill="#a0a7b4" font-size="12">only approved actions run</text></g>
  <circle r="4" fill="#a78bfa"><animateMotion dur="3s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;.35;1" calcMode="linear"><mpath href="#ob1"/></animateMotion><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;.33;.36;1" dur="3s" repeatCount="indefinite"/></circle>
  <circle r="4" fill="#52d492"><animateMotion dur="3s" repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="0;.55;.9;1" calcMode="linear"><mpath href="#ob2"/></animateMotion><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;.54;.56;.9;1" dur="3s" repeatCount="indefinite"/></circle></svg>`;
const PRINCIPLES = [["LLMs reason", "var(--agent)", "Agent", "Understands the task, plans, and proposes the next action."], ["Jev decides", "var(--plane)", "Control plane", "Scores the situation in one fast call: relevant? risky? finished? stuck?"], ["Code enforces", "var(--review)", "Policy", "Plain rules in a JSON file turn scores into allow, review, replan or block."], ["Tools execute", "var(--tool)", "Action", "Only approved actions reach your APIs, data and customers."]];
const principles = `<div class="principles">${PRINCIPLES.map(([h, c, who, p]) => `<div class="card principle" style="--c:${c}"><div class="who"><i></i>${who}</div><h4>${h}</h4><p>${p}</p></div>`).join("")}</div>`;

// ───────── pages ─────────
function home(root) {
  root.innerHTML = `<section class="hero"><div class="eyebrow"><span class="dot plane"></span>Powered by Jev</div>
      <h1>The operating system<br/>for autonomous agents.</h1>
      <p class="tagline">Your agents act. You stay in control.</p>
      <p class="lede">JevOS sits between your AI agent and the tools it uses. Every proposed action is scored, checked against your policy, and allowed, paused for you, or stopped — before it touches the real world.</p>
      <div class="hero-cta"><a class="btn primary lg" href="#/start">Get started${icon("arrow")}</a><a class="btn lg" href="#/how">See how it works</a></div>
      <div class="install"><span class="tp">$</span><span>npx acp init &amp;&amp; npx acp run agent.example.ts</span><button class="btn ghost sm" data-copy="npx acp init && npx acp run agent.example.ts" aria-label="Copy">${icon("copy")}</button></div></section>
    <section class="wide">${termWindow("~/my-agent — acp", "", "data-term")}<p class="caption">Real output from <span class="mono">acp run</span>: a failed search is retried, a destructive tool is blocked, and an email waits for a <span class="mono">y</span> in your terminal.</p></section>
    <section><h2 class="sec">One loop, four jobs</h2><p class="sec-sub">The LLM keeps doing the thinking. The hundreds of small decisions around it move to a layer that is fast, cheap and yours.</p>${principles}</section>
    <section><h2 class="sec">Everything happens on your machine</h2><p class="sec-sub">No dashboard to log into. The control plane is a library and a command.</p>
      <div class="grid g-3">${[["tool", "A local CLI", "<span class=mono>acp run</span> wraps your agent, prints every decision live, and asks you in the terminal when a person is needed."], ["policies", "Policy is a file", "<span class=mono>acp.policy.json</span> lives in your repo: limits, blocked tools, approvals, thresholds. Review it like code."], ["decisions", "Traces you can replay", "Every verdict is appended to <span class=mono>.acp/traces.jsonl</span>. <span class=mono>acp policy check</span> replays them against a new policy before you ship it."]].map(([i, h, p]) => `<div class="card"><div class="card-body"><div class="agent-ico feature-ico">${icon(i)}</div><div class="feature-h">${h}</div><p class="muted" style="font-size:13.5px">${p}</p></div></div>`).join("")}</div></section>
    <section class="cta-band card"><div><h2 class="sec" style="margin:0">Three commands to a controlled agent.</h2><p class="muted" style="margin-top:6px">Works offline with a built-in mock. Add a Jev key when you're ready.</p></div><a class="btn primary lg" href="#/start">Get started${icon("arrow")}</a></section>`;
  return playTerminal($("[data-term]", root));
}

function how(root) {
  let cur = "safe";
  root.innerHTML = `<section class="doc-head"><div class="eyebrow">How it works</div><h1 class="doc-h1">A checkpoint between thinking and doing.</h1><p class="lede">Your agent proposes an action. Before any tool runs, the control plane asks a purpose-built decision model a handful of quick questions, then lets <b>your rules</b> — not the model — make the call.</p></section>
    <section class="wide" style="max-width:860px">${concept}</section>
    <section>${principles}</section>
    <section><h2 class="sec">Try a situation</h2><p class="sec-sub">Pick what the agent wants to do and watch the default policy respond.</p>
      <div class="card"><div class="card-head" style="padding-bottom:16px;border-bottom:1px solid var(--line);flex-wrap:wrap"><div class="scenario-tabs">${Object.entries(SCENARIOS).map(([k, s]) => `<button class="chip" data-sc="${k}">${s.label}</button>`).join("")}</div></div><div class="sim" data-sim></div></div></section>
    <section><h2 class="sec">The rule order never changes</h2><p class="sec-sub">Hard limits and lists run before any model signal, so a confidently wrong model can't unblock a tool.</p>
      <div class="card"><div class="card-body"><ol class="rule-order">${POLICY_PATH.map((p, i) => `<li><span class="mono faint">${String(i + 1).padStart(2, "0")}</span>${p.label}<span class="mono faint">${p.rule}</span></li>`).join("")}</ol></div></div></section>
    <section><div class="grid g-3">${[["Fails closed", "gate", "If the decision model is unreachable, nothing is auto-allowed. With no terminal to ask, approvals are denied."], ["Checks after every result", "checkc", "Goal and stuck checks run before the next LLM turn, so a finished agent stops paying."], ["Measured, not guessed", "decisions", "Default thresholds were set by running labeled cases through live Jev. <span class=mono>npm run eval</span> re-checks them on your own cases."], ["One policy, many agents", "agents", "<span class=mono>acp serve --fleet</span> turns JevOS into a shared control plane: per-agent permissions, fleet-wide budgets, one approval queue, one audit log."]].map(([h, i, p]) => `<div class="card"><div class="card-body"><div class="agent-ico feature-ico">${icon(i)}</div><div class="feature-h">${h}</div><p class="muted" style="font-size:13.5px">${p}</p></div></div>`).join("")}</div></section>
    <section class="cta-band card"><div><h2 class="sec" style="margin:0">See it on your own machine.</h2></div><a class="btn primary lg" href="#/start">Get started${icon("arrow")}</a></section>`;
  function paint() {
    const s = SCENARIOS[cur], v = decide(s.sig, s.tool);
    $$("[data-sc]", root).forEach((b) => b.classList.toggle("on", b.dataset.sc === cur));
    $("[data-sim]", root).innerHTML = `<div><div class="cap" style="color:var(--agent)"><i></i>1 · Agent proposes</div><div class="bubble"><small>agent says</small>“${esc(s.say)}”</div><pre class="code" style="margin-top:10px">${esc(JSON.stringify({ tool: s.tool, args: s.args }, null, 2))}</pre></div>
      <div><div class="cap" style="color:var(--plane)"><i></i>2 · Control plane scores it</div>${["actionRelevant", "actionRisky", "needsHuman", "goalComplete", "stuck"].map((k) => signalRow(k, s.sig[k])).join("")}<p class="faint" style="font-size:12px;margin-top:6px">White tick = policy threshold</p></div>
      <div class="outcome"><div class="cap" style="color:${VERDICT[v.decision].color}"><i></i>3 · Policy decides</div><div class="big" style="color:${VERDICT[v.decision].color}">${VERDICT[v.decision].label}</div><p class="mono faint" style="font-size:12px">${esc(v.rule)} · ${esc(v.reason)}</p><p class="muted" style="font-size:13.5px">${s.next}</p><details style="margin-top:4px"><summary class="faint" style="cursor:pointer;font-size:12.5px">Show the rule path</summary><div style="margin-top:8px">${policyPath(v)}</div></details></div>`;
  }
  paint();
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-sc]"); if (b) { cur = b.dataset.sc; paint(); } });
}

const STEPS = [
  ["Install", "You need Node 20 or newer. The packages aren't on npm yet, so install from the repository.", code("git clone <this-repo> agent-control-plane\ncd agent-control-plane\nnpm install")],
  ["Create a policy and an example agent", "<span class=mono>acp init</span> writes two files into the current folder. Nothing is overwritten if they already exist.", code("npx acp init") + termWindow("output", `  <span class="tG">create</span>  acp.policy.json\n  <span class="tG">create</span>  agent.example.ts`)],
  ["Run the agent under control", "Every decision prints live. The example deliberately hits a timeout, proposes a blocked tool and needs one approval, so you see each path.", code("npx acp run agent.example.ts")],
  ["Approve in the terminal", "When policy sends an action for review, the agent waits and the CLI asks you. Anything other than <span class=mono>y</span> denies it. With no interactive terminal (CI, pipes) the answer is always no.", termWindow("approval", `  <span class="tY">┌ approval needed</span>\n  <span class="tY">│</span> <b>send_email</b> ${g('{"to":"me@example.com","subject":"Competitor comparison"}')}\n  <span class="tY">│</span> tool "send_email" always requires approval ${g("·")} risk 0.85\n  <span class="tY">└</span> approve? [y/N] `)],
  ["Make the policy yours", "Policy is a JSON file in your repo. Lists and limits always win over model signals.", code(`{\n  "maxSteps": 30,\n  "maxRetries": 3,\n  "blockedTools": ["delete_database"],\n  "readOnlyTools": ["web_search"],\n  "maxCost": 1,\n  "approvalRequired": ["send_email"],\n  "thresholds": { "riskReview": 0.6, "riskBlock": 0.8, "humanApproval": 0.6, "goalComplete": 0.8, "stuck": 0.8 }\n}`, "json")],
  ["Preview a policy change before shipping it", "Replays your recorded decisions through the edited policy and shows what would change.", code("npx acp policy check --show-changes") + termWindow("output", `Replayed <b>12</b> gate decisions from .acp/traces.jsonl against acp.policy.json\n\n  <span class="tG">ALLOW         </span>     6 ${g("→")}     0  <span class="tC">-6</span>\n  <span class="tY">HUMAN_REVIEW  </span>     4 ${g("→")}    10  <span class="tY">+6</span>\n  <span class="tR">BLOCK         </span>     2 ${g("→")}     2  ${g("no change")}\n\n6 decisions would change.`)],
  ["Bring your own agent", "An agent file exports a <span class=mono>planner</span> (your LLM: it proposes the next action) and <span class=mono>tools</span>. The control plane runs the loop.", code(`import type { Planner, ToolDef } from "@jevos/core";\n\nexport const task = "Resolve ticket #48121";\n\nexport const tools: ToolDef[] = [\n  { name: "lookup_order", description: "Read an order by id", execute: ({ id }) => db.orders.get(id) },\n  { name: "refund", description: "Refund an order", category: "financial", execute: refund },\n];\n\nexport const planner: Planner = {\n  async propose(state, hint) {\n    // call your LLM with state.task, state.history and the hint;\n    // return { tool, args } or { finish: "summary" }\n  },\n};`, "ts") + `<p class="muted" style="font-size:13.5px;margin-top:10px">Already have an agent loop? Use the library directly: <span class="mono">control.tool(myTool)</span> gates one tool, <span class="mono">control.evaluate(state)</span> returns signals and a verdict.</p>`],
  ["Run it in the background", "Start the agent with <span class=mono>--queue-approvals</span> and it parks review requests on disk instead of asking. Answer from any terminal. No answer within the timeout means no.", code("npx acp run agent.example.ts --queue-approvals &\nnpx acp approvals\nnpx acp approve <id>")],
  ["Trust the record", "Every decision is appended to a hash-chained log, and approvals record who answered. Verification pinpoints the first altered line.", code("npx acp traces verify") + termWindow("output", `<span class="tG">intact</span> ${g("·")} 17 events, hash chain verified`)],
  ["Teach it your workload", "Mark real decisions right or wrong, then score the model and policy against them. Re-run after any threshold or wording change.", code("npx acp label\nnpx acp eval")],
  ["Switch from the mock to Jev", "Without a key, decisions come from an offline mock so you can try everything. Set a TypeSafe key in your shell to use real Jev, and pin a version so tuned thresholds stay valid.", code("export TYPESAFE_API_KEY=...   # your key, in your own shell\nexport JEV_MODEL=jev-1.13.0\nnpx acp doctor") + `<p class="muted" style="font-size:13.5px;margin-top:10px">Put the two variables in a <span class="mono">.env</span> file next to your agent (keep it out of git) and the CLI loads it automatically. Verified against the live API: a decision takes roughly 350–1000 ms and costs about $0.00003.</p>`],
];
function start(root) {
  root.innerHTML = `<div class="doc"><aside class="toc"><div class="nav-label" style="padding-left:0">Get started</div>${STEPS.map(([h], i) => `<a href="#/start" data-jump="s${i}"><span class="mono">${i + 1}</span>${h}</a>`).join("")}</aside>
    <div><section class="doc-head" style="text-align:left;margin:0 0 8px"><div class="eyebrow">Get started</div><h1 class="doc-h1">From zero to a controlled agent.</h1><p class="lede" style="margin-left:0">About five minutes. Everything runs locally and offline until you add a key.</p></section>
      <ol class="steps">${STEPS.map(([h, p, body], i) => `<li id="s${i}"><span class="n mono">${i + 1}</span><h3>${h}</h3><p>${p}</p>${body}</li>`).join("")}</ol>
      <div class="cta-band card" style="margin-top:32px"><div><h2 class="sec" style="margin:0">Want every flag?</h2></div><a class="btn lg" href="#/cli">CLI reference${icon("arrow")}</a></div></div></div>`;
  root.addEventListener("click", (e) => { const a = e.target.closest("[data-jump]"); if (a) { e.preventDefault(); $(`#${a.dataset.jump}`, root).scrollIntoView({ behavior: "smooth", block: "start" }); } });
}

const CLI = [
  ["acp init", "Write acp.policy.json and agent.example.ts into the current folder. Existing files are left alone.", []],
  ["acp run <agent-file>", "Run an agent under control with a live decision trace. Exit code 0 when the goal completes, 2 when halted or escalated.", [["--task <text>", "Override the task exported by the agent file"], ["--policy <file>", "Policy file (default acp.policy.json; built-in defaults if absent)"], ["--traces <file>", "Where decisions are appended (default .acp/traces.jsonl)"], ["--agent-id <name>", "Name recorded in traces (default: the file name)"], ["--queue-approvals", "Park review requests on disk and wait for <span class=mono>acp approve</span> from any terminal. For background, CI and server runs"], ["--approval-timeout <s>", "How long a queued request waits before it is denied (default 900)"], ["--speculative", "Ask the planner for the next step while the result check runs. Faster; may discard one LLM call per task"], ["--auto-approve", "Approve every review request without asking. Unsafe; for demos only"], ["--quiet", "Only print approvals and the final summary"]]],
  ["acp traces", "Print recorded decisions, one per line, with a verdict summary.", [["--file <file>", "Trace file to read"], ["--agent <id>", "Only this agent"], ["--verdict <V>", "ALLOW, BLOCK, HUMAN_REVIEW, REPLAN, RETRY, STOP, EXECUTED, FAILED…"], ["--last <n>", "How many to show (default 40)"], ["--json", "Raw JSONL for piping into other tools"]]],
  ["acp approvals · acp approve <id> · acp deny <id>", "List and answer review requests from any terminal. A unique prefix of the id is enough. Unanswered requests time out to a denial.", [["--note <text>", "Recorded with the decision"]]],
  ["acp traces verify", "Check the audit log's hash chain. Reports the first line that was edited, removed or reordered; exit code 3 if the log was tampered with.", []],
  ["acp label", "Walk through recorded decisions and mark each right or wrong. Your answers become eval cases in .acp/cases.jsonl.", [["--index <line> --expect <VERDICT>", "Label one decision without prompts"], ["--last <n>", "How many recent decisions to review (default 30)"]]],
  ["acp eval", "Score the current model and policy against your labeled cases. Exit code 4 on any miss, so CI can catch regressions.", []],
  ["acp policy check", "Replay recorded gate decisions through a policy file and report what would change.", [["--policy <file>", "Candidate policy"], ["--traces <file>", "Trace file to replay"], ["--show-changes", "List every decision that flips"]]],
  ["acp doctor", "Show which decision model, policy and trace file will be used.", []],
];
function cli(root) {
  root.innerHTML = `<section class="doc-head"><div class="eyebrow">CLI reference</div><h1 class="doc-h1"><span class="mono">acp</span></h1><p class="lede">Inside this repository run it as <span class="mono">npx acp</span>. Decisions come from Jev when <span class="mono">TYPESAFE_API_KEY</span> is set, otherwise from the offline mock.</p></section>
    <section class="stack" style="max-width:860px;margin:0 auto">${CLI.map(([cmd, desc, opts]) => `<div class="card"><div class="card-body"><div class="cmd mono"><span class="tp">$</span> ${esc(cmd)}</div><p class="muted" style="margin-top:6px;font-size:13.5px">${desc}</p>${opts.length ? `<table class="opts">${opts.map(([f, d]) => `<tr><td class="mono">${esc(f)}</td><td>${d}</td></tr>`).join("")}</table>` : ""}</div></div>`).join("")}
      <div class="card"><div class="card-body"><div class="feature-h">Verdicts</div><div class="verdicts">${[["ALLOW", "The tool runs."], ["HUMAN_REVIEW", "The agent waits; you answer in the terminal."], ["BLOCK", "Never runs; the agent is told why."], ["REPLAN", "Irrelevant, looping, or the wrong tool — the agent must try something else."], ["RETRY", "A failure looked temporary; the same action runs again."], ["STOP", "Goal reached or a hard limit hit; the loop ends."]].map(([v, d]) => `<div>${badge(v)}<span class="muted">${d}</span></div>`).join("")}</div></div></div></section>`;
}

// ───────── shell + router ─────────
const PAGES = { "": home, how, start, cli };
$("#app").innerHTML = `<header class="site-nav"><a class="brand" href="#/" style="padding:0">${logo}<div class="brand-name">JevOS<span>The OS for autonomous agents · powered by Jev</span></div></a>
    <nav>${NAV.map(([id, label]) => `<a href="#/${id}" data-nav="${id}">${label}</a>`).join("")}</nav><a class="btn primary sm nav-cta" href="#/start">Get started</a></header>
  <main class="site" data-page></main>
  <footer class="site-foot"><span>JevOS — the operating system for autonomous agents, powered by Jev.</span><span class="mono">runs locally · no account · no dashboard</span></footer>`;

let cleanup;
function route() {
  const id = location.hash.replace(/^#\/?/, "").split("?")[0];
  const page = PAGES[id] ? id : "";
  cleanup?.();
  $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === page));
  const root = Object.assign(document.createElement("div"), { className: "site-inner" });
  $("[data-page]").replaceChildren(root);
  cleanup = PAGES[page](root);
  scrollTo(0, 0);
}
addEventListener("hashchange", route);
document.addEventListener("click", (e) => { const b = e.target.closest("[data-copy]"); if (b) copyText(b.dataset.copy, "Copied"); });
route();
