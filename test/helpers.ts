/**
 * helpers.ts — shared test fixtures (not a test file itself).
 * Creates a throwaway git project so getDiffStat()/guards have a real diff.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand } from '../src/verifier.js';

export const GOAL = `# Project Goal

Implement a greet() function.

\`\`\`checklist
[
  { "id": "greet-file", "text": "src/greet.js exists", "check": { "type": "fileExists", "path": "src/greet.js" } },
  { "id": "greet-impl", "text": "greet returns a Hello greeting", "check": { "type": "fileContains", "path": "src/greet.js", "pattern": "Hello" } },
  { "id": "tests-pass", "text": "the greet test passes", "check": { "type": "command", "command": "node greet.test.js" } }
]
\`\`\`
`;

export const GREET_TEST = `import assert from 'node:assert';
import { greet } from './src/greet.js';
assert.strictEqual(greet('World'), 'Hello, World!');
console.log('ok');
`;

export const PLAN_PARTIAL_THEN_FIX = [
  {
    message: 'initial greet (wrong word)',
    writeFiles: [{ path: 'src/greet.js', content: 'export function greet(n){return `Hi, ${n}`;}\n' }],
  },
  {
    message: 'fix greet to the exact greeting',
    writeFiles: [{ path: 'src/greet.js', content: 'export function greet(n){return `Hello, ${n}!`;}\n' }],
  },
];

/** Create a temp project that is a real git repo with the goal + test committed. */
export async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-orch-'));
  await runCommand(
    'git init -q && git config user.email t@example.com && git config user.name tester',
    dir,
    30_000,
  );
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 't', type: 'module' }), 'utf8');
  await fs.writeFile(path.join(dir, 'PROJECT_GOAL.md'), GOAL, 'utf8');
  await fs.writeFile(path.join(dir, 'greet.test.js'), GREET_TEST, 'utf8');
  // mock-plan.json lets the project self-drive in mock mode (no inline plan),
  // e.g. when the MCP server constructs its own MockCodexClient.
  await fs.writeFile(
    path.join(dir, 'mock-plan.json'),
    JSON.stringify({ steps: PLAN_PARTIAL_THEN_FIX }, null, 2),
    'utf8',
  );
  await runCommand('git add -A && git commit -qm baseline', dir, 30_000);
  return dir;
}
