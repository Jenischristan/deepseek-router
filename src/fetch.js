import { Readable } from 'node:stream';
import zlib from 'node:zlib';

const HAS_ZSTD = typeof zlib.createZstdDecompress === 'function';

// Firefox sends zstd in Accept-Encoding. Only advertise it when this Node
// runtime can actually decompress the response; older Node releases cannot.
export const DEFAULT_ACCEPT_ENCODING = HAS_ZSTD
  ? 'gzip, deflate, br, zstd'
  : 'gzip, deflate, br';

function isZstdOnly(encoding) {
  return encoding.trim().toLowerCase() === 'zstd';
}

/**
 * Decompress a `content-encoding: zstd` response. Node's fetch understands
 * gzip, deflate, and br, but not zstd (even on releases that ship the zlib
 * bindings), so the transport wrapper has to do this one itself.
 */
export function decodeZstdResponse(response) {
  if (!response?.body) return response;

  const encoding = response.headers.get('content-encoding') || '';
  if (!isZstdOnly(encoding)) return response;

  if (!HAS_ZSTD) {
    throw new Error(
      'upstream returned a zstd body but this Node.js cannot decompress zstd',
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');

  const stream = Readable.fromWeb(response.body).pipe(
    zlib.createZstdDecompress(),
  );

  return new Response(Readable.toWeb(stream), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Wrap a fetch implementation so zstd responses are decoded before the
 * caller's JSON/SSE parser sees them.
 */
export function withZstd(fetchImpl = fetch) {
  return async (input, init) => decodeZstdResponse(await fetchImpl(input, init));
}
