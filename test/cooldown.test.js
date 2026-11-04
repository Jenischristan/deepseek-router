import assert from 'node:assert/strict';
import test from 'node:test';

import { ToolCooldown } from '../src/cooldown.js';
import { createServer } from '../src/server.js';

const BAR = '\uFF5C';

const tools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

function dsml(name, params) {
  const body = params
    .map(
      ([key, value]) =>
        `<${BAR}DSML${BAR}parameter name="${key}" string="true">${value}</${BAR}DSML${BAR}parameter>`,
    )
    .join('\n');
  return `<${BAR}DSML${BAR}calls>\n<${BAR}DSML${BAR}invoke name="${name}">\n${body}\n</${BAR}DSML${BAR}invoke>\n</${BAR}DSML${BAR}calls>`;
}

function sseBody(parts) {
  const ready = { request_message_id: 'req', response_message_id: 'msg', model_type: 'default' };
  const payload = {
    v: {
      response: {
        message_id: 'msg',
        status: 'FINISHED',
        accumulated_token_usage: 99,
        fragments: (Array.isArray(parts) ? parts : [parts]).map((part) =>
          typeof part === 'string' ? { type: 'RESPONSE', content: part } : part,
        ),
      },
    },
  };
  return [
    'event: ready',
    `data: ${JSON.stringify(ready)}`,
    '',
    `data: ${JSON.stringify(payload)}`,
    '',
    '',
  ].join('\n');
}

function fakeTokenStore() {
  const account = { token: 'test-token' };
  return {
    count: 1,
    active: 0,
    current: () => account,
    rotate: () => null,
    noteResponse: () => null,
    status: () => ({ accounts: 1, active: 1 }),
  };
}

async function withServer(handler, fn, { config = {} } = {}) {
  const calls = [];
  const client = {
    createSession: async () => `session-${calls.length}`,
    completion: async (request) => {
      calls.push({ at: Date.now(), request });
      const reply = await handler(request, calls.length - 1);
      return new Response(sseBody(reply), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  };
  const cfg = {
    apiKey: '',
    logLevel: 'error',
    sessionTtlMs: 60_000,
    maxSessions: 10,
    concurrency: 1,
    minIntervalMs: 0,
    injectToolPrompt: true,
    parseToolCalls: true,
    repairToolCalls: true,
    maxToolRepairs: 2,
    ...config,
  };
  const server = createServer({ config: cfg, tokenStore: fakeTokenStore(), client });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn({ base: `http://127.0.0.1:${port}`, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const chat = (base, body) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'go' }],
      ...body,
    }),
  });

function assembleToolCalls(text) {
  const byIndex = new Map();
  for (const block of text.split('\n\n')) {
    if (!block.startsWith('data: ')) continue;
    const data = block.slice(6);
    if (data === '[DONE]') continue;
    const event = JSON.parse(data);
    for (const delta of event.choices?.[0]?.delta?.tool_calls || []) {
      const call = byIndex.get(delta.index) || { id: '', name: '', arguments: '' };
      if (delta.id) call.id = delta.id;
      if (delta.function?.name) call.name = delta.function.name;
      if (delta.function?.arguments) call.arguments += delta.function.arguments;
      byIndex.set(delta.index, call);
    }
  }
  return [...byIndex.values()];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('ToolCooldown waits after a recent tool result', () => {
  let now = 1_000;
  const cooldown = new ToolCooldown({ now: () => now });
  cooldown.record([{ id: 'call-1' }], 1_000);

  now = 1_500;
  const assistant = { tool_calls: [{ id: 'call-1' }] };
  const toolMessages = [{ role: 'tool', tool_call_id: 'call-1', content: 'ok' }];
  assert.equal(cooldown.executionMs({ assistant, toolMessages }), 500);
  assert.equal(
    cooldown.delayFor({ assistant, toolMessages, delayMs: 4_000, skipAfterMs: 8_000 }),
    4_000,
  );

  now = 9_000;
  assert.equal(
    cooldown.delayFor({ assistant, toolMessages, delayMs: 4_000, skipAfterMs: 8_000 }),
    0,
  );
});

test('ToolCooldown skips unknown ids, disabled waits, and user turns', () => {
  const cooldown = new ToolCooldown({ now: () => 10_000 });
  cooldown.record([{ id: 'known' }], 9_000);

  assert.equal(
    cooldown.delayFor({
      assistant: { tool_calls: [{ id: 'missing' }] },
      toolMessages: [{ role: 'tool', tool_call_id: 'missing' }],
      delayMs: 4_000,
      skipAfterMs: 8_000,
    }),
    4_000,
  );
  assert.equal(
    cooldown.delayFor({
      toolMessages: [{ role: 'tool', tool_call_id: 'known' }],
      delayMs: 0,
      skipAfterMs: 8_000,
    }),
    0,
  );
  assert.equal(cooldown.delayFor({ toolMessages: [], delayMs: 4_000 }), 0);
});

test('ToolCooldown expires old delivery timestamps and caps memory', () => {
  let now = 0;
  const cooldown = new ToolCooldown({
    ttlMs: 1_000,
    max: 2,
    now: () => now,
  });
  cooldown.record([{ id: 'a' }], 0);
  now = 500;
  cooldown.record([{ id: 'b' }], 500);
  now = 1_600;
  cooldown.record([{ id: 'c' }], 1_600);

  assert.equal(
    cooldown.executionMs({ toolMessages: [{ tool_call_id: 'a' }] }, 1_600),
    null,
  );
  assert.equal(
    cooldown.executionMs({ toolMessages: [{ tool_call_id: 'b' }] }, 1_600),
    null,
  );
  assert.equal(cooldown.deliveredAt.size, 1);
});

test('tool result requests wait for the configured cooldown', async () => {
  await withServer(
    (_request, index) => (index === 0 ? dsml('bash', [['command', 'ls']]) : 'done'),
    async ({ base, calls }) => {
      const first = await (await chat(base, { tools })).json();
      const call = first.choices[0].message.tool_calls[0];
      const followUpAt = Date.now();

      const second = await chat(base, {
        tools,
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: null, tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: 'file-a' },
        ],
      });

      assert.equal(second.status, 200);
      assert.equal((await second.json()).choices[0].message.content, 'done');
      assert.equal(calls.length, 2);
      assert.ok(
        calls[1].at - followUpAt >= 150,
        `cooldown was ${calls[1].at - followUpAt}ms`,
      );
    },
    { config: { toolResultDelaySeconds: 0.2, toolResultSkipAfterSeconds: 5 } },
  );
});

test('a long tool execution skips the cooldown', async () => {
  await withServer(
    (_request, index) => (index === 0 ? dsml('bash', [['command', 'ls']]) : 'done'),
    async ({ base, calls }) => {
      const first = await chat(base, { tools, stream: true });
      const call = assembleToolCalls(await first.text())[0];
      assert.ok(call?.id);

      await sleep(150);
      const followUpAt = Date.now();
      const second = await chat(base, {
        tools,
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: null, tool_calls: [{ ...call, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
          { role: 'tool', tool_call_id: call.id, content: 'file-a' },
        ],
      });

      assert.equal(second.status, 200);
      assert.equal(calls.length, 2);
      // The configured cooldown is 600ms; a 100ms execution threshold must
      // skip it after the sleep above.
      assert.ok(
        calls[1].at - followUpAt < 400,
        `cooldown was not skipped (${calls[1].at - followUpAt}ms)`,
      );
    },
    { config: { toolResultDelaySeconds: 0.6, toolResultSkipAfterSeconds: 0.1 } },
  );
});
