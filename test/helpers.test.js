import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import os from 'node:os';

import { loadConfig, normalizeAccounts } from '../src/config.js';
import { DEFAULT_ACCEPT_ENCODING } from '../src/fetch.js';
import { SessionStore, conversationKey } from '../src/sessions.js';
import { TokenStore } from '../src/token.js';

const ENV_KEYS = [
  'DEEPSEEK_TOKEN',
  'DEEPSEEK_ACCOUNTS',
  'DEEPSEEK_ACCOUNT_SWITCH_AFTER',
  'DEEPSEEK_CLIENT_VERSION',
  'DEEPSEEK_LOCALE',
  'DEEPSEEK_USER_AGENT',
  'DEEPSEEK_COOKIES',
  'DEEPSEEK_HIF_LEIM',
  'DEEPSEEK_HIF_DLIQ',
  'DEEPSEEK_HIF_DLIQ_REFRESH',
  'DEEPSEEK_HIF_REFRESH_ENABLED',
  'DEEPSEEK_POW_CHALLENGE_ENABLED',
  'DEEPSEEK_ACCEPT_LANGUAGE',
  'DEEPSEEK_ACCEPT_ENCODING',
  'DEEPSEEK_SEC_GPC',
  'DEEPSEEK_TRANSPORT',
  'DEEPSEEK_TRANSPORT_BINARY',
  'DEEPSEEK_TRANSPORT_PROFILE',
  'DEEPSEEK_TOKEN_FILE',
  'DEEPSEEK_ROUTER_CONFIG_FILE',
  'DEEPSEEK_ROUTER_KEY',
  'REPAIR_TOOL_CALLS',
  'MAX_TOOL_REPAIRS',
  'LOG_LEVEL',
  'HOST',
  'PORT',
  'UPSTREAM_MIN_INTERVAL_MS',
  'UPSTREAM_CONCURRENCY',
  'DEEPSEEK_REQUEST_DELAY_SECONDS',
  'REQUEST_DELAY_SECONDS',
  'DEEPSEEK_TOOL_RESULT_DELAY_SECONDS',
  'DEEPSEEK_TOOL_RESULT_SKIP_AFTER_SECONDS',
  'SESSION_TTL_MS',
  'MAX_SESSIONS',
  'INJECT_TOOL_PROMPT',
  'PARSE_TOOL_CALLS',
  'REQUEST_TIMEOUT_MS',
];

const MISSING_CONFIG = path.join(os.tmpdir(), 'deepseek-router-test-missing-config.json');

