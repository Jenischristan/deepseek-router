import assert from 'node:assert/strict';
import test from 'node:test';

import { DeepSeekClient } from '../src/deepseek.js';
import { DEFAULT_ACCEPT_ENCODING } from '../src/fetch.js';
import { HifStore } from '../src/hif.js';

const ACCOUNT = {
  token: 'token-a',
  cookies: 'smidV2=a',
  hifLeim: 'static-leim',
  hifDliq: 'static-dliq',
};

function hifResponse(value, ttl = '600') {
  return new Response(
    JSON.stringify({ code: 0, data: { biz_data: { value } } }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-hif-ttl': ttl },
    },
  );
}

function hifFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (overrides[url]) return overrides[url](options);
    return url.includes('hif-dliq')
      ? hifResponse('fresh-dliq')
      : hifResponse('fresh-leim');
  };
  return { calls, impl };
}

test('hif: fetches both values and caches them per account', async () => {
  const { calls, impl } = hifFetch();
  const store = new HifStore({ fetchImpl: impl, now: () => 1000 });

  const first = await store.get(ACCOUNT, { origin: 'https://chat.deepseek.com' });
  assert.deepEqual(first, {
    leim: 'fresh-leim',
    dliq: 'fresh-dliq',
    expiresAt: 1000 + 8 * 60 * 1000,
  });
  assert.equal(calls.length, 2);

  const second = await store.get(ACCOUNT);
  assert.equal(second, first);
  assert.equal(calls.length, 2, 'cached value must not refetch');

  const other = await store.get({ ...ACCOUNT, token: 'token-b' });
  assert.equal(other.leim, 'fresh-leim');
  assert.equal(calls.length, 4, 'each account gets its own cache entry');
});

test('hif: skips the hif-dliq query when disabled and keeps the static value', async () => {
  const { calls, impl } = hifFetch();
  const store = new HifStore({ fetchImpl: impl, refreshDliq: false, now: () => 1000 });

  const values = await store.get(ACCOUNT, { origin: 'https://chat.deepseek.com' });
  assert.equal(values.leim, 'fresh-leim');
  assert.equal(values.dliq, 'static-dliq');
  assert.equal(values.expiresAt, 1000 + 8 * 60 * 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hif-leim.deepseek.com/query');
});

test('hif: sends caller headers without account cookies', async () => {
  const { calls, impl } = hifFetch();
  const store = new HifStore({ fetchImpl: impl });

  await store.get(ACCOUNT, { origin: 'https://chat.deepseek.com' });

  for (const { options } of calls) {
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.origin, 'https://chat.deepseek.com');
  }
});

test('hif: refreshes when the server TTL has elapsed', async () => {
  let now = 0;
  const { calls, impl } = hifFetch();
  const store = new HifStore({ fetchImpl: impl, now: () => now });

  await store.get(ACCOUNT);
  assert.equal(calls.length, 2);

  now = 8 * 60 * 1000 - 1;
  await store.get(ACCOUNT);
  assert.equal(calls.length, 2, 'still fresh');

  now = 8 * 60 * 1000;
  await store.get(ACCOUNT);
  assert.equal(calls.length, 4, 'refreshed after the TTL');
});

test('hif: honours a shorter x-hif-ttl from the server', async () => {
  let now = 0;
  const { calls, impl } = hifFetch({
    'https://hif-leim.deepseek.com/query': async () => hifResponse('fresh-leim', '60'),
    'https://hif-dliq.deepseek.com/query': async () => hifResponse('fresh-dliq', '60'),
  });
  const store = new HifStore({ fetchImpl: impl, now: () => now });

  await store.get(ACCOUNT);
  now = 60 * 1000 * 0.8 - 1;
  await store.get(ACCOUNT);
  assert.equal(calls.length, 2);

  now = 60 * 1000 * 0.8;
  await store.get(ACCOUNT);
  assert.equal(calls.length, 4);
});

