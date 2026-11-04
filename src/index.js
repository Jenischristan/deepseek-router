#!/usr/bin/env node
import fs from 'node:fs';

import { loadConfig } from './config.js';
import { DeepSeekClient } from './deepseek.js';
import { MODELS } from './server.js';
import { PowSolver } from './pow.js';
import { createServer } from './server.js';
import { TokenStore } from './token.js';
import { startTransport } from './transport.js';

export async function runForeground() {
  const config = loadConfig();

  if (!fs.existsSync(config.wasmPath)) {
    console.error(`Missing PoW solver wasm: ${config.wasmPath}`);
    console.error('Copy the DeepSeek sha3 wasm to assets/sha3.wasm or set SHA3_WASM.');
    process.exit(1);
  }

  let solver;
  try {
    solver = new PowSolver(config.wasmPath);
  } catch (error) {
    console.error(`Failed to initialize PoW solver: ${error.message}`);
    process.exit(1);
  }

  let transport;
  try {
    transport = await startTransport(config);
  } catch (error) {
    console.error(`Failed to start transport: ${error.message}`);
    process.exit(1);
  }

  const tokenStore = new TokenStore(config);
  const client = new DeepSeekClient({
    tokenStore,
    solver,
    config,
    fetchImpl: transport?.fetch,
  });
  const server = createServer({ config, tokenStore, client });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${config.port} is already in use. Set PORT to another value.`);
    } else {
      console.error(`Server error: ${error.message}`);
    }
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));

  const url = `http://${config.host}:${config.port}`;
  const status = tokenStore.status();
  console.log(`deepseek-router listening on ${url}`);
  console.log(
    `  token:  ${
      status.hasToken
        ? `configured (account ${status.activeAccount}/${status.accounts})`
        : 'MISSING (run scripts/get-token.py --write)'
    }`,
  );
  console.log(`  auth:   ${config.apiKey ? 'enabled (API key required)' : 'disabled'}`);
  console.log(`  models: ${MODELS.map((model) => model.id).join(', ')}`);
  console.log(
    `  transport: ${transport ? `firefox sidecar (${config.transportProfile})` : 'node fetch'}`,
  );
  console.log(
    `  upstream: serialized, request delay ${
      config.requestDelaySeconds != null
        ? `${config.requestDelaySeconds}s`
        : `${config.minIntervalMs}ms`
    }`,
  );

  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    server.close(async () => {
      await transport?.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  await runForeground();
}
