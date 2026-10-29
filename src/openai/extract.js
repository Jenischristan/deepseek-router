import { has, isPlainObject, looseJsonParse, parseLooseValues, scanJsonValue, tryParse } from './json.js';
import { alignArguments, findProperty, schemaTypes } from './schema.js';

// Tool calling: payload -> call extraction (JSON forms)
// ===========================================================================

function normalizeArguments(value) {
  if (value == null) return { arguments: {}, argumentsText: '{}' };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { arguments: {}, argumentsText: '{}' };
    const parsed = looseJsonParse(trimmed);
    if (parsed.ok) {
      return {
        arguments: parsed.value,
        argumentsText: JSON.stringify(parsed.value),
        ...(parsed.repaired ? { repaired: true } : {}),
      };
    }
    return { arguments: {}, argumentsText: '{}', rawArguments: trimmed };
  }
  if (typeof value === 'object') {
    return { arguments: value, argumentsText: JSON.stringify(value) };
  }
  return { arguments: { value }, argumentsText: JSON.stringify({ value }) };
}

const NAME_KEYS = ['name', 'tool', 'tool_name', 'function_name', 'recipient_name'];
const ARG_KEYS = ['arguments', 'args', 'parameters', 'params', 'input', 'tool_input', 'kwargs'];

function flatArguments(payload, tools = []) {
  if (!isPlainObject(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length === 1 && ARG_KEYS.includes(keys[0])) {
    const key = keys[0];
    const declared = (tools || []).some(
      (tool) => tool?.parameters?.properties && has(tool.parameters.properties, key),
    );
    if (!declared) {
      const inner = payload[key];
      if (isPlainObject(inner)) return inner;
    }
  }
  return payload;
}

// Last resort when the model forgot the tool name: pick the one tool whose
// schema the arguments satisfy completely. Never guesses between near-ties.
function inferToolName(args, tools, preferredName) {
  const candidates = (tools || []).filter((tool) => tool && typeof tool.name === 'string');
  if (!candidates.length || !isPlainObject(args)) return null;

  const keys = Object.keys(args);
  const fitsTool = (tool, { allowExtra = false } = {}) => {
    const aligned = alignArguments(args, tool.parameters || {}, { guess: false });
    if (aligned.missing.length) return null;
    if (aligned.leftover.length && !allowExtra) return null;
    // A tool must still look like it was called with one of its own
    // parameters; otherwise any stray JSON answer becomes a call.
    if (keys.length && aligned.matched === 0) return null;
    return aligned;
  };

  if (candidates.length === 1) {
    // A lone tool can receive extra arguments (e.g. workdir folded into a
    // command); it just needs to satisfy the schema and use one real parameter.
    return fitsTool(candidates[0], { allowExtra: true }) ? candidates[0].name : null;
  }
  if (!keys.length) return null;

  const scored = candidates.map((tool) => {
    const aligned = fitsTool(tool);
    let score = aligned ? aligned.matched * 2 + 10 : -1;
    if (score >= 0 && preferredName && tool.name === preferredName) score += 5;
    return { name: tool.name, score, fits: Boolean(aligned) };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || !best.fits || best.score <= 0) return null;
  if (scored[1] && scored[1].score === best.score) return null;
  return best.name;
}

export function extractCalls(payload, context = {}) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => extractCalls(item, context));
  }
  if (typeof payload === 'string') {
    const values = parseLooseValues(payload);
    if (values.length) return values.flatMap((item) => extractCalls(item, context));
    const parsed = looseJsonParse(payload);
    return parsed.ok ? extractCalls(parsed.value, context) : [];
  }
  if (typeof payload !== 'object') return [];

  if (Array.isArray(payload.tool_uses)) {
    return payload.tool_uses.flatMap((item) => extractCalls(item, context));
  }
  if (Array.isArray(payload.calls)) {
    return payload.calls.flatMap((item) => extractCalls(item, context));
  }
  if (Array.isArray(payload.tool_calls)) {
    return payload.tool_calls.flatMap((item) => extractCalls(item, context));
  }

  let name;
  let args;
  let nameKey = null;
  let nestedFunction = false;
  if (isPlainObject(payload.function)) {
    nestedFunction = true;
    name = payload.function.name;
    args =
      payload.function.arguments ?? payload.function.parameters ?? payload.function.args;
  } else {
    if (typeof payload.function === 'string') {
      name = payload.function;
      nameKey = 'function';
    }
    for (const key of NAME_KEYS) {
      if (name) break;
      if (typeof payload[key] === 'string' && payload[key].trim()) {
        name = payload[key];
        nameKey = key;
      }
    }
    for (const key of ARG_KEYS) {
      if (has(payload, key) && key !== nameKey) {
        args = payload[key];
        break;
      }
    }
    // Flat style: {"name":"bash","command":"ls"}
    if (args === undefined && name && nameKey) {
      const rest = { ...payload };
      delete rest[nameKey];
      delete rest.id;
      delete rest.type;
      if (Object.keys(rest).length) args = rest;
    }
  }

  // A parameter can itself be called "name", "tool", "input" or "function".
  // Only treat the value as an envelope when it names a real tool or is
  // accompanied by an arguments key; otherwise the payload is bare arguments.
  if (
    !nestedFunction &&
    name &&
    nameKey &&
    context.tools?.length &&
    !context.lookupTool?.(name) &&
    !ARG_KEYS.some((key) => key !== nameKey && has(payload, key))
  ) {
    const flat = flatArguments(payload, context.tools);
    const inferred = inferToolName(flat, context.tools, context.preferredName);
    if (inferred) {
      const normalized = normalizeArguments(flat);
      const call = {
        name: inferred,
        inferredName: true,
        arguments: normalized.arguments,
        argumentsText: normalized.argumentsText,
        ...(normalized.repaired ? { repaired: true } : {}),
      };
      if (normalized.rawArguments) call.rawArguments = normalized.rawArguments;
      return [call];
    }
  }

  if (typeof name !== 'string' || !name.trim()) {
    if (context.allowInference === false) return [];
    const flat = flatArguments(payload, context.tools);
    const inferred = inferToolName(flat, context.tools, context.preferredName);
    if (!inferred) return [];
    const normalized = normalizeArguments(flat);
    const call = {
      name: inferred,
      inferredName: true,
      arguments: normalized.arguments,
      argumentsText: normalized.argumentsText,
      ...(normalized.repaired ? { repaired: true } : {}),
    };
    if (normalized.rawArguments) call.rawArguments = normalized.rawArguments;
    return [call];
  }

  const normalized = normalizeArguments(args);
  const call = {
    name: name.trim(),
    arguments: normalized.arguments,
    argumentsText: normalized.argumentsText,
    ...(normalized.repaired ? { repaired: true } : {}),
  };
  if (normalized.rawArguments) call.rawArguments = normalized.rawArguments;
  return [call];
}

