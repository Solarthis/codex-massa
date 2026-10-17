import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ExecCodexClient } from '../src/codex-client.js';
import { DEFAULT_CODEX_CLI, validateSafetyConfig } from '../src/config.js';
import type { ApprovalPolicy, CodexTaskInput } from '../src/types.js';
import { LoopController, newRunId } from '../src/loop.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const serverPath = fileURLToPath(new URL('../src/mcp-server.js', import.meta.url));

async function fixture(t: test.TestContext, body: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'massa-exec-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'fake-codex');
  await fs.writeFile(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const client = new ExecCodexClient({ ...DEFAULT_CODEX_CLI, bin });
  const input: CodexTaskInput = {
    projectDir: dir, prompt: 'Say hello', sandbox: 'workspace-write',
    approvalPolicy: 'never', timeoutMs: 2000,
  };
  return { dir, bin, client, input };
}

const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } });

test('exec rejects stderr-only nonzero exit and preserves its diagnostics', async (t) => {
  const { client, input } = await fixture(t, 'echo "fake configuration failure" >&2\nexit 42');
  await assert.rejects(client.runTask(input), /codex exec failed.*42.*fake configuration failure/s);
});

test('exec rejects a nonzero exit even after an assistant message', async (t) => {
  const { client, input } = await fixture(t, `echo '${message}'\necho 'partial failure' >&2\nexit 7`);
  await assert.rejects(client.runTask(input), /codex exec failed.*7.*partial failure/s);
});

test('exec rejects a signal termination', async (t) => {
  const { client, input } = await fixture(t, 'echo terminated >&2\nkill -TERM $$');
  await assert.rejects(client.runTask(input), /codex exec failed/);
});

test('exec rejects timeout even after partial output', async (t) => {
  const { client, input } = await fixture(t, `echo '${message}'\nexec sleep 5`);
  await assert.rejects(client.runTask({ ...input, timeoutMs: 100 }), /timed out/);
});

test('exec retains successful structured output and resume arguments', async (t) => {
  const thread = JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' });
  const { client, input } = await fixture(t, `printf '%s\\n' "$@" >&2\necho '${thread}'\necho '${message}'`);
  const first = await client.runTask(input);
  assert.equal(first.output, 'hello');
  assert.equal(first.threadId, 'thread-123');
  const next = await client.runTask({ ...input, threadId: first.threadId });
  assert.equal(next.output, 'hello');
  assert.match((next.raw as { stderr: string }).stderr, /^exec\nresume\nthread-123\n--json\n/);
  assert.match((next.raw as { stderr: string }).stderr, /approval_policy="never"/);
});

test('exec retains successful legacy structured output', async (t) => {
  const legacy = JSON.stringify({ msg: { type: 'agent_message', message: 'legacy hello' } });
  const { client, input } = await fixture(t, `echo '${legacy}'`);
  assert.equal((await client.runTask(input)).output, 'legacy hello');
});

test('CLI task exits nonzero and never reports ok for a failed worker', async (t) => {
  const { dir, bin } = await fixture(t, 'echo "fake configuration failure" >&2\nexit 42');
  await assert.rejects(exec(process.execPath, [cliPath, 'task', '--project-dir', dir, '--prompt', 'Say hello'], {
    env: { ...process.env, CODEX_BIN: bin },
  }), (err: any) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /42.*fake configuration failure/s);
    assert.doesNotMatch(err.stdout, /"status": "ok"/);
    return true;
  });
});

test('MCP task returns error with worker diagnostics', async (t) => {
  const { dir, bin } = await fixture(t, 'echo "fake configuration failure" >&2\nexit 42');
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath],
    env: { ...process.env, CODEX_BIN: bin, CODEX_ORCHESTRATOR_MODE: 'exec' } });
  const client = new Client({ name: 'exec-regression', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  const result = await client.callTool({ name: 'codex_task', arguments: { project_dir: dir, prompt: 'Say hello' } });
  const content = result.content as Array<{ type: string; text?: string }>;
  const obj = JSON.parse(content.find(c => c.type === 'text')!.text!);
  assert.equal(obj.status, 'error');
  assert.match(obj.error, /42.*fake configuration failure/s);
});

test('loop cannot complete after worker failure even if verification passes', async (t) => {
  const { dir, client } = await fixture(t, 'echo "fake configuration failure" >&2\nexit 42');
  await fs.writeFile(path.join(dir, 'PROJECT_GOAL.md'), '# Goal\nSay hello');
  const controller = new LoopController(newRunId(), {
    projectDir: dir, goalFile: 'PROJECT_GOAL.md', maxIterations: 1, maxRuntimeMs: 5000,
    verificationCommands: ['true'], sandbox: 'workspace-write', approvalPolicy: 'never', codexMode: 'exec',
  }, client);
  await controller.init();
  const state = await controller.runToCompletion();
  assert.equal(state.status, 'limit_reached');
  assert.equal(state.iterations[0]!.review!.complete, false);
  assert.match(state.iterations[0]!.review!.remainingGaps.join('\n'), /42.*fake configuration failure/s);
});

test('approval validation rejects retired and unknown values before execution', () => {
  for (const policy of ['untrusted', 'on-failure', 'invalid']) {
    assert.throws(() => validateSafetyConfig('workspace-write', policy as ApprovalPolicy), /approval.*on-request.*never/i);
  }
  for (const policy of ['on-request', 'never'] as const) {
    assert.doesNotThrow(() => validateSafetyConfig('workspace-write', policy));
  }
});
