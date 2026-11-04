import assert from 'node:assert/strict';
import test from 'node:test';

import { ChallengeError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import { TokenStore } from '../src/token.js';

function tokenStore(tokens) {
  return new TokenStore({
    accounts: tokens.map((token) => ({ token })),
    configFile: null,
  });
}

function sseResponse(content) {
  const ready = {
    request_message_id: 'req-1',
    response_message_id: 'msg-1',
    model_type: 'default',
  };
  const update = {
    v: {
      response: {
        message_id: 'msg-1',
        status: 'FINISHED',
        accumulated_token_usage: 1,
        fragments: [{ type: 'RESPONSE', content }],
      },
    },
  };
  return new Response(
    [
      'event: ready',
      `data: ${JSON.stringify(ready)}`,
      '',
      `data: ${JSON.stringify(update)}`,
      '',
      '',
    ].join('\n'),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
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

async function withServer(fn, overrides = {}, options = {}) {
  const client = options.client ?? {
    createSession: async () => 'session-1',
    completion: async () => {
      throw new Error('completion should not be reached');
    },
  };
  const config = {
    apiKey: '',
    logLevel: 'error',
    sessionTtlMs: 60_000,
    maxSessions: 10,
    concurrency: 1,
    minIntervalMs: 0,
    injectToolPrompt: true,
    parseToolCalls: true,
    ...overrides,
  };
  const server = createServer({
    config,
    tokenStore: options.tokenStore ?? fakeTokenStore(),
    client,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const completion = (extra = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  }),
});

test('GET /health reports status without auth', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, 'ok');
    assert.equal(json.upstream.active, 1);
    assert.ok(Array.isArray(json.models));
  }, { apiKey: 'secret' });
});

test('GET /v1/models lists models without auth when no key is set', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/models`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, 'list');
    assert.ok(json.data.some((model) => model.id === 'deepseek-chat'));
  });
});

test('GET /v1/models rejects a wrong API key', async () => {
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/v1/models`, {
        headers: { authorization: 'Bearer nope' },
      });
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.error.type, 'authentication_error');
      assert.equal(json.error.code, 'invalid_api_key');
    },
    { apiKey: 'secret' },
  );
});

test('GET /v1/models accepts the configured API key', async () => {
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/v1/models`, {
        headers: { authorization: 'Bearer secret' },
      });
      assert.equal(res.status, 200);
    },
    { apiKey: 'secret' },
  );
});

test('GET /v1/models/:id returns a model and 404 for unknown ids', async () => {
  await withServer(async (base) => {
    const found = await fetch(`${base}/v1/models/deepseek-reasoner`);
    assert.equal(found.status, 200);
    assert.equal((await found.json()).id, 'deepseek-reasoner');

    const missing = await fetch(`${base}/v1/models/nope`);
    assert.equal(missing.status, 404);
    const json = await missing.json();
    assert.equal(json.error.code, 'model_not_found');
    assert.equal(json.error.param, 'model');
  });
});

test('POST /v1/chat/completions validates messages', async () => {
  await withServer(async (base) => {
    const missing = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [] }),
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.param, 'messages');

    const badRole = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{}] }),
    });
    assert.equal(badRole.status, 400);
  });
});

test('POST /v1/chat/completions rejects invalid JSON and n > 1', async () => {
  await withServer(async (base) => {
    const badJson = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    assert.match((await badJson.json()).error.message, /valid JSON/);

    const many = await fetch(`${base}/v1/chat/completions`, completion({ n: 2 }));
    assert.equal(many.status, 400);
    assert.equal((await many.json()).error.param, 'n');
  });
});

test('POST /v1/chat/completions returns 404 for an unknown model', async () => {
  await withServer(async (base) => {
    const res = await fetch(
      `${base}/v1/chat/completions`,
      completion({ model: 'does-not-exist' }),
    );
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, 'model_not_found');
  });
});

test('an interactive challenge marks the account and fails over to the next one', async () => {
  const store = tokenStore(['a', 'b']);
  const calls = [];
  const client = {
    createSession: async ({ account }) => `session-${account.token}`,
    completion: async ({ account }) => {
      calls.push(account.token);
      if (account.token === 'a') throw new ChallengeError('CHALLENGE_REQUIRED');
      return sseResponse('hello from b');
    },
  };

  await withServer(
    async (base) => {
      const first = await fetch(`${base}/v1/chat/completions`, completion());
      assert.equal(first.status, 200);
      assert.equal((await first.json()).choices[0].message.content, 'hello from b');
      assert.deepEqual(calls, ['a', 'b']);
      assert.equal(store.active, 1);
      assert.equal(store.isChallenged('a'), true);
      assert.equal(store.isChallenged('b'), false);

      // The next request starts on b, not on the challenged account.
      const second = await fetch(`${base}/v1/chat/completions`, completion());
      assert.equal(second.status, 200);
      assert.deepEqual(calls, ['a', 'b', 'b']);
    },
    {},
    { client, tokenStore: store },
  );
});

test('a request reports the short challenge message when every account is blocked', async () => {
  const store = tokenStore(['a', 'b', 'c', 'd']);
  store.index = 3;
  for (const token of ['a', 'b', 'c', 'd']) store.markChallenge(token);
  let completions = 0;
  const client = {
    createSession: async () => 'session-1',
    completion: async () => {
      completions += 1;
      throw new Error('completion should not be reached');
    },
  };

  await withServer(
    async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, completion());
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error.code, 'challenge_required');
      assert.equal(json.error.type, 'permission_error');
      assert.equal(
        json.error.message,
        'DeepSeek account 4 requires manual verification (captcha/challenge).',
      );
      assert.equal(completions, 0);
    },
    {},
    { client, tokenStore: store },
  );
});

test('unknown endpoints return a structured 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/nope`);
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, 'not_found');
  });
});

test('POST /v1/sessions/clear empties the cache', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/sessions/clear`, { method: 'POST' });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.sessions, 0);
  });
});

test('CORS preflight is answered without auth', async () => {
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    },
    { apiKey: 'secret' },
  );
});

test('oversized request bodies are rejected with 413', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'x'.repeat(17 * 1024 * 1024) }],
      }),
    });
    assert.equal(res.status, 413);
  });
});

test('POST /v1/token validates the payload', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: '   ' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.param, 'token');
  });
});

test('POST /v1/token accepts hifDliq without persisting', async () => {
  const store = new TokenStore({
    accounts: [{ token: 'a' }],
    configFile: null,
  });
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/v1/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'a',
          hifDliq: 'dliq-value',
          persist: false,
        }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.hasHifDliq, true);
      assert.equal(store.current().hifDliq, 'dliq-value');
    },
    {},
    { tokenStore: store },
  );
});
