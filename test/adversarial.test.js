import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { SessionStore, conversationKey } from '../src/sessions.js';
import { TokenStore } from '../src/token.js';
import { HttpError, AuthError, UpstreamError, isPowError } from '../src/errors.js';
import { consumeDeepSeekStream, fragmentsText } from '../src/openai/sse.js';

// Hard / adversarial tests
// ===========================================================================
// These tests attack edge cases the existing suite only touches lightly:
// weird chunk boundaries, protocol smuggling, cache-key collisions, repair
// loops, account rotation, concurrency and stream/JSON parity.

const BAR = '\uFF5C';

const tools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          workdir: { type: 'string' },
          timeout: { type: 'number' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'integer' } },
        required: ['path'],
      },
    },
  },
];

function dsml(name, params, { calls = true } = {}) {
  const body = params
    .map(
      ([key, value, string = true]) =>
        `<${BAR}DSML${BAR}parameter name="${key}" string="${string}">${value}</${BAR}DSML${BAR}parameter>`,
    )
    .join('\n');
  const invoke = `<${BAR}DSML${BAR}invoke name="${name}">\n${body}\n</${BAR}DSML${BAR}invoke>`;
  return calls ? `<${BAR}DSML${BAR}calls>\n${invoke}\n</${BAR}DSML${BAR}calls>` : invoke;
}

// ---------------------------------------------------------------------------
// SSE parsing: chunk boundaries, patches, ordering, errors
// ---------------------------------------------------------------------------

