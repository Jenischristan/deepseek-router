const LEIM_URL = 'https://hif-leim.deepseek.com/query';
const DLIQ_URL = 'https://hif-dliq.deepseek.com/query';

// DeepSeek returns `x-hif-ttl: 600` (10 minutes). Refresh a little early so a
// request never goes out with a value that expires mid-flight.
const DEFAULT_TTL_MS = 8 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const PARTIAL_TTL_MS = 60 * 1000;

/**
 * Fetches and caches the short-lived anti-bot headers used by the web client.
 *
 * The official app polls hif-leim/hif-dliq every time the previous value is
 * about to expire. A static snapshot from log-in is rejected after roughly ten
 * minutes, which is what makes the router look like an unofficial client.
 */
export class HifStore {
  constructor({
    fetchImpl = fetch,
    refreshDliq = true,
    ttlMs = DEFAULT_TTL_MS,
    failureTtlMs = FAILURE_TTL_MS,
    partialTtlMs = PARTIAL_TTL_MS,
    timeoutMs = 3000,
    now = Date.now,
  } = {}) {
    this.fetchImpl = fetchImpl;
    // hif-dliq.deepseek.com is IPv6-only on some networks. The router disables
    // this by default; callers can pass refreshDliq: false to keep the static
    // value, or true to refresh both headers.
    this.refreshDliq = refreshDliq;
    this.ttlMs = ttlMs;
    this.failureTtlMs = failureTtlMs;
    this.partialTtlMs = partialTtlMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.cache = new Map();
    this.inflight = new Map();
  }

  key(account) {
    return account?.token || account?.cookies || 'anonymous';
  }

  async get(account, headers = {}) {
    const key = this.key(account);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = this._refresh(account, headers, cached).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  async _refresh(account, headers, cached) {
    const [leim, dliq] = await Promise.all([
      this._query(LEIM_URL, headers),
      this.refreshDliq ? this._query(DLIQ_URL, headers) : Promise.resolve(null),
    ]);

    const now = this.now();
    const values = {
      leim: leim.value || cached?.leim || account?.hifLeim || '',
      dliq: dliq?.value || cached?.dliq || account?.hifDliq || '',
      expiresAt: now + this._ttl(leim, dliq),
    };
    this.cache.set(this.key(account), values);
    return values;
  }

  _ttl(leim, dliq) {
    if (!leim.value || (this.refreshDliq && !dliq?.value)) {
      return leim.value || dliq?.value ? this.partialTtlMs : this.failureTtlMs;
    }
    const ttls = [leim.ttlMs, dliq?.ttlMs].filter(Boolean);
    const serverTtl = ttls.length ? Math.min(...ttls) : this.ttlMs;
    return Math.max(this.failureTtlMs, Math.min(this.ttlMs, serverTtl * 0.8));
  }

  async _query(url, headers) {
    try {
      // Preserve the caller's header order; only add accept when the caller
      // did not already provide browser headers.
      const requestHeaders = headers.accept
        ? headers
        : { accept: '*/*', ...headers };
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: requestHeaders,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return { value: '', ttlMs: 0 };

      const json = await response.json();
      const value = json?.data?.biz_data?.value;
      const ttlSec = Number(response.headers.get('x-hif-ttl')) || 600;
      return {
        value: typeof value === 'string' ? value : '',
        ttlMs: ttlSec * 1000,
      };
    } catch {
      return { value: '', ttlMs: 0 };
    }
  }
}
