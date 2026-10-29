import assert from 'node:assert/strict';
import test from 'node:test';

import {
  looseJsonParse,
  parseLooseValues,
  scanJsonValue,
  stableStringify,
  tryParse,
  messageContentText,
  normalizeTools,
  normalizeToolChoice,
  toolChoiceMode,
  toolSignature,
  makeToolCallId,
} from '../src/openai/json.js';
import {
  normalizeIdentifier,
  alignArguments,
  coerceSchemaValue,
  coerceSchemaObject,
  validateArguments,
  describeType,
  describeValueType,
  resolveToolName,
  rankToolNames,
  damerauDistance,
  findProperty,
  schemaTypes,
  primaryType,
  valueMatchesType,
  matchesSchemaType,
  tryEnumMatch,
  shellQuote,
  groupBy,
} from '../src/openai/schema.js';
import { sanitizeToolCalls, validateToolCalls } from '../src/openai/sanitize.js';
import { parseToolResponse, interpretToolResponse } from '../src/openai/parse.js';
import { extractDsml, extractV3Tokens, extractCalls } from '../src/openai/extract.js';

// Parser / schema hardening
// ===========================================================================
// Targets JSON repair, the DSML walker, V3 tokens, schema alignment/coercion,
// sanitisation and payload envelopes with hostile inputs.

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
    properties: { path: { type: 'string' }, limit: { type: 'integer' } },
    required: ['path'],
  },
};

const tools = [bash, read];

function dsml(name, params, { calls = true } = {}) {
  const body = params
    .map(
      ([key, value, string = true]) =>
        `<${BAR}DSML${BAR}parameter name="${key}" string="${string}">${value}</${BAR}DSML${BAR}parameter>`,
    )
    .join('\n');
  const invoke = `<${BAR}DSML${BAR}invoke name="${name}">\n${body}\n</${BAR}DSML${BAR}invoke>`;
  return calls ? `<${BAR}DSML${BAR}calls>\n${invoke}\n</${BAR}DSML${BAR}calls>` : invoke;
}

// ---------------------------------------------------------------------------
// Loose JSON repair
// ---------------------------------------------------------------------------

test('json: classic model-JSON defects are repaired and flagged', () => {
  const cases = [
    ["{'a':1}", { a: 1 }],
    ['{"a":1,}', { a: 1 }],
    ['{"a":1 "b":2}', { a: 1, b: 2 }],
    ['{a:1}', { a: 1 }],
    ['{"a":"x" "b":"y"}', { a: 'x', b: 'y' }],
    ['[1,2,]', [1, 2]],
    ['{"a":[1,2,],"b":{}}', { a: [1, 2], b: {} }],
  ];
  for (const [input, expected] of cases) {
    const parsed = looseJsonParse(input);
    assert.equal(parsed.ok, true, input);
    assert.deepEqual(parsed.value, expected, input);
    assert.equal(parsed.repaired, true, `${input} should be flagged as repaired`);
  }
});

test('json: valid JSON is not flagged as repaired', () => {
  const parsed = looseJsonParse('{"a":1}');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.repaired, undefined);
});

test('json: unfixable input fails cleanly', () => {
  for (const input of ['{"a":tru}', 'not json', '', 'nul', '{"a" 1 2 3']) {
    assert.equal(looseJsonParse(input).ok, false, input);
  }
});

test('json: truncated objects are closed instead of rejected', () => {
  assert.deepEqual(looseJsonParse('{'), { ok: true, value: {}, repaired: true });
  assert.deepEqual(looseJsonParse('{"a":'), { ok: true, value: { a: null }, repaired: true });
  assert.deepEqual(looseJsonParse('{"a":[1,2'), {
    ok: true,
    value: { a: [1, 2] },
    repaired: true,
  });
});

test('json: escaped quotes and backslashes survive repair', () => {
  const parsed = looseJsonParse('{"a":"he said \\"hi\\"","b":"c:\\\\tmp"}');
  assert.deepEqual(parsed.value, { a: 'he said "hi"', b: 'c:\\tmp' });
});

