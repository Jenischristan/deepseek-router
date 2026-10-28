// Tool calling: JSON helpers
// ===========================================================================

import crypto from 'node:crypto';

export const MAX_TOOL_RESULT_CHARS = 24000;
export const MAX_CALLS = 32;

export function makeToolCallId() {
  return `call_${crypto.randomBytes(12).toString('hex')}`;
}

export const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
export const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
    return sorted;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

export function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: undefined };
  }
}

export const WS = new Set([' ', '\n', '\r', '\t']);
const WORD_RE = /[A-Za-z_$][\w$]*/y;
const NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function skipWs(src, index) {
  let probe = index;
  while (probe < src.length && WS.has(src[probe])) probe += 1;
  return probe;
}

// Does a JSON object key ("name": / 'name': / name:) start at `pos`?
function looksLikeKey(src, pos) {
  const ch = src[pos];
  if (ch === '"' || ch === "'") {
    let i = pos + 1;
    while (i < src.length && i - pos < 200) {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === '\n') return false;
      if (src[i] === ch) break;
      i += 1;
    }
    if (src[i] !== ch) return false;
    return src[skipWs(src, i + 1)] === ':';
  }
  WORD_RE.lastIndex = pos;
  const match = WORD_RE.exec(src);
  if (!match) return false;
  return src[skipWs(src, pos + match[0].length)] === ':';
}

// Is the quote at `quoteIndex` the real end of the string? Models forget to
// escape inner quotes in file contents ("print("hi", x)"), so a quote only
// closes the string when what follows is valid JSON for the position we are in.
//   role: 'key' | 'value' (object value) | 'array' | 'unknown'
function isClosingQuote(src, quoteIndex, role) {
  const probe = skipWs(src, quoteIndex + 1);
  const next = src[probe];
  if (next === undefined) return true;
  if (role === 'key') return next === ':';
  if (next === '}' || next === ']') return true;
  if (next === ':') return role === 'unknown';
  // The comma was forgotten: `"a":"x" "b":1`.
  if (next !== ',') return role === 'value' && looksLikeKey(src, probe);

  const after = skipWs(src, probe + 1);
  const following = src[after];
  if (following === undefined || following === '}' || following === ']') return true;
  if (role === 'array') return /["'[{\-\dA-Za-z]/.test(following);
  if (role === 'value') return looksLikeKey(src, after);
  return true;
}

// Reads a (possibly single-quoted, possibly sloppy) string starting at `start`
// and returns it re-encoded as strict JSON. Handles the failures models make
// most often: raw newlines/tabs inside the string, unescaped inner quotes,
// invalid escapes such as "\d", and a missing closing quote.
function readLooseString(src, start, role = 'unknown') {
  const quote = src[start];
  const length = src.length;
  let index = start + 1;
  let body = '';

  while (index < length) {
    const ch = src[index];

    if (ch === '\\') {
      const next = src[index + 1];
      if (next === undefined) {
        index += 1;
        break;
      }
      if (next === 'u') {
        const hex = src.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          body += src.slice(index, index + 6);
          index += 6;
        } else {
          body += '\\\\';
          index += 1;
        }
        continue;
      }
      if ('"\\/bfnrt'.includes(next)) {
        body += ch + next;
        index += 2;
        continue;
      }
      if (next === "'") {
        body += "'";
        index += 2;
        continue;
      }
      // Unknown escape (regex "\d", Windows path "\U"): keep the backslash.
      body += '\\\\';
      index += 1;
      continue;
    }

    if (ch === quote && isClosingQuote(src, index, role)) {
      return { json: `"${body}"`, next: index + 1 };
    }

    if (ch === '"') body += '\\"';
    else if (ch === '\n') body += '\\n';
    else if (ch === '\r') body += '\\r';
    else if (ch === '\t') body += '\\t';
    else if (ch < ' ') body += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else body += ch;
    index += 1;
  }

  return { json: `"${body}"`, next: index };
}

