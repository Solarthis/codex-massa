/**
 * loop.ts — Autonomous loop controller.
 *
 * Implements the specified behavior exactly:
 *   1. Read PROJECT_GOAL.md.
 *   2. Read relevant repo docs / manifests / tests.
 *   3. Produce an acceptance checklist -> .codex-orchestrator/checklist.md.
 *   4. Ask Codex to implement the smallest coherent milestone.
 *   5. Run verification commands.
 *   6. Review git diff against the checklist.
 *   7. If incomplete, send a targeted follow-up (passed / failed / files / errors).
 *   8. Repeat until completion OR a max-iteration / max-runtime limit.
 *   9. Produce a final report.
 *
 * Safety: guard checks run on the run config, every outgoing prompt, and every
 * observed diff. A hard-block guard pauses the loop for human approval. Both
 * iteration and runtime limits are enforced; the loop can never run forever.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_CODEX_TASK_TIMEOUT_MS,
  DEFAULT_GUARD_THRESHOLDS,
  DEFAULT_VERIFY_TIMEOUT_MS,
  validateSafetyConfig,
  type GuardThresholds,
} from './config.js';
import { guardDiff, guardPrompt, guardRunConfig, hasBlock } from './guards.js';
import { Store } from './store.js';
import { getDiffStat, review, runVerification } from './verifier.js';
import type {
  ApprovalPolicy,
  ChecklistItem,
  CodexClient,
  CodexMode,
  GuardResult,
  IterationDecision,
  IterationRecord,
  ReviewResult,
  RunState,
  SandboxMode,
  VerificationResult,
} from './types.js';

export function newRunId(): string {
  return `run-${randomUUID().slice(0, 8)}`;
}

export interface LoopParams {
  projectDir: string;
  goalFile: string;
  maxIterations: number;
  maxRuntimeMs: number;
  verificationCommands: string[];
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  codexMode: CodexMode;
}

export interface LoopOptions {
  guardThresholds?: GuardThresholds;
  taskTimeoutMs?: number;
  verifyTimeoutMs?: number;
  /**
   * If true, guard blocks are recorded but DO NOT pause the loop. This must
   * only be set by an explicit human-in-the-loop approval path; default false.
   */
  autoApproveGuards?: boolean;
  /** Optional progress callback (used by the CLI to stream output). */
  onEvent?: (line: string) => void;
}

const MAX_LOG_FIELD = 8000;
function trim(s: string, max = MAX_LOG_FIELD): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

export class LoopController {
  readonly runId: string;
  readonly store: Store;
  private readonly params: LoopParams;
  private readonly client: CodexClient;
  private readonly thresholds: GuardThresholds;
  private readonly taskTimeoutMs: number;
  private readonly verifyTimeoutMs: number;
  private readonly autoApproveGuards: boolean;
  private readonly onEvent: (line: string) => void;
  private state!: RunState;
  private deadline = Number.POSITIVE_INFINITY;

