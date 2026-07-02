# AGENTS.md

<!--
  Codex automatically reads the nearest AGENTS.md when working in a directory.
  Copy this into your TARGET project root as AGENTS.md and tailor it. The
  orchestrator does not inject this file; Codex picks it up on its own. (It is
  not used in dry-run/mock mode.)
-->

## Scope & safety
- Work only inside this project directory. Never modify files outside it.
- Never read, print, or move secrets/credentials (`.env*`, `*.pem`, `~/.ssh`, `~/.aws`, `~/.codex`).
- Do not deploy, publish, purchase, or change auth/security settings.
- Do not delete large parts of the repo.

## How to work
- Make the smallest coherent change that advances `PROJECT_GOAL.md`.
- After each change, make the verification commands pass.
- Reference exact files/tests you touched in your summary.

## Project conventions
- Language / framework: <fill in>
- Build: `<fill in, e.g. npm run build>`
- Test: `<fill in, e.g. npm test>`
- Style: <fill in, e.g. existing eslint/prettier config>
- Dependencies: do not add new ones without explicit approval.
