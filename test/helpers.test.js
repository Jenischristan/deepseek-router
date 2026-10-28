import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import os from 'node:os';

import { loadConfig, normalizeAccounts } from '../src/config.js';
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
    { token: 'a', cookies: '', hifLeim: '' },
    { token: 'b', cookies: 'c=1', hifLeim: '' },
  ]);
});

test('loadConfig reads new env overrides', () => {
  withEnv(
    {
      DEEPSEEK_TOKEN: 'env-token',
      DEEPSEEK_CLIENT_VERSION: '9.9.9',
      DEEPSEEK_LOCALE: 'de_DE',
      DEEPSEEK_USER_AGENT: 'test-agent',
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

test('TokenStore noteResponse switches after N messages', () => {
  const store = tokenStore(['a', 'b'], 2);
  assert.equal(store.noteResponse('a'), null);
  assert.deepEqual(store.noteResponse('a'), { from: 1, to: 2, count: 2 });
  assert.equal(store.current().token, 'b');
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
