import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './config.js';

const READY_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 3_000;

// The sidecar is deliberately not a general proxy. Keep this list in sync with
// transport/main.go.
const ALLOWED_HOSTS = new Set([
  'chat.deepseek.com',
  'hif-leim.deepseek.com',
  'hif-dliq.deepseek.com',
]);

function isAllowedTarget(url) {
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    (url.port === '' || url.port === '443') &&
    ALLOWED_HOSTS.has(url.hostname.toLowerCase())
  );
}

function headerEntries(headers) {
  if (!headers) return [];
  const entries = [];

  if (headers instanceof Headers) {
    for (const [name, value] of headers) entries.push([name.toLowerCase(), value]);
    return entries;
  }

  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      entries.push([String(name).toLowerCase(), String(value)]);
    }
    return entries;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) entries.push([name.toLowerCase(), String(item)]);
  }
  return entries;
}

function isFormData(body) {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

function hasBody(init) {
  const method = String(init.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;
  const body = init.body;
  return (
    body != null &&
    (typeof body === 'string' ||
      body instanceof Uint8Array ||
      body instanceof ArrayBuffer ||
      isFormData(body))
  );
}

// Firefox writes the multipart Content-Type and Content-Length after the author
// headers and immediately before Origin. Node adds both to the outer request
// itself, so put the names in the order hint and let the sidecar place the real
// headers.
function orderWithBodyHeaders(order, init) {
  const next = order.slice();
  const origin = next.indexOf('origin');
  const insertAt = origin === -1 ? next.length : origin;
  const names = [];

  if (isFormData(init.body) && !next.includes('content-type')) {
    names.push('content-type');
  }
  if (hasBody(init) && !next.includes('content-length')) {
    names.push('content-length');
  }
  if (names.length) next.splice(insertAt, 0, ...names);
  return next;
}

/**
 * Build a fetch-compatible function that forwards DeepSeek requests to the
 * local Firefox-impersonating sidecar. The original method, headers, body and
 * abort signal are preserved; only the destination changes.
 */
export function createTransportFetch(baseUrl, key) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);

  return async function transportFetch(input, init = {}) {
    const target =
      typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);

    if (!isAllowedTarget(target)) {
      throw new Error(`transport: refusing non-DeepSeek target ${target.origin}`);
    }

    const entries = headerEntries(init.headers);
    const order = [];
    const seen = new Set();
    for (const [name] of entries) {
      if (seen.has(name)) continue;
      seen.add(name);
      order.push(name);
    }
    const finalOrder = orderWithBodyHeaders(order, init);

    const headers = new Headers();
    for (const [name, value] of entries) headers.append(name, value);
    headers.set('x-deepseek-target', target.toString());
    headers.set('x-deepseek-method', String(init.method || 'GET').toUpperCase());
    headers.set('x-deepseek-header-order', finalOrder.join(','));
    headers.set('x-deepseek-transport-key', key);

    return globalThis.fetch(new URL('forward', base), {
      ...init,
      method: 'POST',
      headers,
      redirect: 'manual',
    });
  };
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error('Firefox transport did not become ready'));
    }, READY_TIMEOUT_MS);

    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const match = /^READY\s+(\S+)/.exec(line.trim());
        if (match) finish(null, match[1]);
      }
    };

    const onExit = (code, signal) => {
      finish(
        new Error(
          `Firefox transport exited before ready (code ${code ?? signal})`,
        ),
      );
    };

    const onError = (error) => finish(error);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        reject(error);
      } else {
        resolve(value);
      }
    }

    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, CLOSE_TIMEOUT_MS);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * Start the optional Firefox transport sidecar. Returns null for the default
 * Node transport, and throws when Firefox transport was requested but the
 * binary or profile is unavailable.
 */
export async function startTransport(config) {
  const mode = String(config?.transport || 'node').toLowerCase();
  if (mode === 'node') return null;
  if (mode !== 'firefox') {
    throw new Error(`unknown transport '${config.transport}' (use node or firefox)`);
  }

  const binary =
    config.transportBinary || path.join(ROOT, 'transport', 'deepseek-transport');
  if (!fs.existsSync(binary)) {
    throw new Error(
      `Firefox transport binary not found: ${binary}\nBuild it with: make transport`,
    );
  }

  const key = crypto.randomBytes(32).toString('hex');
  const args = [
    '--listen',
    '127.0.0.1:0',
    '--key',
    key,
    '--profile',
    config.transportProfile || 'firefox_159',
    '--parent-pid',
    String(process.pid),
  ];

  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const baseUrl = await waitForReady(child);

  let stopping = false;
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(
        `Firefox transport exited (code ${code ?? signal}); restart the router to use it again`,
      );
    }
  });

  return {
    baseUrl,
    fetch: createTransportFetch(baseUrl, key),
    close: async () => {
      stopping = true;
      await stopChild(child);
    },
  };
}
