import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ToolCallStreamFilter,
  parseToolResponse,
  interpretToolResponse,
  sanitizeToolCalls,
  formatToolCallsForTranscript,
  formatToolResultPrompt,
  createServer,
} from '../src/server.js';
import { extractDsml } from '../src/openai/extract.js';

const BAR = '\uFF5C';
const D = 'DSML';
const tag = (n, a = '', c = false) => `<${c ? '/' : ''}${BAR}${D}${BAR}${n}${a}>`;
const close = (n) => tag(n, '', true);
const wrap = (name, params, { calls = true } = {}) => {
  const body = params
    .map(([k, v, s = 'true']) => `${tag('parameter', ` name="${k}" string="${s}"`)}${v}${close('parameter')}`)
    .join('\n');
  const invoke = `${tag('invoke', ` name="${name}"`)}\n${body}\n${close('invoke')}`;
  return calls ? `${tag('calls')}\n${invoke}\n${close('calls')}` : invoke;
};

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

const tools = [bash, read, search];
const allowedNames = new Set(tools.map((t) => t.name));
const parse = (text, options = {}) =>
  parseToolResponse(text, tools, { allowedNames, ...options });

// A command may legitimately echo a *balanced* literal parameter tag; that is
// supported behaviour. Strip those pairs before asserting that no protocol
// markup leaked into the executed arguments.
const GAP = '[\\s\\u200B-\\u200D]*';
const T = `${GAP}(?:[${BAR}|]${GAP}){0,3}DSML${GAP}(?:[${BAR}|]${GAP}){0,3}`;
const LITERAL_PAIR_RE = new RegExp(
  `<${T}parameter\\b[^>]*>[\\s\\S]*?</${T}parameter${GAP}>`,
  'gi',
);
function residualDsml(value) {
  // The value is JSON-stringified, so newlines inside a literal tag appear as
  // the two characters \n. Decode them before matching the tolerant prefix.
  let text = String(value).replace(/\\[nrt]/g, (m) => ({ '\\n': '\n', '\\r': '\r', '\\t': '\t' })[m]);
  for (;;) {
    const next = text.replace(LITERAL_PAIR_RE, '');
    if (next === text) return text;
    text = next;
  }
}

// ---------------------------------------------------------------------------
// Marker normalisation
// ---------------------------------------------------------------------------

test('marker: lowercase dsml still parses', () => {
  const text = wrap('bash', [['command', 'ls']]).replace(/DSML/g, 'dsml');
  const r = parse(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].arguments.command, 'ls');
});

test('marker: zero-width spaces inside the marker are ignored', () => {
  const zw = '\u200B';
  const text = wrap('bash', [['command', 'ls']]).replace(/DSML/g, `${zw}DSML${zw}`);
  const r = parse(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].arguments.command, 'ls');
});

test('marker: one, two or three bars all parse', () => {
  for (const bars of [BAR, BAR + BAR, BAR + BAR + BAR, '|', '||', '|||']) {
    const text = [
      `<${bars}DSML${bars} calls>`,
      `<${bars}DSML${bars} invoke name="bash">`,
      `<${bars}DSML${bars} parameter name="command" string="true">ls</${bars}DSML${bars} parameter>`,
      `</${bars}DSML${bars} invoke>`,
      `</${bars}DSML${bars} calls>`,
    ].join('\n');
    const r = parse(text);
    assert.equal(r.calls.length, 1, `bars=${JSON.stringify(bars)}`);
    assert.equal(r.calls[0].arguments.command, 'ls');
  }
});

