/**
 * guards.ts — Explicit safety guard checks (NOT comments).
 *
 * The orchestrator must refuse or pause for human approval when a task would:
 *   - delete large parts of the repo
 *   - modify files outside the project
 *   - access secrets
 *   - purchase paid services
 *   - deploy to production
 *   - change auth/security-critical settings
 *   - use `danger-full-access`
 *
 * Guards run at three points:
 *   1. guardRunConfig  — before the loop starts (sandbox/approval combo).
 *   2. guardPrompt     — on every prompt about to be sent to Codex (intent).
 *   3. guardDiff       — on the git diff Codex produced (observed effect).
 *
 * Any `block`-severity GuardResult pauses the loop for human approval.
 */

import * as path from 'node:path';
import { DANGER_SANDBOX, type GuardThresholds } from './config.js';
import type {
  ApprovalPolicy,
  DiffStat,
  GuardResult,
  SandboxMode,
} from './types.js';

function blocked(guard: string, message: string): GuardResult {
  return { guard, triggered: true, severity: 'block', message };
}
function warn(guard: string, message: string): GuardResult {
  return { guard, triggered: true, severity: 'warn', message };
}

/** True if any guard result is a hard block. */
export function hasBlock(results: GuardResult[]): boolean {
  return results.some((r) => r.triggered && r.severity === 'block');
}

// ---- 1. run config -------------------------------------------------------

export function guardRunConfig(
  sandbox: SandboxMode,
  approvalPolicy: ApprovalPolicy,
): GuardResult[] {
  const out: GuardResult[] = [];
  if (sandbox === DANGER_SANDBOX) {
    out.push(
      blocked(
        'danger-full-access',
        `sandbox="${DANGER_SANDBOX}" grants full filesystem access; requires human approval.`,
      ),
    );
  }
  if (sandbox !== 'workspace-write' && approvalPolicy === 'never') {
    out.push(
      warn(
        'unattended-outside-workspace',
        `approval_policy="never" with sandbox="${sandbox}" runs unattended outside the workspace confinement.`,
      ),
    );
  }
  return out;
}

// ---- 2. prompt intent ----------------------------------------------------

interface IntentRule {
  guard: string;
  /** Pattern signalling a forbidden/risky intent. */
  re: RegExp;
  message: string;
}

const PROMPT_INTENT_RULES: IntentRule[] = [
  {
    guard: 'deploy-to-production',
    re: /\b(deploy|ship|publish|release|roll\s?out|promote)\b[^.\n]{0,40}\b(prod|production|live|mainnet)\b|\b(vercel|netlify)\b[^.\n]{0,20}--prod|\bkubectl\s+apply\b|\bterraform\s+apply\b|\bgit\s+push\b[^.\n]{0,30}\b(prod|production|origin\s+main)\b/i,
    message: 'prompt asks to deploy/release to production.',
  },
  {
    guard: 'purchase-paid-service',
    re: /\b(purchase|buy|order|check\s?out|pay\s+for|subscribe\s+to|charge\s+(the\s+)?card|stripe\s+(charge|payment)|enter\s+(credit\s+)?card)\b/i,
    message: 'prompt asks to purchase a paid service or move money.',
  },
  {
    guard: 'access-secrets',
    // Match read/exfiltrate verbs near secret keywords; a separate alternative
    // catches bare "cat .env" / "cat secrets" (where a dot follows the verb).
    re: /\b(read|print|cat|exfiltrate|leak|send|upload)\b[\s\S]{0,40}?(secret|secrets|credential|credentials|api[_\s-]?key|access[_\s-]?token|private\s+key|\.env|password)\b|\b(cat|less|head|tail|type)\s+[^\n]{0,30}\.env\b|~\/\.(ssh|aws|codex|config)\b|\bid_rsa\b/i,
    message: 'prompt asks to access or exfiltrate secrets/credentials.',
  },
  {
    guard: 'auth-security-change',
    re: /\b(disable|bypass|weaken|turn\s+off|remove)\b[^.\n]{0,40}\b(auth|authentication|authorization|2fa|mfa|encryption|tls|ssl|firewall|cors|csrf|rbac|permission|security)\b/i,
    message: 'prompt asks to weaken/disable an auth or security control.',
  },
  {
    guard: 'danger-full-access',
    re: /danger-full-access|--dangerously-bypass-approvals-and-sandbox|--yolo\b/i,
    message: 'prompt requests danger-full-access / sandbox bypass.',
  },
  {
    guard: 'mass-delete',
    re: /\brm\s+-rf\s+(\/(?:\s|$)|~|\.\.|\*)|\bgit\s+clean\s+-[a-z]*x[a-z]*d|\bdelete\s+(the\s+)?(entire|whole|all)\b[^.\n]{0,20}\b(repo|repository|project|directory)\b/i,
    message: 'prompt asks to delete large parts of the repo / dangerous rm.',
  },
];

export function guardPrompt(prompt: string): GuardResult[] {
  const out: GuardResult[] = [];
  for (const rule of PROMPT_INTENT_RULES) {
    if (rule.re.test(prompt)) out.push(blocked(rule.guard, rule.message));
  }
  return out;
}

// ---- 3. observed diff ----------------------------------------------------

/** Path patterns that, if changed, indicate secrets/auth-critical files. */
const SECRET_PATH_RES: RegExp[] = [
  /(^|\/)\.env(\.[\w.-]+)?$/i,
  /(^|\/)secrets?(\/|$)/i,
  /(^|\/)credentials?(\.|\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_rsa\b/i,
  /\.(pem|key|pfx|p12|keystore)$/i,
  /(^|\/)\.git\/config$/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
];

/** Path fragments that indicate auth/security-critical settings. */
const AUTH_PATH_RE =
  /(^|\/)(auth|authz|authentication|authorization|security|iam|rbac|firewall|cors)[\w.-]*(\.|\/|$)/i;

export function guardDiff(
  projectDir: string,
  diff: DiffStat,
  thresholds: GuardThresholds,
): GuardResult[] {
  const out: GuardResult[] = [];
  const root = path.resolve(projectDir);

  // (a) modifications outside the project root
  for (const f of diff.files) {
    const abs = path.resolve(root, f.path);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      out.push(
        blocked(
          'outside-project',
          `change touches a path outside the project root: ${f.path}`,
        ),
      );
    }
  }

  // (b) large deletions
  const deletedFiles = diff.files.filter((f) => f.status.startsWith('D'));
  if (deletedFiles.length > thresholds.maxDeletedFiles) {
    out.push(
      blocked(
        'mass-delete',
        `deletes ${deletedFiles.length} files (threshold ${thresholds.maxDeletedFiles}).`,
      ),
    );
  }
  if (diff.totalDeleted > thresholds.maxDeletedLines) {
    out.push(
      blocked(
        'mass-delete',
        `removes ${diff.totalDeleted} lines (threshold ${thresholds.maxDeletedLines}).`,
      ),
    );
  }

  // (c) secrets / credentials touched
  for (const f of diff.files) {
    if (SECRET_PATH_RES.some((re) => re.test(f.path))) {
      out.push(
        blocked('access-secrets', `change touches a secret/credential file: ${f.path}`),
      );
    }
  }

  // (d) auth/security-critical files touched (warn — surfaced in the log)
  for (const f of diff.files) {
    if (AUTH_PATH_RE.test(f.path) && !SECRET_PATH_RES.some((re) => re.test(f.path))) {
      out.push(
        warn('auth-security-change', `change touches an auth/security-related file: ${f.path}`),
      );
    }
  }

  return out;
}
