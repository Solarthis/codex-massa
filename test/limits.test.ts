/**
 * limits.test.ts — proves the loop can never run forever: both the
 * max-iteration and max-runtime limits halt it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopController, newRunId } from '../src/loop.js';
import { MockCodexClient } from '../src/codex-client.js';
import { makeProject } from './helpers.js';

function controllerWith(dir: string, opts: { maxIterations: number; maxRuntimeMs: number; delayMs?: number }) {
  return new LoopController(
    newRunId(),
    {
      projectDir: dir,
      goalFile: 'PROJECT_GOAL.md',
      maxIterations: opts.maxIterations,
      maxRuntimeMs: opts.maxRuntimeMs,
      verificationCommands: ['node greet.test.js'], // never passes (no greet.js written)
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      codexMode: 'mock',
    },
    // Empty plan => worker never makes progress => goal never met.
    new MockCodexClient({ plan: [], delayMs: opts.delayMs ?? 0 }),
  );
}

test('max-iteration limit halts a non-converging loop', async () => {
  const dir = await makeProject();
  const controller = controllerWith(dir, { maxIterations: 2, maxRuntimeMs: 60_000 });
  await controller.init();
  const state = await controller.runToCompletion();
  assert.equal(state.status, 'limit_reached');
  assert.equal(state.currentIteration, 2);
  assert.match(state.stopReason ?? '', /max iterations/);
});

test('max-runtime limit halts a slow loop', async () => {
  const dir = await makeProject();
  // Each mock call sleeps 40ms; runtime budget is 10ms => stops after iter 1.
  const controller = controllerWith(dir, { maxIterations: 100, maxRuntimeMs: 10, delayMs: 40 });
  await controller.init();
  const state = await controller.runToCompletion();
  assert.equal(state.status, 'limit_reached');
  assert.match(state.stopReason ?? '', /runtime/);
  assert.ok(state.currentIteration < 100, 'must not run all iterations');
});