test('marker: arbitrary whitespace around bars and name', () => {
  const text = [
    `< ${BAR} DSML ${BAR} calls >`,
    `< ${BAR} DSML ${BAR} invoke name="bash" >`,
    `< ${BAR} DSML ${BAR} parameter name="command" string="true" >ls</ ${BAR} DSML ${BAR} parameter >`,
    `</ ${BAR} DSML ${BAR} invoke >`,
    `</ ${BAR} DSML ${BAR} calls >`,
  ].join('\n');
  const r = parse(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].arguments.command, 'ls');
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test('orphan: parameters without an invoke infer a lone tool', () => {
  const text = [
    `${tag('', ' command" string="true"')}ls${close('parameter')}`,
    `${tag('', ' workdir" string="true"')}/tmp${close('parameter')}`,
  ].join('\n');
  const r = parse(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'bash');
  assert.equal(r.calls[0].arguments.command, 'ls');
  assert.equal(r.calls[0].arguments.workdir, '/tmp');
});

test('orphan: ambiguous parameters go to repair, never guess', () => {
  const alpha = {
    name: 'alpha',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  };
  const beta = {
    name: 'beta',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  };
  const text = `${tag('', ' value" string="true"')}x${close('parameter')}`;
  const r = parseToolResponse(text, [alpha, beta], {
    allowedNames: new Set(['alpha', 'beta']),
  });
  assert.equal(r.calls.length, 0);
  assert.ok(r.invalidCalls.length > 0);
});

test('garbled opener: dropped name= is recovered as the parameter name', () => {
  const text = [
    tag('function_calls'),
    tag('invoke', ' name="bash"'),
    `${tag('', ' command" string="true"')}echo ok${close('parameter')}`,
    `${tag('', ' timeout" string="false"')}5000${close('parameter')}`,
    close('invoke'),
    close('function_calls'),
  ].join('\n');
  const r = parse(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].arguments.command, 'echo ok');
  assert.equal(r.calls[0].arguments.timeout, 5000);
});

test('garbled opener: value still holding markup is never executed', () => {
  const text = [
    tag('invoke', ' name="bash"'),
    `${tag('parameter', ' name="command" string="true"')}ls${close('parameter')}`,
    `${tag('', ' timeout" string="false"')}5000${close('parameter')}`,
    close('invoke'),
  ].join('\n');
  const r = parse(text);
  for (const call of r.calls) {
    assert.doesNotMatch(JSON.stringify(call.arguments), /DSML/);
  }
});

test('structure: missing invoke closer recovers the next invoke', () => {
  const text = [
    tag('calls'),
    tag('invoke', ' name="bash"'),
    `${tag('parameter', ' name="command" string="true"')}one${close('parameter')}`,
    tag('invoke', ' name="read"'),
    `${tag('parameter', ' name="filePath" string="true"')}two.txt${close('parameter')}`,
    close('invoke'),
    close('calls'),
  ].join('\n');
  const r = parse(text);
  assert.deepEqual(
    r.calls.map((c) => [c.name, c.arguments.command || c.arguments.filePath]),
    [
      ['bash', 'one'],
      ['read', 'two.txt'],
    ],
  );
});

test('structure: unknown-name closer is stripped from the value', () => {
  const text = [
    tag('calls'),
    tag('invoke', ' name="bash"'),
    `${tag('parameter', ' name="command" string="true"')}ls -la${tag('timeout', '', true)}${close('parameter')}`,
    `${tag('parameter', ' name="timeout" string="false"')}5000${close('parameter')}`,
    close('invoke'),
    close('calls'),
  ].join('\n');
  const r = parse(text);
  assert.equal(r.calls[0].arguments.command, 'ls -la');
  assert.equal(r.calls[0].arguments.timeout, 5000);
  assert.doesNotMatch(r.calls[0].argumentsText, /DSML/);
});

test('structure: unterminated parameter goes to repair', () => {
  const text = [
    tag('calls'),
    tag('invoke', ' name="bash"'),
    `${tag('parameter', ' name="command" string="true"')}ls`,
    close('invoke'),
    close('calls'),
  ].join('\n');
  const r = parse(text);
  assert.equal(r.calls.length, 0);
  assert.ok(r.invalidCalls.some((i) => /unterminated/.test(i.reason)));
});

