/**
 * config.ts — Defaults, limits, and Codex-CLI launch settings.
 *
 * Everything version-dependent about the Codex CLI lives here so it can be
 * overridden without touching the client code. Values are confirmed against the
 * documented OpenAI Codex CLI interface; see README "Codex CLI compatibility".
 */

import type { ApprovalPolicy, SandboxMode } from './types.js';

// ---- Safety defaults (hard requirements from the spec) -------------------

/** Default sandbox MUST be workspace-write. */
export const DEFAULT_SANDBOX: SandboxMode = 'workspace-write';

/** Default approval policy MUST be `never` (only valid inside the workspace). */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = 'never';

/** The sandbox value that always requires human approval. */
export const DANGER_SANDBOX: SandboxMode = 'danger-full-access';

// ---- Loop limits (must never loop indefinitely) --------------------------

export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000; // 30 minutes
/** Per-Codex-call timeout so a single task can never hang the loop forever. */
export const DEFAULT_CODEX_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
/** Per-verification-command timeout. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** How often the loop polls the cooperative stop flag between long steps. */
export const STOP_POLL_INTERVAL_MS = 1000;

// ---- Guard thresholds ----------------------------------------------------

export interface GuardThresholds {
  /** Pause if a single iteration deletes more than this many files. */
  maxDeletedFiles: number;
  /** Pause if a single iteration deletes more than this many lines total. */
  maxDeletedLines: number;
}

export const DEFAULT_GUARD_THRESHOLDS: GuardThresholds = {
  maxDeletedFiles: 5,
  maxDeletedLines: 500,
};

// ---- Codex CLI launch settings (version-dependent) -----------------------

export interface CodexCliConfig {
  /** Executable name / path. */
  bin: string;
  /** Subcommand+args to launch Codex as an MCP server over stdio. */
  mcpServerArgs: string[];
  /** Tool name to START a Codex conversation. */
  mcpStartTool: string;
  /** Tool name to CONTINUE a Codex conversation. */
  mcpReplyTool: string;
  /** Subcommand for one-shot non-interactive runs (exec fallback). */
  execArgs: string[];
  /** Flag that switches `codex exec` to JSONL event output. */
  execJsonFlag: string;
}

/**
 * Defaults built against the documented Codex CLI interface.
 * Override per-version via the orchestrator config if a future Codex renames
 * these (see README "Codex CLI compatibility").
 */
export const DEFAULT_CODEX_CLI: CodexCliConfig = {
  bin: process.env.CODEX_BIN ?? 'codex',
  mcpServerArgs: ['mcp-server'],
  mcpStartTool: 'codex',
  mcpReplyTool: 'codex-reply',
  execArgs: ['exec'],
  execJsonFlag: '--json',
};

// ---- Validation ----------------------------------------------------------

export class ConfigError extends Error {}

/**
 * Validate the requested sandbox/approval combination.
 * `never` approval is only permitted when the sandbox confines writes to the
 * workspace; with danger-full-access we never run unattended.
 */
export function validateSafetyConfig(
  sandbox: SandboxMode,
  approvalPolicy: ApprovalPolicy,
): void {
  if (sandbox === DANGER_SANDBOX && approvalPolicy === 'never') {
    throw new ConfigError(
      `Refusing to run with sandbox="${DANGER_SANDBOX}" and approval_policy="never": ` +
        `full filesystem access unattended is not allowed. Use sandbox="workspace-write" ` +
        `or set approval_policy to "on-request"/"untrusted" and supervise the run.`,
    );
  }
}
