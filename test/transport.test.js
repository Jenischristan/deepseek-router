import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createTransportFetch } from '../src/transport.js';

async function startSidecar(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('transport: forwards target, method, headers and body to the sidecar', async () => {
  const seen = {};
  const sidecar = await startSidecar((req, res) => {
    seen.method = req.method;
    seen.url = req.url;
    seen.headers = req.headers;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.body = body;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      res.end('data: two\n\n');
    });
  });

  try {
    const transportFetch = createTransportFetch(sidecar.url, 'secret-key');
    const response = await transportFetch(
      'https://chat.deepseek.com/api/v0/chat/completion',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token',
          accept: '*/*',
        },
        body: '{"prompt":"hi"}',
      },
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'data: one\n\ndata: two\n\n');

    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/forward');
    assert.equal(
      seen.headers['x-deepseek-target'],
      'https://chat.deepseek.com/api/v0/chat/completion',
    );
    assert.equal(seen.headers['x-deepseek-method'], 'POST');
    assert.equal(seen.headers['x-deepseek-transport-key'], 'secret-key');
    assert.equal(
      seen.headers['x-deepseek-header-order'],
      'content-type,authorization,accept,content-length',
    );
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.headers.authorization, 'Bearer token');
    assert.equal(seen.headers.accept, '*/*');
    assert.equal(seen.body, '{"prompt":"hi"}');
  } finally {
    await sidecar.close();
  }
});

test('transport: content-length is placed immediately before origin', async () => {
  const seen = {};
  const sidecar = await startSidecar((req, res) => {
    seen.order = req.headers['x-deepseek-header-order'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  try {
    const transportFetch = createTransportFetch(sidecar.url, 'key');
    await transportFetch('https://chat.deepseek.com/api/v0/chat/completion', {
      method: 'POST',
      headers: {
        'user-agent': 'ua',
        'accept-encoding': 'gzip',
        'x-ds-pow-response': 'pow',
        'x-client-bundle-id': 'com.deepseek.chat',
        authorization: 'Bearer token',
        'content-type': 'application/json',
        origin: 'https://chat.deepseek.com',
        'sec-gpc': '1',
        referer: 'https://chat.deepseek.com/',
        cookie: 'a=b',
        'sec-fetch-dest': 'empty',
      },
      body: '{}',
    });

    assert.equal(
      seen.order,
      'user-agent,accept-encoding,x-ds-pow-response,x-client-bundle-id,' +
        'authorization,content-type,content-length,origin,sec-gpc,referer,' +
        'cookie,sec-fetch-dest',
    );
  } finally {
    await sidecar.close();
  }
});

test('transport: multipart bodies order content-type then content-length before origin', async () => {
  const seen = {};
  const sidecar = await startSidecar((req, res) => {
    seen.order = req.headers['x-deepseek-header-order'];
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  try {
    const transportFetch = createTransportFetch(sidecar.url, 'key');
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');

    await transportFetch('https://chat.deepseek.com/api/v0/file/upload_file', {
      method: 'POST',
      headers: {
        'user-agent': 'ua',
        'x-thinking-enabled': '0',
        'x-file-size': '5',
        'x-ds-pow-response': 'pow',
        'x-client-bundle-id': 'com.deepseek.chat',
        authorization: 'Bearer token',
        origin: 'https://chat.deepseek.com',
        'sec-gpc': '1',
        referer: 'https://chat.deepseek.com/',
        cookie: 'a=b',
        'sec-fetch-dest': 'empty',
      },
      body: form,
    });

    assert.equal(
      seen.order,
      'user-agent,x-thinking-enabled,x-file-size,x-ds-pow-response,' +
        'x-client-bundle-id,authorization,content-type,content-length,origin,' +
        'sec-gpc,referer,cookie,sec-fetch-dest',
    );
  } finally {
    await sidecar.close();
  }
});

test('transport: GET hif requests keep their method and empty header order', async () => {
  const seen = {};
  const sidecar = await startSidecar((req, res) => {
    seen.method = req.method;
    seen.targetMethod = req.headers['x-deepseek-method'];
    seen.order = req.headers['x-deepseek-header-order'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"code":0}');
  });

  try {
    const transportFetch = createTransportFetch(sidecar.url, 'key');
    const response = await transportFetch('https://hif-leim.deepseek.com/query');

    assert.equal(response.status, 200);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.targetMethod, 'GET');
    assert.equal(seen.order, '');
    assert.equal(await response.text(), '{"code":0}');
  } finally {
    await sidecar.close();
  }
});

test('transport: refuses non-DeepSeek targets', async () => {
  const transportFetch = createTransportFetch('http://127.0.0.1:1', 'key');
  await assert.rejects(
    transportFetch('https://evil.example/api'),
    /refusing non-DeepSeek target/,
  );
  await assert.rejects(
    transportFetch('https://user:pass@chat.deepseek.com/api'),
    /refusing non-DeepSeek target/,
  );
  await assert.rejects(
    transportFetch('http://chat.deepseek.com/api'),
    /refusing non-DeepSeek target/,
  );
});