const VALUE_END_RE = /^(?:"|-?\d|true$|false$|null$|\}$|\]$)/;

// Best-effort repair of almost-JSON: trailing commas, missing commas, single
// quotes, bare keys, True/False/None, raw control characters in strings,
// unescaped inner quotes, unterminated strings and unclosed brackets. Returns
// a strict JSON string, or null when hopeless.
function repairJsonText(input) {
  const src = String(input ?? '').trim();
  if (!src || (src[0] !== '{' && src[0] !== '[')) return null;

  const out = [];
  const stack = [];
  const length = src.length;
  let index = 0;
  let done = false;

  const last = () => (out.length ? out[out.length - 1] : '');
  const closeValueGap = () => {
    if (last() === ',') out.pop();
    if (last() === ':') out.push('null');
  };
  // A value/key is about to start right after another value: the comma was forgotten.
  const ensureComma = () => {
    if (stack.length && VALUE_END_RE.test(last())) out.push(',');
  };
  const roleHere = () => {
    const top = stack[stack.length - 1];
    if (top === '{') return last() === ':' ? 'value' : 'key';
    if (top === '[') return 'array';
    return 'unknown';
  };

  while (index < length && !done) {
    const ch = src[index];

    if (WS.has(ch)) {
      index += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const role = roleHere();
      const parsed = readLooseString(src, index, role);
      if (role !== 'value') ensureComma();
      out.push(parsed.json);
      index = parsed.next;
      continue;
    }

    if (ch === '{' || ch === '[') {
      ensureComma();
      stack.push(ch);
      out.push(ch);
      index += 1;
      continue;
    }

    if (ch === '}' || ch === ']') {
      const open = ch === '}' ? '{' : '[';
      const at = stack.lastIndexOf(open);
      index += 1;
      if (at === -1) continue; // stray closer
      while (stack.length - 1 > at) {
        const inner = stack.pop();
        closeValueGap();
        out.push(inner === '{' ? '}' : ']');
      }
      closeValueGap();
      stack.pop();
      out.push(ch);
      if (!stack.length) done = true;
      continue;
    }

    if (ch === ',') {
      const prev = last();
      index += 1;
      if (prev === '' || prev === ',' || prev === '{' || prev === '[' || prev === ':') continue;
      out.push(',');
      continue;
    }

    if (ch === ':') {
      out.push(':');
      index += 1;
      continue;
    }

    WORD_RE.lastIndex = index;
    let match = WORD_RE.exec(src);
    if (match) {
      const word = match[0];
      const probe = skipWs(src, index + word.length);
      if (src[probe] === ':') {
        ensureComma();
        out.push(JSON.stringify(word));
      } else {
        const lower = word.toLowerCase();
        ensureComma();
        if (lower === 'true') out.push('true');
        else if (lower === 'false') out.push('false');
        else if (lower === 'null' || lower === 'none' || lower === 'undefined' || lower === 'nan') {
          out.push('null');
        } else {
          return null;
        }
      }
      index += word.length;
      continue;
    }

    NUMBER_RE.lastIndex = index;
    match = NUMBER_RE.exec(src);
    if (match) {
      ensureComma();
      out.push(match[0]);
      index += match[0].length;
      continue;
    }

    return null;
  }

  while (stack.length) {
    closeValueGap();
    out.push(stack.pop() === '{' ? '}' : ']');
  }
  return out.join('');
}

export function looseJsonParse(text) {
  const strict = tryParse(text);
  if (strict.ok) return strict;
  const repaired = repairJsonText(text);
  if (repaired == null) return strict;
  const retry = tryParse(repaired);
  return retry.ok ? { ok: true, value: retry.value, repaired: true } : strict;
}

// Index just past the balanced JSON object/array that starts at `start`, or -1
// when it never closes (truncated output).
export function scanJsonValue(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

export function parseLooseValues(text) {
  const source = String(text || '');
  const values = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch !== '{' && ch !== '[') {
      index += 1;
      continue;
    }
    const end = scanJsonValue(source, index);
    if (end === -1) break;
    const parsed = looseJsonParse(source.slice(index, end));
    if (parsed.ok) {
      values.push(parsed.value);
      index = end;
      continue;
    }
    // Stray closers ("}}") and commas between objects: skip this opener and
    // resume scanning, so the next object in the run is still recovered.
    index += 1;
  }
  return values;
}

function imagePlaceholder(part) {
  const raw =
    part.type === 'image_url' || part.type === 'input_image'
      ? part.image_url && typeof part.image_url === 'object'
        ? part.image_url.url
        : part.image_url ?? part.url
      : null;
  if (typeof raw !== 'string' || !raw) return null;
  const remote = /^https?:\/\//i.test(raw) && raw.length <= 300;
  return remote ? `[Image attachment: ${raw}]` : '[Image attachment]';
}

export function messageContentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object') {
        const image = imagePlaceholder(part);
        if (image) parts.push(image);
        else if (typeof part.text === 'string') parts.push(part.text);
        else parts.push(stableStringify(part));
      }
    }
    return parts.join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    const image = imagePlaceholder(content);
    if (image) return image;
    return stableStringify(content);
  }
  return String(content);
}

export function normalizeTools(body) {
  const raw = [];
  if (Array.isArray(body?.tools)) raw.push(...body.tools);
  if (Array.isArray(body?.functions)) raw.push(...body.functions);

  const seen = new Set();
  const tools = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const fn = item.type === 'function' && item.function ? item.function : item;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    tools.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters:
        fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
    });
  }
  return tools;
}

export function normalizeToolChoice(body) {
  if (body?.tool_choice != null) return body.tool_choice;
  if (body?.function_call != null) return body.function_call;
  return 'auto';
}

export function toolChoiceMode(choice) {
  if (choice === 'none') return { mode: 'none' };
  if (choice === 'required' || choice === 'any') return { mode: 'required' };
  if (choice && typeof choice === 'object') {
    const name = choice.function?.name || choice.name;
    if (typeof name === 'string' && name.trim()) {
      return { mode: 'function', name: name.trim() };
    }
  }
  return { mode: 'auto' };
}

export function toolSignature(tools, toolChoice, parallelToolCalls) {
  const payload = {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    choice: toolChoice,
    parallel: parallelToolCalls !== false,
  };
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}