function sseResponse(raw, { chunkSize = 0 } = {}) {
  if (!chunkSize) {
    return new Response(raw, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function update(patch) {
  return `data: ${JSON.stringify(patch)}\n\n`;
}

test('sse: byte-by-byte delivery yields identical text to whole-body delivery', async () => {
  const events = [
    'event: ready',
    `data: ${JSON.stringify({ request_message_id: 'r', response_message_id: 'm' })}`,
    '',
    update({ v: { response: { status: 'WIP', fragments: [{ type: 'RESPONSE', content: 'He' }] } } }),
    update({ p: null, v: 'llo ' }),
    update({ p: null, v: 'wor' }),
    update({ p: null, v: 'ld' }),
    update({ v: { response: { status: 'FINISHED', accumulated_token_usage: 17 } } }),
    '',
  ].join('\n');

  const whole = await consumeDeepSeekStream(sseResponse(events));
  const tiny = await consumeDeepSeekStream(sseResponse(events, { chunkSize: 1 }));
  const odd = await consumeDeepSeekStream(sseResponse(events, { chunkSize: 7 }));

  assert.deepEqual(fragmentsText(tiny.fragments), { content: 'Hello world', reasoning: '' });
  assert.deepEqual(fragmentsText(odd.fragments), fragmentsText(whole.fragments));
  assert.equal(tiny.totalTokens, 17);
  assert.equal(odd.responseMessageId, 'm');
  assert.equal(odd.status, 'FINISHED');
});

test('sse: multi-byte UTF-8 split across chunk boundaries is not corrupted', async () => {
  const text = 'héllo — 世界 🚀';
  const events = [
    update({ v: { response: { status: 'FINISHED', fragments: [{ content: text }] } } }),
  ].join('\n');
  for (const size of [1, 2, 3, 5]) {
    const result = await consumeDeepSeekStream(sseResponse(events, { chunkSize: size }));
    assert.equal(fragmentsText(result.fragments).content, text, `chunk size ${size}`);
  }
});

test('sse: CRLF line endings and comment/garbage lines are handled', async () => {
  const raw = [
    ': keepalive comment',
    'event: update',
    `data: ${JSON.stringify({ v: { response: { fragments: [{ type: 'RESPONSE', content: 'a' }] } } })}`,
    'data: not json at all',
    `data: ${JSON.stringify({ v: { response: { status: 'FINISHED' } } })}`,
    '',
  ].join('\r\n');
  const result = await consumeDeepSeekStream(sseResponse(raw, { chunkSize: 3 }));
  assert.equal(fragmentsText(result.fragments).content, 'a');
  assert.equal(result.status, 'FINISHED');
});

test('sse: a snapshot that shrinks to a prefix does not lose already-streamed text', async () => {
  const deltas = [];
  const raw = [
    update({ v: { response: { fragments: [{ content: 'abcdef' }] } } }),
    update({ v: { response: { status: 'FINISHED', fragments: [{ content: 'abc' }] } } }),
  ].join('\n');
  const result = await consumeDeepSeekStream(sseResponse(raw), {
    onDelta: (field, text) => deltas.push(text),
  });
  // A prefix snapshot is stale, not a rewrite: the streamed text is kept.
  assert.equal(fragmentsText(result.fragments).content, 'abcdef');
  assert.deepEqual(deltas, ['abcdef']);
});

test('sse: a divergent snapshot rewrites the fragment and emits the full new text', async () => {
  const deltas = [];
  const raw = [
    update({ v: { response: { fragments: [{ content: 'abcdef' }] } } }),
    update({ v: { response: { status: 'FINISHED', fragments: [{ content: 'XYZ' }] } } }),
  ].join('\n');
  const result = await consumeDeepSeekStream(sseResponse(raw), {
    onDelta: (field, text) => deltas.push(text),
  });
  assert.equal(fragmentsText(result.fragments).content, 'XYZ');
  assert.deepEqual(deltas, ['abcdef', 'XYZ']);
});

test('sse: THINK fragments never leak into content even with appended patches', async () => {
  const raw = [
    update({
      v: {
        response: {
          fragments: [
            { type: 'THINK', content: 'plan ' },
            { type: 'RESPONSE', content: 'ok' },
          ],
        },
      },
    }),
    update({ p: 'response/fragments/0/content', o: 'APPEND', v: 'more' }),
    update({ p: 'response/fragments/1/content', o: 'APPEND', v: '!' }),
    update({ v: { response: { status: 'FINISHED' } } }),
  ].join('\n');
  const result = await consumeDeepSeekStream(sseResponse(raw));
  assert.deepEqual(fragmentsText(result.fragments), { content: 'ok!', reasoning: 'plan more' });
});

test('sse: BATCH patch application preserves order', async () => {
  const raw = [
    update({
      p: 'response',
      o: 'BATCH',
      v: [
        { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '1' }] },
        { p: null, v: '2' },
        { p: 'response/status', v: 'FINISHED' },
      ],
    }),
  ].join('\n');
  const result = await consumeDeepSeekStream(sseResponse(raw));
  assert.equal(fragmentsText(result.fragments).content, '12');
  assert.equal(result.status, 'FINISHED');
});

test('sse: non-retryable hint errors do not request a retry', async () => {
  await assert.rejects(
    consumeDeepSeekStream(
      sseResponse(`event: hint\ndata: ${JSON.stringify({ type: 'error', content: 'boom' })}\n\n`),
    ),
    (error) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.status, 502);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('sse: numeric error payload is raised as an UpstreamError', async () => {
  await assert.rejects(
    consumeDeepSeekStream(sseResponse(`data: ${JSON.stringify({ code: 50006, msg: 'no' })}\n\n`)),
    (error) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.code, 50006);
      return true;
    },
  );
});

test('sse: missing FINISHED marker downgrades status to INCOMPLETE', async () => {
  const result = await consumeDeepSeekStream(
    sseResponse(update({ v: { response: { fragments: [{ content: 'cut' }] } } })),
  );
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(fragmentsText(result.fragments).content, 'cut');
});

test('errors: isPowError accepts the PoW codes (numeric or numeric string)', () => {
  for (const code of [40300, 40301, 40303, 40304, '40300', '40304']) {
    assert.equal(isPowError(code), true, `code ${String(code)}`);
  }
  for (const code of [40302, 50006, 'pow_required', 'POW', null, undefined, '']) {
    assert.equal(isPowError(code), false, `code ${String(code)}`);
  }
});

test('errors: HttpError, AuthError, UpstreamError expose defaults', () => {
  const http = new HttpError(400, 'bad', { param: 'x' });
  assert.equal(http.status, 400);
  assert.equal(http.param, 'x');
  assert.equal(http.type, 'invalid_request_error');
  const auth = new AuthError('nope');
  assert.equal(auth.status, 401);
  assert.equal(auth.type, 'authentication_error');
  const upstream = new UpstreamError('x');
  assert.equal(upstream.status, 502);
  assert.equal(upstream.retryable, false);
});

// ---------------------------------------------------------------------------
// Session store: TTL, LRU, account eviction, key sensitivity
// ---------------------------------------------------------------------------

test('sessions: get() refreshes LRU order so the oldest is evicted, not the hottest', () => {
  const store = new SessionStore({ ttlMs: 60_000, max: 3 });
  store.set('a', { v: 1 });
  store.set('b', { v: 2 });
  store.set('c', { v: 3 });
  assert.equal(store.get('a').v, 1); // a is now newest
  store.set('d', { v: 4 }); // should evict b
  assert.equal(store.get('b'), null);
  assert.equal(store.get('a').v, 1);
  assert.equal(store.get('c').v, 3);
  assert.equal(store.get('d').v, 4);
});

test('sessions: expired entries are pruned on read and on write', async () => {
  const store = new SessionStore({ ttlMs: 10, max: 10 });
  store.set('x', { v: 1 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.get('x'), null);
  store.set('y', { v: 2 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  store.set('z', { v: 3 });
  assert.equal(store.size, 1);
});

test('sessions: deleteByAccount removes only matching entries', () => {
  const store = new SessionStore({ ttlMs: 60_000, max: 10 });
  store.set('a', { accountToken: 'tok1' });
  store.set('b', { accountToken: 'tok2' });
  store.set('c', { accountToken: 'tok1' });
  store.deleteByAccount('tok1');
  assert.equal(store.get('a'), null);
  assert.equal(store.get('c'), null);
  assert.equal(store.get('b').accountToken, 'tok2');
});

test('sessions: conversationKey is sensitive to every field', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const base = conversationKey('default', false, messages, '', 'tok');
  assert.notEqual(base, conversationKey('default', true, messages, '', 'tok'));
  assert.notEqual(base, conversationKey('default', false, messages, 'k', 'tok'));
  assert.notEqual(base, conversationKey('default', false, messages, '', 'other'));
  assert.notEqual(
    base,
    conversationKey('default', false, [{ role: 'user', content: 'HI' }], '', 'tok'),
  );
  assert.equal(base, conversationKey('default', false, messages, '', 'tok'));
});

// ---------------------------------------------------------------------------
// Token store: rotation, switch-after, config reload, env precedence
// ---------------------------------------------------------------------------

const tokenCfg = (overrides = {}) => ({
  accounts: [
    { token: 'a', cookies: 'ca', hifLeim: 'ha', hifDliq: 'da' },
    { token: 'b', cookies: 'cb', hifLeim: 'hb', hifDliq: 'db' },
    { token: 'c', cookies: 'cc', hifLeim: 'hc', hifDliq: 'dc' },
  ],
  configFile: null,
  ...overrides,
});

test('token: rotate() advances and wraps, keeping cookies per account', () => {
  const store = new TokenStore(tokenCfg());
  assert.equal(store.current().token, 'a');
  assert.equal(store.cookies, 'ca');
  assert.equal(store.rotate().token, 'b');
  assert.equal(store.cookies, 'cb');
  assert.equal(store.rotate().token, 'c');
  assert.equal(store.rotate().token, 'a');
});

test('token: rotate(failedToken) is a no-op when the current token moved', () => {
  const store = new TokenStore(tokenCfg());
  const stayed = store.rotate('stale-token');
  assert.equal(stayed.token, 'a');
  assert.equal(store.active, 0);
});

test('token: single account never rotates away from itself', () => {
  const store = new TokenStore({ accounts: [{ token: 'only' }], configFile: null });
  assert.equal(store.rotate().token, 'only');
  assert.equal(store.count, 1);
});

test('token: noteResponse switches exactly after N responses', () => {
  const store = new TokenStore(tokenCfg({ accountSwitchAfter: 2 }));
  assert.equal(store.noteResponse('a'), null);
  const switched = store.noteResponse('a');
  assert.deepEqual(switched, { from: 1, to: 2, count: 2 });
  assert.equal(store.current().token, 'b');
  assert.equal(store.noteResponse('a'), null); // stale token ignored
});

test('token: switchAfter <= 0 disables rotation on responses', () => {
  const store = new TokenStore(tokenCfg({ accountSwitchAfter: 0 }));
  for (let i = 0; i < 5; i += 1) assert.equal(store.noteResponse('a'), null);
  assert.equal(store.current().token, 'a');
});

test('token: status() reports active account, lengths and flags', () => {
  const store = new TokenStore(tokenCfg());
  const status = store.status();
  assert.equal(status.accounts, 3);
  assert.equal(status.activeAccount, 1);
  assert.equal(status.tokenLength, 1);
  assert.equal(status.hasCookies, true);
  assert.equal(status.hasHifLeim, true);
  assert.equal(status.hasHifDliq, true);
  assert.equal(status.hasToken, true);
});

test('token: update(accounts) keeps the active token if it still exists', () => {
  const store = new TokenStore(tokenCfg());
  store.rotate(); // active = b
  store.update({ accounts: [{ token: 'x' }, { token: 'b' }, { token: 'y' }] });
  assert.equal(store.current().token, 'b');
  assert.equal(store.active, 1);
});

test('token: update(token) replaces the current account and dedupes', () => {
  const store = new TokenStore(tokenCfg());
  store.update({ token: 'a', cookies: 'new-cookie' });
  assert.equal(store.current().token, 'a');
  assert.equal(store.cookies, 'new-cookie');
  assert.equal(store.count, 3);
});

test('token: update(hifDliq) refreshes the active account', () => {
  const store = new TokenStore(tokenCfg());
  store.update({ hifDliq: 'new-dliq' });
  assert.equal(store.hifDliq, 'new-dliq');
  assert.equal(store.hifLeim, 'ha');
  assert.equal(store.current().token, 'a');
});

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------

function fakeTokenStore(accounts = [{ token: 'test-token' }]) {
  let index = 0;
  return {
    get count() {
      return accounts.length;
    },
    get active() {
      return index;
    },
    current: () => accounts[index],
    rotate: (failed) => {
      if (accounts.length <= 1) return accounts[index];
      if (failed && accounts[index].token !== failed) return accounts[index];
      index = (index + 1) % accounts.length;
      return accounts[index];
    },
    noteResponse: () => null,
    update: () => null,
    status: () => ({ accounts: accounts.length, active: index + 1 }),
  };
}

function sseBody(parts, { status = 'FINISHED', usage = 99, modelType = 'default' } = {}) {
  const ready = { request_message_id: 'req', response_message_id: 'msg', model_type: modelType };
  const payload = {
    v: {
      response: {
        message_id: 'msg',
        status,
        accumulated_token_usage: usage,
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

async function withServer(handler, fn, { config = {}, accounts } = {}) {
  const calls = [];
  const client = {
    createSession: async () => `session-${calls.length}`,
    uploadFile: async ({ file }) => ({ id: `file-${file.name}` }),
    completion: async (request) => {
      calls.push(request);
      const reply =
        typeof handler === 'function' ? await handler(request, calls.length - 1) : handler;
      if (reply instanceof Response) return reply;
      if (reply instanceof Error) throw reply;
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
  const server = createServer({ config: cfg, tokenStore: fakeTokenStore(accounts), client });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn({ base: `http://127.0.0.1:${port}`, calls, client, config: cfg });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const chat = (base, body, headers = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'go' }],
      ...body,
    }),
  });

function parseSse(text) {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice(6))
    .filter((line) => line !== '[DONE]')
    .map((line) => JSON.parse(line));
}

function assembleToolCalls(events) {
  const map = new Map();
  for (const event of events) {
    for (const delta of event.choices?.[0]?.delta?.tool_calls || []) {
      const current = map.get(delta.index) || { name: '', arguments: '' };
      if (delta.function?.name) current.name = delta.function.name;
      if (delta.function?.arguments) current.arguments += delta.function.arguments;
      map.set(delta.index, current);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => ({ name: value.name, arguments: JSON.parse(value.arguments) }));
}

// ---------------------------------------------------------------------------
// Streaming / non-streaming parity
// ---------------------------------------------------------------------------

test('parity: arbitrary fragmentation of a DSML block yields identical tool calls', async () => {
  const block = dsml('bash', [['command', 'ls -la'], ['timeout', '5000', false]]);
  const expected = [{ name: 'bash', arguments: { command: 'ls -la', timeout: 5000 } }];

  await withServer(block, async ({ base }) => {
    const json = await (await chat(base, { tools })).json();
    assert.deepEqual(
      json.choices[0].message.tool_calls.map((call) => ({
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments),
      })),
      expected,
    );
  });

  const splits = [];
  for (let i = 1; i < block.length; i += 1) splits.push([block.slice(0, i), block.slice(i)]);
  const chunks = (size) => {
    const out = [];
    for (let i = 0; i < block.length; i += size) out.push(block.slice(i, i + size));
    return out;
  };
  const cases = [...splits, chunks(1), chunks(2), chunks(3), chunks(5)];

  for (const parts of cases) {
    await withServer(parts, async ({ base }) => {
      const res = await chat(base, { tools, stream: true });
      assert.equal(res.status, 200);
      const events = parseSse(await res.text());
      assert.deepEqual(assembleToolCalls(events), expected);
      const finish = events.find((event) => event.choices?.[0]?.finish_reason)?.choices[0]
        .finish_reason;
      assert.equal(finish, 'tool_calls');
      const visible = events.map((e) => e.choices?.[0]?.delta?.content || '').join('');
      assert.doesNotMatch(visible, /DSML|invoke|parameter/);
    });
  }
});

test('parity: prose before a tool block is identical in both modes', async () => {
  const text = 'Sure, let me look.\n\n' + dsml('bash', [['command', 'pwd']]);
  await withServer(text, async ({ base }) => {
    const plain = await (await chat(base, { tools })).json();
    assert.equal(plain.choices[0].message.content, 'Sure, let me look.');
    assert.equal(plain.choices[0].message.tool_calls.length, 1);
  });
  await withServer(text, async ({ base }) => {
    const events = parseSse(await (await chat(base, { tools, stream: true })).text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || '').join('');
    assert.equal(content.trim(), 'Sure, let me look.');
    assert.deepEqual(assembleToolCalls(events), [{ name: 'bash', arguments: { command: 'pwd' } }]);
  });
});

test('parity: usage is derived from upstream total in both modes', async () => {
  const reply = () =>
    new Response(sseBody([{ type: 'RESPONSE', content: 'abcdefgh' }], { usage: 400 }), {
      status: 200,
    });
  await withServer(reply, async ({ base }) => {
    const plain = await (await chat(base, {})).json();
    assert.equal(plain.usage.total_tokens, 400);
    assert.equal(
      plain.usage.prompt_tokens + plain.usage.completion_tokens,
      plain.usage.total_tokens,
    );
  });
  await withServer(reply, async ({ base }) => {
    const events = parseSse(
      await (await chat(base, { stream: true, stream_options: { include_usage: true } })).text(),
    );
    assert.equal(events.at(-1).usage.total_tokens, 400);
  });
});

test('parity: truncated upstream maps to finish_reason=length in both modes', async () => {
  const reply = () =>
    new Response(sseBody('partial answer', { status: 'INCOMPLETE' }), { status: 200 });
  await withServer(reply, async ({ base }) => {
    const json = await (await chat(base, {})).json();
    assert.equal(json.choices[0].finish_reason, 'length');
    assert.equal(json.choices[0].message.content, 'partial answer');
  });
  await withServer(reply, async ({ base }) => {
    const events = parseSse(await (await chat(base, { stream: true })).text());
    const finish = events.filter((e) => e.choices?.[0]?.finish_reason).at(-1).choices[0]
      .finish_reason;
    assert.equal(finish, 'length');
  });
});

// ---------------------------------------------------------------------------
// Tool-call repair loop
// ---------------------------------------------------------------------------

test('repair: an unterminated call is retried and the fixed call is the only one returned', async () => {
  await withServer(
    (_request, turn) =>
      turn === 0
        ? `<${BAR}DSML${BAR}calls><${BAR}DSML${BAR}invoke name="bash"><${BAR}DSML${BAR}parameter name="command" string="true">pwd`
        : dsml('bash', [['command', 'pwd']]),
    async ({ base, calls }) => {
      const json = await (await chat(base, { tools })).json();
      assert.equal(calls.length, 2, 'one repair round-trip expected');
      assert.match(calls[1].prompt, /Tool call error/);
      assert.equal(json.choices[0].finish_reason, 'tool_calls');
      assert.deepEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments), {
        command: 'pwd',
      });
      assert.equal(json.choices[0].message.content, null);
    },
  );
});

test('repair: unknown tool name gets a repair prompt naming available tools', async () => {
  await withServer(
    (_request, turn) =>
      turn === 0 ? dsml('shell', [['command', 'ls']]) : dsml('bash', [['command', 'ls']]),
    async ({ base, calls }) => {
      const json = await (await chat(base, { tools })).json();
      assert.equal(calls.length, 2);
      assert.match(calls[1].prompt, /not an available tool/);
      assert.match(calls[1].prompt, /bash/);
      assert.equal(json.choices[0].message.tool_calls[0].function.name, 'bash');
    },
  );
});

test('repair: give-up path returns a notice instead of an empty reply', async () => {
  await withServer(
    dsml('does_not_exist', [['x', '1']]),
    async ({ base, calls }) => {
      const json = await (await chat(base, { tools })).json();
      assert.equal(calls.length, 3, 'initial + 2 repairs');
      const message = json.choices[0].message;
      assert.equal(message.tool_calls, undefined);
      assert.match(message.content, /unusable/);
      assert.equal(json.choices[0].finish_reason, 'stop');
    },
    { config: { maxToolRepairs: 2 } },
  );
});

test('repair: maxToolRepairs=0 never retries', async () => {
  await withServer(
    dsml('shell', [['command', 'ls']]),
    async ({ base, calls }) => {
      const json = await (await chat(base, { tools })).json();
      assert.equal(calls.length, 1);
      assert.equal(json.choices[0].message.tool_calls, undefined);
      assert.match(json.choices[0].message.content, /unusable/);
    },
    { config: { maxToolRepairs: 0 } },
  );
});

test('repair: an exception during repair still returns a usable 200', async () => {
  await withServer(
    (_request, turn) => {
      if (turn === 0) return dsml('shell', [['command', 'ls']]);
      throw new UpstreamError('upstream broke', { status: 502 });
    },
    async ({ base, calls }) => {
      const res = await chat(base, { tools });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(calls.length, 2);
      assert.equal(json.choices[0].message.tool_calls, undefined);
    },
  );
});

test('repair: missing required argument is repaired, not executed', async () => {
  await withServer(
    (_request, turn) =>
      turn === 0
        ? dsml('read', [['limit', '10', false]])
        : dsml('read', [['path', '/etc/hosts'], ['limit', '10', false]]),
    async ({ base, calls }) => {
      const json = await (await chat(base, { tools })).json();
      assert.equal(calls.length, 2);
      assert.match(calls[1].prompt, /missing required parameter "path"/);
      assert.deepEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments), {
        path: '/etc/hosts',
        limit: 10,
      });
    },
  );
});

