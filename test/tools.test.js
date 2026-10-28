import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ToolCallStreamFilter,
  buildToolInstructions,
  interpretToolResponse,
  parseToolResponse,
  formatToolCallsForTranscript,
  formatToolResultPrompt,
  sanitizeToolCalls,
  splitAtToolMarker,
} from '../src/server.js';

const BAR = '\uFF5C';

const bash = {
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      workdir: { type: 'string' },
      timeout: { type: 'number' },
    },
    required: ['command'],
  },
};

const read = {
  name: 'read',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { filePath: { type: 'string' } },
    required: ['filePath'],
  },
};

const tools = [bash, read];
const allowedNames = new Set(tools.map((tool) => tool.name));

function parse(text, options = {}) {
  const parsed = parseToolResponse(text, tools, {
    allowedNames,
    ...options,
  });
  return { ...parsed, calls: sanitizeToolCalls(parsed.calls, tools) };
}

test('accepts the documented calls envelope', () => {
  const result = parse(
    '<tool_call>{"calls":[{"name":"bash","arguments":{"command":"ls"}}]}</tool_call>',
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
  assert.equal(result.calls[0].argumentsText, '{"command":"ls"}');
  assert.equal(result.invalidCalls.length, 0);
});

test('infers the tool name from bare argument objects', () => {
  const result = parse('<tool_call>{"command":"ls -la","timeout":60000}</tool_call>');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
  assert.deepEqual(result.calls[0].arguments, { command: 'ls -la', timeout: 60000 });
  assert.equal(result.content, '');
});

test('infers per object in newline-separated calls', () => {
  const result = parse('<tool_call>{"command":"ls"}\n{"filePath":"/etc/passwd"}</tool_call>');
  assert.deepEqual(
    result.calls.map((call) => call.name),
    ['bash', 'read'],
  );
});

test('recovers multiple objects with stray braces and commas', () => {
  const result = parse(
    '<tool_call>{"command":"sed -n 1,2p x","timeout":30000}},{"name":"bash","arguments":{"command":"grep y"}}</tool_call>',
  );
  assert.equal(result.calls.length, 2);
  assert.deepEqual(
    result.calls.map((call) => call.argumentsText),
    ['{"command":"sed -n 1,2p x","timeout":30000}', '{"command":"grep y"}'],
  );
});

test('keeps an unterminated tool block usable', () => {
  const result = parse('<tool_call>{"command":"ls"}');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
  assert.equal(result.content, '');
});

test('reports ambiguous bare arguments instead of dropping them silently', () => {
  const ambiguous = [
    {
      name: 'alpha',
      description: '',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
    {
      name: 'beta',
      description: '',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
  ];
  const result = parseToolResponse(
    '<tool_call>{"value":"x"}</tool_call>',
    ambiguous,
    { allowedNames: new Set(['alpha', 'beta']) },
  );
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.invalidCalls, [{ name: null, reason: 'missing_name' }]);
});

test('tool_choice breaks ties for bare arguments', () => {
  const ambiguous = [
    {
      name: 'alpha',
      description: '',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
    {
      name: 'beta',
      description: '',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
  ];
  const result = parseToolResponse('<tool_call>{"value":"x"}</tool_call>', ambiguous, {
    allowedNames: new Set(['alpha', 'beta']),
    preferredName: 'beta',
  });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'beta');
});

test('accepts DeepSeek DSML with full-width bars', () => {
  const text = [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">ls</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
  const result = parse(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
  assert.equal(result.calls[0].argumentsText, '{"command":"ls"}');
});

test('accepts spaced DSML and recovers repeated parameters', () => {
  const text = [
    `<${BAR}DSML${BAR} tool_calls>`,
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">ls</${BAR}DSML${BAR} parameter>`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">pwd</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} tool_calls>`,
  ].join('\n');
  const result = parse(text);
  assert.deepEqual(
    result.calls.map((call) => call.argumentsText),
    ['{"command":"ls"}', '{"command":"pwd"}'],
  );
});

test('unwraps stringified arguments and coerces declared types', () => {
  const result = parse(
    '<tool_call>{"name":"bash","arguments":"{\\"command\\":\\"ls\\",\\"timeout\\":\\"60000\\"}"}</tool_call>',
  );
  assert.deepEqual(result.calls[0].arguments, { command: 'ls', timeout: 60000 });
});

test('rejects unknown tool names', () => {
  const result = parse('<tool_call>{"name":"nope","arguments":{}}</tool_call>');
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.invalidCalls, [{ name: 'nope', reason: 'unknown_tool' }]);
});

test('reports invalid JSON instead of stripping it silently', () => {
  const result = parse('<tool_call>{not json}</tool_call>');
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.invalidCalls, [{ name: null, reason: 'invalid_json' }]);
});

test('keeps text outside the tool block', () => {
  const result = parse('Let me check.\n<tool_call>{"command":"ls"}</tool_call>');
  assert.equal(result.calls.length, 1);
  assert.equal(result.content, 'Let me check.');
});

test('stream filter holds tool blocks and passes normal text', () => {
  const filter = new ToolCallStreamFilter();
  let visible = '';
  for (const piece of ['Hel', 'lo <tool_', 'call>{"command":', '"ls"}</tool_call>', ' done']) {
    visible += filter.push(piece);
  }
  const held = filter.takeHeld();
  assert.equal(visible.trim(), 'Hello');
  assert.match(held.blocks, /<tool_call>\{"command":"ls"\}<\/tool_call>/);
  assert.equal(held.pending, '');
});

test('folds workdir only when the schema does not declare it', () => {
  const withoutWorkdir = [
    {
      ...bash,
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  ];
  const folded = parseToolResponse(
    '<tool_call>{"command":"ls","workdir":"/tmp/x"}</tool_call>',
    withoutWorkdir,
    { allowedNames: new Set(['bash']) },
  );
  const [call] = sanitizeToolCalls(folded.calls, withoutWorkdir);
  assert.deepEqual(call.arguments, { command: "cd '/tmp/x' && ls" });

  const kept = parse('<tool_call>{"command":"ls","workdir":"/tmp/x"}</tool_call>');
  assert.deepEqual(kept.calls[0].arguments, { command: 'ls', workdir: '/tmp/x' });
});

test('does not infer tool calls from an unwrapped JSON answer', () => {
  const result = parse('{"command":"ls"}');
  assert.equal(result.calls.length, 0);
  assert.equal(result.content, '{"command":"ls"}');
});

test('still accepts a Set as the second argument', () => {
  const result = parseToolResponse(
    '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
    new Set(['bash']),
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
});

test('tool result prompt can omit the protocol instruction', () => {
  const toolMessages = [
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ];
  const mapping = { call_1: { name: 'bash', argumentsText: '{"command":"ls"}' } };
  const withProtocol = formatToolResultPrompt(toolMessages, mapping);
  const withoutProtocol = formatToolResultPrompt(toolMessages, mapping, { protocol: false });
  assert.match(withProtocol, /reply only with a tool call block/);
  assert.doesNotMatch(withoutProtocol, /tool call block/);
  assert.match(withoutProtocol, /\[Tool result\]/);
  assert.match(withoutProtocol, /result:\nok/);
});

test('instructions do not forbid schema-declared parameters', () => {
  const text = buildToolInstructions(tools);
  assert.doesNotMatch(text, /Never invent parameters such as "workdir"/);
  assert.match(text, /parameter names and types declared in the tool schema/);
});

test('accepts mixed ASCII and full-width pipe markers', () => {
  const text = [
    `<|||DSML${BAR}${BAR} tool_calls>`,
    `<|${BAR}DSML|| invoke name="bash">`,
    `<${BAR}|DSML|${BAR} parameter name="command" string="true">ls</${BAR}|DSML|${BAR} parameter>`,
    `</|${BAR}DSML|| invoke>`,
    `</|||DSML${BAR}${BAR} tool_calls>`,
  ].join('\n');
  const result = parse(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].argumentsText, '{"command":"ls"}');
});

test('accepts a V4.1 spaced block-less invoke', () => {
  const text = [
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">pwd</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
  ].join('\n');
  const result = parse(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
});

test('preserves whitespace in string parameters', () => {
  const text = `<${BAR}DSML${BAR} calls><${BAR}DSML${BAR} invoke name="bash"><${BAR}DSML${BAR} parameter name="command" string="true">  echo hi\n</${BAR}DSML${BAR} parameter></${BAR}DSML${BAR} invoke></${BAR}DSML${BAR} calls>`;
  const result = parse(text);
  assert.deepEqual(result.calls[0].arguments, { command: '  echo hi\n' });
});

test('parses JSON parameter values and keeps raw text on failure', () => {
  const text = [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="timeout" string="false">60000</${BAR}DSML${BAR} parameter>`,
    `<${BAR}DSML${BAR} parameter name="command">ls</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
  const result = parse(text);
  assert.deepEqual(result.calls[0].arguments, { timeout: 60000, command: 'ls' });
});

test('resynchronizes on the next invoke when a close tag is missing', () => {
  const text = [
    `<${BAR}DSML${BAR} tool_calls>`,
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">ls</${BAR}DSML${BAR} parameter>`,
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">pwd</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} tool_calls>`,
  ].join('\n');
  const result = parse(text);
  assert.deepEqual(
    result.calls.map((call) => call.argumentsText),
    ['{"command":"ls"}', '{"command":"pwd"}'],
  );
});

test('rejects an invoke with an unterminated parameter', () => {
  const text = `<${BAR}DSML${BAR} calls><${BAR}DSML${BAR} invoke name="bash"><${BAR}DSML${BAR} parameter name="command" string="true">rm -rf /tmp/x</${BAR}DSML${BAR} invoke></${BAR}DSML${BAR} calls>`;
  const result = parse(text);
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.invalidCalls, [
    { name: 'bash', reason: 'unterminated_parameter' },
  ]);
});

test('recovers a stray parameter after a closed invoke', () => {
  const text = [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">ls</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">pwd</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">id</${BAR}DSML${BAR} parameter>`,
  ].join('\n');
  const result = parse(text);
  assert.deepEqual(
    result.calls.map((call) => call.argumentsText),
    ['{"command":"ls"}', '{"command":"pwd"}', '{"command":"id"}'],
  );
});

test('ignores tool blocks inside think sections', () => {
  const text = [
    '<think>',
    `run this: <${BAR}DSML${BAR} calls><${BAR}DSML${BAR} invoke name="bash"><${BAR}DSML${BAR} parameter name="command" string="true">rm -rf ~</${BAR}DSML${BAR} parameter></${BAR}DSML${BAR} invoke></${BAR}DSML${BAR} calls>`,
    '</think>',
    'Done',
    '<tool_call>{"command":"ls"}</tool_call>',
  ].join('\n');
  const result = parse(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].argumentsText, '{"command":"ls"}');
  assert.equal(result.content, 'Done');
});

test('unwraps args only when the schema does not declare it', () => {
  const echo = {
    name: 'echo',
    description: '',
    parameters: {
      type: 'object',
      properties: { arguments: { type: 'string' } },
      required: ['arguments'],
    },
  };
  const withWrapper = parseToolResponse(
    '<tool_call>{"args":{"command":"ls"}}</tool_call>',
    [bash, echo],
    { allowedNames: new Set(['bash', 'echo']) },
  );
  assert.equal(withWrapper.calls[0].name, 'bash');
  assert.deepEqual(withWrapper.calls[0].arguments, { command: 'ls' });

  const declared = parseToolResponse(
    '<tool_call>{"arguments":{"command":"ls"}}</tool_call>',
    [bash, echo],
    { allowedNames: new Set(['bash', 'echo']) },
  );
  assert.equal(declared.calls[0].name, 'echo');
  assert.deepEqual(declared.calls[0].arguments, { arguments: { command: 'ls' } });
});

test('supports multiple invokes in one calls block', () => {
  const text = [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="bash"><${BAR}DSML${BAR} parameter name="command" string="true">ls</${BAR}DSML${BAR} parameter></${BAR}DSML${BAR} invoke>`,
    `<${BAR}DSML${BAR} invoke name="read"><${BAR}DSML${BAR} parameter name="filePath" string="true">/etc/hosts</${BAR}DSML${BAR} parameter></${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
  const result = parse(text);
  assert.deepEqual(
    result.calls.map((call) => call.name),
    ['bash', 'read'],
  );
});

test('keeps DSML-looking prose but strips a cut-off trailing marker', () => {
  const text = `hello </${BAR}DSML${BAR} calls> world <${BAR}DSML${BAR} invoke`;
  const result = parse(text);
  assert.equal(result.calls.length, 0);
  assert.equal(result.content, `hello </${BAR}DSML${BAR} calls> world`);
});

test('keeps an empty DSML wrapper mentioned in prose', () => {
  const text = `Wrap calls in <${BAR}DSML${BAR} calls> tags.`;
  const result = parse(text);
  assert.equal(result.calls.length, 0);
  assert.equal(result.content, text);
});

test('drops a cut-off tool marker at the end of a stream', () => {
  const filter = new ToolCallStreamFilter();
  const visible = filter.push(`hello <${BAR}DSML${BAR} inv`);
  assert.equal(visible, 'hello ');
  const held = filter.takeHeld();
  assert.equal(held.pending, '');
});

test('keeps a trailing less-than that is not a tool marker', () => {
  const filter = new ToolCallStreamFilter();
  const visible = filter.push('2 <');
  const held = filter.takeHeld();
  assert.equal(visible + held.pending, '2 <');
});

test('drops a partial marker without a tag name', () => {
  const filter = new ToolCallStreamFilter();
  const visible = filter.push(`x <${BAR}DS`);
  assert.equal(visible, 'x ');
  assert.equal(filter.takeHeld().pending, '');
});

test('accepts a direct JSON body inside an invoke', () => {
  const text = [
    `<${BAR}DSML${BAR} function_calls>`,
    `<${BAR}DSML${BAR} invoke name="bash">{"command":"ls"}</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} function_calls>`,
  ].join('\n');
  const result = parse(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].argumentsText, '{"command":"ls"}');
});

test('accepts multiple DSML blocks in one response', () => {
  const block = (command) => [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="bash"><${BAR}DSML${BAR} parameter name="command" string="true">${command}</${BAR}DSML${BAR} parameter></${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
  const result = parse(`${block('ls')}\n${block('pwd')}`);
  assert.deepEqual(
    result.calls.map((call) => call.argumentsText),
    ['{"command":"ls"}', '{"command":"pwd"}'],
  );
});

test('recovers a block-less invoke after a complete block', () => {
  const block = [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="bash"><${BAR}DSML${BAR} parameter name="command" string="true">ls</${BAR}DSML${BAR} parameter></${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
  const orphan = [
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">pwd</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
  ].join('\n');
  const result = parse(`${block}\n${orphan}`);
  assert.deepEqual(
    result.calls.map((call) => call.argumentsText),
    ['{"command":"ls"}', '{"command":"pwd"}'],
  );
});

// ===========================================================================
// Adversarial parser cases: sloppy JSON, name repair, limits, streaming.
// ===========================================================================

test('does not cut a block at a closing tag inside a JSON string', () => {
  const result = parse(
    '<tool_call>{"command":"echo \'</tool_call>\' && ls"}</tool_call>',
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].arguments.command, "echo '</tool_call>' && ls");
  assert.equal(result.content, '');
});

test('repairs raw newlines inside a JSON string', () => {
  const result = parse('<tool_call>{"command":"printf \'a\nb\'"}</tool_call>');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].arguments.command, "printf 'a\nb'");
});

test('keeps unescaped inner double quotes in a command', () => {
  const result = parse('<tool_call>{"command":"echo "hi" > /tmp/x"}</tool_call>');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].arguments.command, 'echo "hi" > /tmp/x');
});

test('repairs single quotes, bare keys and a trailing comma', () => {
  const result = parse("<tool_call>{command: 'ls -la', timeout: 30,}</tool_call>");
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].arguments, { command: 'ls -la', timeout: 30 });
});

