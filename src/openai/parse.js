import { PREFIXED_TAG_SRC, extractCalls, extractDsml, extractV3Tokens } from './extract.js';
import { MAX_CALLS, WS, isPlainObject, looseJsonParse, parseLooseValues, scanJsonValue, stableStringify, toolChoiceMode, tryParse } from './json.js';
import { sanitizeToolCalls, validateToolCalls } from './sanitize.js';
import { resolveToolName, toIndex } from './schema.js';
import { formatToolSignatures } from './prompt.js';

// Tool calling: response parsing
// ===========================================================================

export function stripLeadingThink(text) {
  return splitLeadingThink(text).rest;
}

// Leading <think>…</think> blocks are model reasoning, not assistant content.
// An unclosed block means the reply was cut mid-reasoning: keep the text (it
// may hold the real answer) but let the caller treat it as reasoning.
function splitLeadingThink(text) {
  let source = String(text || '');
  let hadThink = false;
  for (;;) {
    const open = /^\s*<think(?:ing)?\b[^>]*>/i.exec(source);
    if (!open) return { rest: source, hadThink, closed: true };
    hadThink = true;
    const rest = source.slice(open[0].length);
    const close = /<\/think(?:ing)?\s*>/i.exec(rest);
    if (!close) return { rest, hadThink, closed: false };
    source = rest.slice(close.index + close[0].length);
  }
}

const TOOL_WRAPPER_RE = /<(tool_calls?|function_calls?|tool_uses?)\b[^>]*>/gi;

// ```xml / ```json fence that opens immediately before a wrapper tag.
function fenceBefore(text, start) {
  const match = /```[A-Za-z0-9_+.-]*[ \t]*\r?\n[ \t]*$/.exec(
    text.slice(Math.max(0, start - 96), start),
  );
  return match ? start - match[0].length : -1;
}

// Closing fence that follows a wrapper tag on its own line.
function fenceAfter(text, start) {
  const match = /^[ \t]*\r?\n[ \t]*```[ \t]*(?:\r?\n|$)/.exec(text.slice(start));
  return match ? start + match[0].length : -1;
}