  constructor(
    runId: string,
    params: LoopParams,
    client: CodexClient,
    opts: LoopOptions = {},
  ) {
    this.runId = runId;
    this.params = params;
    this.client = client;
    this.store = new Store(params.projectDir, runId);
    this.thresholds = opts.guardThresholds ?? DEFAULT_GUARD_THRESHOLDS;
    this.taskTimeoutMs = opts.taskTimeoutMs ?? DEFAULT_CODEX_TASK_TIMEOUT_MS;
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    this.autoApproveGuards = opts.autoApproveGuards ?? false;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  getState(): RunState {
    return this.state;
  }

  // ---- initialization ----------------------------------------------------

  /** Steps 1–3: read goal, gather context, build + persist the checklist. */
  async init(): Promise<RunState> {
    const projectDir = path.resolve(this.params.projectDir);
    const maxIterations = Math.max(1, Math.floor(this.params.maxIterations));

    this.state = {
      runId: this.runId,
      status: 'initializing',
      projectDir,
      goalFile: this.params.goalFile,
      maxIterations,
      maxRuntimeMs: this.params.maxRuntimeMs,
      verificationCommands: this.params.verificationCommands,
      sandbox: this.params.sandbox,
      approvalPolicy: this.params.approvalPolicy,
      codexMode: this.params.codexMode,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentIteration: 0,
      checklist: [],
      iterations: [],
    };
    await this.store.ensureDirs();
    await this.store.clearStop();
    await this.store.appendEvent('run_started', 0, `run ${this.runId} initializing`, {
      params: this.params,
    });

    // Safety config validation + run-config guard.
    validateSafetyConfig(this.params.sandbox, this.params.approvalPolicy);
    const configGuards = guardRunConfig(this.params.sandbox, this.params.approvalPolicy);
    if (hasBlock(configGuards) && !this.autoApproveGuards) {
      await this.pause(configGuards, 'run configuration requires human approval');
      await this.store.saveState(this.state);
      return this.state;
    }

    // Step 1: read the goal file.
    const goalPath = path.resolve(projectDir, this.params.goalFile);
    let goalText: string;
    try {
      goalText = await fs.readFile(goalPath, 'utf8');
    } catch {
      throw new Error(
        `Goal file not found: ${goalPath}. Create ${this.params.goalFile} (see PROJECT_GOAL.md template).`,
      );
    }

    // Step 2: gather repo context (docs / manifests / tests).
    this.repoContext = await gatherRepoContext(projectDir);

    // Step 3: build + persist the acceptance checklist.
    this.goalText = goalText;
    this.state.checklist = parseGoalChecklist(goalText);
    await this.store.writeChecklist(this.params.goalFile, this.state.checklist);
    await this.store.appendEvent(
      'checklist_created',
      0,
      `built ${this.state.checklist.length} checklist item(s)`,
      { checklist: this.state.checklist },
    );
    this.emit(`📋 checklist: ${this.state.checklist.length} item(s) → ${this.store.topChecklistPath}`);

    this.state.status = 'running';
    await this.store.saveState(this.state);
    return this.state;
  }

  private repoContext = '';
  private goalText = '';

  // ---- main loop ---------------------------------------------------------

  /** Steps 4–9: iterate to completion or a limit, then write the final report. */
  async runToCompletion(): Promise<RunState> {
    if (this.state.status !== 'running') {
      // Either paused at init, or already terminal.
      if (this.state.status === 'paused_for_approval') return this.state;
    }

    this.deadline = Date.now() + this.params.maxRuntimeMs;
    await this.client.start();
    try {
      while (this.state.status === 'running') {
        // cooperative stop
        if (await this.store.isStopRequested()) {
          await this.finishRun('stopped', 'stop requested by operator');
          break;
        }
        // max-runtime limit
        if (Date.now() > this.deadline) {
          await this.finishRun('limit_reached', 'max runtime exceeded');
          break;
        }
        // max-iteration limit
        if (this.state.currentIteration >= this.state.maxIterations) {
          await this.finishRun('limit_reached', `max iterations (${this.state.maxIterations}) reached`);
          break;
        }

        const decision = await this.runOneIteration();
        if (decision === 'done') {
          await this.finishRun('completed', 'all checklist items satisfied and verification passed');
        } else if (decision === 'paused_for_approval') {
          // state.status already set to paused by pause()
          break;
        }
      }
    } finally {
      await this.client.stop();
      await this.store.saveState(this.state);
    }
    return this.state;
  }

  // ---- one iteration -----------------------------------------------------

  private async runOneIteration(): Promise<IterationDecision> {
    const iteration = this.state.currentIteration + 1;
    const startedAt = new Date().toISOString();
    const guardResults: GuardResult[] = [];
    this.emit(`\n── iteration ${iteration}/${this.state.maxIterations} ──`);

    // Build the prompt (step 4 initial, step 7 follow-up).
    const prompt =
      iteration === 1
        ? buildInitialPrompt(this.goalText, this.state, this.repoContext)
        : buildFollowupPrompt(this.state);

    // GUARD: outgoing prompt intent.
    const promptGuards = guardPrompt(prompt);
    guardResults.push(...promptGuards);
    if (hasBlock(promptGuards) && !this.autoApproveGuards) {
      const rec = this.baseRecord(iteration, startedAt, prompt, '', [], undefined, guardResults);
      rec.decision = 'paused_for_approval';
      rec.decisionReason = 'outgoing prompt tripped a safety guard';
      await this.commitIteration(rec);
      await this.pause(promptGuards, 'an outgoing prompt requires human approval');
      return 'paused_for_approval';
    }

    await this.store.appendEvent('prompt_sent', iteration, 'prompt sent to Codex', {
      prompt: trim(prompt),
    });
    this.emit(`→ codex (${this.client.mode}) prompt sent (${prompt.length} chars)`);

    // Step 4: ask Codex.
    let codexOutput = '';
    let codexThreadId = this.state.threadId;
    let taskError: string | undefined;
    try {
      const result = await this.client.runTask({
        projectDir: this.state.projectDir,
        prompt,
        threadId: this.state.threadId,
        sandbox: this.state.sandbox,
        approvalPolicy: this.state.approvalPolicy,
        timeoutMs: this.taskTimeoutMs,
      });
      codexOutput = result.output;
      codexThreadId = result.threadId ?? this.state.threadId;
      this.state.threadId = codexThreadId;
    } catch (err) {
      taskError = err instanceof Error ? err.message : String(err);
      codexOutput = `[codex task error] ${taskError}`;
    }
    await this.store.appendEvent('codex_response', iteration, 'Codex responded', {
      output: trim(codexOutput),
      threadId: codexThreadId,
      error: taskError,
    });
    this.emit(`← codex responded (${codexOutput.length} chars)${taskError ? ' [ERROR]' : ''}`);

    // Step 5: verification.
    const verification = await this.verify(iteration);

    // Step 6: review git diff against checklist + GUARD the diff.
    const diff = await getDiffStat(this.state.projectDir);
    const diffGuards = guardDiff(this.state.projectDir, diff, this.thresholds);
    guardResults.push(...diffGuards);
    if (diffGuards.some((g) => g.triggered)) {
      await this.store.appendEvent('guard', iteration, 'diff guard(s) triggered', diffGuards);
    }

    const { checklist, review: reviewResult } = await review(
      this.state.projectDir,
      this.state.checklist,
      verification,
      diff,
    );
    this.state.checklist = checklist;
    await this.store.writeChecklist(this.state.goalFile, checklist);
    await this.store.appendEvent('review', iteration, 'review complete', reviewResult);
    this.emit(
      `✔ review: ${(reviewResult.checklistCompletion * 100).toFixed(0)}% checklist, ` +
        `${reviewResult.complete ? 'COMPLETE' : `${reviewResult.remainingGaps.length} gap(s)`}`,
    );

    // Step 8 decision.
    let decision: IterationDecision;
    let decisionReason: string;
    if (hasBlock(diffGuards) && !this.autoApproveGuards) {
      decision = 'paused_for_approval';
      decisionReason = 'observed diff tripped a safety guard';
    } else if (reviewResult.complete) {
      decision = 'done';
      decisionReason = 'all checklist items satisfied and verification passed';
    } else {
      decision = 'continue';
      decisionReason = taskError
        ? `Codex task errored; will retry with a follow-up (${reviewResult.remainingGaps.length} gap(s))`
        : `${reviewResult.remainingGaps.length} gap(s) remain; sending a follow-up`;
    }

    const rec = this.baseRecord(
      iteration,
      startedAt,
      prompt,
      codexOutput,
      verification,
      reviewResult,
      guardResults,
    );
    rec.codexThreadId = codexThreadId;
    rec.decision = decision;
    rec.decisionReason = decisionReason;
    await this.commitIteration(rec);

    if (decision === 'paused_for_approval') {
      await this.pause(diffGuards, 'an observed change requires human approval');
    }
    return decision;
  }

  private async verify(iteration: number): Promise<VerificationResult[]> {
    const verification = await runVerification(
      this.state.projectDir,
      this.state.verificationCommands,
      this.verifyTimeoutMs,
    );
    // Trim captured output stored in the record/state to keep JSON manageable.
    for (const v of verification) {
      v.stdout = trim(v.stdout);
      v.stderr = trim(v.stderr);
    }
    const passed = verification.filter((v) => v.passed).length;
    await this.store.appendEvent('verification', iteration, `verification ${passed}/${verification.length} passed`, verification);
    this.emit(`🧪 verification: ${passed}/${verification.length} passed`);
    return verification;
  }

  private baseRecord(
    iteration: number,
    startedAt: string,
    prompt: string,
    codexOutput: string,
    verification: VerificationResult[],
    reviewResult: ReviewResult | undefined,
    guardResults: GuardResult[],
  ): IterationRecord {
    return {
      iteration,
      startedAt,
      finishedAt: new Date().toISOString(),
      prompt,
      codexOutput,
      verification,
      review: reviewResult,
      guardResults,
      decision: 'continue',
      decisionReason: '',
    };
  }

  private async commitIteration(rec: IterationRecord): Promise<void> {
    this.state.currentIteration = rec.iteration;
    this.state.iterations.push(rec);
    await this.store.writeIteration(rec);
    await this.store.appendEvent('decision', rec.iteration, `decision: ${rec.decision}`, {
      decision: rec.decision,
      reason: rec.decisionReason,
    });
    await this.store.saveState(this.state);
  }

  // ---- pause / finish ----------------------------------------------------

  private async pause(guards: GuardResult[], reason: string): Promise<void> {
    const blocks = guards.filter((g) => g.triggered && g.severity === 'block');
    this.state.status = 'paused_for_approval';
    this.state.pendingApproval = {
      reason,
      triggeredBy: blocks.map((g) => g.guard),
      detail: blocks.map((g) => g.message).join('; '),
      requestedAt: new Date().toISOString(),
    };
    // Await: the 'paused' record must be durably written before we return.
    await this.store.appendEvent('paused', this.state.currentIteration, reason, this.state.pendingApproval);
    this.emit(`⛔ PAUSED for approval: ${reason} — ${this.state.pendingApproval.detail}`);
  }

  private async finishRun(status: RunState['status'], reason: string): Promise<void> {
    this.state.status = status;
    this.state.stopReason = reason;
    this.state.finishedAt = new Date().toISOString();
    this.state.finalReport = buildFinalReport(this.state);
    // Await all terminal I/O so the final report/events are flushed before the
    // caller (CLI) can exit the process.
    await this.store.writeFinalReport(this.state.finalReport);
    await this.store.appendEvent('final_report', this.state.currentIteration, 'final report written');
    await this.store.appendEvent('run_finished', this.state.currentIteration, `run finished: ${status}`, { reason });
    this.emit(`\n🏁 ${status.toUpperCase()} — ${reason}`);
  }

  private emit(line: string): void {
    this.onEvent(line);
  }
}

// =========================================================================
// Repo context, checklist parsing, prompts, final report
// =========================================================================

/** Step 2: read relevant docs / manifests / tests into a context string. */
export async function gatherRepoContext(projectDir: string): Promise<string> {
  const root = path.resolve(projectDir);
  const docs = ['README.md', 'AGENTS.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
  const chunks: string[] = [];
  for (const name of docs) {
    try {
      const data = await fs.readFile(path.join(root, name), 'utf8');
      chunks.push(`### ${name}\n${trim(data, 1500)}`);
    } catch {
      /* not present */
    }
  }
  // list test files (best-effort, shallow)
  const tests: string[] = [];
  for (const dir of ['test', 'tests', '__tests__', 'src']) {
    try {
      const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && /\.(test|spec)\.[tj]sx?$/.test(e.name)) tests.push(`${dir}/${e.name}`);
      }
    } catch {
      /* no such dir */
    }
  }
  if (tests.length) chunks.push(`### existing tests\n${tests.join('\n')}`);
  return chunks.join('\n\n') || '(no standard docs/manifests/tests found)';
}