test('hif: falls back to the static value and retries soon on failure', async () => {
  let now = 0;
  const { calls, impl } = hifFetch({
    'https://hif-leim.deepseek.com/query': async () => {
      throw new Error('offline');
    },
    'https://hif-dliq.deepseek.com/query': async () => {
      throw new Error('offline');
    },
  });
  const store = new HifStore({ fetchImpl: impl, now: () => now });

  const first = await store.get(ACCOUNT);
  assert.equal(first.leim, 'static-leim');
  assert.equal(first.dliq, 'static-dliq');
  assert.equal(first.expiresAt, now + 30 * 1000);

  now = 30 * 1000;
  await store.get(ACCOUNT);
  assert.equal(calls.length, 4, 'failure is retried after failureTtlMs');
});

test('hif: keeps a cached value when only one endpoint fails', async () => {
  let now = 0;
  let dliqFails = false;
  const { impl } = hifFetch({
    'https://hif-dliq.deepseek.com/query': async () => {
      if (dliqFails) throw new Error('offline');
      return hifResponse('fresh-dliq');
    },
  });
  const store = new HifStore({ fetchImpl: impl, now: () => now });

  await store.get(ACCOUNT);
  dliqFails = true;
  now = 10 * 60 * 1000;

  const values = await store.get(ACCOUNT);
  assert.equal(values.leim, 'fresh-leim');
  assert.equal(values.dliq, 'fresh-dliq', 'previous value is reused');
  assert.equal(values.expiresAt, now + 60 * 1000, 'partial result retries sooner');
});

test('hif: concurrent callers share one refresh', async () => {
  let resolve;
  const gate = new Promise((r) => {
    resolve = r;
  });
  let calls = 0;
  const impl = async (url) => {
    calls += 1;
    await gate;
    return url.includes('hif-dliq') ? hifResponse('fresh-dliq') : hifResponse('fresh-leim');
  };
  const store = new HifStore({ fetchImpl: impl });

  const results = Promise.all([store.get(ACCOUNT), store.get(ACCOUNT), store.get(ACCOUNT)]);
  resolve();
  const [a, b, c] = await results;

  assert.equal(calls, 2);
  assert.equal(a, b);
  assert.equal(b, c);
});

function client(hif, account = ACCOUNT) {
  return new DeepSeekClient({
    tokenStore: { current: () => account },
    solver: {},
    config: {
      userAgent: 'test-agent',
      clientVersion: '2.7.0',
      locale: 'en_US',
    },
    hif,
  });
}

test('DeepSeekClient: completion headers use fresh hif values', async () => {
  const { calls, impl } = hifFetch();
  const c = client(new HifStore({ fetchImpl: impl }));

  const headers = await c._headers(undefined, {}, { hif: true });
  assert.equal(headers['x-hif-leim'], 'fresh-leim');
  assert.equal(headers['x-hif-dliq'], 'fresh-dliq');
  assert.equal(calls.length, 2);

  const keys = Object.keys(headers);
  assert.ok(keys.indexOf('x-hif-leim') < keys.indexOf('x-client-bundle-id'));
  assert.ok(keys.indexOf('x-hif-dliq') < keys.indexOf('x-client-bundle-id'));
  assert.ok(
    keys.indexOf('x-client-timezone-offset') < keys.indexOf('authorization'),
  );
  assert.ok(keys.indexOf('authorization') < keys.indexOf('content-type'));
  assert.ok(keys.indexOf('content-type') < keys.indexOf('origin'));
  assert.ok(keys.indexOf('origin') < keys.indexOf('sec-gpc'));
  assert.ok(keys.indexOf('sec-gpc') < keys.indexOf('referer'));
  assert.ok(keys.indexOf('referer') < keys.indexOf('cookie'));
  assert.ok(keys.indexOf('cookie') < keys.indexOf('sec-fetch-dest'));
});