// A call body may be wrapped in a Markdown fence and/or preceded by a name line:
//   <tool_call>```json\n{...}\n```</tool_call>
//   <tool_call>bash\n{...}</tool_call>
function cleanCallBody(body) {
  let text = String(body || '').trim();
  let hintName = null;

  const fenced = /^```[A-Za-z0-9_+.-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/i.exec(text);
  if (fenced) {
    text = fenced[1].trim();
  } else {
    const named = /^([A-Za-z_][\w.:-]*)[ \t]*\r?\n([\s\S]+)$/.exec(text);
    if (named && /^(?:```|[{[])/.test(named[2].trim())) {
      hintName = named[1];
      text = named[2].trim();
      const innerFence =
        /^```[A-Za-z0-9_+.-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/i.exec(text);
      if (innerFence) text = innerFence[1].trim();
    }
  }

  return { text, hintName };
}

// Reads the concatenated JSON payloads that start at `start`, skipping the
// stray braces/commas a model leaves between them.
function scanPayloads(text, start) {
  const payloads = [];
  let index = start;
  for (;;) {
    while (
      index < text.length &&
      (WS.has(text[index]) ||
        text[index] === ',' ||
        text[index] === '}' ||
        text[index] === ']')
    ) {
      index += 1;
    }
    if (text[index] !== '{' && text[index] !== '[') break;
    const stop = scanJsonValue(text, index);
    if (stop === -1) return { payloads, unbalanced: true, end: index };
    payloads.push(text.slice(index, stop));
    index = stop;
  }
  return { payloads, unbalanced: false, end: index };
}

// Index just past the first closing tag at or after `from`.
function findCloser(text, name, from) {
  const re = new RegExp(String.raw`\s*</${name}\s*>`, 'gi');
  re.lastIndex = from;
  const match = re.exec(text);
  return match ? { start: match.index, end: re.lastIndex } : null;
}

function looksLikeDsml(text) {
  return new RegExp(PREFIXED_TAG_SRC, 'i').test(text) || /<invoke\b/i.test(text);
}

export function parseToolResponse(text, tools = [], options = {}) {
  let toolList = tools;
  let allowedNames = options.allowedNames ?? null;
  if (tools instanceof Set) {
    allowedNames = tools;
    toolList = [];
  } else if (!Array.isArray(tools)) {
    toolList = [];
  }
  if (!toolList.length && allowedNames && allowedNames.size) {
    toolList = [...allowedNames].map((name) => ({ name, description: '', parameters: {} }));
  }
  const index = toIndex(toolList);
  const restricted = index.tools.length > 0;

  const context = {
    tools: toolList,
    preferredName: options.preferredName || null,
    truncated: Boolean(options.truncated),
    // Strict resolution only: synonyms and typos become suggestions routed
    // through repair, never an automatic rename of a tool the model did not
    // choose. (The raw arguments are still used by extractCalls to pick the
    // right schema when the tool name is missing entirely.)
    lookupTool: (name) => {
      const resolved = resolveToolName(name, index);
      return resolved.name ? index.byName.get(resolved.name) || null : null;
    },
  };

  const source = typeof text === 'string' ? text : '';
  if (!source.trim()) return { calls: [], content: source.trim(), invalidCalls: [] };

  const think = splitLeadingThink(source);
  let content = think.rest;
  const calls = [];
  const invalidCalls = [];

  const addCall = (call) => {
    if (restricted) {
      const resolved = resolveToolName(call.name, index);
      if (!resolved.name) {
        const entry = { name: call.name, reason: 'unknown_tool' };
        if (resolved.suggestions?.length) entry.suggestions = resolved.suggestions;
        invalidCalls.push(entry);
        return;
      }
      if (resolved.name !== call.name) {
        call.renamedFrom = call.name;
        call.name = resolved.name;
      }
    }
    if (calls.length >= MAX_CALLS) {
      invalidCalls.push({ name: call.name, reason: 'too_many_calls' });
      return;
    }
    if (call.rawArguments) {
      // Never run a tool with arguments we could not read: an empty {} would
      // silently execute the wrong thing.
      invalidCalls.push({ name: call.name, reason: 'invalid_arguments' });
      return;
    }
    calls.push(call);
  };

  const absorb = (payload, ctx = context) => {
    const extracted = extractCalls(payload, ctx);
    if (!extracted.length) return false;
    for (const call of extracted) addCall(call);
    return true;
  };

  // Used for loose text (fences, bare JSON): only explicit, known tool names
  // count, so an example snippet in a normal answer is never executed.
  const absorbStrict = (payload) => {
    if (!restricted) return false;
    const extracted = extractCalls(payload, { ...context, allowInference: false });
    if (!extracted.length) return false;
    const allKnown = extracted.every((call) => resolveToolName(call.name, index).name);
    if (!allKnown) return false;
    for (const call of extracted) addCall(call);
    return true;
  };

  const handlePayloadText = (body, hintName = null) => {
    const beforeCalls = calls.length;
    const beforeInvalid = invalidCalls.length;
    const hint = (value) => {
      if (!hintName || !isPlainObject(value)) return value;
      if (value.name || value.function || value.calls || value.tool_calls || value.tool_uses) {
        return value;
      }
      return { name: hintName, arguments: value };
    };
    const absorbOne = (value, repaired) => {
      const before = calls.length;
      absorb(hint(value));
      if (repaired) {
        for (let i = before; i < calls.length; i += 1) calls[i].repaired = true;
      }
    };
    const parsed = looseJsonParse(body);
    if (parsed.ok) {
      absorbOne(parsed.value, parsed.repaired);
    } else {
      for (const value of parseLooseValues(body)) absorbOne(value, false);
    }
    if (calls.length === beforeCalls && invalidCalls.length === beforeInvalid) {
      invalidCalls.push({ name: null, reason: parsed.ok ? 'missing_name' : 'invalid_json' });
    }
  };

  // 1) <tool_call>{...}</tool_call> (and the tool_calls/function_call/tool_use
  //    spellings). A closing tag inside a JSON string must not end the block;
  //    a closing tag after malformed JSON is used as the block boundary so the
  //    whole body can be repaired instead of silently truncating it.
  const extractBlocks = (input) => {
    const openRe = new RegExp(TOOL_WRAPPER_RE.source, 'gi');
    let out = '';
    let cursor = 0;
    let match;

    while ((match = openRe.exec(input)) !== null) {
      const wrapper = match[1].toLowerCase();
      const openEnd = openRe.lastIndex;
      const fenceStart = fenceBefore(input, match.index);
      const matchStart = fenceStart >= cursor ? fenceStart : match.index;

      const firstCloser = findCloser(input, wrapper, openEnd);
      const bodyPreview = input.slice(openEnd, firstCloser ? firstCloser.start : input.length);

      if (looksLikeDsml(bodyPreview)) {
        // Drop only the wrapper tags; the DSML pass owns the body. Any opening
        // fence stays so that a fenced example is recognised as written code
        // (and its empty fence pair cleaned up afterwards) instead of being
        // executed or left behind as debris.
        out += input.slice(cursor, match.index) + bodyPreview;
        cursor = firstCloser ? firstCloser.end : input.length;
        openRe.lastIndex = cursor;
        continue;
      }

      out += input.slice(cursor, matchStart);

      const scanned = scanPayloads(input, openEnd);
      let closer = null;
      if (scanned.payloads.length && !scanned.unbalanced) {
        closer = findCloser(input, wrapper, scanned.end);
      } else {
        closer = firstCloser;
      }

      if (scanned.payloads.length && !scanned.unbalanced) {
        const between = closer ? input.slice(scanned.end, closer.start) : '';
        const cleanBetween = between.replace(/[\s,}\]]/g, '') === '';
        if (cleanBetween) {
          for (const payload of scanned.payloads) handlePayloadText(payload);
          let end = closer ? closer.end : scanned.end;
          if (fenceStart !== -1 && closer) {
            const fenceEnd = fenceAfter(input, end);
            if (fenceEnd !== -1) end = fenceEnd;
          }
          cursor = end;
          openRe.lastIndex = Math.max(openRe.lastIndex, end);
          continue;
        }
      }

      const rawBody = input.slice(openEnd, closer ? closer.start : input.length);
      const cleaned = cleanCallBody(rawBody);
      const trimmedBody = cleaned.text.trim();
      const hasCloser = Boolean(closer);

      if (!trimmedBody) {
        cursor = closer ? closer.end : input.length;
        openRe.lastIndex = Math.max(openRe.lastIndex, cursor);
        continue;
      }

      // A tool tag merely mentioned in prose: never closed on a finished
      // reply, or wrapping something that is clearly not an attempted call.
      // Long mentions stay prose too — swallowing the rest of the reply and
      // firing a repair round would be worse than keeping the text.
      const looksLikePayload = /[{["=:<`]/.test(trimmedBody);
      const proseMention =
        Boolean(trimmedBody) &&
        ((!hasCloser && !context.truncated && !looksLikePayload) ||
          (trimmedBody.length < 80 && !looksLikePayload));
      if (proseMention) {
        cursor = matchStart;
        continue;
      }

      if (scanned.unbalanced && !hasCloser && context.truncated) {
        invalidCalls.push({ name: null, reason: 'truncated_call' });
      } else {
        handlePayloadText(cleaned.text, cleaned.hintName);
      }

      let end = closer ? closer.end : input.length;
      if (fenceStart !== -1 && closer) {
        const fenceEnd = fenceAfter(input, end);
        if (fenceEnd !== -1) end = fenceEnd;
      }
      cursor = end;
      openRe.lastIndex = Math.max(openRe.lastIndex, end);
    }

    return out + input.slice(cursor);
  };

  content = extractBlocks(content);
  content = content.replace(/<\/tool_call\s*>/gi, '');

  // 2) DSML markup
  const dsml = extractDsml(content, context);
  content = dsml.content;
  for (const call of dsml.calls) addCall(call);
  invalidCalls.push(...dsml.invalid);

  // 2b) DeepSeek V3/R1 special tokens: <｜tool▁call▁begin｜>name<｜tool▁sep｜>{...}
  const v3 = extractV3Tokens(content, context);
  content = v3.content;
  for (const call of v3.calls) addCall(call);
  invalidCalls.push(...v3.invalid);

  // 3) ```json fenced call, 4) whole reply is a JSON call.
  if (!calls.length && !invalidCalls.length && restricted) {
    const fenceRe = /```(?:json|tool_call|tool)?[ \t]*\r?\n?([\s\S]*?)```/gi;
    content = content.replace(fenceRe, (match, body) => {
      const parsed = looseJsonParse(body.trim());
      if (!parsed.ok) return match;
      return absorbStrict(parsed.value) ? '' : match;
    });
  }

  if (!calls.length && !invalidCalls.length && restricted) {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = tryParse(trimmed);
      if (parsed.ok && absorbStrict(parsed.value)) content = '';
    }
  }

  // Empty-fence debris left behind after a fenced tool block was removed:
  // "```xml\n\n```". A bare "```\n```" (a closing fence directly followed by
  // the next opening fence) is NOT debris — removing it would glue two real
  // blocks together — so the newline form requires a language tag.
  content = content
    .replace(/```[A-Za-z0-9_+.-]*[ \t]*```/gi, '')
    .replace(/```[A-Za-z0-9_+.-]+[ \t]*\r?\n[ \t\r\n]*```/gi, '')
    .trim();

  // A leading think block that never closed is reasoning, not content: keep
  // the text (the real answer may be in it) but never execute tool calls that
  // appear inside it — they are model-internal, exactly like the closed case.
  if (think.hadThink && !think.closed) {
    return { calls: [], content, invalidCalls: [] };
  }

  return { calls, content, invalidCalls };
}