test('json: scanJsonValue tracks strings, escapes and nesting', () => {
  assert.equal(scanJsonValue('{"a":1}', 0), 7);
  assert.equal(scanJsonValue('[1,[2,3]]', 0), 9);
  assert.equal(scanJsonValue('{"a":"}"}', 0), 9, 'a brace inside a string must not close');
  assert.equal(scanJsonValue('{"a":"\\"}"}', 0), 11, 'escaped quote must not open/close');
  assert.equal(scanJsonValue('{"a":[1', 0), -1);
  assert.equal(scanJsonValue(']', 0), -1);
});

test('json: parseLooseValues recovers every object from a polluted run', () => {
  const values = parseLooseValues('}} {"a":1} , garbage {"b":2} ] {"c":3}');
  assert.deepEqual(values, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('json: parseLooseValues stops at a truncated object', () => {
  assert.deepEqual(parseLooseValues('{"a":1} {"b":'), [{ a: 1 }]);
});

test('json: stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(
    stableStringify({ z: [{ y: 1, x: 2 }] }),
    stableStringify({ z: [{ x: 2, y: 1 }] }),
  );
  assert.notEqual(stableStringify({ a: [1, 2] }), stableStringify({ a: [2, 1] }));
});

test('json: tryParse never repairs', () => {
  assert.equal(tryParse('{"a":1}').ok, true);
  assert.equal(tryParse('{"a":1,}').ok, false);
});

test('json: messageContentText flattens parts and hides base64', () => {
  const text = messageContentText([
    { type: 'text', text: 'hi' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET' } },
    { type: 'text', text: 'there' },
  ]);
  assert.equal(text, 'hi\n[Image attachment]\nthere');
  assert.doesNotMatch(text, /SECRET/);
  assert.equal(messageContentText(42), '42');
  assert.equal(messageContentText(null), '');
});

test('json: normalizeTools dedupes across tools/functions and defaults parameters', () => {
  const list = normalizeTools({
    tools: [{ type: 'function', function: { name: 'a' } }, { function: { name: 'a' } }, null],
    functions: [{ name: 'a' }, { name: 'b' }],
  });
  assert.deepEqual(list.map((tool) => tool.name), ['a', 'b']);
  assert.deepEqual(list[0].parameters, { type: 'object', properties: {} });
});

test('json: toolChoiceMode normalises every accepted shape', () => {
  assert.deepEqual(toolChoiceMode('auto'), { mode: 'auto' });
  assert.deepEqual(toolChoiceMode('none'), { mode: 'none' });
  assert.deepEqual(toolChoiceMode('required'), { mode: 'required' });
  assert.deepEqual(toolChoiceMode('any'), { mode: 'required' });
  assert.deepEqual(toolChoiceMode({ function: { name: ' bash ' } }), {
    mode: 'function',
    name: 'bash',
  });
  assert.deepEqual(toolChoiceMode({ name: 'read' }), { mode: 'function', name: 'read' });
  assert.deepEqual(toolChoiceMode({ function: { name: '   ' } }), { mode: 'auto' });
  assert.deepEqual(toolChoiceMode(undefined), { mode: 'auto' });
});

test('json: normalizeToolChoice prefers tool_choice over legacy function_call', () => {
  assert.equal(normalizeToolChoice({ tool_choice: 'none', function_call: 'auto' }), 'none');
  assert.equal(normalizeToolChoice({ function_call: 'auto' }), 'auto');
  assert.equal(normalizeToolChoice({}), 'auto');
});

test('json: toolSignature reacts to tools, choice, parallel flag and key order', () => {
  const base = toolSignature(tools, 'auto', true);
  assert.equal(base, toolSignature(tools, 'auto', true));
  assert.notEqual(base, toolSignature(tools, 'required', true));
  assert.notEqual(base, toolSignature(tools, 'auto', false));
  assert.notEqual(base, toolSignature(tools.slice(0, 1), 'auto', true));
  const reordered = [
    {
      ...bash,
      parameters: {
        ...bash.parameters,
        properties: {
          timeout: bash.parameters.properties.timeout,
          workdir: bash.parameters.properties.workdir,
          command: bash.parameters.properties.command,
        },
      },
    },
    read,
  ];
  assert.equal(base, toolSignature(reordered, 'auto', true));
});

test('json: makeToolCallId is unique and prefixed', () => {
  const ids = new Set(Array.from({ length: 200 }, () => makeToolCallId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^call_/);
});

// ---------------------------------------------------------------------------
// Schema primitives
// ---------------------------------------------------------------------------

test('schema: normalizeIdentifier strips every non-alphanumeric and lowercases', () => {
  assert.equal(normalizeIdentifier('File_Path'), 'filepath');
  assert.equal(normalizeIdentifier('  A-b.c/d  '), 'abcd');
  assert.equal(normalizeIdentifier(null), '');
  assert.equal(normalizeIdentifier(123), '123');
});

test('schema: schemaTypes/primaryType expand anyOf and prefer non-null', () => {
  assert.deepEqual(schemaTypes({ type: 'string' }), ['string']);
  assert.deepEqual(schemaTypes({ anyOf: [{ type: 'string' }, { type: 'null' }] }), [
    'string',
    'null',
  ]);
  assert.equal(primaryType({ anyOf: [{ type: 'null' }, { type: 'integer' }] }), 'integer');
  assert.equal(primaryType({}), null);
});

test('schema: valueMatchesType is exact for number vs integer', () => {
  assert.equal(valueMatchesType(1, 'integer'), true);
  assert.equal(valueMatchesType(1.5, 'integer'), false);
  assert.equal(valueMatchesType(1.5, 'number'), true);
  assert.equal(valueMatchesType(NaN, 'number'), false);
  assert.equal(valueMatchesType(Infinity, 'number'), false);
  assert.equal(valueMatchesType([], 'object'), false);
  assert.equal(valueMatchesType({}, 'object'), true);
  assert.equal(valueMatchesType(null, 'null'), true);
});

test('schema: matchesSchemaType accepts union members and unknown types', () => {
  assert.equal(matchesSchemaType('x', { type: ['string', 'number'] }), true);
  assert.equal(matchesSchemaType(1, { type: ['string', 'number'] }), true);
  assert.equal(matchesSchemaType({}, { type: ['string', 'number'] }), false);
  assert.equal(matchesSchemaType('anything', {}), true);
});

test('schema: tryEnumMatch is case/punctuation insensitive but never guesses ties', () => {
  assert.equal(tryEnumMatch('READ', { enum: ['read', 'write'] }), 'read');
  assert.equal(tryEnumMatch('re-ad', { enum: ['read', 'write'] }), 'read');
  assert.equal(tryEnumMatch('raed', { enum: ['read', 'write'] }), 'raed');
  assert.equal(tryEnumMatch('read', { enum: ['read', 're_ad'] }), 'read');
});

test('schema: describeType renders arrays, objects, enums and depth limits', () => {
  assert.equal(describeType({ type: 'array', items: { type: 'string' } }), 'string[]');
  assert.equal(
    describeType({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } }),
    '(string | number)[]',
  );
  assert.equal(describeType({ enum: ['a', 'b'] }), '"a" | "b"');
  assert.equal(describeType({ const: 7 }), '7');
  assert.equal(
    describeType({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }),
    '{ a: string }',
  );
  assert.equal(
    describeType({ type: 'object', properties: { a: { type: 'string' } } }, { objects: false }),
    'object',
  );
});

test('schema: describeValueType names integer separately from number', () => {
  assert.equal(describeValueType(1), 'integer');
  assert.equal(describeValueType(1.5), 'number');
  assert.equal(describeValueType([]), 'array');
  assert.equal(describeValueType(null), 'null');
  assert.equal(describeValueType(true), 'boolean');
});

test('schema: shellQuote survives single quotes', () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote('plain/path.txt'), "'plain/path.txt'");
});