test('DeepSeekClient: PoW header precedes hif and client headers', async () => {
  const c = client(null);
  const headers = await c._headers(
    undefined,
    { 'x-ds-pow-response': 'pow' },
    { hif: true },
  );

  const keys = Object.keys(headers);
  assert.ok(keys.indexOf('accept-encoding') < keys.indexOf('x-ds-pow-response'));
  assert.ok(keys.indexOf('x-ds-pow-response') < keys.indexOf('x-hif-leim'));
  assert.ok(keys.indexOf('x-hif-dliq') < keys.indexOf('x-client-bundle-id'));
  assert.ok(
    keys.indexOf('x-client-timezone-offset') < keys.indexOf('authorization'),
  );
  assert.ok(keys.indexOf('authorization') < keys.indexOf('content-type'));
  assert.ok(keys.indexOf('content-type') < keys.indexOf('origin'));
});

test('DeepSeekClient: extra headers keep their insertion order', async () => {
  const c = client(null);
  const headers = await c._headers(undefined, {
    'x-thinking-enabled': '0',
    'x-model-type': 'default',
    'x-file-size': '3',
    'x-ds-pow-response': 'pow',
  });

  const keys = Object.keys(headers);
  assert.ok(keys.indexOf('accept-encoding') < keys.indexOf('x-thinking-enabled'));
  assert.ok(keys.indexOf('x-thinking-enabled') < keys.indexOf('x-model-type'));
  assert.ok(keys.indexOf('x-model-type') < keys.indexOf('x-file-size'));
  assert.ok(keys.indexOf('x-file-size') < keys.indexOf('x-ds-pow-response'));
  assert.ok(keys.indexOf('x-ds-pow-response') < keys.indexOf('x-client-bundle-id'));
});

test('DeepSeekClient: hif-dliq refresh is off by default', async () => {
  const { calls, impl } = hifFetch();
  const c = new DeepSeekClient({
    tokenStore: { current: () => ACCOUNT },
    solver: {},
    config: {
      userAgent: 'test-agent',
      clientVersion: '2.7.0',
      locale: 'en_US',
    },
    fetchImpl: impl,
  });

  const headers = await c._headers(undefined, {}, { hif: true });
  assert.equal(headers['x-hif-leim'], 'fresh-leim');
  assert.equal(headers['x-hif-dliq'], 'static-dliq');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hif-leim.deepseek.com/query');
});

test('DeepSeekClient: hifDliqRefresh opts back into the dliq query', async () => {
  const { calls, impl } = hifFetch();
  const c = new DeepSeekClient({
    tokenStore: { current: () => ACCOUNT },
    solver: {},
    config: {
      userAgent: 'test-agent',
      clientVersion: '2.7.0',
      locale: 'en_US',
      hifDliqRefresh: true,
    },
    fetchImpl: impl,
  });

  const headers = await c._headers(undefined, {}, { hif: true });
  assert.equal(headers['x-hif-leim'], 'fresh-leim');
  assert.equal(headers['x-hif-dliq'], 'fresh-dliq');
  assert.equal(calls.length, 2);
});

test('DeepSeekClient: non-completion headers omit hif', async () => {
  const { calls, impl } = hifFetch();
  const c = client(new HifStore({ fetchImpl: impl }));

  const headers = await c._headers();
  assert.equal(headers['x-hif-leim'], undefined);
  assert.equal(headers['x-hif-dliq'], undefined);
  assert.equal(calls.length, 0, 'hif is only fetched for completion');
});

