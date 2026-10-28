// HTTP server
// ===========================================================================

import crypto from 'node:crypto';
import http from 'node:http';

import { saveConfig } from './config.js';
import { AuthError, HttpError, UpstreamError } from './errors.js';
import { SessionStore, conversationKey } from './sessions.js';
import { MODELS, buildSeedPrompt, chunk, completionResponse, contentToText, dataUrlToBuffer, estimateTokens, extractImages, makeId, openaiError, resolveModel, usageChunk } from './openai/models.js';
import { consumeDeepSeekStream, fragmentsText } from './openai/sse.js';
import { makeToolCallId, normalizeToolChoice, normalizeTools, toolChoiceMode, toolSignature } from './openai/json.js';
import { buildToolInstructions, formatToolReminder } from './openai/prompt.js';
import { interpretToolResponse } from './openai/parse.js';
import { buildToolRepairPrompt, describeInvalidCall } from './openai/parse.js';
import { formatToolResultPrompt, toolCallMapping, normalizeMessagesForCache } from './openai/transcript.js';
import { ToolCallStreamFilter, splitAtToolMarker } from './openai/filter.js';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Gate {
  constructor({ concurrency = 1, minIntervalMs = 400 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.active = 0;
    this.queue = [];
    this.lastStart = 0;
  }

  async acquire(signal) {
    if (signal?.aborted) throw new UpstreamError('Client closed request', { status: 499 });

    while (this.active >= this.concurrency) {
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, cleanup: null };
        const onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index !== -1) this.queue.splice(index, 1);
          reject(new UpstreamError('Client closed request', { status: 499 }));
        };
        this.queue.push(entry);
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
          entry.cleanup = () => signal.removeEventListener('abort', onAbort);
        }
      });
    }

    if (signal?.aborted) throw new UpstreamError('Client closed request', { status: 499 });

    this.active += 1;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);

    if (signal?.aborted) {
      this.release();
      throw new UpstreamError('Client closed request', { status: 499 });
    }

    this.lastStart = Date.now();
  }

  // Spacing for an extra upstream request made while the slot is already held.
  async pace(signal) {
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    if (signal?.aborted) throw new UpstreamError('Client closed request', { status: 499 });
    this.lastStart = Date.now();
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const entry = this.queue.shift();
    if (entry) {
      entry.cleanup?.();
      entry.resolve();
    }
  }
}

function createLogger(level) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const threshold = levels[level] ?? levels.info;
  const write = (name, args) => {
    if (levels[name] > threshold) return;
    const line = args
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ');
    process.stderr.write(`${new Date().toISOString()} ${name.toUpperCase()} ${line}\n`);
  };
  return {
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    info: (...args) => write('info', args),
    debug: (...args) => write('debug', args),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (data) => {
      if (settled) return;
      size += data.length;
      if (size > MAX_BODY_BYTES) {
        fail(new HttpError(413, 'Request body is too large'));
        // Respond before dropping the connection. Destroying the socket
        // outright would make the client see a connection reset instead of
        // the 413, so answer first and stop consuming the upload.
        req.pause();
        return;
      }
      chunks.push(data);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON'));
      }
    });

    req.on('error', (error) => fail(error));
  });
}

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization, content-type, x-api-key, x-stainless-lang, openai-organization, openai-project',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, error) {
  if (res.writableEnded || res.destroyed) return;

  const status = error instanceof HttpError || error instanceof AuthError
    ? error.status
    : error instanceof UpstreamError
      ? error.status
      : 500;

  const type = error.type || 'server_error';
  const code = error.code ?? null;
  const message = error.message || 'Internal server error';

  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');

  sendJson(
    res,
    status >= 400 && status <= 599 ? status : 500,
    openaiError(message, { type, code, param: error.param ?? null }),
  );
}

function checkAuth(req, cfg) {
  if (!cfg.apiKey) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const provided = bearer || String(req.headers['x-api-key'] || '').trim();
  return provided === cfg.apiKey;
}