test('schema: damerauDistance counts transposition as one edit', () => {
  assert.equal(damerauDistance('bash', 'bash'), 0);
  assert.equal(damerauDistance('bsah', 'bash'), 1);
  assert.equal(damerauDistance('bsh', 'bash'), 1);
  assert.equal(damerauDistance('read', 'write'), 4);
  assert.equal(damerauDistance('', 'abc'), 3);
  assert.equal(damerauDistance('abc', ''), 3);
});

test('schema: findProperty refuses ambiguous direct matches', () => {
  assert.equal(findProperty('foo', { foo: {}, FOO: {} }, {}), null);
  assert.equal(findProperty('foo', { foo: {} }, {}), 'foo');
  assert.equal(findProperty('filePath', { path: {} }, {}), 'path');
  assert.equal(findProperty('path', { path: {}, filePath: {} }, { path: 1 }), 'filePath');
});

test('schema: groupBy preserves insertion order of first appearance', () => {
  const grouped = groupBy(['aa', 'b', 'cc', 'd'], (item) => item.length);
  assert.deepEqual([...grouped.keys()], [2, 1]);
  assert.deepEqual(grouped.get(2), ['aa', 'cc']);
});

// ---------------------------------------------------------------------------
// Argument alignment and coercion
// ---------------------------------------------------------------------------

