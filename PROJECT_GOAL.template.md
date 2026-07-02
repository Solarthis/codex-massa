# Project Goal

<!--
  This is the goal the orchestrator drives Codex toward. Copy this file into your
  target project as PROJECT_GOAL.md and edit it.

  Write the goal in plain prose, then give a MACHINE-CHECKABLE acceptance
  checklist in the fenced ```checklist block below. The orchestrator parses that
  block to decide when the goal is met. If you omit the block, the orchestrator
  falls back to parsing "- [ ]" task-list bullets (as verification-gated items),
  and finally to a single "all verification commands pass" item.
-->

## What we want

Describe the feature/change in a sentence or two. Be concrete about the
observable end state.

## Acceptance checklist

Each item: `id` (stable slug), `text` (human description), and an optional
`check` the reviewer evaluates against the repo:

- `{ "type": "fileExists", "path": "src/foo.ts" }`
- `{ "type": "fileContains", "path": "src/foo.ts", "pattern": "export function foo" }`  (pattern is a JS regex, falls back to substring)
- `{ "type": "command", "command": "npm test" }`  (passes when exit code is 0)

Items with NO `check` are satisfied only when every configured verification
command passes.

```checklist
[
  { "id": "module",  "text": "src/foo.ts exists and exports foo()", "check": { "type": "fileExists", "path": "src/foo.ts" } },
  { "id": "behaviour", "text": "foo() returns the expected value",   "check": { "type": "fileContains", "path": "src/foo.ts", "pattern": "return" } },
  { "id": "tests",   "text": "the test suite passes",               "check": { "type": "command", "command": "npm test" } }
]
```

## Verification commands

List the commands the orchestrator should run each iteration (also pass them via
`--verify` on the CLI or `verification_commands` to `start_project_loop`):

- `npm test`
- `npm run build`

## Constraints

- Work only inside the project directory.
- Do not touch secrets, CI/infra, or global config.
- No new dependencies without approval.