test('structure: empty wrapper is repair, not content', () => {
  const r = extractDsml(`${tag('calls')}${close('calls')}`, { tools });
  assert.equal(r.calls.length, 0);
  assert.equal(r.content, '');
  assert.deepEqual(r.invalid, [{ name: null, reason: 'missing_name' }]);
});

test('structure: bare invoke and bare wrapper both parse', () => {
  const bareInvoke = `${tag('invoke', ' name="bash"')}${tag('parameter', ' name="command" string="true"')}ls${close('parameter')}${close('invoke')}`;
  assert.equal(parse(bareInvoke).calls.length, 1);
  const bareWrapper = `${tag('function_calls')}\n${bareInvoke}\n${close('function_calls')}`;
  assert.equal(parse(bareWrapper).calls.length, 1);
});

test('structure: multiple invokes and multiple blocks keep order', () => {
  const a = wrap('bash', [['command', 'a']]);
  const b = wrap('read', [['filePath', 'b']]);
  const c = wrap('bash', [['command', 'c']], { calls: false });
  const r = parse(`${a}\n${b}\n${c}`);
  assert.deepEqual(
    r.calls.map((x) => x.name),
    ['bash', 'read', 'bash'],
  );
  assert.deepEqual(
    r.calls.map((x) => x.arguments.command || x.arguments.filePath),
    ['a', 'b', 'c'],
  );
});

test('structure: repeated array parameter groups into one list', () => {
  const text = [
    tag('calls'),
    tag('invoke', ' name="search"'),
    `${tag('parameter', ' name="query" string="true"')}x${close('parameter')}`,
    `${tag('parameter', ' name="terms" string="false"')}"a"${close('parameter')}`,
    `${tag('parameter', ' name="terms" string="false"')}"b"${close('parameter')}`,
    close('invoke'),
    close('calls'),
  ].join('\n');
  const [call] = sanitizeToolCalls(parse(text).calls, [search]);
  assert.deepEqual(call.arguments, { query: 'x', terms: ['a', 'b'] });
});