function withEnv(patch, fn) {
  const saved = new Map();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.DEEPSEEK_ROUTER_CONFIG_FILE = MISSING_CONFIG;
  for (const [key, value] of Object.entries(patch)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('normalizeAccounts trims, dedupes and fills defaults', () => {
  const accounts = normalizeAccounts([
    '  a  ',
    { token: 'a' },
    { token: ' b ', cookies: 'c=1' },
    { token: '' },
    null,
  ]);
  assert.deepEqual(accounts, [
    { token: 'a', cookies: '', hifLeim: '', hifDliq: '', deviceId: '' },
    { token: 'b', cookies: 'c=1', hifLeim: '', hifDliq: '', deviceId: '' },
  ]);
});

test('normalizeAccounts keeps the per-account device id', () => {
  const accounts = normalizeAccounts([
    { token: 'a', deviceId: ' 797b22a1-3517-49da-bf8a-a223575bd916 ' },
    { token: 'b', deviceId: 42 },
  ]);
  assert.deepEqual(accounts, [
    {
      token: 'a',
      cookies: '',
      hifLeim: '',
      hifDliq: '',
      deviceId: '797b22a1-3517-49da-bf8a-a223575bd916',
    },
    { token: 'b', cookies: '', hifLeim: '', hifDliq: '', deviceId: '' },
  ]);
});

test('loadConfig reads new env overrides', () => {
  withEnv(
    {
      DEEPSEEK_TOKEN: 'env-token',
      DEEPSEEK_CLIENT_VERSION: '9.9.9',
      DEEPSEEK_LOCALE: 'de_DE',
      DEEPSEEK_USER_AGENT: 'test-agent',
      DEEPSEEK_HIF_DLIQ: 'env-dliq',
      DEEPSEEK_HIF_DLIQ_REFRESH: 'on',
      DEEPSEEK_HIF_REFRESH_ENABLED: 'off',
      DEEPSEEK_POW_CHALLENGE_ENABLED: 'off',
      DEEPSEEK_ACCEPT_LANGUAGE: 'de-DE,de;q=0.9',
      DEEPSEEK_ACCEPT_ENCODING: 'gzip, br',
      DEEPSEEK_SEC_GPC: 'off',
      DEEPSEEK_TRANSPORT: 'FIREFOX',
      DEEPSEEK_TRANSPORT_BINARY: '/tmp/transport',
      DEEPSEEK_TRANSPORT_PROFILE: 'firefox_147',
      REPAIR_TOOL_CALLS: 'off',
      MAX_TOOL_REPAIRS: '4',
      LOG_LEVEL: 'debug',
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.token, 'env-token');
      assert.equal(cfg.clientVersion, '9.9.9');
      assert.equal(cfg.locale, 'de_DE');
      assert.equal(cfg.userAgent, 'test-agent');
      assert.equal(cfg.hifDliq, 'env-dliq');
      assert.equal(cfg.hifDliqRefresh, true);
      assert.equal(cfg.hifRefreshEnabled, false);
      assert.equal(cfg.powChallengeEnabled, false);
      assert.equal(cfg.acceptLanguage, 'de-DE,de;q=0.9');
      assert.equal(cfg.acceptEncoding, 'gzip, br');
      assert.equal(cfg.secGpc, false);
      assert.equal(cfg.transport, 'firefox');
      assert.equal(cfg.transportBinary, '/tmp/transport');
      assert.equal(cfg.transportProfile, 'firefox_147');
      assert.equal(cfg.repairToolCalls, false);
      assert.equal(cfg.maxToolRepairs, 4);
      assert.equal(cfg.logLevel, 'debug');
    },
  );
});

test('loadConfig defaults repair settings when unset', () => {
  withEnv({}, () => {
    const cfg = loadConfig();
    assert.equal(cfg.repairToolCalls, true);
    assert.equal(cfg.maxToolRepairs, 2);
  });
});

test('loadConfig defaults browser fingerprint settings', () => {
  withEnv({}, () => {
    const cfg = loadConfig();
    assert.equal(cfg.clientVersion, '2.7.0');
    assert.equal(cfg.locale, 'en_US');
    assert.equal(
      cfg.userAgent,
      'Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0',
    );
    assert.equal(cfg.acceptLanguage, 'en-US,en;q=0.9');
    assert.equal(cfg.acceptEncoding, DEFAULT_ACCEPT_ENCODING);
    assert.equal(cfg.secGpc, true);
    assert.equal(cfg.hifDliqRefresh, false);
    assert.equal(cfg.hifRefreshEnabled, true);
    assert.equal(cfg.powChallengeEnabled, true);
    assert.equal(cfg.requestDelaySeconds, null);
    assert.equal(cfg.toolResultDelaySeconds, null);
    assert.equal(cfg.toolResultSkipAfterSeconds, 8);
    assert.equal(cfg.transport, 'firefox');
    assert.match(cfg.transportBinary, /transport\/deepseek-transport$/);
    assert.equal(cfg.transportProfile, 'firefox_159');
  });
});

test('loadConfig reads requestDelaySeconds from the file and env', () => {
  const file = path.join(os.tmpdir(), `deepseek-router-delay-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ requestDelaySeconds: 4 }));
  try {
    withEnv({ DEEPSEEK_ROUTER_CONFIG_FILE: file }, () => {
      assert.equal(loadConfig().requestDelaySeconds, 4);
    });
    withEnv(
      { DEEPSEEK_ROUTER_CONFIG_FILE: file, DEEPSEEK_REQUEST_DELAY_SECONDS: '0' },
      () => {
        assert.equal(loadConfig().requestDelaySeconds, 0);
      },
    );
  } finally {
    fs.unlinkSync(file);
  }
});

test('TokenStore hot-reloads requestDelaySeconds', () => {
  const file = path.join(os.tmpdir(), `deepseek-router-delay-store-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ token: 'a', requestDelaySeconds: 4 }));
  try {
    const store = new TokenStore({
      token: 'a',
      requestDelaySeconds: 4,
      minIntervalMs: 400,
      configFile: file,
    });
    assert.equal(store.requestDelayMs(), 4000);

    fs.writeFileSync(file, JSON.stringify({ token: 'a', requestDelaySeconds: 0 }));
    let stamp = new Date(Date.now() + 1000);
    fs.utimesSync(file, stamp, stamp);
    assert.equal(store.requestDelayMs(), 0);

    fs.writeFileSync(file, JSON.stringify({ token: 'a' }));
    stamp = new Date(Date.now() + 2000);
    fs.utimesSync(file, stamp, stamp);
    assert.equal(store.requestDelayMs(), 400);
  } finally {
    fs.unlinkSync(file);
  }
});