function computeUsage(messages, content, reasoning, upstreamTotal) {
  const promptText = messages
    .map((message) => contentToText(message?.content))
    .join('\n');
  const reasoningTokens = estimateTokens(reasoning);
  const completionTokens = estimateTokens(content) + reasoningTokens;

  let promptTokens = estimateTokens(promptText);
  let totalTokens = promptTokens + completionTokens;

  // The web endpoint reports usage that includes its own hidden prompt, so
  // derive prompt tokens from the upstream total instead of overstating the
  // completion length.
  if (Number.isFinite(upstreamTotal) && upstreamTotal > completionTokens) {
    totalTokens = upstreamTotal;
    promptTokens = upstreamTotal - completionTokens;
  }

  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: promptTokens,
  };

  if (reasoningTokens > 0) {
    usage.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }

  return usage;
}

// Shared by the streaming and non-streaming paths so the finish reason and
// usage numbers cannot drift apart between the two.
function completionOutcome({ messages, content, reasoning, toolCalls, result }) {
  const usageText = toolCalls.length
    ? `${content}\n${toolCalls.map((call) => call.argumentsText).join('\n')}`
    : content;
  return {
    usage: computeUsage(messages, usageText, reasoning, result.totalTokens),
    finishReason: toolCalls.length
      ? 'tool_calls'
      : result.status === 'FINISHED'
        ? 'stop'
        : 'length',
  };
}

function assistantToolCalls(toolCalls) {
  return (toolCalls || []).map((call) => ({
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.argumentsText,
    },
  }));
}

function isAccountFailure(error) {
  if (error instanceof AuthError) return true;
  return (
    error instanceof UpstreamError &&
    (error.status === 401 ||
      error.status === 403 ||
      error.status === 429 ||
      error.code === 50006)
  );
}

function mappingFromAssistant(assistant) {
  const mapping = {};
  for (const call of assistant?.tool_calls || []) {
    const id = call.id || '';
    if (!id) continue;
    const raw = call.function?.arguments ?? call.arguments ?? {};
    mapping[id] = {
      name: call.function?.name || call.name || 'tool',
      argumentsText: typeof raw === 'string' ? raw : JSON.stringify(raw),
    };
  }
  return mapping;
}

function rememberSession({
  sessions,
  messages,
  modelType,
  thinking,
  toolsKey,
  accountToken,
  sessionId,
  responseMessageId,
  content,
  reasoning,
  toolCalls = [],
}) {
  if (!responseMessageId) return;

  const assistant = { role: 'assistant', content };
  const mapping = toolCallMapping(toolCalls);
  if (toolCalls.length) assistant.tool_calls = assistantToolCalls(toolCalls);

  const entry = {
    sessionId,
    parentMessageId: responseMessageId,
    accountToken,
    ...(toolCalls.length ? { toolCalls: mapping } : {}),
  };

  sessions.set(
    conversationKey(
      modelType,
      thinking,
      normalizeMessagesForCache([...messages, assistant]),
      toolsKey,
      accountToken,
    ),
    entry,
  );

  if (reasoning) {
    const assistantWithReasoning = {
      ...assistant,
      reasoning_content: reasoning,
    };
    sessions.set(
      conversationKey(
        modelType,
        thinking,
        normalizeMessagesForCache([...messages, assistantWithReasoning]),
        toolsKey,
        accountToken,
      ),
      entry,
    );
  }
}