test('structure: repeated command splits into calls sharing workdir', () => {
  const text = [
    tag('calls'),
    tag('invoke', ' name="bash"'),
    `${tag('parameter', ' name="command" string="true"')}ls${close('parameter')}`,
    `${tag('parameter', ' name="workdir" string="true"')}/tmp${close('parameter')}`,
    `${tag('parameter', ' name="command" string="true"')}pwd${close('parameter')}`,
    close('invoke'),
    close('calls'),
  ].join('\n');
  const r = parse(text);
  assert.deepEqual(
    r.calls.map((c) => c.arguments),
    [
      { command: 'ls', workdir: '/tmp' },
      { command: 'pwd', workdir: '/tmp' },
    ],
  );
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

test('values: literal balanced parameter tags survive verbatim', () => {
  const inner = `${tag('parameter', ' name="x"')}y${close('parameter')}`;
  const r = parse(wrap('bash', [['command', `echo ${inner}`]]));
  assert.equal(r.calls[0].arguments.command, `echo ${inner}`);
});

test('values: string=false parses numbers and JSON', () => {
  const r = parse(
    wrap('bash', [
      ['command', 'ls', 'true'],
      ['timeout', '5000', 'false'],
    ]),
  );
  assert.equal(r.calls[0].arguments.timeout, 5000);
  assert.equal(typeof r.calls[0].arguments.timeout, 'number');
});

test('values: whitespace and newlines in string values are preserved', () => {
  const r = parse(wrap('bash', [['command', '  echo hi\n']]));
  assert.equal(r.calls[0].arguments.command, '  echo hi\n');
});

test('values: a JSON body inside invoke is accepted', () => {
  const text = `${tag('calls')}\n${tag('invoke', ' name="bash"')}{"command":"ls"}${close('invoke')}\n${close('calls')}`;
  const r = parse(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].argumentsText, '{"command":"ls"}');
});

// ---------------------------------------------------------------------------
// Prose / fences / think
// ---------------------------------------------------------------------------

test('prose: short marker mention stays visible', () => {
  const text = `Use ${tag('invoke')} to call tools`;
  const r = parse(text);
  assert.equal(r.calls.length, 0);
  assert.equal(r.invalidCalls.length, 0);
  assert.match(r.content, /Use/);
});

test('prose: long tool_call mention is not swallowed', () => {
  const text =
    `To call a tool use the ${tag('tool_call')} wrapper, then explain at length why that matters. ` +
    'x'.repeat(200);
  const r = parse(text);
  assert.equal(r.calls.length, 0);
  assert.ok(r.content.includes('x'.repeat(50)));
});

test('fence: a fenced DSML example is kept, never executed', () => {
  const text = ['Example:', '```xml', wrap('bash', [['command', 'ls']]), '```', 'Done'].join('\n');
  const r = parse(text);
  assert.equal(r.calls.length, 0);
  assert.match(r.content, /```xml/);
  assert.match(r.content, /Done/);
});

test('fence: inline backtick example is kept', () => {
  const text = `Write ${'`'}${tag('invoke', ' name="bash"')}${'`'} to call it.`;
  const r = parse(text);
  assert.equal(r.calls.length, 0);
  assert.match(r.content, /`/);
});

test('think: a tool call inside an unclosed think block is not executed', () => {
  const text = `<think>plan ${wrap('bash', [['command', 'ls']])}`;
  const r = parse(text);
  assert.equal(r.calls.length, 0);
});

test('think: closed think block is stripped and the real call executes', () => {
  const text = `<think>plan</think>\n${wrap('bash', [['command', 'ls']])}`;
  const r = parse(text);
  assert.equal(r.calls.length, 1);
  assert.doesNotMatch(r.content, /plan/);
});

// ---------------------------------------------------------------------------
// Streaming filter parity
// ---------------------------------------------------------------------------

function streamAll(text, chunk = 1, { holdAll = false } = {}) {
  const filter = new ToolCallStreamFilter({ holdAll });
  let visible = '';
  for (let i = 0; i < text.length; i += chunk) visible += filter.push(text.slice(i, i + chunk));
  const held = filter.takeHeld();
  return { visible, held };
}

const corpus = {
  single: wrap('bash', [['command', 'ls']]),
  twoBlocks: `${wrap('bash', [['command', 'a']])}\n${wrap('read', [['filePath', 'b']])}`,
  blockless: wrap('bash', [['command', 'ls']], { calls: false }),
  garbled: [
    tag('function_calls'),
    tag('invoke', ' name="bash"'),
    `${tag('', ' command" string="true"')}ls${close('parameter')}`,
    close('invoke'),
    close('function_calls'),
  ].join('\n'),
  proseBefore: `Here you go:\n${wrap('bash', [['command', 'ls']])}`,
  fenced: '```xml\n' + wrap('bash', [['command', 'ls']]) + '\n```',
  v3: `<${BAR}tool\u2581call\u2581begin${BAR}>bash<${BAR}tool\u2581sep${BAR}>{"command":"ls"}<${BAR}tool\u2581call\u2581end${BAR}>`,
};

for (const [name, text] of Object.entries(corpus)) {
  for (const chunk of [1, 2, 3, 7, 13, 97]) {
    test(`stream parity: ${name} chunk=${chunk}`, () => {
      const { visible, held } = streamAll(text, chunk);
      const direct = parse(text);
      const streamed = parse(held.blocks);
      assert.deepEqual(streamed.calls, direct.calls, 'calls differ');
      assert.deepEqual(streamed.invalidCalls, direct.invalidCalls, 'invalid differ');
      // The filter emits the prose before a marker and holds the marker tail,
      // so the two pieces must join back into the direct parse's visible text.
      assert.equal((visible + streamed.content).trim(), direct.content, 'content differs');
      if (direct.calls.length > 0) {
        assert.equal(visible.trim(), direct.content, 'visible text leaked markup');
        assert.equal(held.pending, '');
      } else {
        assert.doesNotMatch(visible, /DSML/, 'markup leaked from a non-call reply');
      }
    });
  }
}

test('stream: markup never appears in visible text', () => {
  for (const [name, text] of Object.entries(corpus)) {
    const { visible } = streamAll(text, 1);
    assert.doesNotMatch(visible, /DSML/, name);
  }
});

test('stream: holdAll holds plain replies too', () => {
  const { visible, held } = streamAll('plain answer', 1, { holdAll: true });
  assert.equal(visible, '');
  assert.equal(held.blocks, 'plain answer');
});

// ---------------------------------------------------------------------------
// Transcript / echo loop
// ---------------------------------------------------------------------------

test('transcript: replaying calls produces parseable DSML', () => {
  const calls = [
    { id: 'a', function: { name: 'bash', arguments: '{"command":"ls","workdir":"/tmp"}' } },
    { id: 'b', function: { name: 'read', arguments: '{"filePath":"/etc/hosts"}' } },
  ];
  const text = formatToolCallsForTranscript(calls);
  const r = parse(text);
  assert.deepEqual(
    r.calls.map((c) => c.name),
    ['bash', 'read'],
  );
  assert.deepEqual(r.calls[0].arguments, { command: 'ls', workdir: '/tmp' });
});

test('transcript: a value containing a closing tag is escaped and still parseable', () => {
  const nasty = `echo '${close('parameter')}'`;
  const text = formatToolCallsForTranscript([
    { id: 'a', function: { name: 'bash', arguments: JSON.stringify({ command: nasty }) } },
  ]);
  const r = parse(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].arguments.command, nasty);
});

