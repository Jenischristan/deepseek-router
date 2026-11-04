import { ChallengeError, UpstreamError, isChallengeMessage } from '../errors.js';

// DeepSeek SSE stream parser
// ===========================================================================

// Parses DeepSeek's patch-based SSE stream.
// Content lives in fragments: THINK -> reasoning, everything else -> content.
export async function consumeDeepSeekStream(response, handlers = {}) {
  const state = {
    fragments: [],
    current: -1,
    responseMessageId: null,
    requestMessageId: null,
    modelType: null,
    totalTokens: 0,
    status: null,
    title: null,
    done: false,
  };

  const emit = (fragment, text) => {
    if (!text) return;
    // Only RESPONSE fragments are assistant answer text. THINK, SEARCH, TIP and
    // any future non-answer fragment type stay out of content (and out of the
    // tool-call parser), otherwise raw markup/search notes leak to the client.
    const field = !fragment.type || fragment.type === 'RESPONSE' ? 'content' : 'reasoning';
    handlers.onDelta?.(field, text, fragment);
  };

  const appendText = (fragment, text) => {
    if (!text) return;
    fragment.content += text;
    emit(fragment, text);
  };

  const addFragment = (raw) => {
    const fragment = {
      type: raw.type || 'RESPONSE',
      content: typeof raw.content === 'string' ? raw.content : '',
    };
    state.fragments.push(fragment);
    state.current = state.fragments.length - 1;
    emit(fragment, fragment.content);
    return fragment;
  };

  const reconcileSnapshot = (fragments) => {
    const incoming = Array.isArray(fragments) ? fragments : [];
    if (!state.fragments.length) {
      for (const fragment of incoming) addFragment(fragment);
      return;
    }

    for (let i = 0; i < incoming.length; i += 1) {
      const next = incoming[i];
      const existing = state.fragments[i];
      if (!existing) {
        addFragment(next);
        continue;
      }
      const nextContent = typeof next.content === 'string' ? next.content : '';
      if (next.type) existing.type = next.type;
      if (!nextContent || nextContent === existing.content) continue;
      if (existing.content.startsWith(nextContent)) continue;

      if (nextContent.startsWith(existing.content)) {
        appendText(existing, nextContent.slice(existing.content.length));
      } else {
        existing.content = '';
        appendText(existing, nextContent);
      }
    }
  };

  const handleStatus = (value) => {
    if (typeof value !== 'string') return;
    state.status = value;
    if (value === 'FINISHED' || value === 'INCOMPLETE') state.done = true;
  };

  const applyContentPatch = (index, op, value) => {
    const fragment = state.fragments[index];
    if (!fragment) return;
    const text = typeof value === 'string' ? value : '';

    if (op === 'SET') {
      const old = fragment.content;
      fragment.content = text;
      if (text.startsWith(old)) emit(fragment, text.slice(old.length));
      else emit(fragment, text);
      return;
    }

    appendText(fragment, text);
  };

  const applyPatch = (p, op, value) => {
    // No path means "append to the last fragment" (this is how DeepSeek
    // streams most tokens).
    if (p == null && typeof value === 'string') {
      const fragment = state.fragments[state.current];
      if (fragment) appendText(fragment, value);
      return;
    }

    if (p === 'response') {
      if (op === 'BATCH' && Array.isArray(value)) {
        for (const patch of value) applyPatch(patch.p, patch.o, patch.v);
        return;
      }
      if (value && typeof value === 'object') {
        if (typeof value.accumulated_token_usage === 'number') {
          state.totalTokens = value.accumulated_token_usage;
        }
        if (value.quasi_status) handleStatus(value.quasi_status);
        if (value.status) handleStatus(value.status);
        if (Array.isArray(value.fragments)) reconcileSnapshot(value.fragments);
      }
      return;
    }

    if (p === 'response/status') {
      handleStatus(value);
      return;
    }

    if (p === 'response/accumulated_token_usage' || p === 'accumulated_token_usage') {
      if (typeof value === 'number') state.totalTokens = value;
      return;
    }

    if (p === 'response/quasi_status' || p === 'quasi_status') {
      handleStatus(value);
      return;
    }

    if (p === 'response/fragments') {
      if (op === 'APPEND' && Array.isArray(value)) {
        for (const fragment of value) addFragment(fragment);
      } else if (op === 'SET' && Array.isArray(value)) {
        reconcileSnapshot(value);
      }
      return;
    }

    if (typeof p === 'string' && p.startsWith('response/fragments/')) {
      const parts = p.split('/');
      let index = parts[2] === '-1' ? state.fragments.length - 1 : Number(parts[2]);
      if (!Number.isInteger(index) || index < 0) index = state.current;
      if (parts[3] === 'content') applyContentPatch(index, op, value);
    }
  };

  const handleData = (raw, eventName) => {
    if (!raw || raw === '[DONE]') return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (eventName === 'ready') {
      if (data.request_message_id != null) state.requestMessageId = data.request_message_id;
      if (data.response_message_id != null) state.responseMessageId = data.response_message_id;
      if (data.model_type) state.modelType = data.model_type;
      return;
    }

    if (eventName === 'update_session' || eventName === 'close') return;

    if (eventName === 'hint') {
      if (data?.type === 'error') {
        const finish = data.finish_reason || null;
        const text = data.content || data.message || 'DeepSeek rejected the request';
        if (isChallengeMessage(text) || isChallengeMessage(finish)) {
          throw new ChallengeError(text);
        }
        const rateLimited = finish === 'rate_limit_reached';
        throw new UpstreamError(text, {
          status: rateLimited ? 429 : 502,
          code: finish || data.type || null,
          type: rateLimited ? 'rate_limit_error' : 'upstream_error',
          retryable: rateLimited,
        });
      }
      return;
    }

    if (eventName === 'title') {
      state.title = data.content || state.title;
      if (state.title) handlers.onTitle?.(state.title);
      return;
    }

    if (eventName === 'error') {
      const text = data.msg || data.message || 'DeepSeek stream error';
      if (isChallengeMessage(text) || isChallengeMessage(data.code)) {
        throw new ChallengeError(text);
      }
      throw new UpstreamError(text, {
        code: data.code ?? null,
      });
    }

    if (
      typeof data.code === 'number' &&
      data.code !== 0 &&
      data.v == null &&
      data.p == null
    ) {
      const text = data.msg || `DeepSeek error ${data.code}`;
      if (isChallengeMessage(text)) throw new ChallengeError(text);
      throw new UpstreamError(text, {
        code: data.code,
      });
    }

    if (data.v && data.v.response) {
      const responseMessage = data.v.response;
      if (responseMessage.message_id != null) {
        state.responseMessageId = responseMessage.message_id;
      }
      if (typeof responseMessage.accumulated_token_usage === 'number') {
        state.totalTokens = responseMessage.accumulated_token_usage;
      }
      if (responseMessage.status) handleStatus(responseMessage.status);
      if (Array.isArray(responseMessage.fragments)) {
        reconcileSnapshot(responseMessage.fragments);
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(data, 'v')) {
      applyPatch(data.p, data.o, data.v);
      return;
    }

    if (data.p !== undefined || data.o !== undefined) {
      applyPatch(data.p, data.o, data.v);
    }
  };

  const reader = response.body?.getReader();
  if (!reader) throw new UpstreamError('DeepSeek returned an empty stream');

  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';

  const processLine = (line) => {
    if (line === '') {
      eventName = '';
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      handleData(line.slice(5).trimStart(), eventName);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        processLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer) {
      for (const line of buffer.split('\n')) processLine(line.replace(/\r$/, ''));
    }
  } finally {
    if (!state.done) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  }

  const result = {
    status: state.status || (state.done ? 'FINISHED' : 'INCOMPLETE'),
    totalTokens: state.totalTokens,
    responseMessageId: state.responseMessageId,
    requestMessageId: state.requestMessageId,
    title: state.title,
    modelType: state.modelType,
    fragments: state.fragments.map((fragment) => ({ ...fragment })),
  };
  handlers.onFinish?.(result);
  return result;
}

export function fragmentsText(fragments) {
  let content = '';
  let reasoning = '';
  for (const fragment of fragments || []) {
    if (!fragment.type || fragment.type === 'RESPONSE') content += fragment.content || '';
    else reasoning += fragment.content || '';
  }
  return { content, reasoning };
}