// ---------------------------------------------------------------------------
// DSML (DeepSeek's native tool-call markup)
//
//   <｜DSML｜function_calls>
//   <｜DSML｜invoke name="bash">
//   <｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>
//   </｜DSML｜invoke>
//   </｜DSML｜function_calls>
//
// Tags are tokenised first and then walked, instead of using one big lazy
// regex. That is what lets values contain literal tags, lets us recover from a
// forgotten closing tag, and tells "model forgot to close" apart from "output
// was cut off".
// ---------------------------------------------------------------------------

const DSML_NAMES = 'tool_calls|function_calls|calls|invoke|parameter';
const DSML_PREFIX = String.raw`\s*(?:[｜|]\s*){0,3}DSML\s*(?:[｜|]\s*){0,3}`;
// A name-agnostic prefix for cleanup: any DSML marker, any following tag name.
const DSML_PREFIX_ANY = String.raw`\s*(?:[｜|]\s*){0,3}DSML\s*(?:[｜|]\s*){0,3}`;

// `ATTRS_SRC` stops at a `>` only when it is not inside a quoted value. Models
// routinely put `</｜DSML｜parameter>` or `>` inside a parameter value; the old
// `[^>]*` ended the tag there and split the call in half.
const ATTRS_SRC = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const OPEN_TAG_RE = new RegExp(
  String.raw`<(\/?)${DSML_PREFIX}(${DSML_NAMES})(?![A-Za-z0-9_])(${ATTRS_SRC})>`,
  'gi',
);
const DSML_ANY_TAG_RE = new RegExp(
  String.raw`<\/?` + DSML_PREFIX_ANY + String.raw`[^>]*>`,
  'gi',
);
const DSML_PARTIAL_TAIL_RE = new RegExp(
  String.raw`<\/?${DSML_PREFIX}(?:${DSML_NAMES})(?![A-Za-z0-9_])${ATTRS_SRC}$`,
  'i',
);