test('transcript: tool result echoes escape markup and truncate long arguments', () => {
  const big = 'x'.repeat(10000);
  const prompt = formatToolResultPrompt(
    [{ role: 'tool', tool_call_id: 'a', content: `saw ${tag('invoke')} here` }],
    { a: { name: 'bash', argumentsText: JSON.stringify({ command: big }) } },
  );
  assert.doesNotMatch(prompt, new RegExp(`${BAR}DSML${BAR}`));
  assert.match(prompt, /truncated/);
});

// ---------------------------------------------------------------------------
// interpretToolResponse / repair
// ---------------------------------------------------------------------------

test('interpret: unknown tool yields suggestions and needsRepair', () => {
  const r = interpretToolResponse(wrap('bsah', [['command', 'ls']]), tools, { allowedNames });
  assert.equal(r.calls.length, 0);
  assert.equal(r.needsRepair, true);
  assert.deepEqual(r.invalidCalls[0].reason, 'unknown_tool');
  assert.ok(r.invalidCalls[0].suggestions.includes('bash'));
});

test('interpret: duplicate identical calls collapse', () => {
  const one = wrap('bash', [['command', 'ls']], { calls: false });
  const text = `${tag('calls')}\n${one}\n${one}\n${close('calls')}`;
  assert.equal(parse(text).calls.length, 2);
  assert.equal(interpretToolResponse(text, tools, { allowedNames }).calls.length, 1);
});

// ---------------------------------------------------------------------------
// Deterministic fuzz
// ---------------------------------------------------------------------------

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const SEEDS = [
  wrap('bash', [['command', 'ls -la'], ['workdir', '/tmp']]),
  wrap('bash', [['command', 'echo hi'], ['timeout', '5000', 'false']]),
  `${wrap('bash', [['command', 'a']])}\n${wrap('read', [['filePath', 'b']])}`,
  wrap('bash', [['command', `echo ${tag('parameter', ' name="x"')}y${close('parameter')}`]]),
  [
    tag('function_calls'),
    tag('invoke', ' name="bash"'),
    `${tag('', ' command" string="true"')}find . -name x${close('parameter')}`,
    `${tag('', ' timeout" string="false"')}180000${close('parameter')}`,
    close('invoke'),
    close('function_calls'),
  ].join('\n'),
];