test('repairs a missing comma between members', () => {
  const result = parse('<tool_call>{"command":"ls" "workdir":"/tmp/out"}</tool_call>');
  assert.deepEqual(result.calls[0].arguments, { command: 'ls', workdir: '/tmp/out' });
});

test('coerces nested objects, arrays and booleans against the schema', () => {
  const edit = {
    name: 'edit',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              line: { type: 'integer' },
            },
            required: ['path', 'line'],
          },
        },
        dryRun: { type: 'boolean' },
      },
      required: ['edits'],
    },
  };
  const parsed = parseToolResponse(
    '<tool_call>{"name":"edit","arguments":{"edits":[{"path":"a.txt","line":"7"}],"dryRun":"yes"}}</tool_call>',
    [edit],
    { allowedNames: new Set(['edit']) },
  );
  const [call] = sanitizeToolCalls(parsed.calls, [edit]);
  assert.deepEqual(call.arguments, {
    edits: [{ path: 'a.txt', line: 7 }],
    dryRun: true,
  });
});

test('joins an argv-style command array with shell quoting', () => {
  const result = parse('<tool_call>{"command":["ls","-la","My File"]}</tool_call>');
  assert.equal(result.calls[0].arguments.command, "ls -la 'My File'");
});

test('coerces numeric strings and boolean strings', () => {
  const tool = {
    name: 'wait',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        interval: { type: 'integer' },
        background: { type: 'boolean' },
      },
      required: ['interval'],
    },
  };
  const parsed = parseToolResponse(
    '<tool_call>{"name":"wait","arguments":{"interval":"2500","background":"no"}}</tool_call>',
    [tool],
    { allowedNames: new Set(['wait']) },
  );
  const [call] = sanitizeToolCalls(parsed.calls, [tool]);
  assert.deepEqual(call.arguments, { interval: 2500, background: false });
});

