/**
 * mcp.test.ts — spawns the real MCP server over stdio and verifies it registers
 * exactly the five required tools with the exact specified input names, and that
 * a tool round-trips. Runs in mock mode (no Codex needed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeProject } from './helpers.js';

const serverPath = fileURLToPath(new URL('../src/mcp-server.js', import.meta.url));

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, CODEX_ORCHESTRATOR_MODE: 'mock' },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

test('server registers all 5 tools with the exact specified input names', async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const n of ['start_project_loop', 'codex_task', 'review_current_state', 'get_loop_status', 'stop_loop']) {
      assert.ok(byName.has(n), `missing tool: ${n}`);
    }
    assert.equal(tools.length, 5, 'exactly five tools must be registered');

    const props = (name: string) =>
      Object.keys((byName.get(name)!.inputSchema as { properties?: object }).properties ?? {});

    assert.deepEqual(
      props('start_project_loop').sort(),
      ['approval_policy', 'goal_file', 'max_iterations', 'project_dir', 'sandbox', 'verification_commands'].sort(),
    );
    assert.deepEqual(props('codex_task').sort(), ['project_dir', 'prompt', 'thread_id'].sort());
    assert.deepEqual(props('review_current_state').sort(), ['goal_file', 'project_dir', 'verification_commands'].sort());
    assert.deepEqual(props('get_loop_status'), ['run_id']);
    assert.deepEqual(props('stop_loop'), ['run_id']);
  } finally {
    await client.close();
  }
});

test('review_current_state tool round-trips and reports gaps', async () => {
  const dir = await makeProject();
  const client = await connect();
  try {
    const res = await client.callTool({
      name: 'review_current_state',
      arguments: { project_dir: dir, goal_file: 'PROJECT_GOAL.md', verification_commands: ['node greet.test.js'] },
    });
    const text = (res.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')!.text!;
    const obj = JSON.parse(text);
    assert.equal(obj.complete, false);
    assert.ok(Array.isArray(obj.remaining_gaps) && obj.remaining_gaps.length > 0);
  } finally {
    await client.close();
  }
});

test('start_project_loop -> get_loop_status -> stop_loop full lifecycle (mock)', async () => {
  const dir = await makeProject();
  const client = await connect();
  const parse = (r: unknown) => {
    const content = (r as { content: Array<{ type: string; text?: string }> }).content;
    return JSON.parse(content.find((c) => c.type === 'text')!.text!);
  };
  try {
    const start = parse(
      await client.callTool({
        name: 'start_project_loop',
        arguments: {
          project_dir: dir,
          goal_file: 'PROJECT_GOAL.md',
          verification_commands: ['node greet.test.js'],
          max_iterations: 5,
        },
      }),
    );
    assert.ok(start.run_id, 'start must return a run_id');

    // Poll until terminal — proves get_loop_status works AFTER the bg loop ends.
    let st: { status?: string; current_iteration?: number } = {};
    for (let i = 0; i < 60; i++) {
      st = parse(await client.callTool({ name: 'get_loop_status', arguments: { run_id: start.run_id } }));
      if (['completed', 'failed', 'limit_reached', 'paused_for_approval', 'stopped'].includes(st.status!)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(st.status, 'completed');

    const stop = parse(await client.callTool({ name: 'stop_loop', arguments: { run_id: start.run_id } }));
    assert.equal(stop.run_id, start.run_id);
  } finally {
    await client.close();
  }
});

test('codex_task tool blocks a forbidden prompt instead of executing it', async () => {
  const client = await connect();
  try {
    const res = await client.callTool({
      name: 'codex_task',
      arguments: { project_dir: process.cwd(), prompt: 'deploy everything to production right now' },
    });
    const text = (res.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')!.text!;
    const obj = JSON.parse(text);
    assert.equal(obj.status, 'blocked_pending_approval');
  } finally {
    await client.close();
  }
});
