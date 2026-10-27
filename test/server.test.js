import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer } from '../src/server.js';

const tools = [
  {
    type: 'function',
    function: {
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
    },
  },
];

function sseFor(content) {
  const ready = {
    request_message_id: 'req-1',
    response_message_id: 'msg-1',
    model_type: 'default',
  };
  const parts = Array.isArray(content) ? content : [content];
  const update = {
    v: {
      response: {
        message_id: 'msg-1',
        status: 'FINISHED',
        accumulated_token_usage: 42,
        fragments: parts.map((part) => ({ type: 'RESPONSE', content: part })),
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

async function withServer(content, fn, overrides = {}) {
  const prompts = [];
  const uploads = [];
  const completions = [];
  const client = {
    createSession: async () => 'session-1',
    uploadFile: async ({ file }) => {
      uploads.push(file);
      return { id: `file-${uploads.length}`, is_image: true };
    },
    completion: async ({ prompt, refFileIds }) => {
      prompts.push(prompt);
      completions.push({ prompt, refFileIds });
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
    await fn(`http://127.0.0.1:${port}`, prompts, { uploads, completions });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(stream) {
  return {
    model: 'deepseek-chat',
    stream,
    tools,
    messages: [{ role: 'user', content: 'list the files' }],
  };
}

test('non-streaming response converts bare arguments to tool_calls', async () => {
  await withServer('<tool_call>{"command":"ls -la","timeout":60000}</tool_call>', async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request(false)),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
    const [call] = json.choices[0].message.tool_calls;
    assert.equal(call.function.name, 'bash');
    assert.deepEqual(JSON.parse(call.function.arguments), {
      command: 'ls -la',
      timeout: 60000,
    });
    assert.equal(json.choices[0].message.content, null);
  });
});

test('injectToolPrompt=false injects nothing but still parses calls', async () => {
  await withServer(
    '<tool_call>{"command":"pwd"}</tool_call>',
    async (base, prompts) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request(false)),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.choices[0].finish_reason, 'tool_calls');
      assert.equal(json.choices[0].message.tool_calls[0].function.name, 'bash');

      assert.equal(prompts.length, 1);
      assert.doesNotMatch(prompts[0], /tool use protocol/i);
      assert.doesNotMatch(prompts[0], /<tool_call>/);
      assert.doesNotMatch(prompts[0], /"command"/);
      assert.match(prompts[0], /list the files/);
    },
    { injectToolPrompt: false },
  );
});

test('parseToolCalls=false returns raw tool markup as content', async () => {
  await withServer(
    '<tool_call>{"command":"pwd"}</tool_call>',
    async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request(false)),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      const message = json.choices[0].message;
      assert.equal(message.tool_calls, undefined);
      assert.equal(message.content, '<tool_call>{"command":"pwd"}</tool_call>');
      assert.equal(json.choices[0].finish_reason, 'stop');
    },
    { parseToolCalls: false },
  );
});

test('parseToolCalls=false streams the raw markup', async () => {
  await withServer(
    '<tool_call>{"command":"pwd"}</tool_call>',
    async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request(true)),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /<tool_call>/);
      assert.match(text, /command/);
      assert.match(text, /pwd/);
      assert.doesNotMatch(text, /"tool_calls"/);
      assert.match(text, /"finish_reason":"stop"/);
    },
    { parseToolCalls: false },
  );
});

test('streaming response emits tool call deltas for bare arguments', async () => {
  await withServer('<tool_call>{"command":"pwd"}</tool_call>', async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request(true)),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line));

    const calls = [];
    for (const event of events) {
      for (const delta of event.choices?.[0]?.delta?.tool_calls || []) {
        calls[delta.index] = calls[delta.index] || { name: '', arguments: '' };
        if (delta.function?.name) calls[delta.index].name = delta.function.name;
        if (delta.function?.arguments) calls[delta.index].arguments += delta.function.arguments;
      }
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'bash');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'pwd' });

    const finish = events.find((event) => event.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'tool_calls');
  });
});

const BAR = '\uFF5C';

function dsmlCall(command) {
  return [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">${command}</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
}

function parseSse(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((line) => line !== '[DONE]')
    .map((line) => JSON.parse(line));
}

test('non-streaming DSML returns OpenAI-compatible tool_calls', async () => {
  await withServer(dsmlCall('ls'), async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request(false)),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
    assert.equal(json.choices[0].message.content, null);
    const [call] = json.choices[0].message.tool_calls;
    assert.match(call.id, /^call_/);
    assert.equal(call.type, 'function');
    assert.equal(call.function.name, 'bash');
    assert.equal(typeof call.function.arguments, 'string');
    assert.deepEqual(JSON.parse(call.function.arguments), { command: 'ls' });
  });
});

test('streaming DSML emits compliant deltas and no markup', async () => {
  await withServer(`checking\n${dsmlCall('pwd')}`, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request(true)),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const events = parseSse(text);

    let content = '';
    const calls = [];
    const ids = new Map();
    const fragments = [];
    for (const event of events) {
      const delta = event.choices?.[0]?.delta;
      if (typeof delta?.content === 'string') content += delta.content;
      for (const piece of delta?.tool_calls || []) {
        fragments.push(piece);
        calls[piece.index] = calls[piece.index] || { name: '', arguments: '', first: piece };
        if (piece.function?.name) calls[piece.index].name = piece.function.name;
        if (piece.function?.arguments) calls[piece.index].arguments += piece.function.arguments;
        if (piece.id) ids.set(piece.index, piece.id);
      }
    }

    assert.match(content, /checking/);
    assert.doesNotMatch(content, /DSML/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'bash');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'pwd' });
    assert.match(ids.get(0), /^call_/);
    assert.equal(calls[0].first.type, 'function');
    assert.equal(calls[0].first.function.name, 'bash');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'pwd' });

    assert.ok(fragments.length >= 2);
    assert.ok(fragments.every((piece) => Number.isInteger(piece.index)));
    assert.equal(fragments[0].id, ids.get(0));
    for (const piece of fragments.slice(1)) {
      assert.equal(piece.id, undefined);
      assert.equal(piece.type, undefined);
      assert.equal(piece.function?.name, undefined);
      assert.equal(typeof piece.function?.arguments, 'string');
    }

    const finish = events.find((event) => event.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'tool_calls');
    assert.match(text, /data: \[DONE\]/);
  });
});

