import {
  AuthError,
  ChallengeError,
  UpstreamError,
  isChallengeMessage,
  isPowError,
} from './errors.js';
import { DEFAULT_ACCEPT_ENCODING, withZstd } from './fetch.js';
import { HifStore } from './hif.js';

const BASE = 'https://chat.deepseek.com';
const COMPLETION_PATH = '/api/v0/chat/completion';
const UPLOAD_PATH = '/api/v0/file/upload_file';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clientHeaders(cfg) {
  return {
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-platform': 'web',
    'x-client-version': cfg.clientVersion,
    'x-client-locale': cfg.locale,
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
}

// The real web client uses XMLHttpRequest. Firefox writes the standard
// browser headers first, then author headers in insertion order, then
// content-type/content-length, origin, GPC, referer, cookies, and sec-fetch-*.
// Keep this object in that order; the transport sidecar forwards the order
// hint.
function browserHeaders(
  cfg,
  {
    site = 'same-origin',
    contentType = '',
    authorization = '',
    cookie = '',
    hifLeim = '',
    hifDliq = '',
    deviceId = '',
    extraHeaders = {},
  } = {},
) {
  const headers = {
    'user-agent': cfg.userAgent,
    accept: '*/*',
    'accept-language': cfg.acceptLanguage || 'en-US,en;q=0.9',
    'accept-encoding': cfg.acceptEncoding || DEFAULT_ACCEPT_ENCODING,
  };
  Object.assign(headers, extraHeaders);
  if (hifLeim) headers['x-hif-leim'] = hifLeim;
  if (hifDliq) headers['x-hif-dliq'] = hifDliq;
  Object.assign(headers, clientHeaders(cfg));
  if (authorization) headers.authorization = authorization;
  if (contentType) headers['content-type'] = contentType;
  headers.origin = BASE;
  if (cfg.secGpc !== false) headers['sec-gpc'] = '1';
  headers.referer = `${BASE}/`;
  if (cookie) headers.cookie = cookie;
  headers['sec-fetch-dest'] = 'empty';
  headers['sec-fetch-mode'] = 'cors';
  headers['sec-fetch-site'] = site;
  if (deviceId) {
    // The web client's request interceptor appends these last. The browser
    // stores the UUID in localStorage per container; using the same value is
    // part of the account's device identity.
    headers['x-device-id'] = deviceId;
    headers['x-device-model'] = '';
  }
  return headers;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function isChallengeResponse(response, json, text = '') {
  const waf = String(response?.headers?.get('x-amzn-waf-action') || '').toLowerCase();
  const cf = String(response?.headers?.get('cf-mitigated') || '').toLowerCase();
  if (
    (response?.status === 405 && waf === 'captcha') ||
    (response?.status === 202 && waf === 'challenge') ||
    ((response?.status === 403 || response?.status === 429) && cf === 'challenge')
  ) {
    return true;
  }
  return Boolean(challengeMessage(json, text));
}

function throwIfChallengeResponse(response, json, text = '') {
  if (isChallengeResponse(response, json, text)) {
    throw new ChallengeError('DeepSeek requires manual verification (captcha/challenge)');
  }
}

function challengeMessage(json, text = '') {
  const candidates = [
    json?.msg,
    json?.message,
    json?.data?.biz_msg,
    json?.data?.message,
    json?.data?.biz_data?.msg,
  ];
  for (const candidate of candidates) {
    if (isChallengeMessage(candidate)) return String(candidate);
  }
  if (isChallengeMessage(text)) return 'DeepSeek requires manual verification';
  return null;
}

export class DeepSeekClient {
  constructor({ tokenStore, solver, config, hif, fetchImpl = fetch }) {
    this.tokenStore = tokenStore;
    this.solver = solver;
    this.cfg = config;
    this.fetch = withZstd(fetchImpl);
    // `hif: null` disables the runtime fetch (tests, or when the user wants
    // the old static x-hif-leim behavior).
    // `hifRefreshEnabled: false` disables the runtime hif-leim/hif-dliq polls
    // entirely, so completions carry only the static configured values.
    this.hif =
      hif === undefined
        ? this.cfg.hifRefreshEnabled === false
          ? null
          : new HifStore({
              fetchImpl: this.fetch,
              refreshDliq: this.cfg.hifDliqRefresh === true,
            })
        : hif;
  }

  async _headers(account, extra = {}, { hif = false } = {}) {
    const active = account ?? this.tokenStore.current();
    const token = active?.token || '';
    if (!token) throw new AuthError('No DeepSeek token configured');

    let hifLeim = '';
    let hifDliq = '';

    // The web client only adds hif headers to the SSE completion request
    // (`addSSEHeader`), and refreshes them from hif-*.deepseek.com/query
    // before the 10-minute TTL expires. A stale log-in snapshot is one of
    // the strongest "unofficial client" signals.
    if (hif) {
      hifLeim = active?.hifLeim || '';
      hifDliq = active?.hifDliq || '';

      if (this.hif) {
        let values = null;
        try {
          values = await this.hif.get(
            active,
            // hif-*.deepseek.com is a different origin but the same site.
            // The web client's global request hook adds the x-client headers
            // to these polls too, and the browser sends no DeepSeek cookies
            // because they are scoped to chat.deepseek.com.
            browserHeaders(this.cfg, { site: 'same-site' }),
          );
        } catch {
          // A hif outage must not fail the completion; fall back to the
          // configured static value, if any.
        }
        if (values?.leim) hifLeim = values.leim;
        if (values?.dliq) hifDliq = values.dliq;
      }
    }

    return browserHeaders(this.cfg, {
      site: 'same-origin',
      contentType: 'application/json',
      authorization: `Bearer ${token}`,
      cookie: active?.cookies || '',
      hifLeim,
      hifDliq,
      deviceId: active?.deviceId || '',
      extraHeaders: extra,
    });
  }

  async _fetch(path, { body, extraHeaders, signal, account, hif = false } = {}) {
    const headers = await this._headers(account, extraHeaders, { hif });
    const timeout = AbortSignal.timeout(this.cfg.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    return this.fetch(BASE + path, {
      method: 'POST',
      headers,
      body: body ?? '{}',
      signal: combined,
    });
  }

  async createSession({ signal, account } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new UpstreamError('Request aborted', { status: 499 });

      try {
        const response = await this._fetch('/api/v0/chat_session/create', {
          body: '{}',
          signal,
          account,
        });
        const text = await response.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // ignore
        }

        throwIfChallengeResponse(response, json, text);

        if (response.status === 401) throw new AuthError();
        if (json && [40002, 40003].includes(json.code)) throw new AuthError(json.msg);

        if (response.status === 429 || json?.code === 50006) {
          throw new UpstreamError(json?.msg || 'DeepSeek rate limit reached', {
            status: 429,
            code: json?.code ?? 429,
            retryable: true,
            retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          });
        }

        const session = json?.data?.biz_data?.chat_session;
        if (session?.id) return session.id;

        lastError = new UpstreamError(
          json?.msg || `Failed to create chat session (HTTP ${response.status})`,
          {
            status: response.status >= 400 ? response.status : 502,
            code: json?.code,
            retryAfterMs:
              response.status === 429
                ? parseRetryAfter(response.headers.get('retry-after'))
                : null,
          },
        );
      } catch (error) {
        if (
          error instanceof AuthError ||
          error instanceof ChallengeError ||
          error instanceof UpstreamError
        ) {
          throw error;
        }
        if (signal?.aborted) throw new UpstreamError('Request aborted', { status: 499 });
        lastError = error;
      }

      if (attempt < 2) await sleep(400 * (attempt + 1));
    }

    throw lastError instanceof Error
      ? lastError
      : new UpstreamError('Failed to create chat session');
  }

  async _createPowHeader(account, targetPath = COMPLETION_PATH) {
    const response = await this._fetch('/api/v0/chat/create_pow_challenge', {
      body: JSON.stringify({ target_path: targetPath }),
      account,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }

    throwIfChallengeResponse(response, json, text);

    if (response.status === 401 || (json && [40002, 40003].includes(json.code))) {
      throw new AuthError(json?.msg);
    }

    const challenge = json?.data?.biz_data?.challenge;
    if (!challenge) {
      throw new UpstreamError(
        json?.msg || `Failed to create PoW challenge (HTTP ${response.status})`,
        {
          status: response.status >= 400 ? response.status : 502,
          code: json?.code,
          retryAfterMs:
            response.status === 429
              ? parseRetryAfter(response.headers.get('retry-after'))
              : null,
        },
      );
    }

    const answer = this.solver.solve(challenge);
    const payload = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: targetPath,
    };

    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  }

  async uploadFile({ file, thinking = false, modelType = 'default', signal, account }) {
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new UpstreamError('Request aborted', { status: 499 });

      try {
        const powHeader =
          this.cfg.powChallengeEnabled === false
            ? ''
            : await this._createPowHeader(account, UPLOAD_PATH);
        const form = new FormData();
        form.append('file', file);

        const extraHeaders = {
          'x-thinking-enabled': thinking ? '1' : '0',
          'x-model-type': modelType,
          'x-file-size': String(file.size ?? 0),
        };
        if (powHeader) extraHeaders['x-ds-pow-response'] = powHeader;
        const headers = await this._headers(account, extraHeaders);
        // Let fetch set the multipart boundary; the JSON content-type from
        // _headers would break the upload.
        delete headers['content-type'];

        const timeout = AbortSignal.timeout(this.cfg.requestTimeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await this.fetch(BASE + UPLOAD_PATH, {
          method: 'POST',
          headers,
          body: form,
          signal: combined,
        });

        const text = await response.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // ignore
        }

        throwIfChallengeResponse(response, json, text);

        const bizCode = json?.data?.biz_code;
        if (json && isPowError(bizCode) && attempt < 2) {
          lastError = new UpstreamError(json.data?.biz_msg || 'Invalid PoW response', {
            code: bizCode,
            retryable: true,
          });
          await sleep(250);
          continue;
        }

        if (response.status === 401 || (json && [40002, 40003].includes(json.code))) {
          throw new AuthError(json?.msg || 'DeepSeek token is invalid or expired');
        }

        if (response.status === 429 || bizCode === 50006) {
          throw new UpstreamError(json?.data?.biz_msg || json?.msg || 'DeepSeek rate limit reached', {
            status: 429,
            code: bizCode ?? json?.code ?? 429,
            retryable: true,
            retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          });
        }

        if (bizCode !== undefined && bizCode !== 0) {
          throw new UpstreamError(
            json?.data?.biz_msg || `DeepSeek upload failed (biz_code ${bizCode})`,
            { code: bizCode },
          );
        }

        const fileInfo = json?.data?.biz_data;
        if (!fileInfo?.id) {
          throw new UpstreamError(
            json?.msg || text || `DeepSeek upload failed (HTTP ${response.status})`,
            { status: response.status >= 400 ? response.status : 502, code: json?.code ?? null },
          );
        }

        return fileInfo;
      } catch (error) {
        if (error instanceof AuthError || error instanceof UpstreamError) throw error;
        if (signal?.aborted) throw new UpstreamError('Request aborted', { status: 499 });

        lastError = error;
        if (attempt < 2) {
          await sleep(500 * (attempt + 1));
          continue;
        }
      }
    }

    throw lastError instanceof Error
      ? new UpstreamError(`DeepSeek upload failed: ${lastError.message}`, { retryable: true })
      : new UpstreamError('DeepSeek upload failed');
  }

  async completion({
    sessionId,
    parentMessageId,
    prompt,
    modelType = 'default',
    thinking = false,
    search = false,
    refFileIds = [],
    signal,
    account,
  }) {
    const body = JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: parentMessageId ?? null,
      model_type: modelType,
      prompt,
      ref_file_ids: refFileIds,
      thinking_enabled: Boolean(thinking),
      search_enabled: Boolean(search),
      source: 'default',
      action: null,
      preempt: false,
    });

    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new UpstreamError('Request aborted', { status: 499 });

      try {
        // PoW answers are single-use, so a fresh challenge is required for
        // every upstream completion request. powChallengeEnabled=false skips
        // the extra challenge POST and the x-ds-pow-response header.
        const powHeader =
          this.cfg.powChallengeEnabled === false
            ? ''
            : await this._createPowHeader(account);
        const extraHeaders = powHeader ? { 'x-ds-pow-response': powHeader } : {};
        const response = await this._fetch(COMPLETION_PATH, {
          body,
          extraHeaders,
          signal,
          account,
          hif: true,
        });

        const contentType = response.headers.get('content-type') || '';

        throwIfChallengeResponse(response, null, '');
        if (contentType.includes('text/event-stream')) return response;

        const text = await response.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // ignore
        }

        throwIfChallengeResponse(response, json, text);

        if (json && isPowError(json.code) && attempt < 2) {
          lastError = new UpstreamError(json.msg || 'Invalid PoW response', {
            code: json.code,
            retryable: true,
          });
          await sleep(250);
          continue;
        }

        if (response.status === 401 || (json && [40002, 40003].includes(json.code))) {
          throw new AuthError(json?.msg || 'DeepSeek token is invalid or expired');
        }

        if (response.status === 429 || (json && json.code === 50006)) {
          throw new UpstreamError(json?.msg || 'DeepSeek rate limit reached', {
            status: 429,
            code: json?.code ?? 429,
            retryable: true,
            retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          });
        }

        throw new UpstreamError(
          json?.msg || text || `DeepSeek completion failed (HTTP ${response.status})`,
          {
            status: response.status >= 400 ? response.status : 502,
            code: json?.code ?? null,
          },
        );
      } catch (error) {
        if (error instanceof AuthError || error instanceof UpstreamError) throw error;
        if (signal?.aborted) throw new UpstreamError('Request aborted', { status: 499 });

        lastError = error;
        if (attempt < 2) {
          await sleep(500 * (attempt + 1));
          continue;
        }
      }
    }

    throw lastError instanceof Error
      ? new UpstreamError(`DeepSeek request failed: ${lastError.message}`, {
        retryable: true,
      })
      : new UpstreamError('DeepSeek request failed');
  }
}