test('DeepSeekClient: static value is used when the hif fetch fails', async () => {
  const c = client(
    new HifStore({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
  );

  const headers = await c._headers(undefined, {}, { hif: true });
  assert.equal(headers['x-hif-leim'], 'static-leim');
  assert.equal(headers['x-hif-dliq'], 'static-dliq');
});

test('DeepSeekClient: a broken hif store degrades to the static value', async () => {
  const c = client({
    get: async () => {
      throw new Error('boom');
    },
  });

  const headers = await c._headers(undefined, {}, { hif: true });
  assert.equal(headers['x-hif-leim'], 'static-leim');
  assert.equal(headers['x-hif-dliq'], 'static-dliq');
});

test('DeepSeekClient: hif can be disabled', async () => {
  const c = client(null);
  const headers = await c._headers(undefined, {}, { hif: true });
  assert.equal(headers['x-hif-leim'], 'static-leim');
  assert.equal(headers['x-hif-dliq'], 'static-dliq');
});

test('DeepSeekClient: chat headers match the web client', async () => {
  const c = client(null);
  const headers = await c._headers();

  assert.equal(headers['user-agent'], 'test-agent');
  assert.equal(headers.accept, '*/*');
  assert.equal(headers['accept-language'], 'en-US,en;q=0.9');
  assert.equal(headers['accept-encoding'], DEFAULT_ACCEPT_ENCODING);
  assert.equal(headers.origin, 'https://chat.deepseek.com');
  assert.equal(headers.referer, 'https://chat.deepseek.com/');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['sec-gpc'], '1');
  assert.equal(headers['sec-fetch-dest'], 'empty');
  assert.equal(headers['sec-fetch-mode'], 'cors');
  assert.equal(headers['sec-fetch-site'], 'same-origin');
  assert.equal(headers.authorization, 'Bearer token-a');
  assert.equal(headers.cookie, 'smidV2=a');
  assert.equal(headers['x-client-bundle-id'], 'com.deepseek.chat');
  assert.equal(headers['x-client-platform'], 'web');
  assert.equal(headers['x-client-version'], '2.7.0');
  assert.equal(headers['x-client-locale'], 'en_US');
  assert.match(headers['x-client-timezone-offset'], /^-?\d+$/);
  assert.deepEqual(Object.keys(headers), [
    'user-agent',
    'accept',
    'accept-language',
    'accept-encoding',
    'x-client-bundle-id',
    'x-client-platform',
    'x-client-version',
    'x-client-locale',
    'x-client-timezone-offset',
    'authorization',
    'content-type',
    'origin',
    'sec-gpc',
    'referer',
    'cookie',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
  ]);
});

test('DeepSeekClient: hif requests carry browser headers but no auth/cookie', async () => {
  const { calls, impl } = hifFetch();
  const c = client(new HifStore({ fetchImpl: impl }));

  await c._headers(undefined, {}, { hif: true });

  assert.equal(calls.length, 2);
  for (const { options } of calls) {
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers['sec-fetch-site'], 'same-site');
    assert.equal(options.headers['sec-gpc'], '1');
    assert.equal(options.headers.priority, undefined);
    assert.equal(options.headers['x-client-bundle-id'], 'com.deepseek.chat');
    assert.equal(options.headers['x-client-version'], '2.7.0');
    const keys = Object.keys(options.headers);
    assert.ok(keys.indexOf('user-agent') < keys.indexOf('accept'));
    assert.ok(
      keys.indexOf('x-client-timezone-offset') < keys.indexOf('origin'),
      'client headers precede origin',
    );
    assert.ok(keys.indexOf('origin') < keys.indexOf('sec-gpc'));
    assert.ok(keys.indexOf('sec-gpc') < keys.indexOf('referer'));
    assert.ok(keys.indexOf('referer') < keys.indexOf('sec-fetch-dest'));
  }
});

test('DeepSeekClient: browser header settings are configurable', async () => {
  const c = client(null);
  c.cfg = {
    ...c.cfg,
    acceptLanguage: 'de-DE,de;q=0.9',
    acceptEncoding: 'gzip, br',
    secGpc: false,
  };

  const headers = await c._headers();
  assert.equal(headers['accept-language'], 'de-DE,de;q=0.9');
  assert.equal(headers['accept-encoding'], 'gzip, br');
  assert.equal(headers['sec-gpc'], undefined);
});
