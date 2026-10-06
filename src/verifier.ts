/**
 * verifier.ts — Reviewer / verifier.
 *
 * Runs the configured verification commands, captures a structured `git diff`,
 * evaluates each checklist item's machine check, and decides whether the run is
 * complete. Pure I/O against the project dir; holds no loop state.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  ChecklistItem,
  CheckSpec,
  DiffFileChange,
  DiffStat,
  ReviewResult,
  VerificationResult,
} from './types.js';

export interface CommandOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

/** Run a shell command in `cwd` with a hard timeout (kills the process group). */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true, // own process group so we can kill descendants on timeout
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const cap = 1_000_000; // cap captured output at ~1MB each stream

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    function finish(code: number | null, error?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        error,
      });
    }

    child.stdout?.on('data', (d) => {
      if (stdout.length < cap) stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < cap) stderr += d.toString();
    });
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });
}

/** Run a `git` invocation; returns trimmed stdout or null on failure. */
async function git(args: string[], cwd: string): Promise<string | null> {
  const res = await runCommand(`git ${args.join(' ')}`, cwd, 30_000);
  if (res.exitCode !== 0) return null;
  return res.stdout;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return out?.trim() === 'true';
}

async function hasHead(cwd: string): Promise<boolean> {
  const out = await git(['rev-parse', '--verify', 'HEAD'], cwd);
  return out !== null;
}