export function parseAttributes(raw) {
  const attrs = {};
  const source = raw || '';
  // Single left-to-right pass with an anchored `lastIndex`. A plain global
  // regex with the old alternation backtracked per character on a long
  // unquoted value, which could stall the event loop. This is linear.
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const key = match[1].toLowerCase();
    let value = '';
    const at = re.lastIndex;
    const quote = source[at];
    if (quote === '"' || quote === "'") {
      const close = source.indexOf(quote, at + 1);
      if (close === -1) {
        value = source.slice(at + 1);
        re.lastIndex = source.length;
      } else {
        value = source.slice(at + 1, close);
        re.lastIndex = close + 1;
      }
    } else {
      // Unquoted: read to whitespace, `>` or a self-closing `/` at the end.
      let end = at;
      while (end < source.length && !/[\s>]/.test(source[end])) end += 1;
      value = source.slice(at, end);
      re.lastIndex = end;
    }
    attrs[key] = value;
  }
  return attrs;
}

function scanDslTags(text) {
  const tokens = [];
  let cursor = 0;
  for (;;) {
    OPEN_TAG_RE.lastIndex = cursor;
    const match = OPEN_TAG_RE.exec(text);
    if (!match) break;
    const tag = match[2].toLowerCase();
    const attrs = match[3] || '';
    tokens.push({
      kind: tag === 'invoke' ? 'invoke' : tag === 'parameter' ? 'parameter' : 'calls',
      closing: match[1] === '/',
      start: match.index,
      end: OPEN_TAG_RE.lastIndex,
      attrs,
      selfClosing: /\/\s*$/.test(attrs),
    });
    // Never rescan the same characters when a zero-length match is possible.
    cursor = OPEN_TAG_RE.lastIndex > match.index ? OPEN_TAG_RE.lastIndex : match.index + 1;
  }
  return tokens;
}

export const PREFIXED_TAG_SRC = OPEN_TAG_RE.source;

function removeSpans(text, spans) {
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start > cursor) out += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return out + text.slice(cursor);
}

// Finds where the value of the parameter opened by tokens[openIndex] ends.
function findParamEnd(text, tokens, openIndex) {
  let depth = 0;
  let fallbackCloser = -1;

  for (let u = openIndex + 1; u < tokens.length; u += 1) {
    const token = tokens[u];
    if (token.kind !== 'parameter') continue;
    if (!token.closing) {
      depth += 1; // a literal "<parameter>" inside the value (balanced below)
      continue;
    }
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    if (fallbackCloser === -1) fallbackCloser = u;
    const next = tokens[u + 1];
    const gap = text.slice(token.end, next ? next.start : text.length);
    const structural = !next || !(next.kind === 'parameter' && next.closing);
    if (gap.trim() === '' && structural) {
      return { valueEnd: token.start, nextIndex: u, consumedEnd: token.end, recovered: null };
    }
  }

  if (fallbackCloser !== -1) {
    const token = tokens[fallbackCloser];
    return {
      valueEnd: token.start,
      nextIndex: fallbackCloser,
      consumedEnd: token.end,
      recovered: null,
    };
  }

  // Never closed. The next structural tag (if any) is where the value stops.
  for (let u = openIndex + 1; u < tokens.length; u += 1) {
    const token = tokens[u];
    if ((token.kind === 'parameter' && !token.closing) || token.kind !== 'parameter') {
      return {
        valueEnd: token.start,
        nextIndex: u - 1,
        consumedEnd: token.start,
        recovered: 'implicit',
      };
    }
  }
  return {
    valueEnd: text.length,
    nextIndex: tokens.length,
    consumedEnd: text.length,
    recovered: 'eof',
  };
}

