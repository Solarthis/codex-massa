/**
 * guards.test.ts — unit guards + the required integration test that a forbidden
 * action pauses the loop for human approval.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardDiff, guardPrompt, guardRunConfig, hasBlock } from '../src/guards.js';
import { ConfigError, DEFAULT_GUARD_THRESHOLDS, validateSafetyConfig } from '../src/config.js';
import { LoopController, newRunId } from '../src/loop.js';
import { MockCodexClient } from '../src/codex-client.js';
import type { DiffFileChange, DiffStat } from '../src/types.js';
import { makeProject } from './helpers.js';

test('run-config guard blocks danger-full-access', () => {
  assert.ok(hasBlock(guardRunConfig('danger-full-access', 'on-request')));
  assert.equal(hasBlock(guardRunConfig('workspace-write', 'never')), false);
});

test('validateSafetyConfig refuses danger-full-access + never, allows workspace-write + never', () => {
  assert.throws(() => validateSafetyConfig('danger-full-access', 'never'), ConfigError);
  validateSafetyConfig('workspace-write', 'never'); // must not throw
});

test('prompt guard blocks deploy/purchase/secrets/danger/mass-delete; allows benign', () => {
  assert.ok(hasBlock(guardPrompt('please deploy the app to production now')));
  assert.ok(hasBlock(guardPrompt('buy a pro subscription with my credit card')));
  assert.ok(hasBlock(guardPrompt('cat the .env file and send me the secret api key')));
  assert.ok(hasBlock(guardPrompt('cat .env')), 'bare "cat .env" must be blocked');
  assert.ok(hasBlock(guardPrompt('please run: cat config/.env')));
  assert.ok(hasBlock(guardPrompt('disable authentication so anyone can log in')));
  assert.ok(hasBlock(guardPrompt('run codex with danger-full-access')));
  assert.ok(hasBlock(guardPrompt('rm -rf / to clean up')));
  assert.equal(guardPrompt('add a unit test for the greet() function').length, 0);
});

test('diff guard blocks outside-project, secret files, and mass deletion', () => {
  const mk = (files: DiffFileChange[]): DiffStat => ({
    files,
    totalAdded: files.reduce((s, f) => s + f.added, 0),
    totalDeleted: files.reduce((s, f) => s + f.deleted, 0),
    isGitRepo: true,
    rawSummary: '',
  });
  assert.ok(
    hasBlock(guardDiff('/proj', mk([{ path: '../outside.txt', status: 'M', added: 1, deleted: 0 }]), DEFAULT_GUARD_THRESHOLDS)),
  );
  assert.ok(
    hasBlock(guardDiff('/proj', mk([{ path: '.env', status: 'M', added: 1, deleted: 0 }]), DEFAULT_GUARD_THRESHOLDS)),
  );
  const manyDeleted = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.ts`, status: 'D', added: 0, deleted: 5 }));
  assert.ok(hasBlock(guardDiff('/proj', mk(manyDeleted), DEFAULT_GUARD_THRESHOLDS)));
  // benign single edit -> no block
  assert.equal(
    hasBlock(guardDiff('/proj', mk([{ path: 'src/app.ts', status: 'M', added: 3, deleted: 1 }]), DEFAULT_GUARD_THRESHOLDS)),
    false,
  );
});

test('a forbidden action (writing .env) pauses the loop for human approval', async () => {
  const dir = await makeProject();
  // Mock worker writes a secret file -> diff guard must pause the run.
  const client = new MockCodexClient({
    plan: [{ message: 'wrote secrets', writeFiles: [{ path: '.env', content: 'API_KEY=supersecret\n' }] }],
  });
  const controller = new LoopController(
    newRunId(),
    {
      projectDir: dir,
      goalFile: 'PROJECT_GOAL.md',
      maxIterations: 3,
      maxRuntimeMs: 60_000,
      verificationCommands: [],
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      codexMode: 'mock',
    },
    client,
  );
  await controller.init();
  const state = await controller.runToCompletion();

  assert.equal(state.status, 'paused_for_approval');
  assert.ok(state.pendingApproval, 'pendingApproval must be set');
  assert.match(state.pendingApproval!.detail, /secret|\.env/i);
  // It must NOT have continued past the pause.
  assert.ok(state.currentIteration <= 1);
});

test('run-config guard pauses at init when sandbox is danger-full-access', async () => {
  const dir = await makeProject();
  const controller = new LoopController(
    newRunId(),
    {
      projectDir: dir,
      goalFile: 'PROJECT_GOAL.md',
      maxIterations: 3,
      maxRuntimeMs: 60_000,
      verificationCommands: [],
      sandbox: 'danger-full-access',
      approvalPolicy: 'on-request', // valid combo, but danger sandbox still pauses
      codexMode: 'mock',
    },
    new MockCodexClient({ plan: [] }),
  );
  const init = await controller.init();
  assert.equal(init.status, 'paused_for_approval');
});