/**
 * Build the acceptance checklist from PROJECT_GOAL.md.
 * Preference order:
 *   1. A fenced ```checklist code block containing a JSON array of
 *      { id, text, check? } objects.
 *   2. Markdown task-list items ("- [ ] text") -> verification-gated items.
 *   3. A single fallback item "all verification commands pass".
 */
export function parseGoalChecklist(goalText: string): ChecklistItem[] {
  const fence = goalText.match(/```checklist\s*\n([\s\S]*?)\n```/);
  if (fence) {
    try {
      const arr = JSON.parse(fence[1]!) as Array<Partial<ChecklistItem>>;
      return arr.map((it, i) => ({
        id: it.id ?? `c${i + 1}`,
        text: it.text ?? `item ${i + 1}`,
        done: false,
        check: it.check,
      }));
    } catch {
      /* fall through to markdown parsing */
    }
  }

  const items: ChecklistItem[] = [];
  const re = /^[ \t]*[-*]\s+\[[ xX]\]\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(goalText)) !== null) {
    i++;
    items.push({ id: `c${i}`, text: m[1]!.trim(), done: false });
  }
  if (items.length) return items;

  return [{ id: 'c1', text: 'All configured verification commands pass', done: false }];
}

function checklistBlock(state: RunState): string {
  return state.checklist
    .map((i) => `- [${i.done ? 'x' : ' '}] (${i.id}) ${i.text}`)
    .join('\n');
}