function sseWrite(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function clampInt(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

// What to add to the text the client already received so that it ends up with
// `full`, without repeating itself.
function reconcileTail(shown, full) {
  if (!full) return '';
  if (!shown) return full;
  if (full.startsWith(shown)) return full.slice(shown.length);
  if (shown.includes(full)) return '';
  return `\n\n${full}`;
}

function interpretationBadness(interp) {
  const invalid = interp.invalidCalls.filter((item) => item.reason !== 'too_many_calls').length;
  return (
    invalid * 3 +
    interp.argumentProblems.length * 2 +
    (interp.missedRequired || interp.wrongTool ? 4 : 0) -
    (interp.calls.length ? 1 : 0)
  );
}

// Shown instead of an empty reply when the model tried to call a tool and every
// attempt (including repairs) was unusable; an empty reply just stalls agents.
function unusableCallNotice(interp) {
  const reasons = [...new Set(interp.invalidCalls.map((item) => describeInvalidCall(item)))]
    .slice(0, 3)
    .join(' ');
  return `[deepseek-router] The model tried to call a tool but the call was unusable: ${reasons}`;
}

// Turns inline image parts into DeepSeek file ids. Images are uploaded once
// per request (keyed by content hash) so the same picture reused across turns
// does not consume upload quota repeatedly.
function imageUploadKey(image) {
  if (image.kind !== 'data') return `url:${image.url}`;
  return crypto.createHash('sha256').update(image.data).digest('hex');
}

function imageToFile(image) {
  const buffer = dataUrlToBuffer(image);
  if (!buffer) return null;
  return new File([buffer], image.filename, { type: image.mime || 'image/png' });
}

export function createServer({ config, tokenStore, client }) {
  const log = createLogger(config.logLevel);
  const sessions = new SessionStore({
    ttlMs: config.sessionTtlMs,
    max: config.maxSessions,
  });
  const gate = new Gate({
    concurrency: config.concurrency,
    minIntervalMs: config.minIntervalMs,
  });

  async function handleCompletion(req, res) {
    const startedAt = Date.now();
    const body = await readJsonBody(req);

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HttpError(400, "'messages' must be a non-empty array", {
        param: 'messages',
      });
    }

    for (const message of messages) {
      if (!message || typeof message !== 'object' || typeof message.role !== 'string') {
        throw new HttpError(400, 'Each message must have a role', { param: 'messages' });
      }
    }

    if (body.n != null && Number(body.n) > 1) {
      throw new HttpError(400, "Only 'n' = 1 is supported", { param: 'n' });
    }

    const tools = normalizeTools(body);
    const toolChoice = normalizeToolChoice(body);
    const toolChoiceInfo = toolChoiceMode(toolChoice);
    const parallelToolCalls = body.parallel_tool_calls !== false;
    const toolsActive = tools.length > 0 && toolChoiceInfo.mode !== 'none';
    const injectToolPrompt = config.injectToolPrompt !== false;
    const parseToolCalls = config.parseToolCalls !== false;
    const toolsKey = toolsActive
      ? `${toolSignature(tools, toolChoice, parallelToolCalls)}` +
        `${injectToolPrompt ? '' : ':noinject'}${parseToolCalls ? '' : ':noparse'}`
      : '';
    const toolInstructions =
      toolsActive && injectToolPrompt
        ? buildToolInstructions(tools, { toolChoice, parallelToolCalls })
        : '';
    // Re-stated on every follow-up message: in long sessions the original
    // protocol drifts out of the model's attention and it starts renaming tools.
    const toolReminder = toolsActive && injectToolPrompt ? formatToolReminder(tools) : '';
    const allowedToolNames = new Set(tools.map((tool) => tool.name));
    const preferredToolName =
      toolChoiceInfo.mode === 'function' ? toolChoiceInfo.name : null;
    const requiredName =
      preferredToolName && allowedToolNames.has(preferredToolName) ? preferredToolName : null;
    const requireCall =
      toolsActive && (toolChoiceInfo.mode === 'required' || requiredName !== null);
    const maxRepairs =
      toolsActive && parseToolCalls && config.repairToolCalls !== false
        ? clampInt(config.maxToolRepairs, 0, 5, 2)
        : 0;

    if (toolsActive) {
      log.debug(
        `tool calling enabled: ${tools.map((tool) => tool.name).join(', ')} (choice=${toolChoiceInfo.mode}, repairs<=${maxRepairs})`,
      );
    }

    const modelName = body.model || 'deepseek-chat';
    const model = resolveModel(modelName);
    if (!model) {
      throw new HttpError(404, `The model '${modelName}' does not exist`, {
        code: 'model_not_found',
        param: 'model',
      });
    }

    const lastMessage = messages[messages.length - 1];
    let turn = null;

    if (lastMessage.role === 'user') {
      const text = contentToText(lastMessage.content).trim();
      const images = extractImages(lastMessage.content);
      if (text || images.length) turn = { prefix: messages.slice(0, -1), prompt: text, images };
    } else if (lastMessage.role === 'tool' || lastMessage.role === 'function') {
      let assistantIndex = -1;
      for (let i = messages.length - 2; i >= 0; i -= 1) {
        if (messages[i]?.role === 'assistant') {
          assistantIndex = i;
          break;
        }
      }
      if (assistantIndex >= 0) {
        turn = {
          prefix: messages.slice(0, assistantIndex + 1),
          toolMessages: messages.slice(assistantIndex + 1),
          assistant: messages[assistantIndex],
          prompt: '',
        };
      }
    }

    const thinking = Boolean(
      model.thinking || body.thinking === true || body.enable_thinking === true,
    );
    const search = Boolean(
      body.search === true ||
        body.enable_search === true ||
        body.web_search_options != null,
    );
    const stream = body.stream === true;
    const includeUsage = Boolean(body.stream_options?.include_usage);

    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);

    let sessionId = null;
    let upstream = null;
    let usedAccount = null;
    let acquired = false;

    try {
      await gate.acquire(controller.signal);
      acquired = true;

      const keyFor = (items, accountToken) =>
        conversationKey(
          model.modelType,
          thinking,
          normalizeMessagesForCache(items),
          toolsKey,
          accountToken,
        );

      const triedAccounts = new Set();
      const uploadedFiles = new Map();

      const uploadImages = async (images, account) => {
        const ids = [];
        for (const image of images || []) {
          if (image.kind === 'url') {
            throw new HttpError(400, 'Remote image URLs are not supported; send a base64 data URL', {
              param: 'messages',
            });
          }
          const key = imageUploadKey(image);
          let id = uploadedFiles.get(key);
          if (!id) {
            const file = imageToFile(image);
            if (!file) {
              throw new HttpError(400, 'Image attachment has no data', { param: 'messages' });
            }
            await gate.pace(controller.signal);
            const info = await client.uploadFile({
              file,
              thinking,
              modelType: image.modelType || model.modelType,
              signal: controller.signal,
              account,
            });
            id = info.id;
            uploadedFiles.set(key, id);
            log.debug(`uploaded image ${image.filename} -> ${id}`);
          }
          ids.push(id);
        }
        return ids;
      };

      for (let attempt = 0; ; attempt += 1) {
        const account = tokenStore.current();
        if (!account?.token) throw new AuthError('No DeepSeek token configured');
        triedAccounts.add(account.token);

        let attemptSessionId = null;
        let attemptParentMessageId = null;
        let attemptPrompt = '';

        try {
          const cached = turn
            ? sessions.get(keyFor(turn.prefix, account.token))
            : null;
          let continuationPrompt = turn?.prompt || '';
          let refFileIds = [];

          if (cached && turn?.toolMessages) {
            const mapping = {
              ...(cached.toolCalls || {}),
              ...mappingFromAssistant(turn.assistant),
            };
            continuationPrompt = formatToolResultPrompt(turn.toolMessages, mapping, {
              protocol: injectToolPrompt,
              reminder: toolReminder,
            });
          } else if (cached && continuationPrompt && toolReminder) {
            continuationPrompt = `${continuationPrompt}\n\n${toolReminder}`;
          }

          if (!cached && turn?.images?.length) {
            refFileIds = await uploadImages(turn.images, account);
          }

          if (cached && continuationPrompt) {
            attemptSessionId = cached.sessionId;
            attemptParentMessageId = cached.parentMessageId;
            attemptPrompt = continuationPrompt;
            log.debug(
              `reusing upstream session ${attemptSessionId} (parent ${attemptParentMessageId})`,
            );
          } else {
            attemptSessionId = await client.createSession({
              signal: controller.signal,
              account,
            });
            attemptParentMessageId = null;
            attemptPrompt = buildSeedPrompt(messages, {
              toolInstructions,
              reminder: toolReminder,
            }).trim();
            log.debug(`created upstream session ${attemptSessionId}`);
            if (!attemptPrompt) {
              throw new HttpError(400, 'The conversation has no text content', {
                param: 'messages',
              });
            }
          }

          upstream = await client.completion({
            sessionId: attemptSessionId,
            parentMessageId: attemptParentMessageId,
            prompt: attemptPrompt,
            modelType: model.modelType,
            thinking,
            search,
            refFileIds,
            signal: controller.signal,
            account,
          });
          usedAccount = account;
        } catch (error) {
          const failedAccount = tokenStore.active + 1;
          // Read the live count here: rotate() reloads the config, so the
          // account list can change while this request is in flight.
          const maxAccountAttempts = Math.max(1, tokenStore.count);
          const next =
            isAccountFailure(error) && attempt + 1 < maxAccountAttempts
              ? tokenStore.rotate(account.token)
              : null;

          if (!next || next.token === account.token || triedAccounts.has(next.token)) {
            throw error;
          }

          sessions.deleteByAccount(account.token);
          log.warn(
            `account ${failedAccount} failed (${error.message}); switching to account ${tokenStore.active + 1}`,
          );
          continue;
        }

        sessionId = attemptSessionId;
        break;
      }

      if (!usedAccount) throw new AuthError('No DeepSeek account available');

      const id = makeId('chatcmpl');
      const created = Math.floor(Date.now() / 1000);
      const parsing = toolsActive && parseToolCalls;

      // -- tool-call handling ------------------------------------------------

      const interpretFor = (raw, result) =>
        interpretToolResponse(raw, tools, {
          allowedNames: allowedToolNames,
          preferredName: preferredToolName,
          // A reply that did not reach FINISHED may be cut mid tool-call.
          truncated: result.status !== 'FINISHED',
          requireCall,
          requiredName,
        });

      // The model sometimes writes the call inside its THINK fragment. Parse
      // that too (and strip the markup from reasoning) instead of showing raw
      // tags while never executing the call.
      const interpretAttempt = (result) => {
        const text = fragmentsText(result.fragments);
        let interp = interpretFor(text.content, result);
        let reasoning = text.reasoning;

        // Only a THINK fragment is the model's own plan. SEARCH/TIP fragments
        // can contain arbitrary retrieved text, so never execute a call found
        // there; still strip markup from the reasoning shown to the client.
        const thinking = (result.fragments || [])
          .filter((fragment) => fragment.type && /^THINK/i.test(fragment.type))
          .map((fragment) => fragment.content || '')
          .join('');
        if (thinking && splitAtToolMarker(thinking).found) {
          const fromThinking = interpretFor(thinking, result);
          if (
            (fromThinking.calls.length || fromThinking.invalidCalls.length) &&
            !interp.calls.length &&
            !interp.invalidCalls.length
          ) {
            // Reasoning is not assistant content: keep only the visible
            // RESPONSE text (usually empty) when the call came from THINK.
            interp = { ...fromThinking, content: text.content };
          }
        }
        if (reasoning && splitAtToolMarker(reasoning).found) {
          reasoning = interpretFor(reasoning, result).content;
        }
        return { result, raw: text.content, reasoning, interp };
      };

      // Interprets the model's reply; when it is not executable (unknown tool,
      // unreadable JSON, missing/ill-typed arguments, a required call that never
      // came) asks the same upstream conversation to resend it. Nothing has been
      // executed or shown for those, so the client only ever sees the fixed one.
      const settleToolTurn = async (firstResult) => {
        let latest = interpretAttempt(firstResult);
        const attempts = [latest];
        let repairs = 0;

        while (
          latest.interp.needsRepair &&
          repairs < maxRepairs &&
          latest.result.responseMessageId &&
          !controller.signal.aborted
        ) {
          repairs += 1;
          const problems = [
            ...latest.interp.invalidCalls.map((item) => item.reason),
            ...latest.interp.argumentProblems.flatMap((item) =>
              item.problems.map((problem) => `${item.name}: ${problem}`),
            ),
            ...(latest.interp.missedRequired ? ['required call missing'] : []),
            ...(latest.interp.wrongTool ? ['wrong tool for tool_choice'] : []),
          ];
          log.warn(
            `tool call needs repair (${repairs}/${maxRepairs}): ${problems.slice(0, 4).join('; ')}`,
          );
          log.debug(`raw model output: ${latest.raw.slice(0, 2000)}`);

          try {
            await gate.pace(controller.signal);
            const response = await client.completion({
              sessionId,
              parentMessageId: latest.result.responseMessageId,
              prompt: buildToolRepairPrompt(latest.interp, tools, { toolChoice }),
              modelType: model.modelType,
              thinking,
              search: false,
              signal: controller.signal,
              account: usedAccount,
            });
            const result = await consumeDeepSeekStream(response);
            latest = interpretAttempt(result);
            attempts.push(latest);
          } catch (error) {
            if (controller.signal.aborted) throw error;
            log.warn(`tool call repair failed: ${error.message}`);
            break;
          }
        }

        // Prefer the cleanest attempt; on a tie the later one wins.
        let best = attempts[0];
        for (const item of attempts) {
          if (interpretationBadness(item.interp) <= interpretationBadness(best.interp)) best = item;
        }
        return { best, repairs };
      };

      // Turns the chosen attempt into the final text + OpenAI tool calls.
      const finalize = (best) => {
        if (!best.interp) return { content: best.raw, toolCalls: [] };
        const { interp, raw } = best;

        if (interp.invalidCalls.length) {
          log.warn(
            `discarded ${interp.invalidCalls.length} invalid tool call(s): ${interp.invalidCalls
              .map((item) => item.reason || 'invalid')
              .join(', ')}`,
          );
        }
        for (const item of interp.renamed) log.debug(`tool name "${item.from}" -> "${item.to}"`);
        for (const call of interp.calls) {
          if (call.repaired) {
            log.warn(
              `executing tool "${call.name}" with repaired JSON (the model's arguments were not valid JSON)`,
            );
          }
        }

        let toolCalls = interp.calls.map((call) => ({ ...call, id: makeToolCallId() }));
        if (!parallelToolCalls && toolCalls.length > 1) {
          log.debug(`limiting ${toolCalls.length} tool calls to 1 (parallel_tool_calls=false)`);
          toolCalls = toolCalls.slice(0, 1);
        }

        let content;
        if (toolCalls.length) {
          // Keep only what precedes the tool block: whatever the model wrote after
          // it (usually invented results) is noise, and this is exactly what a
          // streaming client has seen, so the session cache key matches either way.
          const split = splitAtToolMarker(raw);
          content = (split.found ? split.before : interp.content).trim();
        } else {
          content = interp.content;
          if (!content.trim() && interp.invalidCalls.length) content = unusableCallNotice(interp);
        }
        return { content, toolCalls };
      };

      const remember = ({ best, content, reasoning, toolCalls }) => {
        if (controller.signal.aborted) return;
        rememberSession({
          sessions,
          messages,
          modelType: model.modelType,
          thinking,
          toolsKey,
          accountToken: usedAccount.token,
          sessionId,
          responseMessageId: best.result.responseMessageId,
          content,
          reasoning,
          toolCalls,
        });
        const switched = tokenStore.noteResponse(usedAccount.token);
        if (switched) {
          log.info(
            `account ${switched.from} handled ${switched.count} message(s); switching to account ${switched.to}`,
          );
        }
      };

      const summary = (repairs, toolCalls) =>
        (toolCalls.length ? ` tool_calls=${toolCalls.length}` : '') +
        (repairs ? ` repairs=${repairs}` : '');

      // -- non-streaming -----------------------------------------------------

      if (!stream) {
        const firstResult = await consumeDeepSeekStream(upstream);
        let best;
        let repairs = 0;
        if (parsing) {
          ({ best, repairs } = await settleToolTurn(firstResult));
        } else {
          const text = fragmentsText(firstResult.fragments);
          best = { result: firstResult, raw: text.content, reasoning: text.reasoning, interp: null };
        }

        const { content, toolCalls } = finalize(best);
        const reasoning = best.reasoning;

        const { usage, finishReason } = completionOutcome({
          messages,
          content,
          reasoning,
          toolCalls,
          result: best.result,
        });

        remember({ best, content, reasoning, toolCalls });

        sendJson(
          res,
          200,
          completionResponse({
            id,
            model: model.id,
            content,
            reasoning,
            toolCalls: assistantToolCalls(toolCalls),
            finishReason,
            usage,
            created,
          }),
        );

        log.info(
          `POST /v1/chat/completions 200 ${Date.now() - startedAt}ms model=${model.id} stream=false` +
            summary(repairs, toolCalls),
        );
        return;
      }

      // -- streaming ---------------------------------------------------------

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      sseWrite(
        res,
        chunk({ id, model: model.id, created, delta: { role: 'assistant', content: '' } }),
      );

      let emittedContent = '';
      let emittedReasoning = '';
      const filter = parsing ? new ToolCallStreamFilter({ holdAll: requireCall }) : null;
      // A call written inside the reasoning fragment is parsed at the end; hold
      // its markup back so the client never sees raw tool tags either way.
      const reasoningFilter = parsing ? new ToolCallStreamFilter() : null;

      const emitContent = (text) => {
        if (!text) return;
        emittedContent += text;
        sseWrite(
          res,
          chunk({ id, model: model.id, created, delta: { content: text } }),
        );
      };

      const firstResult = await consumeDeepSeekStream(upstream, {
        onDelta(field, text) {
          if (field === 'reasoning') {
            const visible = reasoningFilter ? reasoningFilter.push(text) : text;
            if (!visible) return;
            emittedReasoning += visible;
            sseWrite(
              res,
              chunk({
                id,
                model: model.id,
                created,
                delta: { reasoning_content: visible },
              }),
            );
          } else if (filter) {
            emitContent(filter.push(text));
          } else {
            emitContent(text);
          }
        },
      });

      if (filter) {
        const held = filter.takeHeld();
        if (held.pending) emitContent(held.pending);
      }
      if (reasoningFilter) {
        const held = reasoningFilter.takeHeld();
        if (held.pending) {
          emittedReasoning += held.pending;
          sseWrite(
            res,
            chunk({
              id,
              model: model.id,
              created,
              delta: { reasoning_content: held.pending },
            }),
          );
        }
      }

      let best;
      let repairs = 0;
      if (parsing) {
        ({ best, repairs } = await settleToolTurn(firstResult));
      } else {
        const text = fragmentsText(firstResult.fragments);
        best = { result: firstResult, raw: text.content, reasoning: text.reasoning, interp: null };
      }

      const { content: finalText, toolCalls } = finalize(best);

      // Bring what the client has seen in line with the final answer: text that
      // was held back (mandatory calls, false-positive markers, repaired replies)
      // is released now; text already streamed is never repeated.
      const shown = emittedContent.trim();
      const tail = toolCalls.length
        ? shown
          ? ''
          : finalText.trim()
        : reconcileTail(shown, finalText.trim());
      emitContent(tail);
      const content = emittedContent.trim();

      if (toolCalls.length) {
        const calls = assistantToolCalls(toolCalls);
        for (let index = 0; index < calls.length; index += 1) {
          const call = calls[index];
          sseWrite(
            res,
            chunk({
              id,
              model: model.id,
              created,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: call.id,
                    type: 'function',
                    function: { name: call.function.name, arguments: '' },
                  },
                ],
              },
            }),
          );
          sseWrite(
            res,
            chunk({
              id,
              model: model.id,
              created,
              delta: {
                tool_calls: [
                  {
                    index,
                    function: { arguments: call.function.arguments },
                  },
                ],
              },
            }),
          );
        }
      }

      const { usage, finishReason } = completionOutcome({
        messages,
        content,
        reasoning: emittedReasoning,
        toolCalls,
        result: best.result,
      });
      sseWrite(
        res,
        chunk({
          id,
          model: model.id,
          created,
          delta: {},
          finishReason,
        }),
      );

      if (includeUsage) {
        sseWrite(res, usageChunk({ id, model: model.id, created, usage }));
      }

      remember({ best, content, reasoning: emittedReasoning, toolCalls });

      if (!res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }

      log.info(
        `POST /v1/chat/completions 200 ${Date.now() - startedAt}ms model=${model.id} stream=true` +
          summary(repairs, toolCalls),
      );
    } finally {
      res.off('close', onClose);
      if (acquired) gate.release();
    }
  }

  async function handle(req, res) {
    applyCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      sendJson(res, 200, {
        status: 'ok',
        name: 'deepseek-router',
        upstream: tokenStore.status(),
        sessions: sessions.size,
        toolPrompt: config.injectToolPrompt !== false,
        toolParse: config.parseToolCalls !== false,
        toolRepair: config.repairToolCalls !== false ? clampInt(config.maxToolRepairs, 0, 5, 2) : 0,
        models: MODELS.map((model) => model.id),
      });
      return;
    }

    const needsAuth = pathname.startsWith('/v1');
    if (needsAuth && !checkAuth(req, config)) {
      throw new HttpError(401, 'Invalid API key', {
        type: 'authentication_error',
        code: 'invalid_api_key',
      });
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      sendJson(res, 200, { object: 'list', data: MODELS });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/v1/models/')) {
      const id = decodeURIComponent(pathname.slice('/v1/models/'.length));
      const model = MODELS.find((item) => item.id === id);
      if (!model) {
        throw new HttpError(404, `The model '${id}' does not exist`, {
          code: 'model_not_found',
          param: 'model',
        });
      }
      sendJson(res, 200, model);
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      await handleCompletion(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/token') {
      const body = await readJsonBody(req);
      const patch = {};

      if (Array.isArray(body.accounts) && body.accounts.length) {
        patch.accounts = body.accounts;
      } else {
        if (typeof body.token !== 'string' || !body.token.trim()) {
          throw new HttpError(400, "'token' must be a non-empty string", {
            param: 'token',
          });
        }

        patch.token = body.token.trim();
        if (typeof body.cookies === 'string') patch.cookies = body.cookies;
        if (typeof body.hifLeim === 'string') patch.hifLeim = body.hifLeim;
      }

      tokenStore.update(patch);

      if (body.persist !== false) {
        saveConfig(patch);
      }

      sendJson(res, 200, { ok: true, ...tokenStore.status() });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/sessions/clear') {
      sessions.clear();
      sendJson(res, 200, { ok: true, sessions: sessions.size });
      return;
    }

    throw new HttpError(404, `Unknown endpoint: ${req.method} ${pathname}`, {
      code: 'not_found',
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof UpstreamError && error.status === 499) {
        if (!res.destroyed) res.destroy();
        return;
      }

      if (res.headersSent) {
        if (!res.writableEnded) {
          sseWrite(
            res,
            openaiError(error.message || 'Upstream error', {
              type: error.type || 'upstream_error',
              code: error.code ?? null,
            }),
          );
          if (!res.writableEnded && !res.destroyed) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }
        log.warn(`request failed after headers sent: ${error.message}`);
        return;
      }

      log.warn(`${req.method} ${req.url} failed: ${error.message}`);
      sendError(res, error);

      // The rejected request may still be uploading (e.g. a body over the size
      // limit). Answer first, then drop the connection so the client sees the
      // error instead of streaming the rest of a body nobody will read.
      if (error instanceof HttpError && error.status === 413) {
        res.once('finish', () => {
          if (!req.destroyed) req.destroy();
        });
      }
    });
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 75_000;

  return server;
}
