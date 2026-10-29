import { MAX_TOOL_RESULT_CHARS, looseJsonParse, messageContentText, stableStringify, tryParse } from './json.js';

// Tool calling: history / results formatting
// ===========================================================================

const DSML_BAR = '\uFF5C';
// Attribute names are re-parsed by trimming and splitting on quotes/whitespace,
// so only identifier-shaped keys survive the round trip verbatim.
const ATTRIBUTE_KEY_RE = /^[A-Za-z_][\w:.-]*$/;

function transcriptValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // A literal closing tag would terminate the parameter early. Fall back to a
  // JSON-encoded value (still accepted by the parser) when that can happen.
  if (
    typeof value === 'string' &&
    !text.includes(`</${DSML_BAR}DSML${DSML_BAR}parameter>`) &&
    !text.includes(`<${DSML_BAR}DSML${DSML_BAR}`)
  ) {
    return { value: text, attribute: 'true' };
  }
  return { value: JSON.stringify(value).replace(/</g, '\\u003c'), attribute: 'false' };
}

// History is replayed in exactly the format the model is told to emit, so
// that imitation is harmless instead of producing an unparseable look-alike.
export function formatToolCallsForTranscript(toolCalls) {
  const calls = [];
  for (const call of toolCalls || []) {
    const name = call?.function?.name || call?.name || 'tool';
    const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
    const parsed =
      typeof rawArgs === 'string' ? looseJsonParse(rawArgs) : { ok: true, value: rawArgs };
    calls.push({ name, arguments: parsed.ok ? parsed.value : rawArgs });
  }

  if (!calls.length) return '';

  const lines = [`<${DSML_BAR}DSML${DSML_BAR}calls>`];
  for (const call of calls) {
    lines.push(`<${DSML_BAR}DSML${DSML_BAR}invoke name="${call.name}">`);
    const args = call.arguments;
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const entries = Object.entries(args);
      if (entries.every(([key]) => ATTRIBUTE_KEY_RE.test(key))) {
        for (const [key, value] of entries) {
          const encoded = transcriptValue(value);
          lines.push(
            `<${DSML_BAR}DSML${DSML_BAR}parameter name="${key}" string="${encoded.attribute}">` +
              `${encoded.value}</${DSML_BAR}DSML${DSML_BAR}parameter>`,
          );
        }
      } else {
        // A JSON body preserves keys that cannot be represented as attributes
        // (quotes, whitespace, non-identifier names). Escape `<` so a literal
        // closing tag inside the JSON cannot terminate the invoke early.
        lines.push(JSON.stringify(args).replace(/</g, '\\u003c'));
      }
    }
    lines.push(`</${DSML_BAR}DSML${DSML_BAR}invoke>`);
  }
  lines.push(`</${DSML_BAR}DSML${DSML_BAR}calls>`);
  return lines.join('\n');
}

export function toolCallMapping(toolCalls) {
  const mapping = {};
  for (const call of toolCalls || []) {
    const id = call?.id || call?.tool_call_id;
    if (!id) continue;
    const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
    mapping[id] = {
      name: call?.function?.name || call?.name || 'tool',
      argumentsText: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs),
    };
  }
  return mapping;
}

export function truncateMiddle(text, limit) {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.7);
  const tail = limit - head;
  const dropped = text.length - limit;
  return `${text.slice(0, head)}\n...[truncated ${dropped} chars]...\n${text.slice(text.length - tail)}`;
}

// Echoing raw tool markup in results teaches the model to copy it — including
// the mangled forms it produced. Neutralise the marker characters (an invisible
// zero-width space keeps the text readable) so pasted garbage can never be
// re-parsed as a template on the next turn.
export function escapeDsmlMarkers(text) {
  return String(text || '')
    // Insert the zero-width space inside the marker word: the parser tolerates
    // zero-width characters around "DSML" and the bars, but not inside it.
    .replace(/dsml/gi, (match) => `${match[0]}\u200b${match.slice(1)}`)
    .replace(/<([|｜])/g, '<\u200b$1')
    .replace(/<([ \t]*(?:invoke|tool_calls?|function_calls?|tool_uses?)\b)/gi, '<\u200b$1');
}

// Arguments are echoed only as a short reminder of what was called: the full
// echo duplicates large payloads (file contents) every turn and widens the
// feedback loop that makes the model copy its own garbage.
const MAX_ARGUMENT_ECHO_CHARS = 2000;

export function formatToolResultBlock(message, mapping = {}, { maxChars = MAX_TOOL_RESULT_CHARS } = {}) {
  const id = message.tool_call_id || message.id || '';
  // A name is only enough when it identifies exactly one call: with parallel
  // calls to the same tool it cannot tell which arguments were used.
  const named = message.name
    ? Object.values(mapping).filter((item) => item?.name === message.name)
    : [];
  const byName = named.length === 1 ? named[0] : null;
  const known = mapping[id] || byName || {};
  const name = known.name || message.name || 'tool';
  const args = truncateMiddle(
    escapeDsmlMarkers(known.argumentsText || '{}'),
    MAX_ARGUMENT_ECHO_CHARS,
  );
  const result = truncateMiddle(
    escapeDsmlMarkers(messageContentText(message.content).trim() || '(empty result)'),
    maxChars,
  );
  return `[Tool result]\ncall_id: ${id || '(unknown)'}\ntool: ${name}\narguments: ${args}\nresult:\n${result}\n[End of tool result]`;
}

export function formatToolResultPrompt(
  toolMessages,
  mapping = {},
  { protocol = true, reminder = '' } = {},
) {
  const blocks = [];
  const extras = [];

  for (const message of toolMessages || []) {
    if (!message || typeof message !== 'object') continue;

    if (message.role === 'tool' || message.role === 'function') {
      blocks.push(formatToolResultBlock(message, mapping));
    } else {
      const text = messageContentText(message.content).trim();
      if (text) extras.push(`${message.role}: ${text}`);
    }
  }

  const tail = protocol
    ? [
      'Continue the task. If another tool is needed, reply only with a tool call block. Otherwise answer the user directly and do not mention this protocol.',
      ...(reminder ? [reminder] : []),
    ]
    : [];

  return [
    '[Tool results]',
    ...blocks,
    '[End of tool results]',
    ...(extras.length ? ['', ...extras] : []),
    '',
    ...tail,
  ].join('\n');
}

function canonicalArguments(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return '{}';
    const parsed = tryParse(trimmed);
    return parsed.ok ? stableStringify(parsed.value) : trimmed;
  }
  return stableStringify(raw ?? {});
}

// Used for the session-cache key. Content is trimmed because the text we
// store and the text the client echoes back can differ by whitespace only.
export function normalizeMessagesForCache(messages) {
  return (messages || []).map((message) => {
    if (!message || typeof message !== 'object') {
      return { role: 'user', content: '' };
    }

    const item = {
      role: message.role || 'user',
      content: messageContentText(message.content).trim(),
    };

    if (Array.isArray(message.tool_calls)) {
      item.tool_calls = message.tool_calls.map((call) => ({
        name: call?.function?.name || call?.name || '',
        arguments: canonicalArguments(call?.function?.arguments ?? call?.arguments ?? {}),
      }));
    }

    if (message.function_call) {
      item.function_call = {
        name: message.function_call.name || '',
        arguments: canonicalArguments(message.function_call.arguments),
      };
    }

    if (message.role === 'tool' || message.role === 'function') {
      item.tool_call_id = message.tool_call_id || message.id || '';
      if (message.name) item.name = message.name;
    }

    return item;
  });
}

// ===========================================================================