function walkDslTokens(text, tokens) {
  const invokes = [];
  const spans = [];
  let regionStart = null;
  let regionEnd = 0;
  let current = null;

  const touch = (start, end) => {
    if (regionStart === null) regionStart = start;
    regionEnd = Math.max(regionEnd, end);
  };

  const closeCurrent = (bodyEnd, tagEnd, state) => {
    current.bodyEnd = bodyEnd;
    current.body = text.slice(current.bodyStart, bodyEnd);
    current.state = state;
    invokes.push(current);
    touch(bodyEnd, tagEnd);
    current = null;
  };

  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t];

    if (token.kind === 'calls') {
      if (!token.closing) {
        touch(token.start, token.end);
        continue;
      }
      if (current) closeCurrent(token.start, token.start, 'implicit');
      if (regionStart !== null) {
        touch(token.start, token.end);
        spans.push([regionStart, regionEnd]);
        regionStart = null;
      }
      continue;
    }

    if (token.kind === 'invoke') {
      touch(token.start, token.end);
      if (token.closing) {
        if (current) closeCurrent(token.start, token.end, 'closed');
        continue;
      }
      if (current) closeCurrent(token.start, token.start, 'implicit');
      current = {
        name: (parseAttributes(token.attrs).name || '').trim(),
        params: [],
        bodyStart: token.end,
      };
      if (token.selfClosing) closeCurrent(token.end, token.end, 'closed');
      continue;
    }

    // parameter
    if (token.closing) continue;
    const target = current || invokes[invokes.length - 1] || null;
    if (!target) continue;
    const attrs = parseAttributes(token.attrs);
    const found = findParamEnd(text, tokens, t);
    touch(token.start, found.consumedEnd);
    target.params.push({
      name: (attrs.name || '').trim(),
      stringAttr: attrs.string,
      raw: text.slice(token.end, found.valueEnd),
      recovered: found.recovered,
    });
    t = found.nextIndex;
  }

  if (current) closeCurrent(text.length, text.length, 'eof');
  if (regionStart !== null) spans.push([regionStart, Math.max(regionEnd, regionStart)]);
  return { invokes, spans };
}

function lookupPropertySchema(schema, key) {
  const properties = schema?.properties;
  if (!isPlainObject(properties)) return null;
  if (has(properties, key)) return properties[key];
  const target = findProperty(key, properties, {});
  return target ? properties[target] : null;
}

// Without a schema (tool not resolved yet) the value stays a string: the real
// type coercion happens in sanitizeToolCalls once the final tool is known.
const DSML_UNKNOWN_CLOSER_RE = new RegExp(
  String.raw`<\/` + DSML_PREFIX + String.raw`([A-Za-z_][\w:.-]*)` + ATTRS_SRC + String.raw`>`,
  'gi',
);
function stripUnknownClosers(text) {
  const known = new Set(DSML_NAMES.split('|'));
  return text.replace(DSML_UNKNOWN_CLOSER_RE, (m, name) =>
    known.has(String(name).toLowerCase()) ? m : '',
  );
}