test('loadConfig reads tool result cooldown from the file and env', () => {
  const file = path.join(os.tmpdir(), `deepseek-router-cooldown-${process.pid}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      token: 'a',
      toolResultDelaySeconds: 4,
      toolResultSkipAfterSeconds: 8,
    }),
  );
  try {
    withEnv({ DEEPSEEK_ROUTER_CONFIG_FILE: file }, () => {
      const cfg = loadConfig();
      assert.equal(cfg.toolResultDelaySeconds, 4);
      assert.equal(cfg.toolResultSkipAfterSeconds, 8);
    });
    withEnv(
      {
        DEEPSEEK_ROUTER_CONFIG_FILE: file,
        DEEPSEEK_TOOL_RESULT_DELAY_SECONDS: '0',
        DEEPSEEK_TOOL_RESULT_SKIP_AFTER_SECONDS: '3',
      },
      () => {
        const cfg = loadConfig();
        assert.equal(cfg.toolResultDelaySeconds, 0);
        assert.equal(cfg.toolResultSkipAfterSeconds, 3);
      },
    );
  } finally {
    fs.unlinkSync(file);
  }
});

test('TokenStore hot-reloads tool result cooldown', () => {
  const file = path.join(os.tmpdir(), `deepseek-router-cooldown-store-${process.pid}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      token: 'a',
      toolResultDelaySeconds: 4,
      toolResultSkipAfterSeconds: 8,
    }),
  );
  try {
    const store = new TokenStore({
      token: 'a',
      toolResultDelaySeconds: 4,
      toolResultSkipAfterSeconds: 8,
      configFile: file,
    });
    assert.equal(store.toolResultDelayMs(), 4000);
    assert.equal(store.toolResultSkipAfterMs(), 8000);

    fs.writeFileSync(
      file,
      JSON.stringify({
        token: 'a',
        toolResultDelaySeconds: 0,
        toolResultSkipAfterSeconds: 3,
      }),
    );
    let stamp = new Date(Date.now() + 1000);
    fs.utimesSync(file, stamp, stamp);
    assert.equal(store.toolResultDelayMs(), 0);
    assert.equal(store.toolResultSkipAfterMs(), 3000);

    fs.writeFileSync(file, JSON.stringify({ token: 'a' }));
    stamp = new Date(Date.now() + 2000);
    fs.utimesSync(file, stamp, stamp);
    assert.equal(store.toolResultDelayMs(), 0);
    assert.equal(store.toolResultSkipAfterMs(), 8000);
  } finally {
    fs.unlinkSync(file);
  }
});

test('TokenStore disables tool result cooldown when unset', () => {
  const store = new TokenStore({ token: 'a', configFile: null });
  assert.equal(store.toolResultDelayMs(), 0);
  assert.equal(store.toolResultSkipAfterMs(), 8000);
});

