import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ACCEPT_ENCODING } from './fetch.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'deepseek-router')
  : path.join(os.homedir(), '.config', 'deepseek-router');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function configFilePath() {
  return process.env.DEEPSEEK_ROUTER_CONFIG_FILE || CONFIG_FILE;
}

export function readConfigFile() {
  const explicit = process.env.DEEPSEEK_ROUTER_CONFIG_FILE;
  const candidates = explicit
    ? [explicit]
    : [CONFIG_FILE, path.join(ROOT, 'config.json')];
  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      // Missing file: nothing to report, try the next location.
      continue;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      // A malformed config used to look like "no config", which surfaces later
      // as a confusing missing-token error. Say what is actually wrong.
      console.error(`deepseek-router: cannot parse ${file}: ${error.message}`);
      return {};
    }
  }
  return {};
}

export function normalizeAccounts(list) {
  if (!Array.isArray(list)) return [];
  const accounts = [];
  const seen = new Set();

  for (const entry of list) {
    const account =
      typeof entry === 'string'
        ? { token: entry.trim(), cookies: '', hifLeim: '', hifDliq: '' }
        : entry && typeof entry === 'object'
          ? {
            token: typeof entry.token === 'string' ? entry.token.trim() : '',
            cookies: typeof entry.cookies === 'string' ? entry.cookies : '',
            hifLeim: typeof entry.hifLeim === 'string' ? entry.hifLeim : '',
            hifDliq: typeof entry.hifDliq === 'string' ? entry.hifDliq : '',
          }
          : null;

    if (!account?.token || seen.has(account.token)) continue;
    seen.add(account.token);
    accounts.push(account);
  }

  return accounts;
}

function boolValue(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

export function secondsValue(value) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds;
}

function envAccounts() {
  if (!process.env.DEEPSEEK_ACCOUNTS) return [];
  try {
    return normalizeAccounts(JSON.parse(process.env.DEEPSEEK_ACCOUNTS));
  } catch {
    return [];
  }
}