function typedParamValue(param, propertySchema) {
  const attr = param.stringAttr == null ? null : String(param.stringAttr).toLowerCase();
  const raw = stripUnknownClosers(param.raw);
  if (attr === 'true') return raw;

  const types = schemaTypes(propertySchema);
  const stringOnly = types.length > 0 && types.every((type) => type === 'string' || type === 'null');
  if (stringOnly && attr !== 'false') {
    // Model wrote the value on its own lines instead of inline.
    if (attr === null && raw.length > 2 && raw.startsWith('\n') && raw.endsWith('\n')) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  if (!propertySchema && attr !== 'false') return raw;

  const trimmed = raw.trim();
  const strict = tryParse(trimmed);
  if (strict.ok) return strict.value;
  if (types.includes('array') || types.includes('object') || attr === 'false') {
    const loose = looseJsonParse(trimmed);
    if (loose.ok) return loose.value;
  }
  return raw;
}

function groupDslParams(name, params, schema) {
  const typed = params.map((param) => {
    const propertySchema = lookupPropertySchema(schema, param.name);
    return { name: param.name, schema: propertySchema, value: typedParamValue(param, propertySchema) };
  });

  const counts = new Map();
  for (const item of typed) counts.set(item.name, (counts.get(item.name) || 0) + 1);

  // A repeated parameter the schema declares as an array is one list.
  const arrays = {};
  const rest = [];
  for (const item of typed) {
    if ((counts.get(item.name) || 0) > 1 && schemaTypes(item.schema).includes('array')) {
      (arrays[item.name] ||= []).push(item.value);
    } else {
      rest.push(item);
    }
  }

  // Any other repeat means several calls were packed into one <invoke>.
  const restCounts = new Map();
  for (const item of rest) restCounts.set(item.name, (restCounts.get(item.name) || 0) + 1);
  let primary = null;
  if ((restCounts.get('command') || 0) > 1) {
    primary = 'command';
  } else {
    for (const item of rest) {
      if ((restCounts.get(item.name) || 0) > 1) {
        primary = item.name;
        break;
      }
    }
  }

  const groups = [];
  let currentGroup = {};
  for (const item of rest) {
    if (item.name === primary && has(currentGroup, item.name)) {
      groups.push(currentGroup);
      currentGroup = {};
    }
    currentGroup[item.name] = item.value;
  }
  groups.push(currentGroup);
  Object.assign(groups[0], arrays);

  for (const key of ['workdir', 'cwd', 'directory']) {
    const values = groups.map((group) => group[key]).filter((value) => value !== undefined);
    if (values.length === 1) {
      for (const group of groups) {
        if (group[key] === undefined) group[key] = values[0];
      }
    }
  }

  return groups.map((args) => ({
    name,
    arguments: args,
    argumentsText: JSON.stringify(args),
  }));
}

// <invoke name="x"> with no <parameter> children: JSON body, <child> tags, or empty.
function parseInvokeBody(name, body, context, schema) {
  const text = String(body || '');
  const trimmed = text.trim();
  if (!trimmed) return { calls: [{ name, arguments: {}, argumentsText: '{}' }], invalid: [] };

  const asCalls = (values) => ({
    calls: values.map((value) => ({
      name,
      arguments: value,
      argumentsText: JSON.stringify(value),
    })),
    invalid: [],
  });

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = looseJsonParse(trimmed);
    if (parsed.ok) {
      const extracted = extractCalls(parsed.value, { ...context, allowInference: false });
      if (extracted.length) return { calls: extracted, invalid: [] };
      if (isPlainObject(parsed.value)) return asCalls([parsed.value]);
    } else {
      const values = parseLooseValues(trimmed);
      if (values.length) return asCalls(values);
    }
    return { calls: [], invalid: [{ name, reason: 'invalid_arguments' }] };
  }

  const params = [];
  const re = /<([A-Za-z_][\w.-]*)\b([^>]*)>([\s\S]*?)<\/\1\s*>/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (/^(?:invoke|calls|tool_calls|function_calls|tool_call|parameter)$/i.test(match[1])) continue;
    const attrs = parseAttributes(match[2]);
    params.push({
      name: (attrs.name || match[1]).trim(),
      stringAttr: attrs.string,
      raw: match[3],
    });
  }
  if (params.length) return { calls: groupDslParams(name, params, schema), invalid: [] };

  return { calls: [], invalid: [{ name, reason: 'invalid_arguments' }] };
}