test('coerce: integer rounding, boolean words, and string forms', () => {
  assert.equal(coerceSchemaValue(2.6, { type: 'integer' }), 3);
  assert.equal(coerceSchemaValue('7', { type: 'integer' }), 7);
  assert.equal(coerceSchemaValue('7.9', { type: 'number' }), 7.9);
  assert.equal(coerceSchemaValue(true, { type: 'integer' }), 1);
  assert.equal(coerceSchemaValue('yes', { type: 'boolean' }), true);
  assert.equal(coerceSchemaValue('no', { type: 'boolean' }), false);
  assert.equal(coerceSchemaValue(1, { type: 'boolean' }), true);
  assert.equal(coerceSchemaValue(0, { type: 'boolean' }), false);
  assert.equal(coerceSchemaValue(12, { type: 'string' }), '12');
  assert.equal(coerceSchemaValue(false, { type: 'string' }), 'false');
});

test('coerce: argv arrays become shell strings only for command-like keys', () => {
  assert.equal(coerceSchemaValue(['ls', '-la'], { type: 'string' }, 'command'), 'ls -la');
  assert.equal(coerceSchemaValue(['a b', 'c'], { type: 'string' }, 'command'), "'a b' c");
  assert.equal(coerceSchemaValue(['a', 'b'], { type: 'string' }, 'content'), 'a\nb');
});

test('coerce: object strings are parsed, array strings split, scalars wrapped', () => {
  assert.deepEqual(coerceSchemaValue('{"a":1}', { type: 'object' }), { a: 1 });
  assert.deepEqual(coerceSchemaValue('{"a":1,}', { type: 'object' }), { a: 1 });
  assert.deepEqual(coerceSchemaValue('[1,2]', { type: 'array', items: { type: 'integer' } }), [
    1,
    2,
  ]);
  assert.deepEqual(coerceSchemaValue('x', { type: 'array', items: { type: 'string' } }), ['x']);
});

test('coerce: anyOf prefers a matching variant without string-to-number damage', () => {
  assert.equal(coerceSchemaValue('5', { anyOf: [{ type: 'string' }, { type: 'integer' }] }), '5');
  assert.equal(coerceSchemaValue(5, { anyOf: [{ type: 'null' }, { type: 'integer' }] }), 5);
});

test('coerce: nested containers are coerced element-wise', () => {
  const schema = {
    type: 'object',
    properties: {
      list: {
        type: 'array',
        items: { type: 'object', properties: { n: { type: 'number' } } },
      },
    },
  };
  assert.deepEqual(coerceSchemaObject({ list: [{ n: '1' }, { n: '2' }] }, schema), {
    list: [{ n: 1 }, { n: 2 }],
  });
});

test('align: close typos map, unrelated names never do', () => {
  const schema = { properties: { command: { type: 'string' } }, required: ['command'] };
  assert.deepEqual(alignArguments({ comand: 'ls' }, schema).args, { command: 'ls' });
  assert.deepEqual(alignArguments({ code: 'ls' }, schema).args, { code: 'ls' });
});

test('align: aliases map even without a typo (file -> path)', () => {
  const schema = { properties: { path: { type: 'string' } }, required: ['path'] };
  const aligned = alignArguments({ file: '/etc/hosts' }, schema);
  assert.deepEqual(aligned.args, { path: '/etc/hosts' });
  assert.deepEqual(aligned.missing, []);
});

test('align: guess=false disables the single-missing repair', () => {
  const schema = { properties: { command: { type: 'string' } }, required: ['command'] };
  const aligned = alignArguments({ comand: 'ls' }, schema, { guess: false });
  assert.deepEqual(aligned.args, { comand: 'ls' });
  assert.deepEqual(aligned.missing, ['command']);
});

