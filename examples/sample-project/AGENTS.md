# AGENTS.md — instructions for the Codex worker

> Codex automatically reads the nearest `AGENTS.md`. This file tells the worker
> how to behave inside THIS project. (In dry-run/mock mode it is not used, but a
> real Codex run honors it.)

## Scope
- Work only inside this project directory. Do not modify files outside it.
- Do not touch secrets, credentials, `.env*`, CI/infra, or global config.

## How to work
- Make the smallest coherent change that moves the project toward the goal in
  `PROJECT_GOAL.md`.
- After editing, make the verification command pass: `node greet.test.js`.
- Keep `src/greet.js` minimal and dependency-free.

## Conventions
- ES modules (`export function ...`).
- No new dependencies.