// ---------------------------------------------------------------------------
// tool_choice modes and parallel caps
// ---------------------------------------------------------------------------

test('tool_choice=required with a plain-text reply triggers repair', async () => {
  await withServer(
    (_request, turn) => (turn === 0 ? 'I would rather not.' : dsml('bash', [['command', 'pwd']])),
    async ({ base, calls }) => {
      const json = await (await chat(base, { tools, tool_choice: 'required' })).json();
      assert.equal(calls.length, 2);
      assert.match(calls[1].prompt, /must call a tool/);
      assert.equal(json.choices[0].message.tool_calls.length, 1);
    },
  );
});

test('tool_choice with a specific function rejects a different tool then fixes it', async () => {
  await withServer(
    (_request, turn) =>
      turn === 0 ? dsml('bash', [['command', 'pwd']]) : dsml('read', [['path', '/etc/hosts']]),
    async ({ base, calls }) => {
      const json = await (
        await chat(base, { tools, tool_choice: { type: 'function', function: { name: 'read' } } })
      ).json();
      assert.equal(calls.length, 2);
      assert.match(calls[1].prompt, /must call the tool "read"/);
      assert.equal(json.choices[0].message.tool_calls[0].function.name, 'read');
    },
  );
});

test('tool_choice=none disables prompt injection and parsing', async () => {
  await withServer(dsml('bash', [['command', 'pwd']]), async ({ base, calls }) => {
    const json = await (await chat(base, { tools, tool_choice: 'none' })).json();
    assert.equal(json.choices[0].message.tool_calls, undefined);
    assert.doesNotMatch(calls[0].prompt, /Tool use protocol/);
    assert.match(json.choices[0].message.content, /invoke/);
  });
});