async function countLines(file: string): Promise<number> {
  try {
    // A git symlink is a path record, not permission to read its target.
    if (!(await fs.lstat(file)).isFile()) return 0;
    const data = await fs.readFile(file, 'utf8');
    if (data.length === 0) return 0;
    return data.split('\n').length - (data.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

/**
 * Capture the full working-tree change set relative to HEAD: tracked
 * modifications/deletions + untracked additions. The orchestrator never commits,
 * so this accumulates across iterations.
 */
export async function getDiffStat(projectDir: string): Promise<DiffStat> {
  const cwd = path.resolve(projectDir);
  if (!(await isGitRepo(cwd))) {
    return {
      files: [],
      totalAdded: 0,
      totalDeleted: 0,
      isGitRepo: false,
      rawSummary: '(not a git repository — diff-based review unavailable)',
    };
  }

  const headExists = await hasHead(cwd);
  const files: DiffFileChange[] = [];

  // numstat for tracked changes (added\tdeleted\tpath); binary => '-'
  const numstatRef = headExists ? 'HEAD' : '';
  const numstat = await git(
    ['diff', '--no-renames', '--numstat', '-z', ...(numstatRef ? [numstatRef] : [])],
    cwd,
  );
  const counts = new Map<string, { added: number; deleted: number }>();
  if (numstat) {
    for (const line of numstat.split('\0')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const added = parts[0] === '-' ? 0 : parseInt(parts[0]!, 10) || 0;
      const deleted = parts[1] === '-' ? 0 : parseInt(parts[1]!, 10) || 0;
      counts.set(parts.slice(2).join('\t'), { added, deleted });
    }
  }

  // porcelain status for the authoritative file+status list (incl. untracked)
  const status = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    cwd,
  );
  if (status) {
    for (const line of status.split('\0')) {
      if (!line.trim()) continue;
      const xy = line.slice(0, 2);
      // NUL-delimited porcelain leaves the filename exact, without C quoting.
      // Rename detection is disabled so both old/new paths remain reviewable.
      const p = line.slice(3);
      const isUntracked = xy === '??';
      const isDeleted = xy.includes('D');
      const statusLetter = isUntracked ? 'A' : xy.trim() || 'M';
      let added = counts.get(p)?.added ?? 0;
      let deleted = counts.get(p)?.deleted ?? 0;
      if (isUntracked) {
        added = await countLines(path.join(cwd, p));
        deleted = 0;
      }
      files.push({ path: p, status: isDeleted ? 'D' : statusLetter, added, deleted });
    }
  }

  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalDeleted = files.reduce((s, f) => s + f.deleted, 0);
  const statText =
    (await git(['diff', '--stat', ...(headExists ? ['HEAD'] : [])], cwd)) ?? '';
  const untracked = files
    .filter((f) => f.status === 'A' && !counts.has(f.path))
    .map((f) => ` ${f.path} | ${f.added} ++ (untracked)`)
    .join('\n');
  const rawSummary = [statText.trim(), untracked].filter(Boolean).join('\n') ||
    '(no changes)';

  return { files, totalAdded, totalDeleted, isGitRepo: true, rawSummary };
}

/** Run each verification command, capturing structured results. */
export async function runVerification(
  projectDir: string,
  commands: string[],
  timeoutMs: number,
): Promise<VerificationResult[]> {
  const cwd = path.resolve(projectDir);
  const results: VerificationResult[] = [];
  for (const command of commands) {
    const out = await runCommand(command, cwd, timeoutMs);
    results.push({
      command,
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      passed: out.exitCode === 0,
      durationMs: out.durationMs,
      error: out.error,
    });
  }
  return results;
}

/** Resolve an existing file only when both its lexical and real paths stay inside the project. */
async function projectCheckFile(cwd: string, requested: string): Promise<string | null> {
  try {
    const inside = (root: string, file: string): boolean => {
      const relative = path.relative(root, file);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const candidate = path.resolve(cwd, requested);
    if (!inside(cwd, candidate)) return null;
    const root = await fs.realpath(cwd);
    const real = await fs.realpath(candidate);
    if (!inside(root, real) || !(await fs.stat(real)).isFile()) return null;
    return real;
  } catch { return null; }
}

/** Evaluate a single checklist machine check against the repo. */
export async function evaluateCheck(
  projectDir: string,
  check: CheckSpec,
): Promise<boolean> {
  const cwd = path.resolve(projectDir);
  switch (check.type) {
    case 'fileExists': {
      try {
        return (await projectCheckFile(cwd, check.path)) !== null;
      } catch {
        return false;
      }
    }
    case 'fileContains': {
      try {
        const file = await projectCheckFile(cwd, check.path);
        if (file === null) return false;
        const data = await fs.readFile(file, 'utf8');
        try {
          return new RegExp(check.pattern).test(data);
        } catch {
          return data.includes(check.pattern);
        }
      } catch {
        return false;
      }
    }
    case 'command': {
      const out = await runCommand(check.command, cwd, 60_000);
      return out.exitCode === 0;
    }
  }
}

/**
 * Compare repo state to the checklist + verification results.
 * Returns an updated checklist (with done/evidence set) and a ReviewResult.
 *
 * Completion = every checklist item satisfied AND every verification command
 * passed, with at least one of {checklist, verification} present.
 */
export async function review(
  projectDir: string,
  checklist: ChecklistItem[],
  verification: VerificationResult[],
  diff: DiffStat,
): Promise<{ checklist: ChecklistItem[]; review: ReviewResult }> {
  const allVerificationPassed =
    verification.length === 0 || verification.every((v) => v.passed);

  const satisfied: string[] = [];
  const remainingGaps: string[] = [];
  const updated: ChecklistItem[] = [];

  for (const item of checklist) {
    let done: boolean;
    let evidence: string | undefined;
    if (item.check) {
      done = await evaluateCheck(projectDir, item.check);
      evidence = done ? describeCheck(item.check) : undefined;
    } else {
      // verification-gated item
      done = verification.length > 0 && allVerificationPassed;
      evidence = done ? 'all verification commands passed' : undefined;
    }
    updated.push({ ...item, done, evidence });
    if (done) satisfied.push(`${item.id}: ${item.text}`);
    else remainingGaps.push(`${item.id}: ${item.text}`);
  }

  // Surface failing verification commands as explicit gaps too.
  for (const v of verification) {
    if (!v.passed) {
      const detail = (v.stderr || v.stdout || v.error || '').trim().split('\n').slice(-3).join(' ');
      remainingGaps.push(`verification failed: \`${v.command}\` (exit ${v.exitCode})${detail ? ` — ${detail}` : ''}`);
    }
  }

  const allItemsDone = updated.every((i) => i.done);
  const hasSignal = checklist.length > 0 || verification.length > 0;
  const complete = hasSignal && allItemsDone && allVerificationPassed;
  const checklistCompletion =
    updated.length === 0 ? (allVerificationPassed ? 1 : 0) : updated.filter((i) => i.done).length / updated.length;

  return {
    checklist: updated,
    review: {
      remainingGaps,
      satisfied,
      checklistCompletion,
      complete,
      gitDiffSummary: diff.rawSummary,
    },
  };
}

function describeCheck(check: CheckSpec): string {
  switch (check.type) {
    case 'fileExists':
      return `file exists: ${check.path}`;
    case 'fileContains':
      return `file ${check.path} matches /${check.pattern}/`;
    case 'command':
      return `command passed: ${check.command}`;
  }
}

