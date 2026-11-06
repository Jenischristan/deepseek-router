import fs from 'node:fs';
import { configFilePath, normalizeAccounts, secondsValue } from './config.js';

const RELOAD_INTERVAL_MS = 5000;
// A token that returned an auth failure is skipped for this long before it is
// tried again. Dead tokens used to be retried every ten minutes, which produced
// hundreds of failed auth attempts per day and looked like credential stuffing.
// A re-synced token/cookie set clears the quarantine immediately.
const QUARANTINE_MS = 24 * 60 * 60 * 1000;
// Interactive verification cannot be fixed by retrying. Keep the account out
// of rotation long enough for the user to complete it in the browser.
const CHALLENGE_QUARANTINE_MS = 24 * 60 * 60 * 1000;

function accountsFromConfig(cfg) {
  const accounts = normalizeAccounts(cfg.accounts);
  if (accounts.length) return accounts;
  return normalizeAccounts([
    {
      token: cfg.token,
      cookies: cfg.cookies,
      hifLeim: cfg.hifLeim,
      hifDliq: cfg.hifDliq,
      deviceId: cfg.deviceId,
    },
  ]);
}

function normalizeSwitchAfter(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

export class TokenStore {
  constructor(cfg) {
    this.accounts = accountsFromConfig(cfg);
    this.index = 0;
    this.switchAfter = normalizeSwitchAfter(cfg.accountSwitchAfter);
    this.messagesOnAccount = 0;
    this.requestDelaySeconds = secondsValue(cfg.requestDelaySeconds);
    this.minIntervalMs = Math.max(0, Number(cfg.minIntervalMs) || 0);
    this.toolResultDelaySeconds = secondsValue(cfg.toolResultDelaySeconds);
    this.toolResultSkipAfterSeconds = secondsValue(cfg.toolResultSkipAfterSeconds) ?? 8;
    this.tokenFile = cfg.tokenFile || '';
    // `null` disables disk reloads, which tests use to stay hermetic. The
    // default keeps watching the user's config file.
    this.configFile = 'configFile' in cfg ? cfg.configFile : configFilePath();
    this._lastCheck = 0;
    this._fileMtime = 0;
    this._configMtime = 0;
    this._envAccounts = Boolean(process.env.DEEPSEEK_ACCOUNTS);
    this._envToken = Boolean(process.env.DEEPSEEK_TOKEN);
    this._envCookies = Boolean(process.env.DEEPSEEK_COOKIES);
    this._envHif = Boolean(process.env.DEEPSEEK_HIF_LEIM);
    this._envHifDliq = Boolean(process.env.DEEPSEEK_HIF_DLIQ);
    this._envSwitchAfter = process.env.DEEPSEEK_ACCOUNT_SWITCH_AFTER != null;
    this._envRequestDelay =
      process.env.DEEPSEEK_REQUEST_DELAY_SECONDS != null ||
      process.env.REQUEST_DELAY_SECONDS != null;
    this._envToolResultDelay =
      process.env.DEEPSEEK_TOOL_RESULT_DELAY_SECONDS != null;
    this._envToolResultSkip =
      process.env.DEEPSEEK_TOOL_RESULT_SKIP_AFTER_SECONDS != null;
    // token -> expiry timestamp (ms). Populated by markFailed().
    this._quarantine = new Map();
    // token -> expiry timestamp (ms) for interactive challenges. Tracked
    // separately from auth failures so /health can report the difference.
    this._challenges = new Map();
  }

  _isQuarantined(token, now = Date.now()) {
    const until = this._quarantine.get(token);
    if (!until) return false;
    if (until <= now) {
      this._quarantine.delete(token);
      return false;
    }
    return true;
  }

  _isChallenged(token, now = Date.now()) {
    const until = this._challenges.get(token);
    if (!until) return false;
    if (until <= now) {
      this._challenges.delete(token);
      return false;
    }
    return true;
  }

  markFailed(token) {
    if (!token) return;
    const until = Date.now() + QUARANTINE_MS;
    // Do not shorten a longer quarantine (for example the 30-minute
    // interactive-challenge window) when this token is also rotated away.
    const existing = this._quarantine.get(token);
    if (existing && existing > until) return;
    this._quarantine.set(token, until);
  }

  markChallenge(token, cooldownMs = CHALLENGE_QUARANTINE_MS) {
    if (!token) return;
    const until = Date.now() + cooldownMs;
    this._challenges.set(token, until);
    this._quarantine.set(token, until);
  }

  isChallenged(token = null) {
    this._maybeReload();
    const active = token ?? this.accounts[this.index]?.token;
    return this._isChallenged(active);
  }

  _replaceAccounts(list) {
    const currentToken = this.accounts[this.index]?.token;
    const changed =
      list.length !== this.accounts.length ||
      list.some(
        (account, i) =>
          account.token !== this.accounts[i]?.token ||
          account.cookies !== this.accounts[i]?.cookies ||
          account.hifLeim !== this.accounts[i]?.hifLeim ||
          account.hifDliq !== this.accounts[i]?.hifDliq,
      );
    this.accounts = list;
    const index = currentToken
      ? list.findIndex((account) => account.token === currentToken)
      : -1;
    this.index = index >= 0 ? index : 0;
    this.messagesOnAccount = 0;
    // A freshly synced token should be tried immediately instead of waiting
    // out a cooldown earned by a stale token it replaced.
    if (changed) this.clearQuarantine();
  }

  _readTokenFile() {
    if (!this.tokenFile) return;
    try {
      const stat = fs.statSync(this.tokenFile);
      if (stat.mtimeMs !== this._fileMtime) {
        this._fileMtime = stat.mtimeMs;
        const token = fs.readFileSync(this.tokenFile, 'utf8').trim();
        if (token) {
          this._replaceAccounts(
            normalizeAccounts([
              { ...(this.accounts[0] || { cookies: '', hifLeim: '', hifDliq: '' }), token },
              ...this.accounts.slice(1),
            ]),
          );
        }
      }
    } catch {
      // ignore
    }
  }

  _readConfig() {
    if (!this.configFile) return;
    try {
      const stat = fs.statSync(this.configFile);
      if (stat.mtimeMs === this._configMtime) return;
      this._configMtime = stat.mtimeMs;
      const cfg = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));

      if (!this._envSwitchAfter && cfg.accountSwitchAfter !== undefined) {
        this.switchAfter = normalizeSwitchAfter(cfg.accountSwitchAfter);
        if (this.messagesOnAccount >= this.switchAfter) {
          this.messagesOnAccount = 0;
        }
      }

      // Pacing is hot-reloaded: requestDelayMs() reads the config file directly
      // so an edit applies to the next request without a restart.
      if (!this._envRequestDelay) {
        this.requestDelaySeconds = secondsValue(cfg.requestDelaySeconds);
      }
      if (!this._envToolResultDelay) {
        this.toolResultDelaySeconds = secondsValue(cfg.toolResultDelaySeconds);
      }
      if (!this._envToolResultSkip) {
        this.toolResultSkipAfterSeconds =
          secondsValue(cfg.toolResultSkipAfterSeconds) ?? 8;
      }

      if (this._envAccounts) return;

      const accounts = normalizeAccounts(cfg.accounts);
      if (accounts.length) {
        if (this._envToken) {
          const envAccount = this.accounts[0] || {
            token: '',
            cookies: '',
            hifLeim: '',
            hifDliq: '',
          };
          this._replaceAccounts(
            normalizeAccounts([
              {
                token: process.env.DEEPSEEK_TOKEN,
                cookies: envAccount.cookies,
                hifLeim: envAccount.hifLeim,
                hifDliq: envAccount.hifDliq,
              },
              ...accounts,
            ]),
          );
        } else {
          this._replaceAccounts(accounts);
        }
        return;
      }

      const current = this.accounts[0] || {
        token: '',
        cookies: '',
        hifLeim: '',
        hifDliq: '',
      };
      const primary = {
        token:
          !this._envToken && typeof cfg.token === 'string' && cfg.token
            ? cfg.token
            : current.token,
        cookies:
          !this._envCookies && typeof cfg.cookies === 'string'
            ? cfg.cookies
            : current.cookies,
        hifLeim:
          !this._envHif && typeof cfg.hifLeim === 'string'
            ? cfg.hifLeim
            : current.hifLeim,
        hifDliq:
          !this._envHifDliq && typeof cfg.hifDliq === 'string'
            ? cfg.hifDliq
            : current.hifDliq,
      };

      if (primary.token) {
        this._replaceAccounts([primary]);
      }
    } catch {
      // ignore
    }
  }

  _maybeReload() {
    const now = Date.now();
    if (now - this._lastCheck < RELOAD_INTERVAL_MS) return;
    this._lastCheck = now;
    this._readTokenFile();
    this._readConfig();
  }

  current() {
    this._maybeReload();
    return this.accounts[this.index] || null;
  }

  requestDelayMs() {
    this._readConfig();
    if (this.requestDelaySeconds != null) {
      return Math.round(this.requestDelaySeconds * 1000);
    }
    return this.minIntervalMs;
  }

  toolResultDelayMs() {
    this._readConfig();
    if (this.toolResultDelaySeconds == null) return 0;
    return Math.round(this.toolResultDelaySeconds * 1000);
  }

  toolResultSkipAfterMs() {
    this._readConfig();
    if (this.toolResultSkipAfterSeconds == null) return 8000;
    return Math.round(this.toolResultSkipAfterSeconds * 1000);
  }

  async get() {
    return this.current()?.token || '';
  }

  get cookies() {
    return this.current()?.cookies || '';
  }

  get hifLeim() {
    return this.current()?.hifLeim || '';
  }

  get hifDliq() {
    return this.current()?.hifDliq || '';
  }

  get count() {
    this._maybeReload();
    return this.accounts.length;
  }

  get active() {
    this._maybeReload();
    return this.index;
  }

  rotate(failedToken = null) {
    this._maybeReload();
    if (this.accounts.length <= 1) return this.accounts[this.index] || null;

    const current = this.accounts[this.index];
    if (failedToken && current && current.token !== failedToken) {
      return current;
    }

    // Quarantine the token that just failed so it is skipped on subsequent
    // rotations instead of being retried on every cycle.
    if (failedToken) this.markFailed(failedToken);

    // Walk forward to the next token that is not quarantined. If every
    // account is quarantined, fall back to plain round-robin so a config
    // refresh or a recovered token is never permanently locked out.
    const now = Date.now();
    const start = this.index;
    for (let step = 1; step <= this.accounts.length; step += 1) {
      const next = (start + step) % this.accounts.length;
      if (!this._isQuarantined(this.accounts[next]?.token, now)) {
        this.index = next;
        this.messagesOnAccount = 0;
        return this.accounts[this.index];
      }
    }

    // Every account is quarantined: fall back to plain round-robin.
    this.index = (start + 1) % this.accounts.length;
    this.messagesOnAccount = 0;
    return this.accounts[this.index];
  }

  // Re-enable every quarantined token (e.g. after the user re-syncs their
  // browser session). Called when the account list changes so a refreshed
  // token is not skipped for the rest of its cooldown.
  clearQuarantine() {
    this._quarantine.clear();
    this._challenges.clear();
  }

  noteResponse(token = null) {
    this._maybeReload();
    if (this.switchAfter <= 0 || this.accounts.length <= 1) return null;

    const current = this.accounts[this.index];
    if (!current || (token && current.token !== token)) return null;

    this.messagesOnAccount += 1;
    if (this.messagesOnAccount < this.switchAfter) return null;

    const from = this.index + 1;
    this.messagesOnAccount = 0;

    // Scheduled rotation should not land on a token that already failed auth
    // or needs verification. It would produce a pointless failed request and
    // then rotate again on the next turn.
    const now = Date.now();
    for (let step = 1; step <= this.accounts.length; step += 1) {
      const next = (this.index + step) % this.accounts.length;
      if (!this._isQuarantined(this.accounts[next]?.token, now)) {
        if (next === this.index) return null;
        this.index = next;
        return { from, to: this.index + 1, count: this.switchAfter };
      }
    }

    // Every account is quarantined: keep the old round-robin behavior.
    this.index = (this.index + 1) % this.accounts.length;
    return { from, to: this.index + 1, count: this.switchAfter };
  }

  update(patch = {}) {
    if (Array.isArray(patch.accounts) && patch.accounts.length) {
      this._replaceAccounts(normalizeAccounts(patch.accounts));
    } else if (typeof patch.token === 'string' && patch.token) {
      const current = this.accounts[this.index] || {
        token: '',
        cookies: '',
        hifLeim: '',
        hifDliq: '',
        deviceId: '',
      };
      const updated = {
        ...current,
        token: patch.token,
        cookies: typeof patch.cookies === 'string' ? patch.cookies : current.cookies,
        hifLeim: typeof patch.hifLeim === 'string' ? patch.hifLeim : current.hifLeim,
        hifDliq: typeof patch.hifDliq === 'string' ? patch.hifDliq : current.hifDliq,
        deviceId: typeof patch.deviceId === 'string' ? patch.deviceId : current.deviceId,
      };
      const rest = this.accounts.filter((_, i) => i !== this.index);
      const list = normalizeAccounts([updated, ...rest]);
      const index = list.findIndex((account) => account.token === updated.token);
      this.accounts = list;
      this.index = index >= 0 ? index : 0;
      this.messagesOnAccount = 0;
      // A refreshed token/cookies may carry the result of the browser
      // verification, so let the account be tried again immediately.
      this._quarantine.delete(updated.token);
      this._challenges.delete(updated.token);
    } else {
      if (typeof patch.cookies === 'string' && this.accounts[this.index]) {
        this.accounts[this.index] = { ...this.accounts[this.index], cookies: patch.cookies };
      }
      if (typeof patch.hifLeim === 'string' && this.accounts[this.index]) {
        this.accounts[this.index] = { ...this.accounts[this.index], hifLeim: patch.hifLeim };
      }
      if (typeof patch.hifDliq === 'string' && this.accounts[this.index]) {
        this.accounts[this.index] = { ...this.accounts[this.index], hifDliq: patch.hifDliq };
      }
      if (typeof patch.deviceId === 'string' && this.accounts[this.index]) {
        this.accounts[this.index] = { ...this.accounts[this.index], deviceId: patch.deviceId };
      }
      const activeToken = this.accounts[this.index]?.token;
      if (
        activeToken &&
        (typeof patch.cookies === 'string' ||
          typeof patch.hifLeim === 'string' ||
          typeof patch.hifDliq === 'string' ||
          typeof patch.deviceId === 'string')
      ) {
        this._quarantine.delete(activeToken);
        this._challenges.delete(activeToken);
      }
    }

    // Keep an in-memory update from being reverted by the periodic config
    // reload. A later change to the file (new mtime) still wins.
    if (this.configFile) {
      try {
        this._configMtime = fs.statSync(this.configFile).mtimeMs;
      } catch {
        // ignore
      }
    }
  }

  status() {
    this._lastCheck = Date.now();
    this._readTokenFile();
    this._readConfig();
    const current = this.accounts[this.index] || null;
    const challengedAccounts = [];
    for (let i = 0; i < this.accounts.length; i += 1) {
      if (this._isChallenged(this.accounts[i].token)) challengedAccounts.push(i + 1);
    }
    return {
      hasToken: Boolean(current?.token),
      hasCookies: Boolean(current?.cookies),
      hasHifLeim: Boolean(current?.hifLeim),
      hasHifDliq: Boolean(current?.hifDliq),
      tokenLength: current?.token.length || 0,
      accounts: this.accounts.length,
      activeAccount: this.accounts.length ? this.index + 1 : 0,
      switchAfter: this.switchAfter,
      messagesOnAccount: this.messagesOnAccount,
      challengeRequired: this._isChallenged(current?.token),
      challengedAccounts,
    };
  }
}