test('normalizes enum values by case and punctuation', () => {
  const tool = {
    name: 'set_mode',
    description: '',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast', 'safe'] } },
      required: ['mode'],
    },
  };
  const parsed = parseToolResponse(
    '<tool_call>{"name":"set_mode","arguments":{"mode":"SAFE"}}</tool_call>',
    [tool],
    { allowedNames: new Set(['set_mode']) },
  );
  const [call] = sanitizeToolCalls(parsed.calls, [tool]);
  assert.equal(call.arguments.mode, 'safe');
});

test('cleans namespaced and prefixed tool names', () => {
  const result = parse(
    '<tool_call>{"name":"default_api.Bash","arguments":{"command":"ls"}}</tool_call>',
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
  assert.equal(result.calls[0].renamedFrom, 'default_api.Bash');
});

test('reports a transposed tool name instead of executing it as another tool', () => {
  const result = parse('<tool_call>{"name":"bsah","arguments":{"command":"ls"}}</tool_call>');
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.invalidCalls[0].suggestions, ['bash']);
});

test('reports a synonym instead of executing it as another tool', () => {
  const result = parse(
    '<tool_call>{"name":"execute_bash","arguments":{"command":"pwd"}}</tool_call>',
  );
  assert.equal(result.calls.length, 0);
  assert.equal(result.invalidCalls[0].reason, 'unknown_tool');
  assert.deepEqual(result.invalidCalls[0].suggestions, ['bash']);
});