test('parallel_tool_calls=false caps multiple calls to one', async () => {
  const block = [
    `<${BAR}DSML${BAR}calls>`,
    dsml('bash', [['command', 'ls']], { calls: false }),
    dsml('read', [['path', 'a.txt']], { calls: false }),
    dsml('read', [['path', 'b.txt']], { calls: false }),
    `</${BAR}DSML${BAR}calls>`,
  ].join('\n');
  await withServer(block, async ({ base }) => {
    const json = await (await chat(base, { tools, parallel_tool_calls: false })).json();
    assert.equal(json.choices[0].message.tool_calls.length, 1);
    assert.equal(json.choices[0].message.tool_calls[0].function.name, 'bash');
  });
});

test('parallel tool calls keep their order across streaming deltas', async () => {
  const block = [
    `<${BAR}DSML${BAR}calls>`,
    dsml('bash', [['command', 'first']], { calls: false }),
    dsml('read', [['path', 'second.txt']], { calls: false }),
    dsml('bash', [['command', 'third']], { calls: false }),
    `</${BAR}DSML${BAR}calls>`,
  ].join('\n');
  await withServer(block, async ({ base }) => {
    const events = parseSse(await (await chat(base, { tools, stream: true })).text());
    assert.deepEqual(assembleToolCalls(events), [
      { name: 'bash', arguments: { command: 'first' } },
      { name: 'read', arguments: { path: 'second.txt' } },
      { name: 'bash', arguments: { command: 'third' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// HTTP layer: auth, validation, body limits, routing
// ---------------------------------------------------------------------------

test('http: x-api-key is accepted and a wrong key is rejected before touching upstream', async () => {
  let reached = 0;
  await withServer(
    () => {
      reached += 1;
      return 'hi';
    },
    async ({ base }) => {
      const ok = await chat(base, {}, { 'x-api-key': 'secret' });
      assert.equal(ok.status, 200);
      assert.equal(reached, 1);

      const bad = await chat(base, {}, { authorization: 'Bearer nope' });
      assert.equal(bad.status, 401);
      assert.equal(bad.headers.get('www-authenticate'), 'Bearer');
      const json = await bad.json();
      assert.equal(json.error.type, 'authentication_error');
      assert.equal(json.error.code, 'invalid_api_key');
      assert.equal(reached, 1, 'upstream must not be called for a rejected request');
    },
    { config: { apiKey: 'secret' } },
  );
});

test('http: message validation covers non-object, missing role and empty arrays', async () => {
  await withServer('hi', async ({ base }) => {
    const cases = [
      { messages: [] },
      { messages: 'nope' },
      { messages: [null] },
      { messages: [{ content: 'no role' }] },
      { messages: [{ role: 'user', content: 'ok' }], n: 2 },
    ];
    for (const body of cases) {
      const res = await chat(base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const json = await res.json();
      assert.equal(json.error.type, 'invalid_request_error');
    }
  });
});

test('http: malformed JSON and oversized payloads produce structured errors', async () => {
  await withServer('hi', async ({ base }) => {
    const bad = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.type, 'invalid_request_error');
  });
});

test('http: unsupported image URLs are rejected, data URLs are uploaded once', async () => {
  const uploads = [];
  await withServer('ok', async ({ base, client }) => {
    client.uploadFile = async ({ file }) => {
      uploads.push(file.name);
      return { id: `file-${uploads.length}` };
    };

    const remote = await chat(base, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    assert.equal(remote.status, 400);
    assert.match((await remote.json()).error.message, /base64/);

    const pixel =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const image = { type: 'image_url', image_url: { url: pixel } };
    const first = await chat(base, {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'one' }, image, image] },
      ],
    });
    assert.equal(first.status, 200);
    assert.equal(uploads.length, 1, 'identical images must be uploaded once');
  });
});

// ---------------------------------------------------------------------------
// Session reuse / cache correctness
// ---------------------------------------------------------------------------

test('cache: a follow-up user turn reuses the upstream session and sends only the new text', async () => {
  await withServer('answer', async ({ base, calls }) => {
    const first = await chat(base, { messages: [{ role: 'user', content: 'first' }] });
    assert.equal(first.status, 200);
    assert.equal(calls.length, 1);

    const second = await chat(base, {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ],
    });
    assert.equal(second.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].prompt, 'second');
    assert.equal(calls[1].parentMessageId, 'msg');
    assert.equal(calls[1].sessionId, calls[0].sessionId);
  });
});

test('cache: changing tools invalidates the session cache', async () => {
  await withServer('answer', async ({ base, calls }) => {
    await chat(base, { messages: [{ role: 'user', content: 'x' }] });
    await chat(base, {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'y' },
      ],
      tools,
    });
    assert.equal(calls.length, 2);
    assert.notEqual(calls[1].sessionId, calls[0].sessionId);
    assert.match(calls[1].prompt, /Tool use protocol/);
  });
});

test('cache: a tool result turn replays the tool protocol instead of the raw JSON', async () => {
  await withServer(dsml('bash', [['command', 'ls']]), async ({ base, calls }) => {
    const first = await (await chat(base, { tools })).json();
    const call = first.choices[0].message.tool_calls[0];

    await chat(base, {
      tools,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: 'file-a\nfile-b' },
      ],
    });
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /\[Tool result\]/);
    assert.match(calls[1].prompt, /call_id: /);
    assert.match(calls[1].prompt, /tool: bash/);
    assert.match(calls[1].prompt, /file-a/);
    assert.equal(calls[1].parentMessageId, 'msg');
  });
});

