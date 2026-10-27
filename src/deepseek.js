import { AuthError, UpstreamError, isPowError } from './errors.js';

const BASE = 'https://chat.deepseek.com';
const COMPLETION_PATH = '/api/v0/chat/completion';
const UPLOAD_PATH = '/api/v0/file/upload_file';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeepSeekClient {
  constructor({ tokenStore, solver, config }) {
    this.tokenStore = tokenStore;
    this.solver = solver;
    this.cfg = config;
  }

  async _headers(account, extra = {}) {
    const active = account ?? this.tokenStore.current();
    const token = active?.token || '';
    if (!token) throw new AuthError('No DeepSeek token configured');

    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      origin: BASE,
      referer: `${BASE}/`,
      'user-agent': this.cfg.userAgent,
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-platform': 'web',
      'x-client-version': this.cfg.clientVersion,
      'x-client-locale': this.cfg.locale,
      'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    };

    if (active?.cookies) headers.cookie = active.cookies;
    if (active?.hifLeim) headers['x-hif-leim'] = active.hifLeim;

    return { ...headers, ...extra };
  }

  async _fetch(path, { body, extraHeaders, signal, account } = {}) {
    const headers = await this._headers(account, extraHeaders);
    const timeout = AbortSignal.timeout(this.cfg.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    return fetch(BASE + path, {
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

        if (response.status === 401) throw new AuthError();
        if (json && [40002, 40003].includes(json.code)) throw new AuthError(json.msg);

        const session = json?.data?.biz_data?.chat_session;
        if (session?.id) return session.id;

        lastError = new UpstreamError(
          json?.msg || `Failed to create chat session (HTTP ${response.status})`,
          { status: response.status >= 400 ? response.status : 502, code: json?.code },
        );
      } catch (error) {
        if (error instanceof AuthError) throw error;
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

    if (response.status === 401 || (json && [40002, 40003].includes(json.code))) {
      throw new AuthError(json?.msg);
    }

    const challenge = json?.data?.biz_data?.challenge;
    if (!challenge) {
      throw new UpstreamError(
        json?.msg || `Failed to create PoW challenge (HTTP ${response.status})`,
        { status: response.status >= 400 ? response.status : 502, code: json?.code },
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
        const powHeader = await this._createPowHeader(account, UPLOAD_PATH);
        const form = new FormData();
        form.append('file', file);

        const extraHeaders = {
          'x-thinking-enabled': thinking ? '1' : '0',
          'x-model-type': modelType,
          'x-file-size': String(file.size ?? 0),
          'x-ds-pow-response': powHeader,
        };
        const headers = await this._headers(account, extraHeaders);
        // Let fetch set the multipart boundary; the JSON content-type from
        // _headers would break the upload.
        delete headers['content-type'];

        const timeout = AbortSignal.timeout(this.cfg.requestTimeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetch(BASE + UPLOAD_PATH, {
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
        // every upstream completion request.
        const powHeader = await this._createPowHeader(account);
        const response = await this._fetch(COMPLETION_PATH, {
          body,
          extraHeaders: { 'x-ds-pow-response': powHeader },
          signal,
          account,
        });

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('text/event-stream')) return response;

        const text = await response.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // ignore
        }

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