test('resolves an mcp-namespaced name to the bare tool', () => {
  const readFile = {
    name: 'read_file',
    description: '',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  };
  const parsed = parseToolResponse(
    '<tool_call>{"name":"mcp__filesystem__read_file","arguments":{"file_path":"/tmp/a"}}</tool_call>',
    [readFile],
    { allowedNames: new Set(['read_file']) },
  );
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, 'read_file');
});

test('reports ranked suggestions for an unknown tool name', () => {
  const result = parse('<tool_call>{"name":"bas","arguments":{"command":"ls"}}</tool_call>');
  assert.equal(result.calls.length, 0);
  assert.equal(result.invalidCalls[0].reason, 'unknown_tool');
  assert.deepEqual(result.invalidCalls[0].suggestions, ['bash']);
});

test('keeps valid calls while reporting a mixed-in unknown one', () => {
  const text =
    '<tool_call>{"calls":[{"name":"bash","arguments":{"command":"ls"}},{"name":"nope","arguments":{}}]}</tool_call>';
  const result = interpretToolResponse(text, tools, { allowedNames });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
  assert.equal(result.invalidCalls.length, 1);
  assert.equal(result.invalidCalls[0].reason, 'unknown_tool');
  assert.equal(result.needsRepair, true);
});

test('caps calls at 32 and reports the overflow', () => {
  const calls = Array.from({ length: 34 }, (_, index) => ({
    name: 'bash',
    arguments: { command: `echo ${index}` },
  }));
  const result = parse(`<tool_call>${JSON.stringify({ calls })}</tool_call>`);
  assert.equal(result.calls.length, 32);
  assert.equal(result.invalidCalls.length, 2);
  assert.ok(result.invalidCalls.every((item) => item.reason === 'too_many_calls'));
});

