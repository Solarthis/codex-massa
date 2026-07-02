# Project Goal

Implement a tiny greeting module.

## What "done" means

`src/greet.js` should export a `greet(name)` function that returns the string
`Hello, <name>!`, and the verification command `node greet.test.js` should pass.

## Acceptance Checklist

The orchestrator reads the machine-checkable checklist from the fenced
` ```checklist ` block below. Each item has an `id`, human `text`, and an optional
`check` the reviewer evaluates against the repo (`fileExists`, `fileContains`, or
`command`). Items with no `check` are satisfied only when every verification
command passes.

```checklist
[
  { "id": "greet-file", "text": "src/greet.js exists and exports greet()", "check": { "type": "fileExists", "path": "src/greet.js" } },
  { "id": "greet-impl", "text": "greet() returns a 'Hello, ...' greeting", "check": { "type": "fileContains", "path": "src/greet.js", "pattern": "Hello" } },
  { "id": "tests-pass", "text": "the greet test passes", "check": { "type": "command", "command": "node greet.test.js" } }
]
```

## Verification commands

Pass these to the orchestrator with `--verify` (CLI) or `verification_commands`
(MCP tool):

- `node greet.test.js`