export function buildInitialPrompt(goalText: string, state: RunState, repoContext: string): string {
  return [
    `You are an implementation worker driven by an orchestrator. Work ONLY inside the`,
    `project directory: ${state.projectDir}`,
    `Sandbox: ${state.sandbox}. Approval policy: ${state.approvalPolicy}.`,
    `Do NOT touch files outside the project, secrets/credentials, CI/infra, or global config.`,
    ``,
    `# Project goal (${state.goalFile})`,
    trim(goalText, 4000),
    ``,
    `# Acceptance checklist (what "done" means)`,
    checklistBlock(state),
    ``,
    `# Repository context`,
    trim(repoContext, 3000),
    ``,
    `# Your task this turn`,
    `Implement the SMALLEST coherent milestone that moves the project toward passing`,
    `the checklist. Prefer making the configured verification commands pass:`,
    state.verificationCommands.map((c) => `  - ${c}`).join('\n') || '  (none configured)',
    `Make focused edits. Then briefly summarize what you changed and which checklist`,
    `items you addressed.`,
  ].join('\n');
}

export function buildFollowupPrompt(state: RunState): string {
  const last = state.iterations[state.iterations.length - 1];
  const passed = (last?.verification ?? []).filter((v) => v.passed).map((v) => `  ✓ ${v.command}`);
  const failed = (last?.verification ?? [])
    .filter((v) => !v.passed)
    .map((v) => {
      const tail = (v.stderr || v.stdout || v.error || '').trim().split('\n').slice(-8).join('\n      ');
      return `  ✗ ${v.command} (exit ${v.exitCode})\n      ${tail}`;
    });
  const gaps = last?.review?.remainingGaps ?? [];

  return [
    `Continue working in ${state.projectDir}. Same safety constraints as before.`,
    ``,
    `# Status after your last change`,
    `Checklist:`,
    checklistBlock(state),
    ``,
    `Verification that PASSED:`,
    passed.length ? passed.join('\n') : '  (none)',
    ``,
    `Verification that FAILED (fix these):`,
    failed.length ? failed.join('\n') : '  (none)',
    ``,
    `Remaining gaps:`,
    gaps.length ? gaps.map((g) => `  - ${g}`).join('\n') : '  (none reported)',
    ``,
    `# Your task this turn`,
    `Fix the failures above and close the remaining gaps with the smallest coherent`,
    `change. Reference the exact files/tests you modify. Then summarize what you fixed.`,
  ].join('\n');
}

