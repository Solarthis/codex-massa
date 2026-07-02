# codex-orchestrator

A **local MCP-based orchestrator** that lets Claude Code (or any MCP client)
delegate implementation work to **OpenAI Codex**, review Codex's output, run
verification, send targeted follow-ups, and **loop until a project goal passes**
or a safety limit is hit.

It runs two ways from the same code:

1. as an **MCP server** (official `@modelcontextprotocol/sdk`) exposing 5 tools, and
2. as a **thin CLI** that drives the identical loop.

It ships with a **dry-run / mock mode** that proves the whole loop end-to-end
(checklist → task → verify → review → follow-up → done) **with no real Codex call
and no network**.

It also ships a ready-made **`/massa` slash command for Claude Code**
([`commands/massa.md`](commands/massa.md)) that drives the whole flow: it
clarifies the goal with you, writes `PROJECT_GOAL.md`, starts the loop, and
reports progress. See [The /massa command](#the-massa-command-for-claude-code).

---

## Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Install & build](#install--build)
- [Quick start: the dry-run proof](#quick-start-the-dry-run-proof)
- [The 5 MCP tools](#the-5-mcp-tools)
- [Register in Claude Code (exact config)](#register-in-claude-code-exact-config)
- [The /massa command for Claude Code](#the-massa-command-for-claude-code)
- [Worker modes](#worker-modes)
- [Installing & configuring the real Codex CLI](#installing--configuring-the-real-codex-cli)
- [CLI usage](#cli-usage)
- [The autonomous loop](#the-autonomous-loop)
- [Safety guards & limits](#safety-guards--limits)
- [State & logs layout](#state--logs-layout)
- [Worked end-to-end example](#worked-end-to-end-example)
- [Codex CLI compatibility](#codex-cli-compatibility)
- [Troubleshooting](#troubleshooting)

---

## Architecture

- **Runtime:** TypeScript / Node (ESM), built with `tsc`. Tests use the built-in
  `node:test` runner — no extra test dependency.
- **Integration path:** **`codex mcp-server`** is the primary worker transport
  (driven via the MCP SDK client over stdio). **`codex exec --json`** is the
  fallback. Both sit behind one `CodexClient` interface alongside a **mock** impl.
- **Dependencies (pinned):** `@modelcontextprotocol/sdk` (mandated SDK) and
  `zod` (the SDK's tool-schema API). Dev: `typescript`, `@types/node`. Nothing else.

### Modules (each in its own file under `src/`)

| File | Responsibility |
|---|---|
| [`codex-client.ts`](src/codex-client.ts) | Codex worker behind one interface: `MockCodexClient`, `McpCodexClient` (`codex mcp-server`), `ExecCodexClient` (`codex exec --json`). |
| [`loop.ts`](src/loop.ts) | Loop controller: goal → checklist → milestone → verify → review → follow-up → report. |
| [`verifier.ts`](src/verifier.ts) | Reviewer/verifier: runs verification commands, parses `git diff`, evaluates checklist checks, computes completion. |
| [`guards.ts`](src/guards.ts) | Explicit safety guard checks (run config, outgoing prompt, observed diff). |
| [`store.ts`](src/store.ts) | Logging + state store: JSON state, per-iteration logs, JSONL event log, `checklist.md`, final report, stop flag. |
| [`config.ts`](src/config.ts) | Defaults, limits, guard thresholds, and the version-dependent Codex CLI launch settings. |
| [`types.ts`](src/types.ts) | Shared TypeScript types / JSON state shapes. |
| [`mcp-server.ts`](src/mcp-server.ts) | MCP server wrapper registering the 5 tools. |
| [`cli.ts`](src/cli.ts) | CLI wrapper driving the same modules. |

---

## Requirements

- **Node ≥ 20** (developed/tested on Node 24). `npm`.
- For **real** Codex runs: the **OpenAI Codex CLI** installed and authenticated
  (see [below](#installing--configuring-the-real-codex-cli)). **Not required** for
  the dry-run / tests.

---

## Install & build

```bash
# from a clean clone:
npm install        # installs pinned deps
npm run build      # compiles src/ + test/ to dist/
npm test           # builds, then runs the full test suite (13 tests)
```

`npm test` output ends with `pass 13 / fail 0`.

---

## Quick start: the dry-run proof

Runs the full loop against the bundled sample project using the **mock** worker —
no Codex, no network:

```bash
npm run dry-run
```

This is equivalent to:

```bash
node dist/src/cli.js run \
  --dry-run \
  --project-dir ./examples/sample-project \
  --goal-file PROJECT_GOAL.md \
  --verify "node greet.test.js"
```

It produces `examples/sample-project/.codex-orchestrator/` with the checklist,
per-iteration logs, persisted state, and a final report. See the full captured
output in [Worked end-to-end example](#worked-end-to-end-example).

---

## The 5 MCP tools

Registered with **exactly** these names and input names:

### `start_project_loop`
Start an autonomous loop; returns a `run_id` and runs in the background.

| Input | Type | Notes |
|---|---|---|
| `project_dir` | string | absolute path to the project |
| `goal_file` | string | default `PROJECT_GOAL.md`, relative to `project_dir` |
| `max_iterations` | int | default 10 |
| `verification_commands` | string[] | default `[]` |
| `sandbox` | enum | `read-only` \| `workspace-write` \| `danger-full-access`; default **`workspace-write`** |
| `approval_policy` | enum | `untrusted` \| `on-failure` \| `on-request` \| `never`; default **`never`** |

### `codex_task`
Send one prompt to Codex; returns its output + thread/session id. Outgoing
prompts are guard-checked; a blocked prompt is **not** sent.

| Input | Type | Notes |
|---|---|---|
| `project_dir` | string | |
| `prompt` | string | |
| `thread_id` | string? | continue a prior Codex conversation |

### `review_current_state`
Run `git diff` + verification, compare to the goal checklist, return remaining
gaps. Read-only; does not start a loop.

| Input | Type |
|---|---|
| `project_dir` | string |
| `goal_file` | string (default `PROJECT_GOAL.md`) |
| `verification_commands` | string[] |

### `get_loop_status`
Return current iteration, latest Codex output, latest verification result, and
the next action for a `run_id`.

| Input | Type |
|---|---|
| `run_id` | string |

### `stop_loop`
Request a clean cooperative stop of a `run_id`.

| Input | Type |
|---|---|
| `run_id` | string |

> **Why mode/max-runtime aren't tool inputs:** the spec fixes the input names
> above, so the worker mode and the max-runtime limit are read from environment
> variables instead (`CODEX_ORCHESTRATOR_MODE`, `CODEX_ORCHESTRATOR_MAX_RUNTIME_MS`).
> The max-runtime limit is still always enforced.

---

## Register in Claude Code (exact config)

Add this to your project's **`.mcp.json`** (or merge into Claude Code settings).
Replace the absolute path. A copy is in [`.mcp.json.example`](.mcp.json.example):

```json
{
  "mcpServers": {
    "codex-orchestrator": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/codex-orchestrator/dist/src/mcp-server.js"
      ],
      "env": {
        "CODEX_ORCHESTRATOR_MODE": "mcp-server",
        "CODEX_ORCHESTRATOR_MAX_RUNTIME_MS": "1800000"
      }
    }
  }
}
```

Equivalent CLI registration:

```bash
claude mcp add codex-orchestrator \
  -e CODEX_ORCHESTRATOR_MODE=mcp-server \
  -e CODEX_ORCHESTRATOR_MAX_RUNTIME_MS=1800000 \
  -- node /ABSOLUTE/PATH/TO/codex-orchestrator/dist/src/mcp-server.js
```

**To try it with no Codex installed**, set `CODEX_ORCHESTRATOR_MODE=mock`.

> Run `npm run build` first — the config points at `dist/src/mcp-server.js`.

---

## The /massa command for Claude Code

[`commands/massa.md`](commands/massa.md) is a slash command that turns the raw
MCP tools into a guided flow. Install it by copying it into your Claude Code
commands directory:

```bash
# available in every project:
cp commands/massa.md ~/.claude/commands/massa.md
# or per-project:
cp commands/massa.md YOUR_PROJECT/.claude/commands/massa.md
```

Then, with the MCP server registered (previous section), type `/massa` (optionally
followed by a one-line idea) in Claude Code. The command:

1. routes by size — a small task goes straight to `codex_task`, a real build gets
   the full loop, and "where does the build stand?" uses `review_current_state`;
2. inspects the repo first and only asks what it can't infer (goal, acceptance
   criteria, verification commands, constraints);
3. writes `PROJECT_GOAL.md` with a machine-checkable checklist and shows it to
   you before starting;
4. starts the loop with the safe defaults (`workspace-write`, approval `never`)
   and polls status without spamming;
5. stops and asks you whenever a safety guard pauses the run — it never uses
   `danger-full-access` and never rephrases a prompt past a guard.

---

## Worker modes

Selected via `CODEX_ORCHESTRATOR_MODE` (MCP server) or `--mode` / `--dry-run` (CLI):

| Mode | Transport | Use |
|---|---|---|
| `mock` | none (scripted) | dry-run / tests; applies steps from `<project>/mock-plan.json` (or an inline plan) |
| `mcp-server` | `codex mcp-server` over stdio (MCP SDK) | **primary** real path |
| `exec` | `codex exec --json` per call | fallback when MCP transport is impractical |

---

## Installing & configuring the real Codex CLI

The orchestrator does **not** bundle Codex. For real runs, install + authenticate
it. (Verified against the current Codex CLI; see
[Codex CLI compatibility](#codex-cli-compatibility).)

**Install (pick one):**

```bash
npm install -g @openai/codex          # npm (provides the `codex` binary)
brew install --cask codex             # Homebrew (note: --cask)
curl -fsSL https://chatgpt.com/codex/install.sh | sh   # standalone script
```

**Authenticate (pick one):**

```bash
codex login                           # browser OAuth (ChatGPT sign-in)
codex login status                    # check
printenv OPENAI_API_KEY | codex login --with-api-key   # API key via stdin
```

**Verify the surface the orchestrator targets:**

```bash
codex --help
codex mcp-server --help               # primary transport
codex exec --help                     # fallback transport
```

Config lives at `~/.codex/config.toml` (`CODEX_HOME` defaults to `~/.codex`).
The orchestrator passes `cwd`, `sandbox`, and `approval-policy` per call; you do
not need to pre-configure those.

---

## CLI usage

```text
codex-orchestrator run    --project-dir <dir> [--goal-file PROJECT_GOAL.md]
                          [--verify "<cmd>" ...] [--max-iterations N]
                          [--sandbox workspace-write] [--approval-policy never]
                          [--max-runtime-ms N] [--mode mcp-server|exec|mock] [--dry-run]
codex-orchestrator review --project-dir <dir> [--goal-file ...] [--verify "<cmd>" ...]
codex-orchestrator task   --project-dir <dir> --prompt "<text>" [--thread-id <id>] [--mode ...]
codex-orchestrator status --project-dir <dir> --run-id <id>
codex-orchestrator stop   --project-dir <dir> --run-id <id>
```

`--verify` is repeatable. `--dry-run` forces `--mode mock`. Run `run` exits `0`
on completion, `2` on a limit, `3` when paused for approval, `4` when stopped,
`1` on error.

Examples:

```bash
# Foreground loop against a real project with Codex:
node dist/src/cli.js run --project-dir /path/to/app \
  --verify "npm test" --verify "npm run build" --max-iterations 8

# One-shot review (no loop):
node dist/src/cli.js review --project-dir /path/to/app --verify "npm test"
```

---

## The autonomous loop

Implemented exactly as specified (`src/loop.ts`):

1. Read `PROJECT_GOAL.md`.
2. Read relevant repo docs / manifests / existing tests.
3. Produce an acceptance checklist → `.codex-orchestrator/checklist.md`.
4. Ask Codex to implement the **smallest coherent milestone**.
5. Run the configured verification commands.
6. Review `git diff` against the checklist.
7. If incomplete, send a **targeted follow-up**: what passed, what failed (exact
   commands/exit codes/errors), remaining gaps, what to fix next.
8. Repeat until completion **or** a max-iteration / max-runtime limit.
9. Produce a final report.

---

## Safety guards & limits

Guards are **explicit checks** (`src/guards.ts`), evaluated at three points:

- **Run config** — `sandbox = danger-full-access` blocks; `danger-full-access` +
  `never` is refused outright (`validateSafetyConfig`).
- **Outgoing prompt** — blocks intents to deploy to production, purchase paid
  services, access/exfiltrate secrets, weaken auth/security, mass-delete, or use
  `danger-full-access`.
- **Observed diff** — blocks changes outside the project root, edits to
  secret/credential files (`.env`, `*.pem`, `~/.ssh`, …), and large deletions
  (> 5 files or > 500 lines by default).

A **block** pauses the loop with status `paused_for_approval` and a
`pending_approval` record — it does **not** proceed without a human.

Hard limits (both always enforced, so the loop can never run forever):

- **Max iterations** — default 10 (`max_iterations`).
- **Max runtime** — default 30 min (`CODEX_ORCHESTRATOR_MAX_RUNTIME_MS` /
  `--max-runtime-ms`). Per-Codex-call and per-verification timeouts also apply.

Defaults: sandbox **`workspace-write`**, approval **`never`** (valid only inside
the workspace confinement).

---

## State & logs layout

Everything lives under `<project>/.codex-orchestrator/`:

```text
.codex-orchestrator/
├── checklist.md                      # spec-mandated path (latest run)
└── runs/<run_id>/
    ├── state.json                    # persisted RunState (source of truth)
    ├── checklist.md                  # per-run copy
    ├── events.jsonl                  # append-only structured event log
    ├── final-report.md
    ├── stop.flag                     # present => cooperative stop requested
    └── iterations/
        ├── iter-001.json / iter-001.md
        └── ...
```

The JSONL event log records every `prompt_sent`, `codex_response`,
`verification`, `review`, `guard`, `decision`, `paused`, and `run_finished`.

---

## Worked end-to-end example

The bundled `examples/sample-project/` has a goal (implement `greet()`), a
verification test (`node greet.test.js`), and a `mock-plan.json` whose first step
writes a **wrong** greeting (so verification fails and a follow-up is sent) and
whose second step fixes it.

```console
$ npm run dry-run

▶ run run-64cd35db  (mode=mock, sandbox=workspace-write, approval=never)
📋 checklist: 3 item(s) → .../examples/sample-project/.codex-orchestrator/checklist.md

── iteration 1/10 ──
→ codex (mock) prompt sent (2953 chars)
← codex responded (95 chars)
🧪 verification: 0/1 passed
✔ review: 33% checklist, 3 gap(s)

── iteration 2/10 ──
→ codex (mock) prompt sent (981 chars)
← codex responded (104 chars)
🧪 verification: 1/1 passed
✔ review: 100% checklist, COMPLETE

🏁 COMPLETED — all checklist items satisfied and verification passed

Final status: completed — all checklist items satisfied and verification passed
State dir:     .../examples/sample-project/.codex-orchestrator/runs/run-64cd35db
Checklist:     .../examples/sample-project/.codex-orchestrator/checklist.md
Final report:  .../examples/sample-project/.codex-orchestrator/runs/run-64cd35db/final-report.md
```

Resulting `checklist.md`:

```markdown
# Acceptance Checklist
- [x] **greet-file** — src/greet.js exists and exports greet()
  - evidence: file exists: src/greet.js
- [x] **greet-impl** — greet() returns a 'Hello, ...' greeting
  - evidence: file src/greet.js matches /Hello/
- [x] **tests-pass** — the greet test passes
  - evidence: command passed: node greet.test.js
```

Resulting `final-report.md` (iteration log):

```markdown
## Iteration log
- Iteration 1: continue — 3 gap(s) remain; sending a follow-up (verification 0/1)
- Iteration 2: done — all checklist items satisfied and verification passed (verification 1/1)
```

**Running it for real (with Codex):** drop the `--dry-run` flag and ensure Codex
is installed/authenticated. The loop will use `codex mcp-server`, threading the
conversation across iterations via the returned `threadId`. To exercise the real
`git diff` review on the sample, `git init` the target first:

```bash
cd examples/sample-project && git init -q && git add -A && git commit -qm baseline && cd -
node dist/src/cli.js run --project-dir ./examples/sample-project --verify "node greet.test.js"
```

---

## Codex CLI compatibility

The Codex flag/tool surface drifts between versions. All version-dependent names
are centralized in [`config.ts`](src/config.ts) (`DEFAULT_CODEX_CLI`) so they can
be adjusted in one place. As built (verified against the current Codex CLI):

- **Launch MCP:** `codex mcp-server` (over stdio). *Not* `codex mcp serve`
  (`codex mcp` is the separate "manage external servers" command).
- **MCP tools:** `codex` (start) and `codex-reply` (continue). The `codex` tool
  takes **kebab-case** args (`prompt`, `cwd`, `sandbox`, `approval-policy`) and
  **rejects unknown fields**; `codex-reply` takes **camelCase** `{ threadId, prompt }`.
- **Session id:** returned in `structuredContent.threadId`; reused as `threadId`.
- **exec fallback:** `codex exec --json "<prompt>"`; resume with
  `codex exec resume <id>`. The JSONL stream is tagged by dotted `type`
  (`thread.started` carries `thread_id`; the final answer is in an
  `item.completed` whose `item.type === "agent_message"`, field `text`). A legacy
  `EventMsg` fallback parser is included.
- **Sandbox values:** `read-only` | `workspace-write` | `danger-full-access`.
- **Approval values:** `untrusted` | `on-failure` | `on-request` | `never`.
- **Guarded:** `--dangerously-bypass-approvals-and-sandbox` / `--yolo` and
  `--sandbox danger-full-access` are never emitted.

If a future Codex renames a tool or flag, edit `DEFAULT_CODEX_CLI` — no other
code changes are needed.

---

## Troubleshooting

- **"Goal file not found"** — pass `--project-dir` pointing at the dir that
  contains `PROJECT_GOAL.md`, and `--goal-file` relative to it.
- **`get_loop_status` says "Unknown run_id"** — for cross-process lookups the
  server scans the *server's* cwd. Launch the MCP server from the project dir, or
  use the CLI `status` command with `--project-dir`.
- **Real Codex run errors immediately** — run `codex login status` and
  `codex mcp-server --help`; confirm the binary is on `PATH` (override with the
  `CODEX_BIN` env var).
- **Git diff shows "(not a git repository)"** — the diff-based guards/review need
  a git repo; `git init` the target. The checklist + verification still work
  without git.
- **Loop paused unexpectedly** — check `get_loop_status` → `pending_approval`; a
  safety guard tripped. Review the change, then re-run with adjusted scope.
```
