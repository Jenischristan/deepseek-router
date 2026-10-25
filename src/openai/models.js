// OpenAI-compatible helpers
// ===========================================================================

import crypto from 'node:crypto';

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

export function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') {
    return String(content);
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object') {
        if (part.type === 'text' || part.type === 'input_text') {
          if (typeof part.text === 'string') parts.push(part.text);
        } else if (part.type === 'image_url') {
          const url =
            part.image_url && typeof part.image_url === 'object'
              ? part.image_url.url
              : part.image_url;
          // Never paste a base64 data: URL (can be megabytes) into the prompt.
          const shown =
            typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= 300 ? `: ${url}` : '';
          parts.push(`[Image attachment omitted${shown}]`);
        } else if (typeof part.text === 'string') {
          parts.push(part.text);
        }
      }
    }
    return parts.join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    return JSON.stringify(content);
  }
  return String(content);
}

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