test('malformed DSML never leaks markup in streaming or non-streaming', async () => {
  const malformed = [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="bash">`,
    `<${BAR}DSML${BAR} parameter name="command" string="true">rm -rf /tmp/x</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');

  await withServer(malformed, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request(false)),
    });
    const json = await res.json();
    assert.equal(json.choices[0].message.tool_calls, undefined);
    assert.equal(json.choices[0].finish_reason, 'stop');
    assert.doesNotMatch(json.choices[0].message.content, /DSML|rm -rf/);
  });

  await withServer(malformed, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request(true)),
    });
    const text = await res.text();
    assert.doesNotMatch(text, /DSML|rm -rf/);
    assert.doesNotMatch(text, /"tool_calls"/);
    assert.match(text, /"finish_reason":"stop"/);
  });
});

test('parallel_tool_calls=false caps DSML calls', async () => {
  const content = [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="bash"><${BAR}DSML${BAR} parameter name="command" string="true">ls</${BAR}DSML${BAR} parameter></${BAR}DSML${BAR} invoke>`,
    `<${BAR}DSML${BAR} invoke name="bash"><${BAR}DSML${BAR} parameter name="command" string="true">pwd</${BAR}DSML${BAR} parameter></${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');

  await withServer(content, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request(false), parallel_tool_calls: false }),
    });
    const json = await res.json();
    assert.equal(json.choices[0].message.tool_calls.length, 1);
    assert.deepEqual(
      JSON.parse(json.choices[0].message.tool_calls[0].function.arguments),
      { command: 'ls' },
    );
  });
});

test('streams a DSML block split across many fragments', async () => {
  const pieces = [
    'Hello <',
    BAR,
    'DSML',
    BAR,
    ' calls>\n<',
    BAR,
    'DSML',
    BAR,
    ' invoke name="bash">\n<',
    BAR,
    'DSML',
    BAR,
    ' parameter name="command" string="true">ls',
    '</',
    BAR,
    'DSML',
    BAR,
    ' parameter>\n</',
    BAR,
    'DSML',
    BAR,
    ' invoke>\n</',
    BAR,
    'DSML',
    BAR,
    ' calls>',
  ];

  await withServer(pieces, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request(true)),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const events = parseSse(text);

    let content = '';
    const calls = [];
    for (const event of events) {
      const delta = event.choices?.[0]?.delta;
      if (typeof delta?.content === 'string') content += delta.content;
      for (const piece of delta?.tool_calls || []) {
        calls[piece.index] = calls[piece.index] || { name: '', arguments: '' };
        if (piece.function?.name) calls[piece.index].name = piece.function.name;
        if (piece.function?.arguments) calls[piece.index].arguments += piece.function.arguments;
      }
    }

    assert.equal(content, 'Hello ');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'bash');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls' });
  });
});

test('include_usage emits a final chunk with empty choices', async () => {
  await withServer(dsmlCall('ls'), async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request(true), stream_options: { include_usage: true } }),
    });
    const text = await res.text();
    const events = parseSse(text);
    const usage = events.find((event) => event.usage);
    assert.ok(usage);
    assert.deepEqual(usage.choices, []);
    assert.equal(typeof usage.usage.total_tokens, 'number');
    assert.match(text, /data: \[DONE\]/);
  });
});

test('uploads inline image parts and sends them as ref_file_ids', async () => {
  await withServer('a tiny pixel', async (base, prompts, { uploads, completions }) => {
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${pixel}` } },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].type, 'image/png');
    assert.equal(completions[0].refFileIds.length, 1);
    assert.equal(completions[0].refFileIds[0], 'file-1');
    assert.match(prompts[0], /what is this\?/);
    assert.doesNotMatch(prompts[0], /base64/);
  });
});

test('accepts an image-only user message', async () => {
  await withServer('ok', async (base, prompts) => {
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${pixel}` } }],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(prompts.length, 1);
  });
});

test('uploads multiple images and keeps their order', async () => {
  await withServer('two pictures', async (base, prompts, { uploads, completions }) => {
    const red = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const blue = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'compare these' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${red}` } },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${blue}` } },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(uploads.length, 2);
    assert.deepEqual(completions[0].refFileIds, ['file-1', 'file-2']);
  });
});

test('does not re-upload an image when the session is reused', async () => {
  await withServer('seen it', async (base, prompts, { uploads, completions }) => {
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${pixel}` } },
        ],
      },
    ];
    const send = (body) =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const first = await send({ model: 'deepseek-chat', messages });
    assert.equal(first.status, 200);
    assert.equal(uploads.length, 1);
    assert.deepEqual(completions[0].refFileIds, ['file-1']);

    // The client echoes the assistant reply and asks a follow-up; the cached
    // upstream session is reused, so no image upload and no ref_file_ids.
    const second = await send({
      model: 'deepseek-chat',
      messages: [
        ...messages,
        { role: 'assistant', content: 'seen it' },
        { role: 'user', content: 'and now?' },
      ],
    });
    assert.equal(second.status, 200);
    assert.equal(uploads.length, 1);
    assert.equal(completions.length, 2);
    assert.deepEqual(completions[1].refFileIds, []);
  });
});
