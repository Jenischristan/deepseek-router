import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import { DEFAULT_ACCEPT_ENCODING, withZstd } from '../src/fetch.js';

test(
  'withZstd decodes a zstd response',
  { skip: typeof zlib.zstdCompressSync !== 'function' },
  async () => {
    const body = Buffer.from('hello zstd');
    const compressed = zlib.zstdCompressSync(body);
    const fetchImpl = async () =>
      new Response(compressed, {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-encoding': 'zstd',
          'content-length': String(compressed.length),
        },
      });

    const response = await withZstd(fetchImpl)('https://example.test/');
    assert.equal(await response.text(), 'hello zstd');
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), null);
  },
);

test('DEFAULT_ACCEPT_ENCODING follows the runtime zstd support', () => {
  const expected =
    typeof zlib.createZstdDecompress === 'function'
      ? 'gzip, deflate, br, zstd'
      : 'gzip, deflate, br';
  assert.equal(DEFAULT_ACCEPT_ENCODING, expected);
});