test('cache: /v1/sessions/clear forces a fresh session', async () => {
  await withServer('answer', async ({ base, calls }) => {
    await chat(base, { messages: [{ role: 'user', content: 'x' }] });
    const cleared = await fetch(`${base}/v1/sessions/clear`, { method: 'POST' });
    assert.equal((await cleared.json()).sessions, 0);
    await chat(base, {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'y' },
      ],
    });
    assert.equal(calls.length, 2);
    assert.notEqual(calls[1].sessionId, calls[0].sessionId);
  });
});

// ---------------------------------------------------------------------------
// Account rotation on upstream failure
// ---------------------------------------------------------------------------

test('accounts: an auth failure rotates to the next account and retries', async () => {
  const seen = [];
  await withServer(
    (request) => {
      seen.push(request.account.token);
      if (request.account.token === 'a') throw new AuthError('expired');
      return 'from b';
    },
    async ({ base, calls }) => {
      const json = await (await chat(base, {})).json();
      assert.deepEqual(seen, ['a', 'b']);
      assert.equal(calls.length, 2);
      assert.equal(json.choices[0].message.content, 'from b');
    },
    { accounts: [{ token: 'a' }, { token: 'b' }] },
  );
});

test('accounts: exhaustion propagates the original upstream error', async () => {
  await withServer(
    () => {
      throw new AuthError('all expired');
    },
    async ({ base }) => {
      const res = await chat(base, {});
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error.type, 'authentication_error');
    },
    { accounts: [{ token: 'a' }, { token: 'b' }] },
  );
});

