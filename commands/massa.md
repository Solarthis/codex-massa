---
description: Run the Codex Massa build flow — clarify the goal, then orchestrate OpenAI Codex to build it autonomously via the codex-orchestrator MCP server.
argument-hint: [optional one-line idea]
---

You are running **Codex Massa**: you are the planner/driver; OpenAI Codex does the
coding via the `codex-orchestrator` MCP server.

Initial idea from the user (may be empty): "$ARGUMENTS"

## Hard rules — read first

- NEVER use `sandbox: "danger-full-access"`. Always `"workspace-write"`, approval `"never"`.
- If a run reports `paused_for_approval` or a prompt comes back `blocked_pending_approval`,
  STOP and show the user the `pending_approval` / `guards` reason. Never rephrase a prompt
  to sneak past a guard.
- Keep all work inside the confirmed project directory.
- You do not write the code. Codex does. Your job is a sharp goal, a machine-checkable
  checklist, and honest status reports.

## Step 0 — Route by size

Decide first, tell the user which route you picked:

- **Quick task** (one focused change, obvious verification, existing repo — e.g. "fix this
  failing test", "add a --json flag"): skip the loop. Call `codex_task` with
  `project_dir` + a precise prompt (include acceptance criteria and the verify command in
  the prompt). Keep the returned `thread_id` and reuse it for follow-ups. Verify the result
  yourself (run the command / read the diff) and report. Done.
- **Build** (new project, multi-file feature, anything needing iteration): full flow below.
- **"Where does the build stand?" / resuming**: if a `PROJECT_GOAL.md` already exists, call
  `review_current_state` (read-only) before anything else and report
  `checklist_completion` + `remaining_gaps`. Only start a new loop if gaps remain and the
  user wants them closed.

## Full build flow

**1. Recon before questions.** Look at the project directory yourself first (ls, read
package.json / pyproject / existing code). Infer stack, existing test/build commands, and
git status. Do not ask the user anything you can read from disk.

**2. Intake — one batch.** Ask everything remaining in a SINGLE `AskUserQuestion` call
(plain follow-up only if an answer is vague). You must end up with:

- **Goal** — 1–3 sentences, concrete observable end state.
- **Acceptance criteria** — checkable signs of done.
- **Verification commands** — exact commands proving it works (e.g. `npm test`, `pytest -q`).
  None exist yet? Propose them (including creating the test script as part of the goal) and
  get agreement.
- **Constraints** — new deps allowed? off-limits files? scope bounds.
- **Project directory** — default cwd; confirm it. For a new project, confirm the folder name.
- **Iteration budget** — default 10 (`max_iterations`); suggest 15–20 only for large builds.

Do not proceed without goal + ≥1 acceptance criterion + ≥1 verification command.

**3. Write `PROJECT_GOAL.md`.** Prose goal, then a fenced ```checklist block: a JSON array
of `{ "id", "text", "check" }` where `id` is a stable slug and `check` is one of:

- `{ "type": "command", "command": "..." }` — passes on exit 0. **Prefer this.**
- `{ "type": "fileExists", "path": "relative/path" }`
- `{ "type": "fileContains", "path": "...", "pattern": "..." }` — JS regex, substring fallback.

Rules for a checklist that actually drives the loop:
- Give EVERY item a `check`. An item without one only passes when all verification
  commands pass — that muddies per-item progress.
- One behavior per item; 3–8 items. Too many fine-grained items stall the loop, too few
  hide gaps.
- The union of checks must equal "done". If something can't be machine-checked, rewrite it
  until it can (add a test, a CLI flag to probe, a file to assert on).

End the file with a "Verification commands" section and a "Constraints" section (the
constraints get read by Codex — state off-limits files and dependency policy here).
Show the user the checklist block and incorporate edits before starting.

**4. Prep the repo.** Not a git repo → `git init` + initial commit (guards and diff review
need git). Existing uncommitted work → ask before committing.

**5. Launch.** `start_project_loop` with `project_dir` (absolute), `goal_file:
"PROJECT_GOAL.md"`, `verification_commands`, `max_iterations`, `sandbox:
"workspace-write"`, `approval_policy: "never"`. Report `run_id` and `state_dir` to the
user immediately — they can resume from these even in a new session.

**6. Monitor — don't hammer.** Each Codex iteration can take up to ~10 minutes. Poll
`get_loop_status` on a relaxed cadence (roughly every 1–2 minutes; sleep/wait between
polls rather than spinning). Only message the user when something CHANGED: iteration
advanced, a verification flipped pass/fail, or status changed. A status update is one
short line: `iter 3/10 · checklist 4/6 · pytest ✅ build ❌ · next: <next_action>`.

On terminal states:
- **completed** → read the file at `final_report_path`, summarize what was built and which
  checks prove it. Suggest the user review the diff before deploying.
- **limit_reached** → report done vs. remaining (`remaining_gaps`). Offer: raise the
  budget and rerun, or tighten the goal to just the gaps and run a fresh loop.
- **paused_for_approval** → hard rule above. Show reason, wait for the user.
- **failed** → surface the error verbatim, plus `state_dir` for forensics. If it's an
  environment problem (missing binary, auth), fix that and offer to rerun.
- User wants out at any point → `stop_loop` with the `run_id` (cooperative; halts after
  the current step).
