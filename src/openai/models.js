// OpenAI-compatible helpers
// ===========================================================================

import crypto from 'node:crypto';
import { messageContentText } from './json.js';
import { formatToolCallsForTranscript } from './transcript.js';
const CREATED = 1704067200;

export const MODELS = [
  {
    id: 'deepseek-chat',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    permission: [],
    root: 'deepseek-chat',
    parent: null,
  },
  {
    id: 'deepseek-reasoner',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    permission: [],
    root: 'deepseek-reasoner',
    parent: null,
  },
];

const CHAT_ALIASES = new Set([
  'deepseek-chat',
  'deepseek-v3',
  'deepseek',
  'chat',
  'default',
]);

const REASONER_ALIASES = new Set([
  'deepseek-reasoner',
  'deepseek-r1',
  'deepseek-think',
  'deepseek-thinking',
  'reasoner',
  'r1',
]);

export function resolveModel(name) {
  const id = String(name || 'deepseek-chat').toLowerCase();
  if (CHAT_ALIASES.has(id)) {
    return { id: 'deepseek-chat', modelType: 'default', thinking: false };
  }
  if (REASONER_ALIASES.has(id)) {
    return { id: 'deepseek-reasoner', modelType: 'default', thinking: true };
  }
  return null;
}

export function makeId(prefix = 'chatcmpl') {
  return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
}

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  apng: 'image/apng',
};

function imageUrlOf(part) {
  if (!part) return null;
  if (part.type === 'image_url') {
    const url = part.image_url && typeof part.image_url === 'object'
      ? part.image_url.url
      : part.image_url;
    return typeof url === 'string' ? url : null;
  }
  // OpenAI Responses / newer chat clients use { type: 'input_image', image_url }.
  if (part.type === 'input_image') {
    if (typeof part.image_url === 'string') return part.image_url;
    if (typeof part.url === 'string') return part.url;
    if (typeof part.data === 'string' && typeof part.mimeType === 'string') {
      return `data:${part.mimeType};base64,${part.data}`;
    }
  }
  return null;
}

// An image part becomes an ordered descriptor the HTTP layer can upload.
// `data` holds a base64 data: URL payload (uploaded as-is); `url` is kept for
// remote http(s) images but is not fetched here.
export function extractImages(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    const url = imageUrlOf(part);
    if (!url) continue;
    const dataMatch = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is.exec(url);
    if (dataMatch) {
      const mime = (dataMatch[1] || 'image/png').toLowerCase();
      const data = dataMatch[2].replace(/\s+/g, '');
      const ext = Object.keys(IMAGE_MIME).find((key) => IMAGE_MIME[key] === mime) || 'png';
      images.push({
        kind: 'data',
        mime,
        data,
        filename: part.image_url?.filename || `image-${images.length + 1}.${ext}`,
      });
    } else if (/^https?:\/\//i.test(url)) {
      images.push({
        kind: 'url',
        url,
        filename: part.image_url?.filename || `image-${images.length + 1}`,
      });
    }
  }
  return images;
}

export function dataUrlToBuffer(image) {
  if (!image || image.kind !== 'data') return null;
  const buffer = Buffer.from(image.data, 'base64');
  return buffer.length ? buffer : null;
}

// Kept as a named export for callers; the implementation is shared with
// tool-result and cache text so the two can never disagree.
export const contentToText = messageContentText;

function roleLabel(role) {
  switch (role) {
  case 'assistant':
    return 'Assistant';
  case 'system':
  case 'developer':
    return 'System';
  case 'tool':
  case 'function':
    return 'Tool';
  default:
    return 'User';
  }
}

export function buildSeedPrompt(messages, { toolInstructions = '', reminder = '' } = {}) {
  const systems = [];
  const convo = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    let text = contentToText(message.content).trim();

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = formatToolCallsForTranscript(message.tool_calls);
      text = [text, calls].filter(Boolean).join('\n');
    } else if (message.role === 'tool' || message.role === 'function') {
      const id = message.tool_call_id || message.id || '';
      const name = message.name || '';
      const label = `[Tool result${id ? ` call_id=${id}` : ''}${name ? ` name=${name}` : ''}]`;
      text = `${label}\n${text || '(empty result)'}`;
    }

    if (message.role === 'system' || message.role === 'developer') {
      if (text) systems.push(text);
    } else {
      convo.push({ role: message.role, text });
    }
  }

  if (toolInstructions) systems.push(toolInstructions);

  const systemBlock = systems.length
    ? `[System instructions]\n${systems.join('\n\n')}\n\n`
    : '';

  if (convo.length <= 1) {
    const last = convo[0];
    return systemBlock + (last ? last.text : '');
  }


  const transcript = convo
    .map((item) => `${roleLabel(item.role)}: ${item.text}`)
    .join('\n');

  const closing = toolInstructions
    ? 'Continue the conversation by replying to the final message as the assistant. ' +
      'If you need a tool, use the tool protocol described above. Do not repeat the transcript.'
    : 'Continue the conversation by replying to the final user message as the assistant. ' +
      'Do not repeat the transcript.';

  return (
    systemBlock +
    '[Conversation transcript]\n' +
    transcript +
    '\n[End of transcript]\n\n' +
    closing +
    (reminder ? `\n${reminder}` : '')
  );
}

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(String(text), 'utf8') / 4));
}

export function openaiError(message, { type = 'server_error', code = null, param = null } = {}) {
  return {
    error: {
      message,
      type,
      param,
      code,
    },
  };
}

export function completionResponse({
  id,
  model,
  content,
  reasoning,
  toolCalls,
  finishReason,
  usage,
  created = Math.floor(Date.now() / 1000),
}) {
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  const message = {
    role: 'assistant',
    content: hasToolCalls ? content || null : content || '',
  };
  if (hasToolCalls) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason || 'stop',
      },
    ],
    usage,
  };
}

export function chunk({
  id,
  model,
  delta,
  finishReason = null,
  created = Math.floor(Date.now() / 1000),
}) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: delta || {},
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  };
}

export function usageChunk({ id, model, usage, created }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage,
  };
}
