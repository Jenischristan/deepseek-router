import { extractCalls, extractDsml, extractV3Tokens } from './extract.js';
import { MAX_CALLS, WS, has, isPlainObject, looseJsonParse, parseLooseValues, scanJsonValue, stableStringify, toolChoiceMode, tryParse } from './json.js';
import { sanitizeToolCalls, validateToolCalls } from './sanitize.js';
import { resolveToolName, toIndex } from './schema.js';

// Tool calling: response parsing
// ===========================================================================

export function stripLeadingThink(text) {
  let source = String(text || '');
  for (;;) {
    const open = /^\s*<think(?:ing)?\b[^>]*>/i.exec(source);
    if (!open) return source;
    const rest = source.slice(open[0].length);
    const close = /<\/think(?:ing)?\s*>/i.exec(rest);
    if (!close) return '';
    source = rest.slice(close.index + close[0].length);
  }
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
    // Strict lookup first; with the raw arguments also allow synonym/typo matches
    // so the right schema is used to type the values.
    lookupTool: (name, args) => {
      let resolved = resolveToolName(name, index, { strict: true });
      if (!resolved.name && args) resolved = resolveToolName(name, index, { args, strict: false });
      return resolved.name ? index.byName.get(resolved.name) || null : null;
    },
  };

  const source = typeof text === 'string' ? text : '';
  if (!source.trim()) return { calls: [], content: source.trim(), invalidCalls: [] };

  let content = stripLeadingThink(source);
  const calls = [];
  const invalidCalls = [];

  const addCall = (call, { strictNames = false } = {}) => {
    if (restricted) {
      const resolved = resolveToolName(call.name, index, {
        args: call.arguments,
        strict: strictNames,
      });
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
    const allKnown = extracted.every(
      (call) => resolveToolName(call.name, index, { strict: true }).name,
    );
    if (!allKnown) return false;
    for (const call of extracted) addCall(call, { strictNames: true });
    return true;
  };

  const handlePayloadText = (body) => {
    const beforeCalls = calls.length;
    const beforeInvalid = invalidCalls.length;
    const parsed = looseJsonParse(body);
    if (parsed.ok) {
      absorb(parsed.value);
    } else {
      for (const value of parseLooseValues(body)) absorb(value);
    }
    if (calls.length === beforeCalls && invalidCalls.length === beforeInvalid) {
      invalidCalls.push({ name: null, reason: parsed.ok ? 'missing_name' : 'invalid_json' });
    }
  };

  // 1) <tool_call>{...}</tool_call>, found by balancing the JSON itself, so a
  //    string value containing "</tool_call>" cannot cut the block short and a
  //    missing closing tag is tolerated.
  const extractBlocks = (input) => {
    const openRe = /<tool_call\b[^>]*>/gi;
    const closeRe = /\s*<\/tool_call\s*>/iy;
    let out = '';
    let cursor = 0;
    let match;

    while ((match = openRe.exec(input)) !== null) {
      const bodyStart = openRe.lastIndex;
      out += input.slice(cursor, match.index);

      let probe = bodyStart;
      while (probe < input.length && WS.has(input[probe])) probe += 1;

      if (input[probe] === '{' || input[probe] === '[') {
        const payloads = [];
        let end = probe;
        while (end < input.length && (input[end] === '{' || input[end] === '[')) {
          const stop = scanJsonValue(input, end);
          if (stop === -1) {
            const rest = input.slice(end);
            const closing = /<\/tool_call\s*>/i.exec(rest);
            const body = closing ? rest.slice(0, closing.index) : rest;
            payloads.push({ text: body, unbalanced: true });
            end += body.length;
            break;
          }
          payloads.push({ text: input.slice(end, stop), unbalanced: false });
          end = stop;
          while (end < input.length && WS.has(input[end])) end += 1;
          // Stray closers/commas between payloads ("}},{"): skip them so the
          // next balanced object is still recovered as its own call.
          while (end < input.length && (input[end] === '}' || input[end] === ']' || input[end] === ',')) {
            end += 1;
            while (end < input.length && WS.has(input[end])) end += 1;
          }
        }

        closeRe.lastIndex = end;
        const closed = closeRe.exec(input);
        if (closed) end = closeRe.lastIndex;

        for (const payload of payloads) {
          if (payload.unbalanced && !closed && context.truncated) {
            invalidCalls.push({ name: null, reason: 'truncated_call' });
          } else {
            handlePayloadText(payload.text);
          }
        }
        cursor = end;
        openRe.lastIndex = Math.max(openRe.lastIndex, end);
        continue;
      }

      const rest = input.slice(bodyStart);
      const closing = /<\/tool_call\s*>/i.exec(rest);
      const body = closing ? rest.slice(0, closing.index) : rest;
      if (looksLikeDsml(body)) {
        cursor = bodyStart; // drop only the wrapper tag; DSML pass handles the rest
        continue;
      }
      const trimmedBody = body.trim();
      // "<tool_call>" merely mentioned in prose: no JSON follows and the tag is
      // never closed (or what it wraps is clearly not an attempted call).
      const proseMention =
        Boolean(trimmedBody) &&
        ((!closing && !context.truncated) ||
          (trimmedBody.length < 80 && !/[{["=:<]/.test(trimmedBody)));
      if (proseMention) {
        cursor = match.index; // keep the text as-is
        continue;
      }
      if (trimmedBody) invalidCalls.push({ name: null, reason: 'invalid_json' });
      cursor = bodyStart + body.length + (closing ? closing[0].length : 0);
      openRe.lastIndex = cursor;
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

  // 3) The model imitating the transcript label it saw in history.
  if (!calls.length && !invalidCalls.length) {
    const label = /\[Assistant tool calls\]\s*/i.exec(content);
    if (label) {
      const start = content.indexOf('{', label.index + label[0].length);
      const bracket = content.indexOf('[', label.index + label[0].length);
      const from = [start, bracket].filter((value) => value !== -1).sort((a, b) => a - b)[0];
      if (from !== undefined) {
        const stop = scanJsonValue(content, from);
        const body = stop === -1 ? content.slice(from) : content.slice(from, stop);
        const parsed = looseJsonParse(body);
        if (parsed.ok && absorb(parsed.value, { ...context, allowInference: false })) {
          content = content.slice(0, label.index) + (stop === -1 ? '' : content.slice(stop));
        }
      }
    }
  }

  // 4) ```json fenced call, 5) whole reply is a JSON call.
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

  content = content.replace(/```(?:json)?\s*```/gi, '').trim();
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
    'Reply again with ONLY the corrected tool block. Include ALL the tool calls you intended, not just the failed ones, in exactly this format:',
    '<tool_call>{"calls":[{"name":"<exact tool name>","arguments":{...}}]}</tool_call>',
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