// Parse + align + validate in one step. `needsRepair` tells the caller that
// asking the model to try again is likely to beat shipping this to the client.
//
// options: allowedNames, preferredName, truncated, validate,
//          requireCall (tool_choice required/function),
//          requiredName (tool_choice names a specific function)
export function interpretToolResponse(text, tools, options = {}) {
  const toolList = Array.isArray(tools) ? tools : [];
  const parsed = parseToolResponse(text, toolList, options);

  // The same call twice in one reply (model repeated its block) would run twice.
  const seen = new Set();
  const calls = sanitizeToolCalls(parsed.calls, toolList).filter((call) => {
    const signature = `${call.name}\u0000${stableStringify(call.arguments)}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });

  const argumentProblems = options.validate === false ? [] : validateToolCalls(calls, toolList);
  const invalidCalls = parsed.invalidCalls;
  const repairableInvalid = invalidCalls.filter((item) => item.reason !== 'too_many_calls');

  const noCalls = calls.length === 0;
  const missedRequired = Boolean(options.requireCall) && noCalls && invalidCalls.length === 0;
  const wrongTool =
    Boolean(options.requiredName) &&
    calls.length > 0 &&
    !calls.some((call) => call.name === options.requiredName);

  // Nothing has been executed yet, so any invalid call means the whole reply
  // is better re-sent than shipped with a call silently missing.
  const needsRepair =
    repairableInvalid.length > 0 ||
    argumentProblems.length > 0 ||
    missedRequired ||
    wrongTool;

  return {
    content: parsed.content,
    calls,
    invalidCalls,
    argumentProblems,
    missedRequired,
    wrongTool,
    needsRepair,
    renamed: calls
      .filter((call) => call.renamedFrom)
      .map((call) => ({ from: call.renamedFrom, to: call.name })),
  };
}

export function describeInvalidCall(item) {
  const quoted = item.name ? `"${item.name}"` : 'a tool call';
  switch (item.reason) {
  case 'unknown_tool': {
    const hint = item.suggestions?.length
      ? ` Did you mean ${item.suggestions.map((name) => `"${name}"`).join(' or ')}?`
      : ' Use only the tool names listed.';
    return `${quoted} is not an available tool.${hint}`;
  }
  case 'invalid_json':
    return 'a <tool_call> block did not contain valid JSON (escape newlines as \\n and quotes as \\" inside strings).';
  case 'invalid_arguments':
    return `the arguments for ${quoted} were not a valid JSON object.`;
  case 'dsml_in_value':
    return (
      `the arguments for ${quoted} still contained raw tool-call markup (a DSML tag). ` +
      'Rewrite the values as plain text without any <…DSML…> tags.'
    );
  case 'missing_name':
    return 'a tool call had no tool name.';
  case 'unterminated_parameter':
  case 'unterminated_invoke':
  case 'truncated_call':
    return (
      `the tool call${item.name ? ` for "${item.name}"` : ''} was cut off before it was complete. ` +
        'Send a shorter call (for large file contents, write them in smaller pieces).'
    );
  case 'too_many_calls':
    return 'too many tool calls in one block.';
  default:
    return `${quoted} was invalid (${item.reason}).`;
  }
}

// Tools worth spelling out in a repair message: the ones involved in the errors.
function repairFocusTools(interpretation, tools, requiredName) {
  const names = new Set();
  for (const item of interpretation.argumentProblems || []) names.add(item.name);
  for (const item of interpretation.invalidCalls || []) {
    for (const name of item.suggestions || []) names.add(name);
  }
  if (requiredName) names.add(requiredName);
  return tools.filter((tool) => names.has(tool.name));
}

// The follow-up message sent upstream when a reply could not be executed.
export function buildToolRepairPrompt(interpretation, tools, { toolChoice = 'auto' } = {}) {
  const mode = toolChoiceMode(toolChoice);
  const requiredName = mode.mode === 'function' ? mode.name : null;

  const lines = [
    '[Tool call error]',
    'Your previous reply could not be executed, so NO tool was run:',
  ];
  for (const item of interpretation.invalidCalls) {
    if (item.reason === 'too_many_calls') continue;
    lines.push(`- ${describeInvalidCall(item)}`);
  }
  for (const item of interpretation.argumentProblems) {
    for (const problem of item.problems) lines.push(`- tool "${item.name}": ${problem}`);
  }
  if (interpretation.wrongTool && requiredName) {
    lines.push(`- You must call the tool "${requiredName}" in this turn.`);
  } else if (interpretation.missedRequired) {
    lines.push(
      requiredName
        ? `- You must call the tool "${requiredName}" in this turn.`
        : '- You must call a tool in this turn.',
    );
  }

  const focus = repairFocusTools(interpretation, tools, requiredName);
  const everything = tools.length <= 30;
  lines.push(
    '',
    'Reply again with ONLY the corrected tool block. Include ALL the tool calls you intended, not just the failed ones, in DeepSeek DSML markup:',
    '<\uFF5CDSML\uFF5Cfunction_calls>',
    '<\uFF5CDSML\uFF5Cinvoke name="<exact tool name>">',
    '<\uFF5CDSML\uFF5Cparameter name="<exact parameter name>" string="true">value</\uFF5CDSML\uFF5Cparameter>',
    '</\uFF5CDSML\uFF5Cinvoke>',
    '</\uFF5CDSML\uFF5Cfunction_calls>',
    'Use string="false" for non-string values (JSON value). The JSON form <tool_call>{"calls":[...]}</tool_call> is also accepted as a fallback.',
    'Tool names and parameter names are case-sensitive.',
  );
  if (focus.length || everything) {
    lines.push('Tool signatures:', formatToolSignatures(focus.length ? focus : tools, { max: 40 }));
  }
  if (!everything || focus.length) {
    lines.push(`All available tool names: ${tools.map((tool) => tool.name).join(', ')}`);
  }
  lines.push('If you now believe no tool is needed, answer the user directly instead.');
  return lines.join('\n');
}
// ===========================================================================
