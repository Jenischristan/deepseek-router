import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ToolCallStreamFilter,
  buildToolInstructions,
  parseToolResponse,
  formatToolResultPrompt,
  sanitizeToolCalls,
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
    `<${BAR}${BAR}DSML${BAR}${BAR} calls>`,
    `<${BAR}${BAR}DSML${BAR}${BAR} invoke name="bash">`,
    `<${BAR}${BAR}DSML${BAR}${BAR} parameter name="command" string="true">ls</${BAR}${BAR}DSML${BAR}${BAR} parameter>`,
    `</${BAR}${BAR}DSML${BAR}${BAR} invoke>`,
    `</${BAR}${BAR}DSML${BAR}${BAR} calls>`,
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
  assert.equal(visible.trim(), 'Hello  done');
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

test('strips orphan and cut-off markers from content', () => {
  const result = parse(`hello </${BAR}DSML${BAR} calls> world <${BAR}DSML${BAR} invoke`);
  assert.equal(result.calls.length, 0);
  assert.equal(result.content, 'hello  world');
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