test('accounts: a non-account error is not retried on another account', async () => {
  let count = 0;
  await withServer(
    () => {
      count += 1;
      throw new UpstreamError('bad gateway', { status: 502 });
    },
    async ({ base }) => {
      const res = await chat(base, {});
      assert.equal(res.status, 502);
      assert.equal(count, 1);
    },
    { accounts: [{ token: 'a' }, { token: 'b' }] },
  );
});

// ---------------------------------------------------------------------------
// Concurrency gate
// ---------------------------------------------------------------------------

test('gate: concurrency=1 serialises upstream calls', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await withServer(
    async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return 'ok';
    },
    async ({ base }) => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          chat(base, { messages: [{ role: 'user', content: `m${index}` }] }),
        ),
      );
      assert.ok(results.every((res) => res.status === 200));
      assert.equal(maxInFlight, 1);
    },
    { config: { concurrency: 1 } },
  );
});

test('gate: account failover is spaced by minIntervalMs', async () => {
  const times = [];
  await withServer(
    async () => {
      times.push(Date.now());
      if (times.length === 1) throw new AuthError('bad token');
      return 'ok';
    },
    async ({ base }) => {
      const res = await chat(base, {});
      assert.equal(res.status, 200);
    },
    {
      accounts: [{ token: 'a' }, { token: 'b' }],
      config: { minIntervalMs: 80 },
    },
  );
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 60, `failover gap was ${times[1] - times[0]}ms`);
});

