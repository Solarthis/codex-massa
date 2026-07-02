/**
 * store.ts — Logging + state store.
 *
 * Owns the on-disk `.codex-orchestrator/` layout. All run state is structured
 * JSON; every prompt, Codex response, verification output, and decision is
 * appended to a JSONL event log AND mirrored into a human-readable per-iteration
 * Markdown file.
 *
 *   <projectDir>/.codex-orchestrator/
 *   ├── checklist.md                 (spec-mandated path; latest run's checklist)
 *   └── runs/<runId>/
 *       ├── state.json               (persisted RunState — source of truth)
 *       ├── checklist.md             (per-run copy)
 *       ├── events.jsonl             (append-only structured event log)
 *       ├── final-report.md
 *       ├── stop.flag                (presence => cooperative stop requested)
 *       └── iterations/
 *           ├── iter-001.json / iter-001.md
 *           └── ...
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  ChecklistItem,
  IterationRecord,
  RunState,
} from './types.js';

export const STATE_DIR_NAME = '.codex-orchestrator';

export type EventType =
  | 'run_started'
  | 'checklist_created'
  | 'prompt_sent'
  | 'codex_response'
  | 'verification'
  | 'review'
  | 'guard'
  | 'decision'
  | 'paused'
  | 'resumed'
  | 'final_report'
  | 'run_finished';

export interface LogEvent {
  ts: string;
  type: EventType;
  iteration: number;
  message: string;
  data?: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** Atomic write: write to a temp file then rename over the target. */
async function writeFileAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, file);
}

export class Store {
  readonly projectDir: string;
  readonly runId: string;
  readonly stateRoot: string;
  readonly runDir: string;
  readonly iterationsDir: string;

  constructor(projectDir: string, runId: string) {
    this.projectDir = path.resolve(projectDir);
    this.runId = runId;
    this.stateRoot = path.join(this.projectDir, STATE_DIR_NAME);
    this.runDir = path.join(this.stateRoot, 'runs', runId);
    this.iterationsDir = path.join(this.runDir, 'iterations');
  }

  async ensureDirs(): Promise<void> {
    await fs.mkdir(this.iterationsDir, { recursive: true });
  }

  // ---- paths -------------------------------------------------------------

  get statePath(): string {
    return path.join(this.runDir, 'state.json');
  }
  get eventsPath(): string {
    return path.join(this.runDir, 'events.jsonl');
  }
  get topChecklistPath(): string {
    return path.join(this.stateRoot, 'checklist.md');
  }
  get runChecklistPath(): string {
    return path.join(this.runDir, 'checklist.md');
  }
  get finalReportPath(): string {
    return path.join(this.runDir, 'final-report.md');
  }
  get stopFlagPath(): string {
    return path.join(this.runDir, 'stop.flag');
  }

  // ---- state -------------------------------------------------------------

  async saveState(state: RunState): Promise<void> {
    state.updatedAt = nowIso();
    await this.ensureDirs();
    await writeFileAtomic(this.statePath, JSON.stringify(state, null, 2));
  }

  async loadState(): Promise<RunState> {
    const raw = await fs.readFile(this.statePath, 'utf8');
    return JSON.parse(raw) as RunState;
  }

  /** Load a run's state without constructing a controller (cross-process). */
  static async loadState(projectDir: string, runId: string): Promise<RunState> {
    return new Store(projectDir, runId).loadState();
  }

  /** List run ids found under a project's state dir, newest first by mtime. */
  static async listRuns(projectDir: string): Promise<string[]> {
    const runsDir = path.join(path.resolve(projectDir), STATE_DIR_NAME, 'runs');
    let entries: string[];
    try {
      entries = await fs.readdir(runsDir);
    } catch {
      return [];
    }
    const withTimes = await Promise.all(
      entries.map(async (id) => {
        try {
          const st = await fs.stat(path.join(runsDir, id));
          return { id, mtime: st.mtimeMs };
        } catch {
          return { id, mtime: 0 };
        }
      }),
    );
    return withTimes.sort((a, b) => b.mtime - a.mtime).map((e) => e.id);
  }

  // ---- events ------------------------------------------------------------

  async appendEvent(
    type: EventType,
    iteration: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    await this.ensureDirs();
    const event: LogEvent = { ts: nowIso(), type, iteration, message, data };
    await fs.appendFile(this.eventsPath, JSON.stringify(event) + '\n', 'utf8');
  }

  async readEvents(): Promise<LogEvent[]> {
    try {
      const raw = await fs.readFile(this.eventsPath, 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as LogEvent);
    } catch {
      return [];
    }
  }

  // ---- checklist ---------------------------------------------------------