test('deduplicates an identical call repeated in one reply', () => {
  const call = { name: 'bash', arguments: { command: 'ls' } };
  const text = `<tool_call>${JSON.stringify({ calls: [call, call] })}</tool_call>`;
  const result = interpretToolResponse(text, tools, { allowedNames });
  assert.equal(result.calls.length, 1);
  assert.equal(result.needsRepair, false);
});

test('parses DeepSeek V3 special-token calls', () => {
  const text = [
    '<\uFF5Ctool\u2581call\u2581begin\uFF5C>bash',
    '<\uFF5Ctool\u2581sep\uFF5C>{"command":"ls"}',
    '<\uFF5Ctool\u2581call\u2581end\uFF5C>',
  ].join('');
  const result = parse(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
  assert.equal(result.calls[0].argumentsText, '{"command":"ls"}');
  assert.equal(result.content, '');
});

test('parses a fenced call and keeps the surrounding prose', () => {
  const text = [
    'Let me check.',
    '```json',
    '{"name":"bash","arguments":{"command":"ls"}}',
    '```',
  ].join('\n');
  const result = parse(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
  assert.equal(result.content, 'Let me check.');
});

test('does not execute a bare JSON answer with an unknown tool', () => {
  const result = parse('{"name":"nope","arguments":{"command":"ls"}}');
  assert.equal(result.calls.length, 0);
  assert.equal(result.invalidCalls.length, 0);
  assert.equal(result.content, '{"name":"nope","arguments":{"command":"ls"}}');
});

test('keeps a prose mention of tool_call tags', () => {
  const text = 'Use <tool_call> tags in your reply.';
  const result = parse(text);
  assert.equal(result.calls.length, 0);
  assert.equal(result.invalidCalls.length, 0);
  assert.equal(result.content, text);
});

test('reports a cut-off call only when the stream was truncated', () => {
  const text = '<tool_call>{"command":"echo';
  const truncated = parse(text, { truncated: true });
  assert.equal(truncated.calls.length, 0);
  assert.deepEqual(truncated.invalidCalls, [{ name: null, reason: 'truncated_call' }]);
});

test('holds a tool block split across every character until the stream ends', () => {
  const filter = new ToolCallStreamFilter();
  const text = '<tool_call>{"command":"ls"}</tool_call>tail';
  let visible = '';
  for (const char of text) visible += filter.push(char);
  const held = filter.takeHeld();
  assert.equal(visible, '');
  assert.equal(held.blocks, text);
  assert.equal(held.pending, '');
});

test('does not release a block at a closing tag inside a JSON string', () => {
  const filter = new ToolCallStreamFilter();
  const text = '<tool_call>{"command":"echo \'</tool_call>\'"}</tool_call>tail';
  let visible = '';
  for (const char of text) visible += filter.push(char);
  const held = filter.takeHeld();
  assert.equal(visible, '');
  assert.equal(held.blocks, text);
  assert.equal(held.pending, '');
});

test('splitAtToolMarker strips leading think blocks', () => {
  const text =
    '<think>plan</think>Before <tool_call>{"command":"ls"}</tool_call> After';
  assert.deepEqual(splitAtToolMarker(text), { before: 'Before ', found: true });
  assert.deepEqual(splitAtToolMarker('<thinking>x</thinking>plain'), {
    before: 'plain',
    found: false,
  });
});

test('shares a single workdir with every call packed in one invoke', () => {
  const text = [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">ls</${BAR}DSML${BAR} parameter>`,
    `<${BAR}DSML${BAR} parameter name="workdir" string="true">/tmp/out</${BAR}DSML${BAR} parameter>`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">pwd</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
  const result = parse(text);
  assert.deepEqual(
    result.calls.map((call) => call.arguments),
    [
      { command: 'ls', workdir: '/tmp/out' },
      { command: 'pwd', workdir: '/tmp/out' },
    ],
  );
});

test('groups a repeated DSML parameter declared as an array', () => {
  const search = {
    name: 'search',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        terms: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
  };
  const text = [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="search">`,
    `<${BAR}DSML${BAR} parameter name="query" string="true">x</${BAR}DSML${BAR} parameter>`,
    `<${BAR}DSML${BAR} parameter name="terms" string="false">"a"</${BAR}DSML${BAR} parameter>`,
    `<${BAR}DSML${BAR} parameter name="terms" string="false">"b"</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
  const parsed = parseToolResponse(text, [search], { allowedNames: new Set(['search']) });
  const [call] = sanitizeToolCalls(parsed.calls, [search]);
  assert.deepEqual(call.arguments, { query: 'x', terms: ['a', 'b'] });
});

test('keeps every streamed block when a second block arrives later', () => {
  const filter = new ToolCallStreamFilter();
  const first = '<tool_call>{"command":"ls"}</tool_call>';
  const second = '<tool_call>{"command":"pwd"}</tool_call>';
  let visible = '';
  visible += filter.push(first);
  visible += filter.push('\n');
  visible += filter.push(second);
  visible += filter.push('\ntail');
  const held = filter.takeHeld();
  assert.equal(visible, '');
  assert.equal(held.blocks, `${first}\n${second}\ntail`);
  const parsed = parse(held.blocks);
  assert.deepEqual(
    parsed.calls.map((call) => call.arguments.command),
    ['ls', 'pwd'],
  );
});

test('holds V3 special tokens including calls_end', () => {
  const text = [
    '<\uFF5Ctool\u2581calls\u2581begin\uFF5C>',
    '<\uFF5Ctool\u2581call\u2581begin\uFF5C>bash',
    '<\uFF5Ctool\u2581sep\uFF5C>{"command":"ls"}',
    '<\uFF5Ctool\u2581call\u2581end\uFF5C>',
    '<\uFF5Ctool\u2581calls\u2581end\uFF5C>',
    'tail',
  ].join('');
  const filter = new ToolCallStreamFilter();
  let visible = '';
  for (const char of text) visible += filter.push(char);
  const held = filter.takeHeld();
  assert.equal(visible, '');
  assert.equal(held.blocks, text);
  const parsed = parse(held.blocks);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, 'bash');
});

test('parses function_call and tool_use wrappers', () => {
  const functionCall = parse(
    '<function_call>{"name":"bash","arguments":{"command":"ls"}}</function_call>',
  );
  assert.equal(functionCall.calls.length, 1);
  assert.equal(functionCall.calls[0].name, 'bash');

  const toolUse = parse('<tool_use>{"name":"read","arguments":{"filePath":"/tmp/a"}}</tool_use>');
  assert.equal(toolUse.calls.length, 1);
  assert.equal(toolUse.calls[0].name, 'read');
});

test('parses a fenced or named body inside tool_call', () => {
  const fenced = parse(
    '<tool_call>\n```json\n{"name":"bash","arguments":{"command":"ls"}}\n```\n</tool_call>',
  );
  assert.equal(fenced.calls.length, 1);
  assert.equal(fenced.content, '');

  const named = parse('<tool_call>bash\n{"command":"pwd"}</tool_call>');
  assert.equal(named.calls.length, 1);
  assert.equal(named.calls[0].name, 'bash');
  assert.deepEqual(named.calls[0].arguments, { command: 'pwd' });
});

test('removes a fence surrounding the whole tool block', () => {
  const text = [
    'Checking.',
    '```xml',
    '<tool_call>{"command":"ls"}</tool_call>',
    '```',
    'Done',
  ].join('\n');
  const result = parse(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.content, 'Checking.\nDone');
});

test('streaming and non-streaming agree for every chunking', () => {
  const samples = [
    '<tool_call>{"command":"ls"}</tool_call>',
    '<tool_call>{"command":"ls"}</tool_call>\n<tool_call>{"command":"pwd"}</tool_call>',
    `before <${BAR}DSML${BAR}calls><${BAR}DSML${BAR}invoke name="bash"><${BAR}DSML${BAR}parameter name="command" string="true">ls</${BAR}DSML${BAR}parameter></${BAR}DSML${BAR}invoke></${BAR}DSML${BAR}calls> after`,
    '<function_call>{"name":"read","arguments":{"filePath":"/tmp/a"}}</function_call>',
    'Use <tool_call> tags in your reply.',
  ];
  const shape = (result) =>
    result.calls.map((call) => ({ name: call.name, arguments: call.arguments }));

  for (const text of samples) {
    const expected = shape(parse(text));
    for (const size of [1, 2, 5, 13, text.length]) {
      const filter = new ToolCallStreamFilter();
      let visible = '';
      for (let index = 0; index < text.length; index += size) {
        visible += filter.push(text.slice(index, index + size));
      }
      const held = filter.takeHeld();
      const streamed = shape(parse(visible + held.blocks + held.pending));
      assert.deepEqual(streamed, expected, `chunk size ${size}: ${text.slice(0, 30)}`);
    }
  }
});

test('does not auto-rename a typo or synonym before a repair round-trip', () => {
  const typo = parse('<tool_call>{"name":"bsah","arguments":{"command":"ls"}}</tool_call>');
  assert.equal(typo.calls.length, 0);
  assert.equal(typo.invalidCalls[0].reason, 'unknown_tool');
  assert.deepEqual(typo.invalidCalls[0].suggestions, ['bash']);

  const synonym = parse(
    '<tool_call>{"name":"execute_bash","arguments":{"command":"pwd"}}</tool_call>',
  );
  assert.equal(synonym.calls.length, 0);
  assert.equal(synonym.invalidCalls[0].reason, 'unknown_tool');
  assert.deepEqual(synonym.invalidCalls[0].suggestions, ['bash']);
});

test('does not infer a lone all-optional tool from unrelated JSON', () => {
  const echo = {
    name: 'echo',
    description: '',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
    },
  };
  const result = parseToolResponse('<tool_call>{"result":"all good"}</tool_call>', [echo], {
    allowedNames: new Set(['echo']),
  });
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.invalidCalls, [{ name: null, reason: 'missing_name' }]);
});

test('does not guess an unrelated argument name', () => {
  const result = parse('<tool_call>{"code":"print(1)"}</tool_call>');
  assert.equal(result.calls.length, 0);
  assert.equal(result.invalidCalls[0].reason, 'missing_name');
});

test('coerces anyOf values without turning a string into a number', () => {
  const tool = {
    name: 'note',
    description: '',
    parameters: {
      type: 'object',
      properties: { text: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['text'],
    },
  };
  const parsed = parseToolResponse(
    '<tool_call>{"name":"note","arguments":{"text":42}}</tool_call>',
    [tool],
    { allowedNames: new Set(['note']) },
  );
  const [call] = sanitizeToolCalls(parsed.calls, [tool]);
  assert.equal(call.arguments.text, '42');
});


test('replays tool history as parseable DSML', () => {
  const text = formatToolCallsForTranscript([
    { id: 'call_1', function: { name: 'bash', arguments: '{"command":"ls","timeout":5}' } },
  ]);
  assert.match(text, new RegExp(`^<${BAR}DSML${BAR}calls>`));
  assert.doesNotMatch(text, /"calls"/);
  const parsed = parse(text);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, 'bash');
  assert.deepEqual(parsed.calls[0].arguments, { command: 'ls', timeout: 5 });
});

test('DSML history stays parseable when a value contains a closing tag', () => {
  const text = formatToolCallsForTranscript([
    {
      function: {
        name: 'bash',
        arguments: { command: `printf '</${BAR}DSML${BAR}parameter>'` },
      },
    },
  ]);
  assert.doesNotMatch(text, /printf '</);
  const parsed = parse(text);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].arguments.command, `printf '</${BAR}DSML${BAR}parameter>'`);
});

test('infers a lone tool whose parameter is named name', () => {
  const setName = {
    name: 'set_name',
    description: '',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  };
  const parsed = parseToolResponse('<tool_call>{"name":"alice"}</tool_call>', [setName], {
    allowedNames: new Set(['set_name']),
  });
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, 'set_name');
  assert.deepEqual(parsed.calls[0].arguments, { name: 'alice' });
});

test('holds a fenced tool block without leaking the fence opener', () => {
  const filter = new ToolCallStreamFilter();
  assert.equal(filter.push('Before\n```xml\n<tool_'), 'Before\n');
  assert.equal(filter.push('call>{"command":"ls"}</tool_call>\n```\nAfter'), '');
  const held = filter.takeHeld();
  assert.equal(held.blocks, '```xml\n<tool_call>{"command":"ls"}</tool_call>\n```\nAfter');
  assert.equal(held.pending, '');
  const parsed = parse(held.blocks);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].arguments.command, 'ls');
});