test('gate: requestDelaySeconds spaces requests', async () => {
  const times = [];
  await withServer(
    async () => {
      times.push(Date.now());
      return 'ok';
    },
    async ({ base }) => {
      await chat(base, { messages: [{ role: 'user', content: 'a' }] });
      await chat(base, { messages: [{ role: 'user', content: 'b' }] });
      assert.equal(times.length, 2);
      assert.ok(times[1] - times[0] >= 60, `delay was ${times[1] - times[0]}ms`);
    },
    { config: { requestDelaySeconds: 0.08, minIntervalMs: 0 } },
  );
});

test('gate: requestDelaySeconds 0 overrides minIntervalMs', async () => {
  const started = Date.now();
  await withServer(
    async () => 'ok',
    async ({ base }) => {
      await chat(base, { messages: [{ role: 'user', content: 'a' }] });
      await chat(base, { messages: [{ role: 'user', content: 'b' }] });
    },
    { config: { requestDelaySeconds: 0, minIntervalMs: 5000 } },
  );
  assert.ok(Date.now() - started < 2000, `requests took ${Date.now() - started}ms`);
});

test('gate: concurrency=3 allows parallelism up to the limit', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await withServer(
    async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return 'ok';
    },
    async ({ base }) => {
      await Promise.all(
        Array.from({ length: 9 }, (_, index) =>
          chat(base, { messages: [{ role: 'user', content: `m${index}` }] }),
        ),
      );
      assert.ok(maxInFlight <= 3, `max in flight was ${maxInFlight}`);
      assert.ok(maxInFlight >= 2, `expected some parallelism, got ${maxInFlight}`);
    },
    { config: { concurrency: 3 } },
  );
});