  async writeChecklist(goalFile: string, items: ChecklistItem[]): Promise<void> {
    await this.ensureDirs();
    const md = renderChecklistMarkdown(this.runId, goalFile, items);
    await writeFileAtomic(this.runChecklistPath, md);
    // spec-mandated top-level path:
    await writeFileAtomic(this.topChecklistPath, md);
  }

  // ---- iterations --------------------------------------------------------

  async writeIteration(record: IterationRecord): Promise<void> {
    await this.ensureDirs();
    const base = path.join(this.iterationsDir, `iter-${pad3(record.iteration)}`);
    await writeFileAtomic(`${base}.json`, JSON.stringify(record, null, 2));
    await writeFileAtomic(`${base}.md`, renderIterationMarkdown(record));
  }

  // ---- final report ------------------------------------------------------

  async writeFinalReport(markdown: string): Promise<void> {
    await this.ensureDirs();
    await writeFileAtomic(this.finalReportPath, markdown);
  }

  // ---- cooperative stop --------------------------------------------------

  async requestStop(reason: string): Promise<void> {
    await this.ensureDirs();
    await fs.writeFile(this.stopFlagPath, `${nowIso()} ${reason}\n`, 'utf8');
  }

  async isStopRequested(): Promise<boolean> {
    try {
      await fs.access(this.stopFlagPath);
      return true;
    } catch {
      return false;
    }
  }

  async clearStop(): Promise<void> {
    try {
      await fs.rm(this.stopFlagPath);
    } catch {
      /* nothing to clear */
    }
  }
}

// ---- markdown renderers --------------------------------------------------

function renderChecklistMarkdown(
  runId: string,
  goalFile: string,
  items: ChecklistItem[],
): string {
  const lines: string[] = [
    `# Acceptance Checklist`,
    ``,
    `- Run: \`${runId}\``,
    `- Goal file: \`${goalFile}\``,
    `- Generated: ${nowIso()}`,
    ``,
  ];
  for (const item of items) {
    const box = item.done ? '[x]' : '[ ]';
    lines.push(`- ${box} **${item.id}** — ${item.text}`);
    if (item.evidence) lines.push(`  - evidence: ${item.evidence}`);
  }
  lines.push('');
  return lines.join('\n');
}

function truncate(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

function renderIterationMarkdown(r: IterationRecord): string {
  const lines: string[] = [
    `# Iteration ${r.iteration}`,
    ``,
    `- Started: ${r.startedAt}`,
    `- Finished: ${r.finishedAt ?? '(in progress)'}`,
    `- Decision: **${r.decision}** — ${r.decisionReason}`,
    ``,
    `## Prompt sent to Codex`,
    '```',
    truncate(r.prompt),
    '```',
    ``,
    `## Codex response` + (r.codexThreadId ? ` (thread: \`${r.codexThreadId}\`)` : ''),
    '```',
    truncate(r.codexOutput),
    '```',
    ``,
    `## Verification`,
  ];
  if (r.verification.length === 0) {
    lines.push('_(no verification commands configured)_');
  } else {
    for (const v of r.verification) {
      lines.push(
        `- \`${v.command}\` → ${v.passed ? '✅ pass' : '❌ fail'} (exit ${v.exitCode}, ${v.durationMs}ms)`,
      );
      if (!v.passed) {
        const tail = (v.stderr || v.stdout || v.error || '').trim();
        if (tail) {
          lines.push('  ```');
          lines.push('  ' + truncate(tail, 1500).split('\n').join('\n  '));
          lines.push('  ```');
        }
      }
    }
  }
  lines.push('');
  if (r.review) {
    lines.push(`## Review`);
    lines.push(
      `- Checklist completion: ${(r.review.checklistCompletion * 100).toFixed(0)}%`,
    );
    lines.push(`- Complete: ${r.review.complete ? 'yes' : 'no'}`);
    if (r.review.satisfied.length) {
      lines.push(`- Satisfied this iteration:`);
      for (const s of r.review.satisfied) lines.push(`  - ${s}`);
    }
    if (r.review.remainingGaps.length) {
      lines.push(`- Remaining gaps:`);
      for (const g of r.review.remainingGaps) lines.push(`  - ${g}`);
    }
    lines.push('');
    lines.push(`### git diff summary`);
    lines.push('```');
    lines.push(truncate(r.review.gitDiffSummary, 3000));
    lines.push('```');
    lines.push('');
  }
  if (r.guardResults.some((g) => g.triggered)) {
    lines.push(`## Guards triggered`);
    for (const g of r.guardResults.filter((x) => x.triggered)) {
      lines.push(`- [${g.severity}] **${g.guard}** — ${g.message}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