test('loadConfig reads pacing and rotation settings from the config file', () => {
  const file = path.join(os.tmpdir(), `deepseek-router-config-${process.pid}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      accounts: [{ token: 'a' }],
      minIntervalMs: 4000,
      concurrency: 2,
      accountSwitchAfter: 15,
      hifRefreshEnabled: false,
      powChallengeEnabled: false,
    }),
  );
  try {
    withEnv({ DEEPSEEK_ROUTER_CONFIG_FILE: file }, () => {
      const cfg = loadConfig();
      assert.equal(cfg.minIntervalMs, 4000);
      assert.equal(cfg.concurrency, 2);
      assert.equal(cfg.accountSwitchAfter, 15);
      assert.equal(cfg.hifRefreshEnabled, false);
      assert.equal(cfg.powChallengeEnabled, false);
    });
  } finally {
    fs.unlinkSync(file);
  }
});

function tokenStore(tokens, switchAfter = 0) {
  return new TokenStore({
    accounts: tokens.map((token) => ({ token })),
    accountSwitchAfter: switchAfter,
    // Tests must not read the user's real config file.
    configFile: null,
  });
}

test('TokenStore rotates and wraps around', () => {
  const store = tokenStore(['a', 'b', 'c']);
  assert.equal(store.current().token, 'a');
  assert.equal(store.rotate('a').token, 'b');
  assert.equal(store.rotate('b').token, 'c');
  assert.equal(store.rotate('c').token, 'a');
});

test('TokenStore rotate ignores a stale failed token', () => {
  const store = tokenStore(['a', 'b']);
  assert.equal(store.rotate('other').token, 'a');
});

test('TokenStore skips a token that already failed auth', () => {
  const store = tokenStore(['a', 'b', 'c']);
  // Each failed token is quarantined, so the next rotation skips it.
  assert.equal(store.rotate('a').token, 'b');
  assert.equal(store.rotate('b').token, 'c');
  assert.deepEqual([...store._quarantine.keys()].sort(), ['a', 'b']);
});

test('TokenStore never returns a quarantined token while a live one exists', () => {
  const store = tokenStore(['a', 'b', 'c']);
  store.markFailed('a');
  store.markFailed('b');
  // Only c is live. Repeated rotations of the failing token keep landing on c;
  // they never hand back the quarantined a or b.
  assert.equal(store.rotate('a').token, 'c');
  assert.equal(store.rotate('a').token, 'c');
  assert.equal(store.rotate('b').token, 'c');
});

test('TokenStore clears quarantine when the account list changes', () => {
  const store = tokenStore(['a', 'b']);
  store.markFailed('a');
  store.update({ accounts: [{ token: 'c' }, { token: 'd' }] });
  assert.equal(store._quarantine.size, 0);
});

test('TokenStore keeps quarantine when the account list is unchanged', () => {
  const store = tokenStore(['a', 'b']);
  store.markFailed('a');
  // Simulates the periodic config reload re-applying the same accounts.
  store.update({ accounts: [{ token: 'a' }, { token: 'b' }] });
  assert.equal(store._quarantine.size, 1);
});

test('TokenStore round-robins once every token is quarantined', () => {
  const store = tokenStore(['a', 'b', 'c']);
  assert.equal(store.rotate('a').token, 'b');
  assert.equal(store.rotate('b').token, 'c');
  // c's failure quarantines the last live token, so the fallback is plain
  // round-robin and the index wraps to a.
  assert.equal(store.rotate('c').token, 'a');
  assert.equal(store.rotate('a').token, 'b');
});

test('TokenStore falls back to round-robin when every token is quarantined', () => {
  const store = tokenStore(['a', 'b']);
  store.markFailed('a');
  store.markFailed('b');
  assert.equal(store.rotate('a').token, 'b');
  assert.equal(store.rotate('b').token, 'a');
});

test('TokenStore quarantine expires', () => {
  const store = tokenStore(['a', 'b']);
  store.markFailed('a');
  assert.equal(store.rotate('a').token, 'b');
  // Force the quarantine entry into the past: a is selectable again.
  store._quarantine.set('a', Date.now() - 1);
  assert.equal(store.rotate('b').token, 'a');
});

test('TokenStore quarantines an account that needs interactive verification', () => {
  const store = tokenStore(['a', 'b']);
  store.markChallenge('a');
  assert.equal(store.isChallenged('a'), true);
  assert.equal(store.isChallenged('b'), false);
  assert.equal(store.rotate('a').token, 'b');

  const status = store.status();
  assert.equal(status.challengeRequired, false);
  assert.deepEqual(status.challengedAccounts, [1]);
});

test('TokenStore keeps the longer challenge quarantine when it rotates', () => {
  const store = tokenStore(['a', 'b']);
  store.markChallenge('a');
  const challengeUntil = store._challenges.get('a');
  store.rotate('a');
  assert.ok(store._quarantine.get('a') >= challengeUntil);
  assert.equal(store.isChallenged('a'), true);
});

test('TokenStore reports a challenge on the active account', () => {
  const store = tokenStore(['a', 'b']);
  store.markChallenge('a');
  const status = store.status();
  assert.equal(status.challengeRequired, true);
  assert.equal(status.activeAccount, 1);
});

test('TokenStore challenge expires and is cleared by a cookie refresh', () => {
  const store = tokenStore(['a', 'b']);
  store.markChallenge('a');
  store._challenges.set('a', Date.now() - 1);
  store._quarantine.set('a', Date.now() - 1);
  assert.equal(store.isChallenged('a'), false);

  store.markChallenge('a');
  store.update({ cookies: 'fresh=1' });
  assert.equal(store.isChallenged('a'), false);
  assert.equal(store._quarantine.has('a'), false);
});

test('TokenStore noteResponse switches after N messages', () => {
  const store = tokenStore(['a', 'b'], 2);
  assert.equal(store.noteResponse('a'), null);
  assert.deepEqual(store.noteResponse('a'), { from: 1, to: 2, count: 2 });
  assert.equal(store.current().token, 'b');
});

test('TokenStore noteResponse skips quarantined accounts', () => {
  const store = tokenStore(['a', 'b', 'c'], 1);
  store.markFailed('b');
  assert.deepEqual(store.noteResponse('a'), { from: 1, to: 3, count: 1 });
  assert.equal(store.current().token, 'c');
  assert.deepEqual(store.noteResponse('c'), { from: 3, to: 1, count: 1 });
});

test('TokenStore noteResponse stays put when every other account is quarantined', () => {
  const store = tokenStore(['a', 'b'], 1);
  store.markFailed('b');
  assert.equal(store.noteResponse('a'), null);
  assert.equal(store.current().token, 'a');
});

test('TokenStore single account never rotates even after failure', () => {
  const store = tokenStore(['a']);
  assert.equal(store.rotate('a').token, 'a');
});

test('TokenStore single account never rotates', () => {
  const store = tokenStore(['a'], 1);
  assert.equal(store.noteResponse('a'), null);
  assert.equal(store.rotate('a').token, 'a');
});

test('TokenStore update replaces the active token', () => {
  const store = tokenStore(['a', 'b']);
  store.update({ token: 'new' });
  assert.equal(store.current().token, 'new');
  assert.equal(store.count, 2);
});

test('SessionStore evicts expired and over-capacity entries', () => {
  const sessions = new SessionStore({ ttlMs: 60_000, max: 2 });
  sessions.set('a', { sessionId: '1' });
  sessions.set('b', { sessionId: '2' });
  sessions.set('c', { sessionId: '3' });
  assert.equal(sessions.size, 2);
  assert.equal(sessions.get('a'), null);

  sessions.set('d', { sessionId: '4' });
  for (const value of sessions.map.values()) value.updatedAt = Date.now() - 120_000;
  assert.equal(sessions.get('d'), null);
  assert.equal(sessions.size, 0);
});

test('SessionStore deleteByAccount removes only matching entries', () => {
  const sessions = new SessionStore({ ttlMs: 60000, max: 10 });
  sessions.set('a', { sessionId: '1', accountToken: 't1' });
  sessions.set('b', { sessionId: '2', accountToken: 't2' });
  sessions.deleteByAccount('t1');
  assert.equal(sessions.size, 1);
  assert.equal(sessions.get('b').sessionId, '2');
});

test('conversationKey changes with account and message prefix', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const base = conversationKey('default', false, messages, '', 't1');
  assert.notEqual(base, conversationKey('default', false, messages, '', 't2'));
  assert.notEqual(
    base,
    conversationKey('default', false, [{ role: 'user', content: 'yo' }], '', 't1'),
  );
  assert.equal(base, conversationKey('default', false, messages, '', 't1'));
});