test('align: additionalProperties=false drops leftovers instead of forwarding them', () => {
  const schema = {
    properties: { command: { type: 'string' } },
    required: ['command'],
    additionalProperties: false,
  };
  const aligned = alignArguments({ command: 'ls', junk: 1 }, schema);
  assert.deepEqual(aligned.args, { command: 'ls' });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validate: reports missing, unknown, wrong type and enum in one pass', () => {
  const schema = {
    type: 'object',
    properties: {
      command: { type: 'string' },
      n: { type: 'integer' },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
    required: ['command', 'n'],
    additionalProperties: false,
  };
  const problems = validateArguments({ n: '1.5', mode: 'c', extra: true }, schema);
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('missing required parameter "command"')));
  assert.ok(problems.some((p) => p.includes('"n" must be integer')));
  assert.ok(problems.some((p) => p.includes('"mode" must be one of')));
  assert.ok(problems.some((p) => p.includes('unknown parameter "extra"')));
});

test('validate: descends into array items with path labels', () => {
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          required: ['id'],
        },
      },
    },
  };
  const problems = validateArguments({ items: [{ id: 1 }, { id: 'x' }] }, schema);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /items\[1\]\.id/);
});

test('validate: null optional values are allowed but null required ones are not', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  assert.equal(validateArguments({ a: null }, schema).length, 1);
});

test('validate: non-object arguments yield a single clear problem', () => {
  assert.deepEqual(validateArguments([], { type: 'object' }), ['arguments must be a JSON object']);
});

// ---------------------------------------------------------------------------
// sanitizeToolCalls
// ---------------------------------------------------------------------------

test('sanitize: unwraps a nested arguments envelope and keeps sibling keys', () => {
  const calls = [
    {
      name: 'bash',
      arguments: { arguments: '{"command":"ls"}', extra: 1 },
      argumentsText: '{"arguments":"{\\"command\\":\\"ls\\"}","extra":1}',
    },
  ];
  const [call] = sanitizeToolCalls(calls, tools);
  assert.deepEqual(call.arguments, { command: 'ls', extra: 1 });
});

test('sanitize: folds workdir into command when the schema has no workdir', () => {
  const schema = [
    {
      name: 'run',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  ];
  const [call] = sanitizeToolCalls(
    [{ name: 'run', arguments: { command: 'ls', workdir: '/tmp' }, argumentsText: '{}' }],
    schema,
  );
  assert.deepEqual(call.arguments, { command: "cd '/tmp' && ls" });
});

test('sanitize: does not fold when the command already cds', () => {
  const schema = [
    { name: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  ];
  const [call] = sanitizeToolCalls(
    [{ name: 'run', arguments: { command: 'cd /a && ls', cwd: '/tmp' }, argumentsText: '{}' }],
    schema,
  );
  assert.equal(call.arguments.command, 'cd /a && ls');
  assert.equal(call.arguments.cwd, undefined, 'cwd key is still removed');
});

test('sanitize: unchanged calls are returned as-is, changed ones get new text', () => {
  const call = { name: 'bash', arguments: { command: 'ls' }, argumentsText: '{"command":"ls"}' };
  const [same] = sanitizeToolCalls([call], tools);
  assert.equal(same, call);

  const [changed] = sanitizeToolCalls(
    [{ name: 'bash', arguments: { command: 5 }, argumentsText: '{"command":5}' }],
    tools,
  );
  assert.deepEqual(changed.arguments, { command: '5' });
  assert.equal(changed.argumentsText, '{"command":"5"}');
});

test('validateToolCalls: only reports known tools that have problems', () => {
  const results = validateToolCalls(
    [
      { name: 'bash', arguments: { command: 'ls' } },
      { name: 'bash', arguments: {} },
      { name: 'unknown', arguments: {} },
    ],
    tools,
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].index, 1);
  assert.equal(results[0].name, 'bash');
});

// ---------------------------------------------------------------------------
// DSML extraction edge cases
// ---------------------------------------------------------------------------

test('dsml: prose mention is not a call and stays visible', () => {
  const result = parseToolResponse(`Use <${BAR}DSML${BAR}invoke to call tools`, tools);
  assert.equal(result.calls.length, 0);
  assert.equal(result.invalidCalls.length, 0);
  assert.match(result.content, /Use/);
});

test('dsml: an empty calls wrapper with no invoke is left untouched', () => {
  const text = `<${BAR}DSML${BAR}calls></${BAR}DSML${BAR}calls>`;
  const { calls, content } = extractDsml(text, { tools });
  assert.equal(calls.length, 0);
  assert.equal(content, text);
});

test('dsml: literal nested parameter tags inside a value survive verbatim', () => {
  const inner = `<${BAR}DSML${BAR}parameter name="x">y</${BAR}DSML${BAR}parameter>`;
  const result = parseToolResponse(dsml('bash', [['command', `echo ${inner}`]]), tools);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].arguments.command, `echo ${inner}`);
});

