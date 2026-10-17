/**
 * codex-client.ts — Codex worker behind one interface, three implementations.
 *
 *   MockCodexClient  — no network, deterministic; applies a scripted plan of
 *                      file writes/deletes so the full loop can be proven.
 *   McpCodexClient   — PRIMARY path: drives `codex mcp-server` over stdio using
 *                      the official MCP SDK client.
 *   ExecCodexClient  — FALLBACK only: shells out to `codex exec --json` and
 *                      parses the JSONL event stream.
 *
 * All version-dependent Codex names (subcommands, tool names, flags) come from
 * config.DEFAULT_CODEX_CLI so they can be reconciled in one place per Codex
 * version. Live calls are only reachable when codexMode !== 'mock'.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  DEFAULT_CODEX_CLI,
  type CodexCliConfig,
} from './config.js';
import { runCommand } from './verifier.js';
import type {
  CodexClient,
  CodexMode,
  CodexTaskInput,
  CodexTaskResult,
} from './types.js';

// =========================================================================
// Mock
// =========================================================================

export interface MockFileWrite {
  path: string;
  content: string;
}

export interface MockStep {
  /** The "assistant" message Codex would return for this turn. */
  message: string;
  writeFiles?: MockFileWrite[];
  deleteFiles?: string[];
}

export interface MockOptions {
  /** Scripted steps; step N applied on the N-th runTask call. */
  plan?: MockStep[];
  /**
   * If no inline plan is given, load steps from this JSON file (relative to
   * projectDir) the first time runTask is called. Shape: { steps: MockStep[] }.
   * Defaults to "mock-plan.json".
   */
  planFile?: string;
  /** Artificial per-call latency (used in tests to exercise the runtime limit). */
  delayMs?: number;
}

export class MockCodexClient implements CodexClient {
  readonly mode: CodexMode = 'mock';
  private plan: MockStep[] | undefined;
  private readonly planFile: string;
  private readonly delayMs: number;
  private callIndex = 0;
  private readonly threadId = 'mock-thread-0001';

  constructor(opts: MockOptions = {}) {
    this.plan = opts.plan;
    this.planFile = opts.planFile ?? 'mock-plan.json';
    this.delayMs = opts.delayMs ?? 0;
  }

  async start(): Promise<void> {
    /* nothing to start */
  }

  async stop(): Promise<void> {
    /* nothing to stop */
  }

  private async ensurePlan(projectDir: string): Promise<MockStep[]> {
    if (this.plan) return this.plan;
    const file = path.resolve(projectDir, this.planFile);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as { steps?: MockStep[] };
      this.plan = Array.isArray(parsed.steps) ? parsed.steps : [];
    } catch {
      this.plan = [];
    }
    return this.plan;
  }

  async runTask(input: CodexTaskInput): Promise<CodexTaskResult> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const plan = await this.ensurePlan(input.projectDir);
    const step = plan[this.callIndex];
    this.callIndex++;

    if (!step) {
      return {
        output:
          '[mock] No further scripted changes. Reporting current state as final.',
        threadId: this.threadId,
        raw: { mock: true, callIndex: this.callIndex, noop: true },
      };
    }

    const applied: string[] = [];
    for (const w of step.writeFiles ?? []) {
      const abs = path.resolve(input.projectDir, w.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, w.content, 'utf8');
      applied.push(`wrote ${w.path}`);
    }
    for (const d of step.deleteFiles ?? []) {
      const abs = path.resolve(input.projectDir, d);
      try {
        await fs.rm(abs, { recursive: false });
        applied.push(`deleted ${d}`);
      } catch {
        applied.push(`could not delete ${d} (missing)`);
      }
    }

    const output = `${step.message}\n\n[mock actions] ${applied.join('; ') || 'no file changes'}`;
    return {
      output,
      threadId: this.threadId,
      raw: { mock: true, callIndex: this.callIndex, applied },
    };
  }
}

// =========================================================================
// MCP server (primary)
// =========================================================================

/** Tolerantly pull a conversation/session/thread id out of any object tree. */
function findThreadId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value == null) return undefined;
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        typeof v === 'string' &&
        /^(conversation|session|thread)_?id$/i.test(k) &&
        v.length > 0
      ) {
        return v;
      }
    }
    for (const v of Object.values(value as Record<string, unknown>)) {
      const found = findThreadId(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Extract assistant text from an MCP tool-call result. Codex puts the answer in
 * `structuredContent.content` and mirrors it in the `content[]` text blocks.
 */
function extractText(result: unknown): string {
  const r = result as {
    structuredContent?: { content?: unknown };
    content?: Array<{ type?: string; text?: string }>;
  };
  const sc = r?.structuredContent?.content;
  if (typeof sc === 'string' && sc.trim()) return sc.trim();
  if (Array.isArray(r?.content)) {
    return r.content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
      .trim();
  }
  return '';
}

/** Codex returns the session id in `structuredContent.threadId`. */
function extractThreadId(result: unknown): string | undefined {
  const r = result as { structuredContent?: { threadId?: unknown } };
  const t = r?.structuredContent?.threadId;
  if (typeof t === 'string' && t.length > 0) return t;
  return findThreadId(result);
}

export class McpCodexClient implements CodexClient {
  readonly mode: CodexMode = 'mcp-server';
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private readonly cli: CodexCliConfig;

  constructor(cli: CodexCliConfig = DEFAULT_CODEX_CLI) {
    this.cli = cli;
  }

  async start(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.cli.bin,
      args: this.cli.mcpServerArgs,
      stderr: 'inherit',
    });
    this.client = new Client(
      { name: 'codex-orchestrator', version: '0.1.0' },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
  }

  async stop(): Promise<void> {
    try {
      await this.client?.close();
    } finally {
      this.client = undefined;
      this.transport = undefined;
    }
  }

  async runTask(input: CodexTaskInput): Promise<CodexTaskResult> {
    if (!this.client) {
      throw new Error('McpCodexClient.start() must be called before runTask().');
    }
    const isContinuation = Boolean(input.threadId);
    // IMPORTANT: the two tools have DIFFERENT, strict schemas.
    //  - `codex`       : kebab-case, additionalProperties:false (unknown fields
    //                    are rejected). Only prompt is required.
    //  - `codex-reply` : camelCase { threadId, prompt }; the session keeps the
    //                    cwd/sandbox/approval it was started with.
    const name = isContinuation ? this.cli.mcpReplyTool : this.cli.mcpStartTool;
    const args: Record<string, unknown> = isContinuation
      ? { threadId: input.threadId, prompt: input.prompt }
      : {
          prompt: input.prompt,
          cwd: path.resolve(input.projectDir),
          sandbox: input.sandbox,
          'approval-policy': input.approvalPolicy,
        };

    const result = (await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: input.timeoutMs },
    )) as unknown;

    return {
      output: extractText(result) || '[codex returned no text content]',
      threadId: extractThreadId(result) ?? input.threadId,
      raw: result,
    };
  }
}

