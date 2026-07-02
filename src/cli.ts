#!/usr/bin/env node
/**
 * cli.ts — Thin CLI wrapper around the SAME modules the MCP server uses.
 *
 * Commands:
 *   run     Run an autonomous loop to completion (foreground, streams progress).
 *   review  Run a one-shot review_current_state.
 *   task    Send a single prompt to Codex (codex_task).
 *   status  Print a run's status (get_loop_status).
 *   stop    Request a cooperative stop of a run (stop_loop).
 *
 * Worker mode defaults to "mcp-server"; pass --dry-run (or --mode mock) to use
 * the mock worker with no network / no real Codex call.
 */

import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_CODEX_TASK_TIMEOUT_MS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_RUNTIME_MS,
  DEFAULT_SANDBOX,
  validateSafetyConfig,
} from './config.js';
import { createCodexClient } from './codex-client.js';
import { guardPrompt, hasBlock } from './guards.js';
import { LoopController, newRunId, parseGoalChecklist } from './loop.js';
import { Store } from './store.js';
import { getDiffStat, review, runVerification } from './verifier.js';
import type {
  ApprovalPolicy,
  CodexMode,
  SandboxMode,
} from './types.js';

function out(s = ''): void {
  process.stdout.write(s + '\n');
}

const HELP = `codex-orchestrator — local MCP orchestrator for OpenAI Codex

Usage:
  codex-orchestrator run    --project-dir <dir> [--goal-file PROJECT_GOAL.md]
                            [--verify "<cmd>" ...] [--max-iterations N]
                            [--sandbox workspace-write] [--approval-policy never]
                            [--max-runtime-ms N] [--mode mcp-server|exec|mock] [--dry-run]
  codex-orchestrator review --project-dir <dir> [--goal-file PROJECT_GOAL.md] [--verify "<cmd>" ...]
  codex-orchestrator task   --project-dir <dir> --prompt "<text>" [--thread-id <id>] [--mode ...] [--dry-run]
  codex-orchestrator status --project-dir <dir> --run-id <id>
  codex-orchestrator stop   --project-dir <dir> --run-id <id>

Notes:
  --dry-run forces --mode mock (no network, no real Codex). In mock mode the
  worker applies steps from <project-dir>/mock-plan.json.
`;

const options = {
  'project-dir': { type: 'string' as const },
  'goal-file': { type: 'string' as const, default: 'PROJECT_GOAL.md' },
  verify: { type: 'string' as const, multiple: true },
  'max-iterations': { type: 'string' as const },
  'max-runtime-ms': { type: 'string' as const },
  sandbox: { type: 'string' as const },
  'approval-policy': { type: 'string' as const },
  mode: { type: 'string' as const },
  'dry-run': { type: 'boolean' as const, default: false },
  prompt: { type: 'string' as const },
  'thread-id': { type: 'string' as const },
  'run-id': { type: 'string' as const },
  help: { type: 'boolean' as const, short: 'h', default: false },
};

function resolveMode(values: Record<string, unknown>): CodexMode {
  if (values['dry-run']) return 'mock';
  const m = (values.mode as string) ?? 'mcp-server';
  if (m === 'mock' || m === 'mcp-server' || m === 'exec') return m;
  throw new Error(`Invalid --mode "${m}" (mock|mcp-server|exec)`);
}

function requireDir(values: Record<string, unknown>): string {
  const dir = values['project-dir'] as string | undefined;
  if (!dir) throw new Error('--project-dir is required');
  return path.resolve(dir);
}

async function cmdRun(values: Record<string, unknown>): Promise<number> {
  const projectDir = requireDir(values);
  const sandbox = (values.sandbox as SandboxMode) ?? DEFAULT_SANDBOX;
  const approvalPolicy = (values['approval-policy'] as ApprovalPolicy) ?? DEFAULT_APPROVAL_POLICY;
  validateSafetyConfig(sandbox, approvalPolicy);
  const mode = resolveMode(values);
  const maxIterations = values['max-iterations']
    ? parseInt(values['max-iterations'] as string, 10)
    : DEFAULT_MAX_ITERATIONS;
  const maxRuntimeMs = values['max-runtime-ms']
    ? parseInt(values['max-runtime-ms'] as string, 10)
    : DEFAULT_MAX_RUNTIME_MS;
  const verificationCommands = (values.verify as string[] | undefined) ?? [];

  const runId = newRunId();
  out(`▶ run ${runId}  (mode=${mode}, sandbox=${sandbox}, approval=${approvalPolicy})`);
  const controller = new LoopController(
    runId,
    {
      projectDir,
      goalFile: values['goal-file'] as string,
      maxIterations,
      maxRuntimeMs,
      verificationCommands,
      sandbox,
      approvalPolicy,
      codexMode: mode,
    },
    createCodexClient({ mode }),
    { onEvent: out },
  );

  await controller.init();
  const state = await controller.runToCompletion();

  out('');
  out(`Final status: ${state.status}${state.stopReason ? ` — ${state.stopReason}` : ''}`);
  out(`State dir:     ${controller.store.runDir}`);
  out(`Checklist:     ${controller.store.topChecklistPath}`);
  out(`Final report:  ${controller.store.finalReportPath}`);

  switch (state.status) {
    case 'completed':
      return 0;
    case 'limit_reached':
      return 2;
    case 'paused_for_approval':
      return 3;
    case 'stopped':
      return 4;
    default:
      return 1;
  }
}

