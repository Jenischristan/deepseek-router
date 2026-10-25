import { has, isPlainObject, toolChoiceMode } from './json.js';
import { describeType, normalizeIdentifier, primaryType } from './schema.js';
import { truncateMiddle } from './transcript.js';

// Tool calling: prompts
// ===========================================================================

function oneLine(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function placeholderFor(schema, key) {
  switch (primaryType(schema)) {
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return `<${key}>`;
  }
}

// The example must not anchor the model on one tool: prefer a simple, common
// tool over whatever happens to be first in the list (often a sub-agent tool).
function pickExampleTool(tools, preferredName) {
  const named = preferredName && tools.find((item) => item.name === preferredName);
  if (named) return named;

  let best = null;
  let bestScore = -Infinity;
  for (const tool of tools) {
    const properties = isPlainObject(tool.parameters?.properties) ? tool.parameters.properties : {};
    const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
    let score = -required.length * 2;
    if (!required.every((key) => primaryType(properties[key]) === 'string')) score -= 5;
    if (!required.length) score -= 3;
    if (/^(?:task|agent|subagent|skill|todo|exit|enter|notebook|mcp)/i.test(tool.name)) score -= 8;
    if (score > bestScore) {
      best = tool;
      bestScore = score;
    }
  }
  return best || tools[0];
}

function exampleCall(tools, preferredName) {
  const tool = pickExampleTool(tools, preferredName);
  const properties = isPlainObject(tool.parameters?.properties) ? tool.parameters.properties : {};
  const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
  const args = {};
  for (const key of required) args[key] = placeholderFor(properties[key], key);
  return `<tool_call>${JSON.stringify({ calls: [{ name: tool.name, arguments: args }] })}</tool_call>`;
}

// Names models commonly invent from other agent frameworks. Only warned about
// when the client does not really define a tool with that name.
const COMMONLY_INVENTED = [
  'execute_bash',
  'run_command',
  'read_file',
  'write_file',
  'str_replace_editor',
  'search_files',
  'list_files',
  'run_terminal_cmd',
  'web_search',
  'task',
];

function inventedNameWarning(tools) {
  const real = new Set(tools.map((tool) => normalizeIdentifier(tool.name)));
  const missing = COMMONLY_INVENTED.filter((name) => !real.has(normalizeIdentifier(name))).slice(0, 6);
  if (!missing.length) return '';
  return (
    `- Only the tools listed below exist. Names such as ${missing.map((name) => `"${name}"`).join(', ')} ` +
    'are NOT available unless they appear in the list; use the listed tool that does the job instead.'
  );
}

function toolSection(tool) {
  const lines = [`### ${tool.name}`];
  if (tool.description) lines.push(truncateMiddle(tool.description.trim(), 6000));

  const schema = tool.parameters || {};
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const keys = Object.keys(properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);

  if (!keys.length) {
    lines.push(schema.additionalProperties ? 'Parameters: free-form JSON object.' : 'Parameters: none.');
  } else {
    lines.push('Parameters:');
    for (const key of keys) {
      const property = properties[key] || {};
      const type = describeType(property);
      const note = [];
      if (has(property, 'default')) note.push(`default ${JSON.stringify(property.default)}`);
      const description = oneLine(property.description, 600);
      lines.push(
        `- ${key} (${type}, ${required.has(key) ? 'required' : 'optional'})` +
          `${description ? `: ${description}` : ''}${note.length ? ` [${note.join(', ')}]` : ''}`,
      );
    }
  }

  const raw = JSON.stringify(schema);
  if (/"\$ref"|"allOf"/.test(raw) || schema.anyOf || schema.oneOf) {
    lines.push(`Full JSON schema: ${stableStringify(schema)}`);
  }
  return lines.join('\n');
}

export function formatToolSignatures(tools, { max = 60 } = {}) {
  const list = tools.slice(0, max);
  const lines = list.map((tool) => {
    const properties = isPlainObject(tool.parameters?.properties) ? tool.parameters.properties : {};
    const required = new Set(Array.isArray(tool.parameters?.required) ? tool.parameters.required : []);
    const params = Object.keys(properties).map(
      (key) =>
        `${key}${required.has(key) ? '' : '?'}: ${describeType(properties[key], { objects: false })}`,
    );
    const signature = `${tool.name}(${params.join(', ')})`;
    return `- ${signature.length > 300 ? `${signature.slice(0, 297)}…)` : signature}`;
  });
  if (tools.length > list.length) lines.push(`- … and ${tools.length - list.length} more`);
  return lines.join('\n');
}

