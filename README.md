# Agent Control Plane

**The operating system for autonomous agents — powered by Jev.**

Decision and policy runtime that sits between an agent's reasoning (LLM) and its tools.
**LLMs reason. Tools execute. Code enforces. Jev decides.**

Each step: project state → one parallel [Jev](https://typesafe.ai) call for all signals → deterministic policy → `ALLOW | BLOCK | HUMAN_REVIEW | REPLAN | RETRY | STOP` → execute → trace.

```
packages/core      @agent-control/core   library: state projection, signals, policy, recovery, traces, run loop
packages/cli       acp                   the product surface: run agents under control from your terminal
packages/planner-claude                  Claude as the planner (the LLM half of a real agent)
packages/server    POST /v1/decisions    HTTP surface for non-TypeScript agents
bench/                                   with/without-control benchmark (needs an Anthropic key)
packages/site      website               information + getting started only; it controls nothing
examples/research-agent                  offline end-to-end demo
```

## Quick start

```bash
npm install
npx acp init
npx acp run agent.example.ts
```

`acp run` prints every decision live, asks `approve? [y/N]` in the terminal when policy wants a person,
and appends each verdict to `.acp/traces.jsonl`. With no interactive terminal, approvals are denied (fail closed).

| Command | What it does |
| --- | --- |
| `acp init` | Write `acp.policy.json`, `agent.example.ts` (offline) and `agent.claude.ts` (real LLM). Never overwrites |
| `acp run <agent-file>` | Run an agent under control. `--task --policy --traces --agent-id --queue-approvals --approval-timeout --speculative --auto-approve --quiet` |
| `acp approvals` / `acp approve <id>` / `acp deny <id>` | Answer review requests from any terminal, for agents started with `--queue-approvals` (background, CI, server). Unanswered requests time out to a denial |
| `acp traces` | Inspect recorded decisions. `--agent --verdict --last --json` |
| `acp traces verify` | Check the audit log's hash chain. Exit code 3 and the line number if anything was edited, removed or reordered |
| `acp policy check` | Replay recorded gate decisions through a policy file. `--show-changes` |
| `acp label` | Mark recorded decisions right or wrong; they become eval cases in `.acp/cases.jsonl` |
| `acp eval` | Score the current model + policy against your labeled cases. Exit code 4 on a miss, so CI can catch regressions |
| `acp doctor` | Show which decision model, policy and trace file will be used |

An agent file exports `{ task, planner, tools }`; `planner.propose(state, hint)` is your LLM.

No API key is needed: without `TYPESAFE_API_KEY` everything uses `MockModel`, a deterministic test double.
Set `TYPESAFE_API_KEY` (and optionally `JEV_MODEL=jev-1.13.0` to pin a version) to use real Jev.

The Jev integration is verified against the live API (`jev-1.13.0`): all three answer types parse, decisions take ~350-1000 ms and cost about $0.00003 each.
Put your key in `.env` (gitignored; see `.env.example`) and the CLI picks it up.

## What the control plane does beyond gating

- **Prompt-injection check.** Every fresh tool result is scored before the planner reads it. Above the threshold the text is withheld from the LLM, the agent is told to use another source, and the event is traced (`prompt_injection`). Measured on live Jev: injected results 0.72-0.99, benign ones (docs, emails, test output) at most 0.07.
- **Budgets.** Planners report token spend; `maxCost` (control + planner, USD) and `maxPlannerTokens` halt a run. `@agent-control/planner-claude` reports it automatically.
- **Less latency.** `readOnlyTools` skip the gate's model call entirely (hard rules still apply, results are still checked): the example run drops from 10 decisions to 7. `--speculative` asks the planner for the next step while the result check runs, at the cost of one discarded LLM call per task.
- **Tamper-evident audit log.** Trace lines are hash-chained; approvals record who answered. `acp traces verify` pinpoints the first altered line.
- **Timeouts fail closed.** A Jev call that takes longer than 8 s is treated as a failure, so the action goes to a person instead of hanging the agent. Observed Jev latency ranged from 0.3 s to 6.7 s within one evening.

## Benchmark

```bash
npm run bench -- --tasks 5        # needs ANTHROPIC_API_KEY and TYPESAFE_API_KEY
npm run bench -- --smoke          # no keys: checks the harness only
```

`bench/` runs the same Claude planner on 20 simulated tasks with and without the control plane and reports success, unsafe actions
(wrong refunds, deleted tables, followed injections), LLM calls, tokens, cost and time. **It has not been run yet** - no Anthropic key was
available - so this project makes no measured claim about savings.

## Publishing

```bash
npm run pack:check                # build + list what each tarball would contain
```

`@agent-control/core`, `@agent-control/cli` and `@agent-control/planner-claude` build to `dist/` and are publish-ready. The names are free on npm,
but the `@agent-control` scope has to be created by whoever owns the npm account, and the license is currently `UNLICENSED` - pick one before publishing.

## Calibration

```bash
npm run eval             # labeled cases -> live Jev -> per-signal separation + end-to-end verdicts
npm run eval -- --v --table
npm run eval:variants    # A/B test candidate question wordings
```

`packages/core/eval/cases.ts` holds 31 labeled situations. Current result on live Jev: every signal 100% at the 0.5 line, 26/26 expected verdicts
with the default policy. What the tuning found:

- Concrete, enumerated questions beat judgement-style ones. "A careful operator would want to approve..." scored harmless searches ~0.65 (44% accuracy);
  "moves money, deletes data, deploys to production, or runs a destructive command" separates every case (0.90 vs 0.02).
- Risk alone must not block. A legitimate wire transfer scores risk 0.95, so `risk_block` now needs high risk **and** low relevance;
  risky-but-relevant goes to a person.
- Default thresholds sit inside the measured gaps. Add cases from your own workload and re-run before trusting them, and again when you change the pinned model version.
- Question wording is overridable per id: `new ControlPlane({ questions: { needs_human: "..." } })`.

Other scripts: `npm test`, `npm run typecheck`, `npm run demo`, `npm run server`, `npm run site` (http://localhost:4173).
The CLI currently runs through `tsx`; the packages are not published to npm yet.

## Usage

```ts
import { ControlPlane, JevModel, JsonlSink } from "@agent-control/core";

const control = new ControlPlane({
  model: new JevModel({ model: "jev-1.13.0" }),
  policy: { maxSteps: 30, maxRetries: 3, blockedTools: ["delete_database"], approvalRequired: ["send_email"] },
  sink: new JsonlSink("traces/agent.jsonl"),
  onApproval: async ({ action }) => askHuman(action), // absent/false = action does not run
});

// 1. Full loop: you supply a Planner (your LLM) and tools
const result = await control.run({ task, planner, tools });

// 2. Tool middleware for an existing agent
const email = control.tool(emailTool);
const r = await email({ to: "a@b.c" }, state); // executed | failed | blocked | denied | replan | stop

// 3. Signals + verdict only
const { signals, verdict } = await control.evaluate(state);
```

HTTP (`npm run server`, port 8787): `POST /v1/decisions` with `{ state, questions: [...] }` for raw typed answers,
or `{ state: AgentState, policy? }` for the standard signals plus a policy verdict.

## Design rules

- **Jev signals, code decides.** Hard limits, block lists and approval lists run before any model signal; a confidently wrong model cannot unblock a tool.
- **Fail closed.** If the decision model errors, nothing is auto-allowed (`model_unavailable` → human review). No approver configured → denied.
- **Post-result check before the next LLM turn.** Goal completion and stuck detection run after every tool result, so a finished or looping agent never pays for another planner call.
- **Small state.** `projectState` sends Jev only the task, proposed action, a window of recent actions and pinned context. Counts (repeat streak, failures) are computed in code because Jev cannot count.
- **Atomic, positive questions** in `signals.ts` — Jev reads instructions literally and is unreliable with negation.
- **Thresholds come from measurement.** `DEFAULT_THRESHOLDS` were set with `npm run eval` on live Jev; extend the cases with your workload and override globally or per tool category.

## Not built yet

Model routing, context management (keep/compress/pin), Python SDK, framework adapters, `acp serve`, framework adapters, a real-LLM planner adapter.