export function loadConfig() {
  const file = readConfigFile();
  const env = process.env;

  const primary = {
    token: env.DEEPSEEK_TOKEN || file.token || '',
    cookies: env.DEEPSEEK_COOKIES || file.cookies || '',
    hifLeim: env.DEEPSEEK_HIF_LEIM || file.hifLeim || '',
    hifDliq: env.DEEPSEEK_HIF_DLIQ || file.hifDliq || '',
  };

  const fromEnv = envAccounts();
  let accounts;
  if (fromEnv.length) {
    accounts = fromEnv;
  } else if (env.DEEPSEEK_TOKEN) {
    accounts = normalizeAccounts([primary, ...(file.accounts || [])]);
  } else {
    accounts = normalizeAccounts(file.accounts);
  }
  if (!accounts.length && primary.token) accounts = normalizeAccounts([primary]);

  const cfg = {
    accounts,
    token: accounts[0]?.token || '',
    tokenFile: env.DEEPSEEK_TOKEN_FILE || file.tokenFile || '',
    cookies: accounts[0]?.cookies || '',
    hifLeim: accounts[0]?.hifLeim || '',
    hifDliq: accounts[0]?.hifDliq || '',
    hifDliqRefresh: boolValue(
      env.DEEPSEEK_HIF_DLIQ_REFRESH ?? file.hifDliqRefresh,
      false,
    ),
    apiKey: env.DEEPSEEK_ROUTER_KEY || file.apiKey || '',
    host: env.HOST || file.host || '127.0.0.1',
    port: Number(env.PORT || file.port || 8788),
    requestDelaySeconds: secondsValue(
      env.DEEPSEEK_REQUEST_DELAY_SECONDS ??
        env.REQUEST_DELAY_SECONDS ??
        file.requestDelaySeconds,
    ),
    minIntervalMs: Number(env.UPSTREAM_MIN_INTERVAL_MS ?? file.minIntervalMs ?? 400),
    concurrency: Math.max(1, Number(env.UPSTREAM_CONCURRENCY ?? file.concurrency ?? 1)),
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? file.sessionTtlMs ?? 6 * 60 * 60 * 1000),
    maxSessions: Number(env.MAX_SESSIONS ?? file.maxSessions ?? 500),
    injectToolPrompt: boolValue(
      env.INJECT_TOOL_PROMPT ?? env.DEEPSEEK_INJECT_TOOL_PROMPT ?? file.injectToolPrompt,
      true,
    ),
    parseToolCalls: boolValue(
      env.PARSE_TOOL_CALLS ?? env.DEEPSEEK_PARSE_TOOL_CALLS ?? file.parseToolCalls,
      true,
    ),
    accountSwitchAfter: Number(
      env.DEEPSEEK_ACCOUNT_SWITCH_AFTER ?? file.accountSwitchAfter ?? 0,
    ),
    repairToolCalls: boolValue(
      env.REPAIR_TOOL_CALLS ?? env.DEEPSEEK_REPAIR_TOOL_CALLS ?? file.repairToolCalls,
      true,
    ),
    maxToolRepairs: Number(
      env.MAX_TOOL_REPAIRS ?? file.maxToolRepairs ?? 2,
    ),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? file.requestTimeoutMs ?? 10 * 60 * 1000),
    clientVersion: env.DEEPSEEK_CLIENT_VERSION || file.clientVersion || '2.7.0',
    locale: env.DEEPSEEK_LOCALE || file.locale || 'en_US',
    userAgent:
      env.DEEPSEEK_USER_AGENT ||
      file.userAgent ||
      'Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0',
    acceptLanguage:
      env.DEEPSEEK_ACCEPT_LANGUAGE || file.acceptLanguage || 'en-US,en;q=0.9',
    acceptEncoding:
      env.DEEPSEEK_ACCEPT_ENCODING ||
      file.acceptEncoding ||
      DEFAULT_ACCEPT_ENCODING,
    secGpc: boolValue(env.DEEPSEEK_SEC_GPC ?? file.secGpc, true),
    transport: String(env.DEEPSEEK_TRANSPORT || file.transport || 'firefox').toLowerCase(),
    transportBinary:
      env.DEEPSEEK_TRANSPORT_BINARY ||
      file.transportBinary ||
      path.join(ROOT, 'transport', 'deepseek-transport'),
    transportProfile:
      env.DEEPSEEK_TRANSPORT_PROFILE || file.transportProfile || 'firefox_159',
    wasmPath: env.SHA3_WASM || file.wasmPath || path.join(ROOT, 'assets', 'sha3.wasm'),
    logLevel: env.LOG_LEVEL || file.logLevel || 'info',
  };

  if (cfg.tokenFile) {
    try {
      const token = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
      if (token) {
        cfg.accounts = normalizeAccounts([
          { ...(cfg.accounts[0] || { cookies: '', hifLeim: '', hifDliq: '' }), token },
          ...cfg.accounts.slice(1),
        ]);
        cfg.token = cfg.accounts[0].token;
      }
    } catch {
      // ignore
    }
  }

  return cfg;
}

export function saveConfig(patch) {
  const target = configFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

  // The token extractor may rewrite the same file while the router is running.
  // Re-read just before writing and retry if the file changed underneath us, so
  // a concurrent update is merged instead of silently overwritten.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let before = null;
    let current = {};
    try {
      before = fs.statSync(target);
      current = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      // Missing or unreadable file: start from an empty object.
    }

    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });

    let after = null;
    try {
      after = fs.statSync(target);
    } catch {
      // ignore
    }
    if (!before || !after || after.mtimeMs !== before.mtimeMs || attempt === 2) {
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        // ignore
      }
      return next;
    }
  }

  // Unreachable, kept for clarity.
  return {};
}