// Short reminder appended to follow-up messages: long sessions push the
// original protocol far out of the model's attention, and that is when it
// starts renaming tools and parameters.
export function formatToolReminder(tools) {
  if (!tools?.length) return '';
  const compact = tools.length > 40;
  const body = compact
    ? tools.map((tool) => tool.name).join(', ')
    : tools
        .map((tool) => {
          const properties = isPlainObject(tool.parameters?.properties)
            ? tool.parameters.properties
            : {};
          const required = new Set(
            Array.isArray(tool.parameters?.required) ? tool.parameters.required : [],
          );
          const params = Object.keys(properties).map((key) => `${key}${required.has(key) ? '' : '?'}`);
          const signature = `${tool.name}(${params.join(', ')})`;
          return signature.length > 160 ? `${signature.slice(0, 157)}…)` : signature;
        })
        .join(', ');
  return (
    `[Tool reminder] Available tools: ${body}. ` +
    'To call tools reply with <tool_call>{"calls":[{"name":"<exact tool name>","arguments":{...}}]}</tool_call> ' +
    'and nothing after it. Tool and parameter names are case-sensitive: use them exactly as listed (a "?" marks an optional parameter). ' +
    'Never call a tool that is not in this list.'
  );
}

export function buildToolInstructions(tools, { toolChoice = 'auto', parallelToolCalls = true } = {}) {
  if (!tools.length) return '';

  const choice = toolChoiceMode(toolChoice);
  if (choice.mode === 'none') return '';

  const warning = inventedNameWarning(tools);
  const lines = [
    '[Tool use protocol]',
    'You can call tools. To call one or more tools, reply with a tool block in exactly this format and put nothing after it:',
    '<tool_call>{"calls":[{"name":"TOOL_NAME","arguments":{...}}]}</tool_call>',
    `Format example (tool and values are placeholders, choose whichever listed tool fits the task): ${exampleCall(
      tools,
      choice.mode === 'function' ? choice.name : null,
    )}`,
    'Rules:',
    '- "name" must be EXACTLY one of the tool names listed below. Names are case-sensitive. Never invent, abbreviate, translate or prefix them (no "functions." or "default_api.").',
    ...(warning ? [warning] : []),
    '- "arguments" must be a JSON object that uses exactly the parameter names and types declared in the tool schema, includes every required parameter, and matches the declared types (strings in quotes, numbers and booleans unquoted). Do not add parameters that are not listed.',
    '- Keep the JSON valid: escape newlines as \\n and quotes as \\" inside strings, including multi-line file contents.',
    parallelToolCalls
      ? '- Independent calls go in the same "calls" array, in the order they should run.'
      : '- Call at most one tool per tool block.',
    '- Do not wrap the block in Markdown, do not narrate it, and never write tool results yourself; results arrive in the next message.',
    '- When no tool is needed, answer normally without a tool block. If no listed tool fits, say so in plain text instead of inventing one.',
    '- If you emit your native DSML markup instead, the same exact-name rules apply and every tag must be closed.',
  ];

  if (choice.mode === 'required') {
    lines.push('- You must call at least one tool in this turn.');
  } else if (choice.mode === 'function') {
    const exists = tools.some((tool) => tool.name === choice.name);
    if (exists) lines.push(`- You must call the tool "${choice.name}" in this turn.`);
  }

  lines.push(
    '',
    `Valid tool names (${tools.length}): ${tools.map((tool) => tool.name).join(', ')}`,
    '',
    `Available tools (${tools.length}):`,
    '',
  );
  lines.push(tools.map(toolSection).join('\n\n'));
  lines.push('[End of tool use protocol]');

  return lines.join('\n');
}

// ===========================================================================