async function cmdReview(values: Record<string, unknown>): Promise<number> {
  const projectDir = requireDir(values);
  const goalFile = values['goal-file'] as string;
  const verificationCommands = (values.verify as string[] | undefined) ?? [];
  const goalText = await fs.readFile(path.resolve(projectDir, goalFile), 'utf8').catch(() => '');
  const checklist = parseGoalChecklist(goalText);
  const verification = await runVerification(projectDir, verificationCommands, DEFAULT_CODEX_TASK_TIMEOUT_MS);
  const diff = await getDiffStat(projectDir);
  const { review: r } = await review(projectDir, checklist, verification, diff);
  out(JSON.stringify(
    {
      complete: r.complete,
      checklist_completion: r.checklistCompletion,
      remaining_gaps: r.remainingGaps,
      satisfied: r.satisfied,
      verification: verification.map((v) => ({ command: v.command, passed: v.passed, exit_code: v.exitCode })),
      git_diff_summary: r.gitDiffSummary,
    },
    null,
    2,
  ));
  return r.complete ? 0 : 2;
}

async function cmdTask(values: Record<string, unknown>): Promise<number> {
  const projectDir = requireDir(values);
  const prompt = values.prompt as string | undefined;
  if (!prompt) throw new Error('--prompt is required');
  const guards = guardPrompt(prompt);
  if (hasBlock(guards)) {
    out(JSON.stringify({ status: 'blocked_pending_approval', guards: guards.filter((g) => g.triggered) }, null, 2));
    return 3;
  }
  const mode = resolveMode(values);
  const client = createCodexClient({ mode });
  await client.start();
  try {
    const result = await client.runTask({
      projectDir,
      prompt,
      threadId: values['thread-id'] as string | undefined,
      sandbox: DEFAULT_SANDBOX,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      timeoutMs: DEFAULT_CODEX_TASK_TIMEOUT_MS,
    });
    out(JSON.stringify({ status: 'ok', mode, thread_id: result.threadId, output: result.output }, null, 2));
    return 0;
  } finally {
    await client.stop();
  }
}

async function cmdStatus(values: Record<string, unknown>): Promise<number> {
  const projectDir = requireDir(values);
  const runId = values['run-id'] as string | undefined;
  if (!runId) throw new Error('--run-id is required');
  const state = await Store.loadState(projectDir, runId);
  const last = state.iterations[state.iterations.length - 1];
  out(JSON.stringify(
    {
      run_id: state.runId,
      status: state.status,
      current_iteration: state.currentIteration,
      max_iterations: state.maxIterations,
      latest_codex_output: last?.codexOutput ?? null,
      latest_verification: last?.verification.map((v) => ({ command: v.command, passed: v.passed })) ?? [],
      remaining_gaps: last?.review?.remainingGaps ?? [],
      pending_approval: state.pendingApproval ?? null,
    },
    null,
    2,
  ));
  return 0;
}

async function cmdStop(values: Record<string, unknown>): Promise<number> {
  const projectDir = requireDir(values);
  const runId = values['run-id'] as string | undefined;
  if (!runId) throw new Error('--run-id is required');
  const store = new Store(projectDir, runId);
  await store.requestStop('cli stop');
  out(`Stop requested for ${runId}. The loop halts after its current step.`);
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true });
  const command = positionals[0];
  if (values.help || !command) {
    out(HELP);
    return command ? 0 : 1;
  }
  switch (command) {
    case 'run':
      return cmdRun(values);
    case 'review':
      return cmdReview(values);
    case 'task':
      return cmdTask(values);
    case 'status':
      return cmdStatus(values);
    case 'stop':
      return cmdStop(values);
    default:
      out(`Unknown command: ${command}\n`);
      out(HELP);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