test('dsml: string="false" numbers are parsed, not stringified', () => {
  const text = [
    `<${BAR}DSML${BAR}calls>`,
    `<${BAR}DSML${BAR}invoke name="bash">`,
    `<${BAR}DSML${BAR}parameter name="command" string="true">ls</${BAR}DSML${BAR}parameter>`,
    `<${BAR}DSML${BAR}parameter name="timeout" string="false">5000</${BAR}DSML${BAR}parameter>`,
    `</${BAR}DSML${BAR}invoke>`,
    `</${BAR}DSML${BAR}calls>`,
  ].join('\n');
  const result = parseToolResponse(text, tools);
  assert.deepEqual(result.calls[0].arguments, { command: 'ls', timeout: 5000 });
});

test('dsml: a missing invoke close tag still recovers the following invoke', () => {
  const text = [
    `<${BAR}DSML${BAR}calls>`,
    `<${BAR}DSML${BAR}invoke name="bash">`,
    `<${BAR}DSML${BAR}parameter name="command" string="true">one</${BAR}DSML${BAR}parameter>`,
    `<${BAR}DSML${BAR}invoke name="read">`,
    `<${BAR}DSML${BAR}parameter name="path" string="true">two.txt</${BAR}DSML${BAR}parameter>`,
    `</${BAR}DSML${BAR}invoke>`,
    `</${BAR}DSML${BAR}calls>`,
  ].join('\n');
  const result = parseToolResponse(text, tools);
  assert.deepEqual(
    result.calls.map((call) => [call.name, call.arguments]),
    [
      ['bash', { command: 'one' }],
      ['read', { path: 'two.txt' }],
    ],
  );
});

test('dsml: duplicate identical calls are collapsed by interpretToolResponse', () => {
  const block = dsml('bash', [['command', 'ls']], { calls: false });
  const text = `<${BAR}DSML${BAR}calls>\n${block}\n${block}\n</${BAR}DSML${BAR}calls>`;
  assert.equal(parseToolResponse(text, tools).calls.length, 2);
  assert.equal(interpretToolResponse(text, tools).calls.length, 1);
});

test('dsml: markup is fully stripped from the visible content', () => {
  const text = `before ${dsml('bash', [['command', 'ls']])} after`;
  const result = parseToolResponse(text, tools);
  assert.equal(result.content, 'before  after');
  assert.doesNotMatch(result.content, /DSML|invoke|parameter/);
});

// ---------------------------------------------------------------------------
// DeepSeek V3 special tokens
// ---------------------------------------------------------------------------

test('v3: simple name<sep>json form is parsed', () => {
  const text = `<${BAR}tool▁call▁begin${BAR}>bash<${BAR}tool▁sep${BAR}>{"command":"ls"}<${BAR}tool▁call▁end${BAR}>`;
  const { calls } = extractV3Tokens(text);
  assert.deepEqual(calls.map((call) => [call.name, call.arguments]), [['bash', { command: 'ls' }]]);
});

test('v3: "function" prefix and fenced JSON are handled', () => {
  const text =
    `<${BAR}tool▁call▁begin${BAR}>function<${BAR}tool▁sep${BAR}>bash\n` +
    '```json\n{"command":"ls"}\n```' +
    `<${BAR}tool▁call▁end${BAR}>`;
  const { calls } = extractV3Tokens(text);
  assert.deepEqual(calls.map((call) => [call.name, call.arguments]), [['bash', { command: 'ls' }]]);
});

test('v3: unterminated call is a truncation only when the reply is truncated', () => {
  const text = `<${BAR}tool▁call▁begin${BAR}>bash<${BAR}tool▁sep${BAR}>{"command":"ls"`;
  assert.deepEqual(extractV3Tokens(text, {}).invalid, []);
  assert.deepEqual(
    extractV3Tokens(text, { truncated: true }).invalid.map((item) => item.reason),
    ['truncated_call'],
  );
});

