/**
 * mcp-server.ts — MCP server wrapper.
 *
 * Exposes exactly five tools over stdio using the official MCP SDK, with the
 * exact input names required by the spec:
 *   - start_project_loop   (project_dir, goal_file, max_iterations,
 *                           verification_commands, sandbox, approval_policy)
 *   - codex_task           (project_dir, prompt, thread_id?)
 *   - review_current_state (project_dir, goal_file, verification_commands)
 *   - get_loop_status      (run_id)
 *   - stop_loop            (run_id)
 *
 * The worker mode (mock | mcp-server | exec) and the max-runtime limit are NOT
 * tool inputs (the spec fixes the inputs); they come from environment variables:
 *   CODEX_ORCHESTRATOR_MODE            default "mcp-server"
 *   CODEX_ORCHESTRATOR_MAX_RUNTIME_MS  default 1800000 (30 min)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
import { STATE_DIR_NAME } from './store.js';
import type { CodexMode, RunState } from './types.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveMode(): CodexMode {
  const m = (process.env.CODEX_ORCHESTRATOR_MODE ?? 'mcp-server').trim();
  if (m === 'mock' || m === 'mcp-server' || m === 'exec') return m;
  throw new Error(`Invalid CODEX_ORCHESTRATOR_MODE="${m}" (mock|mcp-server|exec)`);
}

function resolveMaxRuntime(): number {
  const v = process.env.CODEX_ORCHESTRATOR_MAX_RUNTIME_MS;
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RUNTIME_MS;
}

/**
 * In-process registry of loops (kept after completion so get_loop_status/stop_loop
 * can still read final state in-memory for the life of the server process).
 */
const running = new Map<string, { controller: LoopController; promise: Promise<unknown> }>();

/**
 * Persistent run_id -> project_dir index so get_loop_status/stop_loop work after
 * a server restart. Stored in-scope under the server cwd's state dir (never in
 * a user-level/global path).
 */
const RUN_INDEX_PATH = path.join(process.cwd(), STATE_DIR_NAME, 'run-index.json');

async function indexRun(runId: string, projectDir: string): Promise<void> {
  let idx: Record<string, string> = {};
  try {
    idx = JSON.parse(await fs.readFile(RUN_INDEX_PATH, 'utf8'));
  } catch {
    /* no index yet */
  }
  idx[runId] = path.resolve(projectDir);
  await fs.mkdir(path.dirname(RUN_INDEX_PATH), { recursive: true });
  await fs.writeFile(RUN_INDEX_PATH, JSON.stringify(idx, null, 2), 'utf8');
}

async function lookupProjectDir(runId: string): Promise<string | undefined> {
  try {
    const idx = JSON.parse(await fs.readFile(RUN_INDEX_PATH, 'utf8')) as Record<string, string>;
    return idx[runId];
  } catch {
    return undefined;
  }
}

function jsonResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'codex-orchestrator', version: '0.1.0' });
  const mode = resolveMode();

  // ---- start_project_loop ------------------------------------------------
  server.registerTool(
    'start_project_loop',
    {
      title: 'Start an autonomous Codex project loop',
      description:
        'Begin an autonomous loop: build a checklist from the goal, delegate the ' +
        'smallest milestone to Codex, verify, review the diff, and follow up until ' +
        'the goal passes or a max-iteration / max-runtime limit is hit. Returns a run_id.',
      inputSchema: {
        project_dir: z.string().describe('Absolute path to the project directory.'),
        goal_file: z.string().default('PROJECT_GOAL.md').describe('Goal file, relative to project_dir.'),
        max_iterations: z.number().int().positive().default(DEFAULT_MAX_ITERATIONS),
        verification_commands: z.array(z.string()).default([]),
        sandbox: z
          .enum(['read-only', 'workspace-write', 'danger-full-access'])
          .default(DEFAULT_SANDBOX),
        approval_policy: z
          .enum(['untrusted', 'on-failure', 'on-request', 'never'])
          .default(DEFAULT_APPROVAL_POLICY),
      },
    },
    async (args) => {
      try {
        validateSafetyConfig(args.sandbox, args.approval_policy);
        const runId = newRunId();
        const controller = new LoopController(
          runId,
          {
            projectDir: args.project_dir,
            goalFile: args.goal_file,
            maxIterations: args.max_iterations,
            maxRuntimeMs: resolveMaxRuntime(),
            verificationCommands: args.verification_commands,
            sandbox: args.sandbox,
            approvalPolicy: args.approval_policy,
            codexMode: mode,
          },
          createCodexClient({ mode }),
        );
        const initState = await controller.init();
        await indexRun(runId, args.project_dir);
        // Run the loop in the background unless it already paused at init.
        // NOTE: the registry entry is intentionally retained after completion so
        // get_loop_status/stop_loop can still read the final state in-memory.
        let promise: Promise<unknown> = Promise.resolve();
        if (initState.status === 'running') {
          promise = controller.runToCompletion().catch(async (err) => {
            const st = controller.getState();
            st.status = 'failed';
            st.stopReason = err instanceof Error ? err.message : String(err);
            st.finishedAt = new Date().toISOString();
            await controller.store.saveState(st);
          });
        }
        running.set(runId, { controller, promise });
        return jsonResult({
          run_id: runId,
          status: initState.status,
          mode,
          checklist_items: initState.checklist.length,
          checklist_path: controller.store.topChecklistPath,
          state_dir: controller.store.runDir,
          note:
            initState.status === 'paused_for_approval'
              ? 'Run paused at init for human approval; see pending_approval in get_loop_status.'
              : 'Loop running in background. Poll get_loop_status for progress.',
        });
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ---- codex_task --------------------------------------------------------
  server.registerTool(
    'codex_task',
    {
      title: 'Send one prompt to Codex',
      description:
        'Send a single prompt to the Codex worker and return its output plus the ' +
        'thread/session id. Outgoing prompts are guard-checked; a blocked prompt is ' +
        'NOT executed and is returned for human approval.',
      inputSchema: {
        project_dir: z.string(),
        prompt: z.string(),
        thread_id: z.string().optional().describe('Continue a prior Codex conversation.'),
      },
    },
    async (args) => {
      const guards = guardPrompt(args.prompt);
      if (hasBlock(guards)) {
        return jsonResult({
          status: 'blocked_pending_approval',
          guards: guards.filter((g) => g.triggered),
          note: 'Prompt tripped a safety guard and was NOT sent to Codex.',
        });
      }
      const client = createCodexClient({ mode });
      try {
        await client.start();
        const result = await client.runTask({
          projectDir: args.project_dir,
          prompt: args.prompt,
          threadId: args.thread_id,
          sandbox: DEFAULT_SANDBOX,
          approvalPolicy: DEFAULT_APPROVAL_POLICY,
          timeoutMs: DEFAULT_CODEX_TASK_TIMEOUT_MS,
        });
        return jsonResult({
          status: 'ok',
          mode,
          output: result.output,
          thread_id: result.threadId,
        });
      } catch (err) {
        return jsonResult({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      } finally {
        await client.stop();
      }
    },
  );

  // ---- review_current_state ---------------------------------------------
  server.registerTool(
    'review_current_state',
    {
      title: 'Review repo state against the goal',
      description:
        'Run git diff + the verification commands, compare to the goal checklist, ' +
        'and return remaining gaps and completion. Read-only; does not start a loop.',
      inputSchema: {
        project_dir: z.string(),
        goal_file: z.string().default('PROJECT_GOAL.md'),
        verification_commands: z.array(z.string()).default([]),
      },
    },
    async (args) => {
      try {
        const goalPath = path.resolve(args.project_dir, args.goal_file);
        const goalText = await fs.readFile(goalPath, 'utf8').catch(() => '');
        const checklist = parseGoalChecklist(goalText);
        const verification = await runVerification(
          args.project_dir,
          args.verification_commands,
          DEFAULT_CODEX_TASK_TIMEOUT_MS,
        );
        const diff = await getDiffStat(args.project_dir);
        const { review: reviewResult, checklist: updated } = await review(
          args.project_dir,
          checklist,
          verification,
          diff,
        );
        return jsonResult({
          complete: reviewResult.complete,
          checklist_completion: reviewResult.checklistCompletion,
          remaining_gaps: reviewResult.remainingGaps,
          satisfied: reviewResult.satisfied,
          verification: verification.map((v) => ({
            command: v.command,
            passed: v.passed,
            exit_code: v.exitCode,
          })),
          git_diff_summary: reviewResult.gitDiffSummary,
          checklist: updated,
        });
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ---- get_loop_status ---------------------------------------------------
  server.registerTool(
    'get_loop_status',
    {
      title: 'Get the status of a run',
      description:
        'Return current iteration, latest Codex output, latest verification result, ' +
        'and the next action for a run_id.',
      inputSchema: { run_id: z.string() },
    },
    async (args) => {
      try {
        const state = await loadRunState(args.run_id);
        if (!state) return jsonResult({ error: `Unknown run_id: ${args.run_id}` });
        const last = state.iterations[state.iterations.length - 1];
        return jsonResult({
          run_id: state.runId,
          status: state.status,
          current_iteration: state.currentIteration,
          max_iterations: state.maxIterations,
          checklist_completion:
            state.checklist.length === 0
              ? null
              : state.checklist.filter((i) => i.done).length / state.checklist.length,
          latest_codex_output: last?.codexOutput ?? null,
          latest_verification:
            last?.verification.map((v) => ({
              command: v.command,
              passed: v.passed,
              exit_code: v.exitCode,
            })) ?? [],
          remaining_gaps: last?.review?.remainingGaps ?? [],
          pending_approval: state.pendingApproval ?? null,
          next_action: nextAction(state),
          final_report_path: state.finishedAt ? new Store(state.projectDir, state.runId).finalReportPath : null,
        });
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ---- stop_loop ---------------------------------------------------------
  server.registerTool(
    'stop_loop',
    {
      title: 'Stop a running loop cleanly',
      description: 'Request a cooperative stop of a run_id; the loop halts after its current step.',
      inputSchema: { run_id: z.string() },
    },
    async (args) => {
      try {
        const entry = running.get(args.run_id);
        const state = await loadRunState(args.run_id);
        if (!state) return jsonResult({ error: `Unknown run_id: ${args.run_id}` });
        const store = new Store(state.projectDir, state.runId);
        await store.requestStop('stop_loop tool');
        if (entry) {
          await entry.promise; // wait for the loop to observe the flag and exit
        }
        const finalState = await loadRunState(args.run_id);
        return jsonResult({
          run_id: args.run_id,
          status: finalState?.status ?? state.status,
          note: entry ? 'Loop stopped.' : 'Stop flag written (loop not tracked in this process).',
        });
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  return server;
}

async function loadRunState(runId: string): Promise<RunState | undefined> {
  // 1) same-process registry (includes finished runs).
  const entry = running.get(runId);
  if (entry) return entry.controller.getState();
  // 2) persistent index -> exact project_dir -> on-disk state (survives restart).
  const projectDir = await lookupProjectDir(runId);
  if (projectDir) {
    try {
      return await Store.loadState(projectDir, runId);
    } catch {
      /* state file missing/corrupt */
    }
  }
  // 3) last resort: the server's own cwd.
  try {
    const ids = await Store.listRuns(process.cwd());
    if (ids.includes(runId)) return await Store.loadState(process.cwd(), runId);
  } catch {
    /* ignore */
  }
  return undefined;
}

function nextAction(state: RunState): string {
  switch (state.status) {
    case 'running':
      return 'continue loop (Codex working / verifying)';
    case 'paused_for_approval':
      return `awaiting human approval: ${state.pendingApproval?.detail ?? 'see pending_approval'}`;
    case 'completed':
      return 'none — goal met';
    case 'limit_reached':
      return `none — ${state.stopReason ?? 'limit reached'}`;
    case 'stopped':
      return 'none — stopped by operator';
    case 'failed':
      return `none — failed: ${state.stopReason ?? 'unknown error'}`;
    case 'initializing':
      return 'initializing';
  }
}

// ---- entrypoint ----------------------------------------------------------

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr (stdout is the MCP channel).
  process.stderr.write(
    `[codex-orchestrator] MCP server ready (mode=${resolveMode()}). 5 tools registered.\n`,
  );
}

// Run only when executed directly (not when imported by tests).
// Compare decoded filesystem paths so directories containing spaces work.
const isMain = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[codex-orchestrator] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
