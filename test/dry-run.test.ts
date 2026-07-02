/**
 * dry-run.test.ts — proves the FULL loop end-to-end with a mock worker:
 * checklist -> task -> verify -> review -> follow-up -> done. No real Codex call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LoopController, newRunId } from '../src/loop.js';
import { MockCodexClient } from '../src/codex-client.js';
import { makeProject, PLAN_PARTIAL_THEN_FIX } from './helpers.js';

test('dry-run mock completes the full loop with a follow-up', async () => {
  const dir = await makeProject();
  const client = new MockCodexClient({ plan: PLAN_PARTIAL_THEN_FIX });
  const runId = newRunId();
  const controller = new LoopController(
    runId,
    {
      projectDir: dir,
      goalFile: 'PROJECT_GOAL.md',
      maxIterations: 5,
      maxRuntimeMs: 60_000,
      verificationCommands: ['node greet.test.js'],
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      codexMode: 'mock',
    },
    client,
  );

  await controller.init();

  // Step 3: checklist was built and persisted.
  assert.equal(controller.getState().checklist.length, 3);
  await fs.access(controller.store.topChecklistPath);

  const state = await controller.runToCompletion();

  // Completed, and it required at least one follow-up iteration.
  assert.equal(state.status, 'completed');
  assert.ok(state.currentIteration >= 2, `expected >=2 iterations, got ${state.currentIteration}`);

  // Iteration 1 was incomplete (verification failed) -> continue (follow-up).
  assert.equal(state.iterations[0]!.decision, 'continue');
  assert.equal(state.iterations[0]!.review?.complete, false);
  assert.ok(
    state.iterations[0]!.verification.some((v) => !v.passed),
    'iteration 1 verification should have a failure',
  );

  // Final iteration completed the goal.
  const last = state.iterations[state.iterations.length - 1]!;
  assert.equal(last.decision, 'done');
  assert.equal(last.review?.complete, true);
  assert.ok(last.verification.every((v) => v.passed), 'final verification should pass');

  // git diff was captured against the checklist.
  assert.match(last.review!.gitDiffSummary, /greet\.js/);

  // Artifacts exist: checklist.md, per-iteration logs, state.json, final report.
  await fs.access(controller.store.statePath);
  await fs.access(controller.store.finalReportPath);
  await fs.access(path.join(controller.store.iterationsDir, 'iter-001.json'));
  await fs.access(path.join(controller.store.iterationsDir, 'iter-001.md'));
  const report = await fs.readFile(controller.store.finalReportPath, 'utf8');
  assert.match(report, /Final Report/);
  assert.match(report, /completed/);

  // Event log recorded prompts, responses, verification, and decisions.
  const events = await controller.store.readEvents();
  const types = new Set(events.map((e) => e.type));
  for (const t of ['checklist_created', 'prompt_sent', 'codex_response', 'verification', 'review', 'decision', 'run_finished']) {
    assert.ok(types.has(t as never), `missing event type: ${t}`);
  }
});