test('v3: a name with no JSON arguments is invalid_arguments, not an empty call', () => {
  const text = `<${BAR}tool▁call▁begin${BAR}>bash<${BAR}tool▁sep${BAR}>just text<${BAR}tool▁call▁end${BAR}>`;
  const result = extractV3Tokens(text, {});
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.invalid.map((item) => item.reason), ['invalid_arguments']);
});

test('v3: text without the token pattern is passed through untouched', () => {
  const text = 'plain answer with {json} inside';
  assert.deepEqual(extractV3Tokens(text), { calls: [], content: text, invalid: [] });
});

// ---------------------------------------------------------------------------
// extractCalls envelope shapes
// ---------------------------------------------------------------------------

test('extract: OpenAI nested function envelope', () => {
  const calls = extractCalls({
    type: 'function',
    function: { name: 'bash', arguments: '{"command":"ls"}' },
  });
  assert.deepEqual(calls.map((call) => [call.name, call.arguments]), [['bash', { command: 'ls' }]]);
});

test('extract: flat name + sibling keys keeps the remaining keys as args', () => {
  const calls = extractCalls({ name: 'bash', command: 'ls', timeout: 5 }, { tools });
  assert.deepEqual(calls[0].arguments, { command: 'ls', timeout: 5 });
  assert.equal(calls[0].argumentsText, '{"command":"ls","timeout":5}');
});

test('extract: tool_calls / calls / tool_uses arrays fan out in order', () => {
  for (const key of ['tool_calls', 'calls', 'tool_uses']) {
    const calls = extractCalls({
      [key]: [
        { name: 'bash', arguments: { command: 'a' } },
        { name: 'read', arguments: { path: 'b' } },
      ],
    });
    assert.deepEqual(calls.map((call) => call.name), ['bash', 'read'], key);
  }
});

test('extract: unparseable argument strings are flagged raw instead of becoming {}', () => {
  const calls = extractCalls({ name: 'bash', arguments: '{oops' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rawArguments, '{oops');
});

test('extract: inference is disabled when allowInference=false', () => {
  assert.deepEqual(extractCalls({ command: 'ls' }, { tools, allowInference: false }), []);
  assert.deepEqual(
    extractCalls({ command: 'ls' }, { tools }).map((call) => call.name),
    ['bash'],
  );
});

// ---------------------------------------------------------------------------
// Tool-name resolution
// ---------------------------------------------------------------------------

test('resolve: namespace, case and call-expression variants map automatically', () => {
  assert.equal(resolveToolName('functions.bash', tools).name, 'bash');
  assert.equal(resolveToolName('BASH', tools).name, 'bash');
  assert.equal(resolveToolName('  tool:read  ', tools).name, 'read');
});

test('resolve: a call expression is only suggested, never auto-executed', () => {
  const resolved = resolveToolName('bash(ls -la)', tools);
  assert.equal(resolved.name, null);
  assert.ok(resolved.suggestions.includes('bash'));
});

test('resolve: a typo only yields suggestions and never executes', () => {
  const resolved = resolveToolName('bsah', tools);
  assert.equal(resolved.name, null);
  assert.ok(resolved.suggestions.includes('bash'));
});

test('resolve: empty / null raw names resolve to null', () => {
  assert.equal(resolveToolName('', tools).name, null);
  assert.equal(resolveToolName(null, tools).name, null);
});

test('resolve: with no tool list everything is allowed verbatim', () => {
  assert.deepEqual(resolveToolName('whatever', []), {
    name: 'whatever',
    how: 'unrestricted',
    suggestions: [],
  });
});

test('resolve: rankToolNames is bounded and ordered by closeness', () => {
  const names = [bash, read, { name: 'write' }, { name: 'bashful' }].map((tool) => ({
    name: tool.name,
    parameters: tool.parameters || {},
  }));
  const ranked = rankToolNames('bsh', names, 2);
  assert.ok(ranked.length <= 2);
  assert.equal(ranked[0], 'bash');
});

test('resolve: ambiguity between two equal candidates is never auto-resolved', () => {
  const twins = [
    { name: 'read', parameters: {} },
    { name: 'Read', parameters: {} },
  ];
  const resolved = resolveToolName('read', twins);
  assert.ok(resolved.name === null || resolved.how === 'exact');
});
