// Validate the real CLI argument parser, stopping before authentication or a model call.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = process.argv[2] ?? process.env.CODEX_BIN ?? 'codex';
const home = mkdtempSync(join(tmpdir(), 'massa-policy-'));
try {
  const env = { ...process.env, CODEX_HOME: home };
  const version = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(version.status, 0, version.stderr || String(version.error));
  console.log(version.stdout.trim());
  for (const policy of ['never', 'on-request', 'untrusted', 'on-failure']) {
    const result = spawnSync(bin, [
      '--ask-for-approval', policy, 'exec', '--ignore-user-config', '--ephemeral',
      '--sandbox', 'read-only', '--output-schema', join(home, 'missing.json'),
      '--json', 'policy validation only',
    ], { env, cwd: home, input: '', encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    if (policy === 'never' || policy === 'on-request') {
      // The deliberately absent schema stops execution after argument parsing.
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Failed to read output schema file/);
      console.log(`${policy}: accepted; stopped at missing schema before task execution`);
    } else {
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /invalid value/);
      assert.match(result.stderr, /possible values: on-request, never/);
      console.log(`${policy}: rejected by CLI policy parser`);
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