export function buildFinalReport(state: RunState): string {
  const done = state.checklist.filter((i) => i.done).length;
  const total = state.checklist.length;
  const lastReview = [...state.iterations].reverse().find((i) => i.review)?.review;
  const lines: string[] = [
    `# Final Report — ${state.runId}`,
    ``,
    `- Status: **${state.status}**${state.stopReason ? ` (${state.stopReason})` : ''}`,
    `- Project: ${state.projectDir}`,
    `- Goal file: ${state.goalFile}`,
    `- Codex mode: ${state.codexMode}`,
    `- Iterations run: ${state.currentIteration} / ${state.maxIterations}`,
    `- Started: ${state.startedAt}`,
    `- Finished: ${state.finishedAt ?? '(running)'}`,
    `- Checklist: ${done}/${total} satisfied`,
    ``,
    `## Checklist`,
    checklistBlock(state),
    ``,
  ];
  if (state.pendingApproval) {
    lines.push(`## ⛔ Pending human approval`);
    lines.push(`- Reason: ${state.pendingApproval.reason}`);
    lines.push(`- Triggered by: ${state.pendingApproval.triggeredBy.join(', ')}`);
    lines.push(`- Detail: ${state.pendingApproval.detail}`);
    lines.push('');
  }
  if (lastReview?.remainingGaps.length) {
    lines.push(`## Remaining gaps`);
    for (const g of lastReview.remainingGaps) lines.push(`- ${g}`);
    lines.push('');
  }
  lines.push(`## Iteration log`);
  for (const it of state.iterations) {
    lines.push(
      `- Iteration ${it.iteration}: ${it.decision} — ${it.decisionReason}` +
        ` (verification ${it.verification.filter((v) => v.passed).length}/${it.verification.length})`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