// =========================================================================
// exec --json (fallback)
// =========================================================================

/**
 * Parse a JSONL event stream from `codex exec --json`.
 *
 * Primary: the CURRENT ThreadEvent stream — dotted top-level `type`:
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"<answer>"}}
 * Note `reasoning` items also carry `text`, so we match `agent_message` exactly.
 *
 * Fallback: the LEGACY EventMsg stream (rollout/older versions) where payloads
 * are wrapped under `msg` and the answer is `agent_message.message`.
 */
function parseExecJsonl(stdout: string): { text: string; threadId?: string } {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  let threadId: string | undefined;
  const agentMessages: string[] = []; // current-format final messages
  let legacyLast = ''; // legacy fallback

  for (const line of lines) {
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // non-JSON log line
    }
    const type: string = evt?.type ?? '';

    // --- current ThreadEvent format ---
    if (type === 'thread.started' && typeof evt.thread_id === 'string') {
      threadId = evt.thread_id;
      continue;
    }
    if (type === 'item.completed' && evt.item?.type === 'agent_message') {
      if (typeof evt.item.text === 'string' && evt.item.text.trim()) {
        agentMessages.push(evt.item.text);
      }
      continue;
    }

    // --- legacy EventMsg fallback ---
    const payload = evt.msg ?? evt;
    const ltype: string = payload.type ?? '';
    if (/^session_configured$/.test(ltype)) {
      threadId = threadId ?? payload.thread_id ?? payload.session_id;
    } else if (/^agent_message$/.test(ltype)) {
      const t = payload.message ?? payload.text ?? '';
      if (typeof t === 'string' && t.trim()) legacyLast = t;
    }
    threadId = threadId ?? findThreadId(evt);
  }

  const text =
    (agentMessages.join('\n').trim() || legacyLast.trim()) ||
    '[no assistant text parsed from exec --json stream]';
  return { text, threadId };
}

export class ExecCodexClient implements CodexClient {
  readonly mode: CodexMode = 'exec';
  private readonly cli: CodexCliConfig;

  constructor(cli: CodexCliConfig = DEFAULT_CODEX_CLI) {
    this.cli = cli;
  }

  async start(): Promise<void> {
    /* exec spawns per task */
  }
  async stop(): Promise<void> {
    /* nothing persistent */
  }

  async runTask(input: CodexTaskInput): Promise<CodexTaskResult> {
    const cwd = path.resolve(input.projectDir);
    // First turn:  codex exec --json -c sandbox_mode=... -c approval_policy=... "<prompt>"
    // Continuation: codex exec resume <id> --json -c ... "<prompt>"
    // `resume` MUST come immediately after `exec`. Sandbox and approval go in as
    // -c overrides: Codex 0.155 dropped `-a` from exec and never had `-s` on
    // `exec resume`, but both accept -c.
    const parts = [this.cli.bin, ...this.cli.execArgs];
    if (input.threadId) parts.push('resume', input.threadId);
    parts.push(
      this.cli.execJsonFlag,
      '-c',
      shellQuote(`sandbox_mode="${input.sandbox}"`),
      '-c',
      shellQuote(`approval_policy="${input.approvalPolicy}"`),
    );
    // Prompt passed via a single-quoted arg; runCommand uses a shell.
    parts.push(shellQuote(input.prompt));
    const command = parts.join(' ');

    const res = await runCommand(command, cwd, input.timeoutMs);
    if (res.error && !res.stdout) {
      throw new Error(`codex exec failed: ${res.error}`);
    }
    const { text, threadId } = parseExecJsonl(res.stdout);
    return {
      output: text,
      threadId: threadId ?? input.threadId,
      raw: { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode },
    };
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// =========================================================================
// Factory
// =========================================================================

export interface CodexClientOptions {
  mode: CodexMode;
  cli?: CodexCliConfig;
  mock?: MockOptions;
}

export function createCodexClient(opts: CodexClientOptions): CodexClient {
  switch (opts.mode) {
    case 'mock':
      return new MockCodexClient(opts.mock);
    case 'mcp-server':
      return new McpCodexClient(opts.cli);
    case 'exec':
      return new ExecCodexClient(opts.cli);
  }
}