function buildDslCalls(invokes, context) {
  const calls = [];
  const invalid = [];

  for (const invoke of invokes) {
    const name = invoke.name;
    if (!name) {
      invalid.push({ name: null, reason: 'missing_name' });
      continue;
    }

    // A parameter is only complete when its own closing tag was found. 'eof'
    // means the output ended mid-value; 'implicit' means the value was cut off
    // by the next structural tag (often the invoke closer itself). Both are
    // malformed blocks — shipping them would silently run the tool with a
    // truncated value.
    const badParam = invoke.params.some((param) => param.recovered != null);
    if (badParam || invoke.state === 'eof') {
      invalid.push({
        name,
        reason: invoke.state === 'eof' && !badParam ? 'unterminated_invoke' : 'unterminated_parameter',
      });
      continue;
    }

    const named = invoke.params.filter((param) => param.name);
    // Resolve the tool with the raw parameters so a renamed tool ("execute_bash"
    // -> "bash") still gets its real schema for typing the values.
    const provisional = {};
    for (const param of named) provisional[param.name] = param.raw;
    const tool = context.lookupTool ? context.lookupTool(name, provisional) : null;
    const schema = tool?.parameters || null;

    if (!named.length) {
      const fallback = parseInvokeBody(name, invoke.body, context, schema);
      calls.push(...fallback.calls);
      invalid.push(...fallback.invalid);
      continue;
    }
    calls.push(...groupDslParams(name, named, schema));
  }

  return { calls, invalid };
}

