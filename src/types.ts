/**
 * types.ts — Shared TypeScript types and JSON state shapes.
 *
 * Everything the orchestrator persists or passes between modules is described
 * here. All inter-module data is structured JSON; these types are the single
 * source of truth for that JSON.
 */

/** Codex sandbox modes (exact strings accepted by the Codex CLI `--sandbox`). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Codex approval policies (exact strings accepted by `--ask-for-approval`). */
export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

/** Which transport the Codex client is using. */
export type CodexMode = 'mock' | 'mcp-server' | 'exec';

/**
 * A machine check the reviewer can evaluate to decide if an item is satisfied.
 * Items without a check are "verification-gated": satisfied iff all configured
 * verification commands pass.
 */
export type CheckSpec =
  | { type: 'fileExists'; path: string }
  | { type: 'fileContains'; path: string; pattern: string }
  | { type: 'command'; command: string };

/** A single acceptance-checklist item derived from the project goal. */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  /** Optional deterministic check the reviewer evaluates against the repo. */
  check?: CheckSpec;
  /** Free-text evidence captured when the reviewer marks the item done. */
  evidence?: string;
}

/** Result of running one configured verification command. */
export interface VerificationResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
  /** Set when the command could not be spawned / timed out, etc. */
  error?: string;
}

/** One changed file in a git diff. */
export interface DiffFileChange {
  /** Path relative to the repo root (or absolute if outside — flagged by guards). */
  path: string;
  /** git status letter: A(dded) M(odified) D(eleted) R(enamed) C(opied) ... */
  status: string;
  added: number;
  deleted: number;
}

/** Aggregate git diff information used by the reviewer and guards. */
export interface DiffStat {
  files: DiffFileChange[];
  totalAdded: number;
  totalDeleted: number;
  /** Whether the project dir is a git repository at all. */
  isGitRepo: boolean;
  /** Raw `git diff --stat`-style text for the iteration log. */
  rawSummary: string;
}

/** Output of the reviewer comparing repo state to the checklist. */
export interface ReviewResult {
  /** Checklist items still not satisfied. */
  remainingGaps: string[];
  /** Checklist items judged satisfied this review. */
  satisfied: string[];
  /** 0..1 fraction of checklist items done. */
  checklistCompletion: number;
  /** True when all checklist items are done AND all verification passed. */
  complete: boolean;
  /** Short summary of `git diff` for the iteration log. */
  gitDiffSummary: string;
}

/** A guard evaluation against a proposed/observed action. */
export interface GuardResult {
  guard: string;
  triggered: boolean;
  severity: 'block' | 'warn';
  message: string;
}

/** A request for human approval that pauses the loop. */
export interface ApprovalRequest {
  reason: string;
  /** The guard(s) that forced the pause. */
  triggeredBy: string[];
  detail: string;
  requestedAt: string;
}

/** The decision the loop controller made at the end of an iteration. */
export type IterationDecision =
  | 'continue'
  | 'done'
  | 'paused_for_approval'
  | 'limit_reached'
  | 'failed';

/** A full record of one loop iteration (also written to its own log file). */
export interface IterationRecord {
  iteration: number;
  startedAt: string;
  finishedAt?: string;
  /** Exact prompt sent to Codex this iteration. */
  prompt: string;
  /** Final assistant text returned by Codex. */
  codexOutput: string;
  /** Codex conversation/session id used or returned. */
  codexThreadId?: string;
  verification: VerificationResult[];
  review?: ReviewResult;
  guardResults: GuardResult[];
  decision: IterationDecision;
  /** Human-readable note about why this decision was taken. */
  decisionReason: string;
}

export type RunStatus =
  | 'initializing'
  | 'running'
  | 'paused_for_approval'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'limit_reached';

/** The complete persisted state of one orchestration run. */
export interface RunState {
  runId: string;
  status: RunStatus;
  /** Absolute project directory the loop operates in. */
  projectDir: string;
  /** Goal file path, relative to projectDir. */
  goalFile: string;
  maxIterations: number;
  maxRuntimeMs: number;
  verificationCommands: string[];
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  codexMode: CodexMode;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  currentIteration: number;
  /** Codex conversation/session id threaded across iterations. */
  threadId?: string;
  checklist: ChecklistItem[];
  /** Lightweight per-iteration summaries (full detail lives in log files). */
  iterations: IterationRecord[];
  pendingApproval?: ApprovalRequest;
  finalReport?: string;
  stopReason?: string;
}

/** Input to the Codex client's single `runTask` method. */
export interface CodexTaskInput {
  projectDir: string;
  prompt: string;
  /** Conversation/session id to continue a prior Codex turn. */
  threadId?: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  /** Per-call timeout; the client must not hang forever. */
  timeoutMs: number;
}

/** Result returned by the Codex client. */
export interface CodexTaskResult {
  /** Final assistant text. */
  output: string;
  /** Conversation/session id to thread the next turn. */
  threadId?: string;
  /** Raw transcript/events for logging (mode-specific). */
  raw?: unknown;
}

/** One interface, three implementations: mock, mcp-server, exec. */
export interface CodexClient {
  readonly mode: CodexMode;
  /** Establish transport (no-op for exec/mock). Must be called before runTask. */
  start(): Promise<void>;
  runTask(input: CodexTaskInput): Promise<CodexTaskResult>;
  /** Tear down transport / child process. */
  stop(): Promise<void>;
}