const MUTATIONS = [
  (t, rnd) => {
    const i = Math.floor(rnd() * t.length);
    return t.slice(0, i) + t.slice(i + 1);
  },
  (t, rnd) => {
    const i = Math.floor(rnd() * t.length);
    return t.slice(0, i) + (rnd() < 0.5 ? '<' : '>') + t.slice(i);
  },
  (t) => t.replace(/name="/g, 'nam="'),
  (t) => t.replace(/DSML/g, 'dsml'),
  (t) => t.replace(new RegExp(BAR, 'g'), ''),
  (t) => t.replace(new RegExp(BAR, 'g'), BAR + BAR),
  (t, rnd) => {
    const i = Math.floor(rnd() * t.length);
    const j = Math.min(t.length, i + Math.floor(rnd() * 40));
    return t.slice(0, i) + t.slice(j);
  },
  (t, rnd) => {
    const i = Math.floor(rnd() * t.length);
    return t.slice(0, i) + '\n' + t.slice(i);
  },
  (t, rnd) => {
    const i = Math.floor(rnd() * t.length);
    return t.slice(0, i) + '\u200B' + t.slice(i);
  },
  (t) => t.replace(/string="(true|false)"/g, 'string='),
];

test('fuzz: parser invariants hold under mutation', () => {
  const rnd = prng(0xc0ffee);
  let cases = 0;
  for (const seed of SEEDS) {
    for (let iter = 0; iter < 300; iter += 1) {
      let text = seed;
      const steps = 1 + Math.floor(rnd() * 4);
      for (let s = 0; s < steps; s += 1) {
        text = MUTATIONS[Math.floor(rnd() * MUTATIONS.length)](text, rnd);
      }
      const r = parse(text);
      cases += 1;

      assert.ok(Array.isArray(r.calls));
      assert.ok(Array.isArray(r.invalidCalls));
      assert.equal(typeof r.content, 'string');

      for (const call of r.calls) {
        const value = residualDsml(JSON.stringify(call.arguments ?? {}));
        assert.doesNotMatch(value, /DSML/, `markup executed for: ${text.slice(0, 120)}`);
      }

      const wellFormed = new RegExp(`<\\/?${BAR}DSML${BAR}`).test(text);
      if (wellFormed && !/```/.test(text)) {
        assert.doesNotMatch(r.content, /DSML/, `markup leaked for: ${text.slice(0, 120)}`);
      }
    }
  }
  assert.ok(cases >= 1500);
});

test('fuzz: streaming and non-streaming agree on mutated input', () => {
  const rnd = prng(0xbadf00d);
  for (const seed of SEEDS) {
    for (let iter = 0; iter < 80; iter += 1) {
      let text = seed;
      const steps = 1 + Math.floor(rnd() * 3);
      for (let s = 0; s < steps; s += 1) {
        text = MUTATIONS[Math.floor(rnd() * MUTATIONS.length)](text, rnd);
      }
      const chunk = 1 + Math.floor(rnd() * 9);
      const filter = new ToolCallStreamFilter();
      let visible = '';
      for (let i = 0; i < text.length; i += chunk) visible += filter.push(text.slice(i, i + chunk));
      const held = filter.takeHeld();
      const direct = parse(text);
      const streamed = parse(held.blocks);
      assert.deepEqual(streamed.calls, direct.calls, `calls differ chunk=${chunk}`);
      assert.deepEqual(streamed.invalidCalls, direct.invalidCalls, 'invalid differ');
      const wellFormed = new RegExp(`<\\/?${BAR}DSML${BAR}`).test(text);
      if (wellFormed && !/```/.test(text)) {
        assert.doesNotMatch(visible, /DSML/, `markup leaked chunk=${chunk}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// End-to-end pipeline (server + streaming)
// ---------------------------------------------------------------------------

function sseFor(content) {
  const ready = {
    request_message_id: 'req-1',
    response_message_id: 'msg-1',
    model_type: 'default',
  };
  const update = {
    v: {
      response: {
        message_id: 'msg-1',
        status: 'FINISHED',
        accumulated_token_usage: 10,
        fragments: [{ type: 'RESPONSE', content }],
      },
    },
  };
  return [
    'event: ready',
    `data: ${JSON.stringify(ready)}`,
    '',
    `data: ${JSON.stringify(update)}`,
    '',
    '',
  ].join('\n');
}

function fakeTokenStore() {
  const account = { token: 'test-token' };
  return {
    count: 1,
    active: 0,
    current: () => account,
    rotate: () => null,
    noteResponse: () => null,
    status: () => ({ accounts: 1, active: 1 }),
  };
}

async function withServer(reply, fn, overrides = {}) {
  const prompts = [];
  const client = {
    createSession: async () => 'session-1',
    uploadFile: async () => ({ id: 'file-1', is_image: true }),
    completion: async ({ prompt }) => {
      prompts.push(prompt);
      const turn = prompts.length - 1;
      const content = typeof reply === 'function' ? reply(turn, prompt) : reply;
      return new Response(sseFor(content), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  };
  const config = {
    apiKey: '',
    logLevel: 'error',
    sessionTtlMs: 60_000,
    maxSessions: 10,
    concurrency: 1,
    minIntervalMs: 0,
    injectToolPrompt: true,
    parseToolCalls: true,
    ...overrides,
  };
  const server = createServer({ config, tokenStore: fakeTokenStore(), client });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const openaiTools = tools.map((t) => ({ type: 'function', function: t }));

async function readSse(res) {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d));
}

function postBody(stream) {
  return {
    model: 'deepseek-chat',
    stream,
    tools: openaiTools,
    messages: [{ role: 'user', content: 'go' }],
  };
}

test('pipeline: non-streaming DSML produces a tool call and no markup', async () => {
  const reply = `Thinking.\n${wrap('bash', [['command', 'ls'], ['timeout', '5000', 'false']])}`;
  await withServer(reply, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(postBody(false)),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const call = body.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'bash');
    assert.deepEqual(JSON.parse(call.function.arguments), { command: 'ls', timeout: 5000 });
    assert.doesNotMatch(body.choices[0].message.content || '', /DSML/);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
  });
});

test('pipeline: streaming DSML emits deltas and no markup', async () => {
  const reply = wrap('bash', [['command', 'pwd']]);
  await withServer(reply, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(postBody(true)),
    });
    const chunks = await readSse(res);
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('');
    assert.doesNotMatch(text, /DSML/);
    const names = chunks
      .map((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name)
      .filter(Boolean);
    assert.ok(names.includes('bash'));
    const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean);
    assert.ok(finish.includes('tool_calls'));
  });
});

test('pipeline: malformed markup never leaks, reply is repaired once', async () => {
  const bad = [
    tag('calls'),
    tag('invoke', ' name="bash"'),
    `${tag('parameter', ' name="command" string="true"')}ls`,
    close('invoke'),
    close('calls'),
  ].join('\n');
  const good = wrap('bash', [['command', 'ls']]);
  await withServer(
    (turn) => (turn === 0 ? bad : good),
    async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(postBody(false)),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.doesNotMatch(JSON.stringify(body), /DSML/);
      assert.equal(body.choices[0].message.tool_calls[0].function.name, 'bash');
      assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), {
        command: 'ls',
      });
    },
  );
});

test('pipeline: lowercase/zero-width marker survives end to end', async () => {
  const reply = wrap('bash', [['command', 'ls']]).replace(/DSML/g, '\u200Bdsml');
  await withServer(reply, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(postBody(false)),
    });
    const body = await res.json();
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'bash');
  });
});