function codeRegions(text) {
  const regions = [];
  const fenceRe = /```[\s\S]*?```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) regions.push([m.index, m.index + m[0].length]);
  const inlineRe = /`[^`\n]+`/g;
  while ((m = inlineRe.exec(text)) !== null) regions.push([m.index, m.index + m[0].length]);
  return regions;
}

function tokensInsideCode(text, tokens) {
  if (!tokens.length) return false;
  const regions = codeRegions(text);
  return tokens.every((tk) =>
    regions.some(([a, b]) => tk.start >= a && tk.end <= b),
  );
}

function parseDslBlocks(text, context) {
  let tokens = scanDslTags(text);
  let style = 'prefixed';
  if (!tokens.some((token) => token.kind === 'invoke' || token.kind === 'calls')) {
    // Unprefixed <function_calls><invoke name="..."> (Claude-style markup). The
    // prefixed scanner already accepts a bare <invoke>; this second pass exists
    // for the bare <function_calls> wrapper, so require a real invoke name.
    tokens = scanDslTags(text);
    style = 'bare';
    if (!tokens.some((token) => token.kind === 'invoke' && !token.closing && /\bname\s*=/i.test(token.attrs))) {
      return { calls: [], invalid: [], spans: [], markers: false, fenced: false };
    }
  }
  if (!tokens.length) return { calls: [], invalid: [], spans: [], markers: false, fenced: false };

  const walked = walkDslTokens(text, tokens);

  // Bare markup is ambiguous (could be prose about XML), so require a real tool.
  if (style === 'bare') {
    const known = walked.invokes.some(
      (invoke) => invoke.name && context.lookupTool && context.lookupTool(invoke.name),
    );
    if (!known) return { calls: [], invalid: [], spans: [], markers: false, fenced: false };
  }

  const built = buildDslCalls(walked.invokes, context);
  return {
    calls: built.calls,
    invalid: built.invalid,
    spans: walked.spans,
    markers: true,
    fenced: tokensInsideCode(text, tokens),
  };
}

function cleanupDsmlContent(text, spans) {
  let content = spans.length ? removeSpans(text, spans) : text;
  content = content.replace(DSML_ANY_TAG_RE, '');
  content = content.replace(DSML_PARTIAL_TAIL_RE, '');
  content = content.replace(/<tool_call\b[^>]*$/i, '').trim();
  return content;
}

export function extractDsml(text, context = {}) {
  const parsed = parseDslBlocks(text, context);
  // A DSML marker was seen but nothing parseable came out of it: that is a
  // failed call, not prose. Strip the markup and let repair fire. Markup
  // inside a fence or backticks is a written example and stays verbatim.
  if (!parsed.calls.length && !parsed.invalid.length) {
    if (parsed.markers && !parsed.fenced) {
      return {
        calls: [],
        content: cleanupDsmlContent(text, parsed.spans),
        invalid: [{ name: null, reason: 'missing_name' }],
      };
    }
    if (parsed.fenced) return { calls: [], content: text.trim(), invalid: [] };
    const content = text
      .replace(DSML_PARTIAL_TAIL_RE, '')
      .replace(/<tool_call\b[^>]*$/i, '')
      .trim();
    return { calls: [], content, invalid: [] };
  }
  return {
    calls: parsed.calls,
    content: cleanupDsmlContent(text, parsed.spans),
    invalid: parsed.invalid,
  };
}

// ---------------------------------------------------------------------------
// DeepSeek V3/R1 special-token tool calls
//
//   <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>NAME<｜tool▁sep｜>{"a":1}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
//   <｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME\n```json\n{"a":1}\n```<｜tool▁call▁end｜>
// ---------------------------------------------------------------------------

const V3_TAG_SRC = String.raw`<\s*[｜|]\s*tool[▁_ ](calls?)[▁_ ](begin|end)\s*[｜|]\s*>`;
const V3_SEP_SRC = String.raw`<\s*[｜|]\s*tool[▁_ ]sep\s*[｜|]\s*>`;
const V3_ANY_SRC = String.raw`<\s*[｜|]\s*tool[▁_ ](?:calls?[▁_ ](?:begin|end)|sep|outputs?[▁_ ](?:begin|end|sep))\s*[｜|]\s*>`;

export function extractV3Tokens(text, context = {}) {
  if (!/tool[▁_ ]call/i.test(text)) return { calls: [], content: text, invalid: [] };

  const tags = [];
  const re = new RegExp(V3_TAG_SRC, 'gi');
  let match;
  while ((match = re.exec(text)) !== null) {
    tags.push({
      kind: match[1].toLowerCase() === 'calls' ? 'calls' : 'call',
      closing: match[2].toLowerCase() === 'end',
      start: match.index,
      end: re.lastIndex,
    });
  }
  if (!tags.some((tag) => tag.kind === 'call' && !tag.closing)) {
    return { calls: [], content: text, invalid: [] };
  }

  const calls = [];
  const invalid = [];
  const sepRe = new RegExp(V3_SEP_SRC, 'i');

  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.kind !== 'call' || tag.closing) continue;

    const next = tags[i + 1];
    const bodyEnd = next ? next.start : text.length;
    const terminated = Boolean(next && next.kind === 'call' && next.closing);
    const inner = text.slice(tag.end, bodyEnd);
    const parts = inner.split(sepRe);

    const splitName = (value) => {
      const stop = value.search(/[\r\n{`]/);
      return stop === -1
        ? { name: value.trim(), rest: '' }
        : { name: value.slice(0, stop).trim(), rest: value.slice(stop) };
    };

    let name = '';
    let argText = '';
    if (parts.length >= 2) {
      const first = parts[0].trim();
      if (/^function$/i.test(first)) {
        const split = splitName(parts.slice(1).join(' '));
        name = split.name;
        argText = split.rest;
      } else {
        name = first;
        argText = parts.slice(1).join(' ');
      }
    } else {
      const split = splitName(inner);
      name = split.name;
      argText = split.rest;
    }

    if (!name) {
      invalid.push({ name: null, reason: 'missing_name' });
      continue;
    }

    argText = argText.replace(/```(?:json)?/gi, '').trim();
    let args = {};
    if (argText) {
      const start = argText.search(/[{[]/);
      if (start === -1) {
        invalid.push({ name, reason: 'invalid_arguments' });
        continue;
      }
      const stop = scanJsonValue(argText, start);
      if (stop === -1 && context.truncated && !terminated) {
        invalid.push({ name, reason: 'truncated_call' });
        continue;
      }
      const parsed = looseJsonParse(stop === -1 ? argText.slice(start) : argText.slice(start, stop));
      if (!parsed.ok || !isPlainObject(parsed.value)) {
        invalid.push({ name, reason: 'invalid_arguments' });
        continue;
      }
      args = parsed.value;
    }
    calls.push({ name, arguments: args, argumentsText: JSON.stringify(args) });
  }

  const first = tags[0];
  const last = tags[tags.length - 1];
  const spanEnd = last.closing ? last.end : text.length;
  let content = text.slice(0, first.start) + text.slice(spanEnd);
  content = content.replace(new RegExp(V3_ANY_SRC, 'gi'), '').trim();
  return { calls, content, invalid };
}
// ===========================================================================
