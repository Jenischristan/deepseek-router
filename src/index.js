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

  let solver = null;
  if (config.powChallengeEnabled !== false) {
    if (!fs.existsSync(config.wasmPath)) {
      console.error(`Missing PoW solver wasm: ${config.wasmPath}`);
      console.error('Copy the DeepSeek sha3 wasm to assets/sha3.wasm or set SHA3_WASM.');
      process.exit(1);
    }

    try {
      solver = new PowSolver(config.wasmPath);
    } catch (error) {
      console.error(`Failed to initialize PoW solver: ${error.message}`);
      process.exit(1);
    }
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
  console.log(
    `  extras:   pow challenge ${
      config.powChallengeEnabled === false ? 'disabled' : 'enabled'
    }, hif refresh ${config.hifRefreshEnabled === false ? 'disabled' : 'enabled'}`,
  );
  console.log(
    `  tool cooldown: ${
      config.toolResultDelaySeconds != null && config.toolResultDelaySeconds > 0
        ? `${config.toolResultDelaySeconds}s base (` +
          `${(config.toolResultDelaySeconds * 0.7).toFixed(1)}-` +
          `${(config.toolResultDelaySeconds * 0.95).toFixed(1)}s actual, skip after ` +
          `${config.toolResultSkipAfterSeconds ?? 8}s execution)`
        : 'disabled'
    }`,
  );

  // Flag settings that make the router look less like a browser session and
  // more like an account farm. These are warnings only; the user can still
  // opt into them deliberately.
  if (!transport) {
    console.warn(
      'warning: transport=node uses Node HTTP/1.1 + OpenSSL, not Firefox HTTP/2/TLS; use transport=firefox unless you have a reason not to.',
    );
  }
  if (config.accountSwitchAfter > 0 && tokenStore.count > 1) {
    console.warn(
      `warning: accountSwitchAfter=${config.accountSwitchAfter} rotates accounts every ${config.accountSwitchAfter} messages; this is a strong multi-account abuse signal. Prefer 0.`,
    );
  }
  if (
    config.requestDelaySeconds != null &&
    Number(config.requestDelaySeconds) >= 0 &&
    Number(config.requestDelaySeconds) < 4
  ) {
    console.warn(
      `warning: requestDelaySeconds=${config.requestDelaySeconds} is faster than a human web session; DeepSeek may rate-limit or challenge the account.`,
    );
  }
  tokenStore.accounts.forEach((account, index) => {
    if (!/(?:^|;\s*)aws-waf-token=/.test(account.cookies || '')) {
      console.warn(
        `warning: account ${index + 1} has no aws-waf-token cookie; DeepSeek may require captcha verification. Re-run scripts/get-token.py --write-accounts while logged in.`,
      );
    }
    if (!account.deviceId) {
      console.warn(
        `warning: account ${index + 1} has no DeepSeek device id; requests will omit x-device-id. Re-run scripts/get-token.py --write-accounts while logged in.`,
      );
    }
    if (!account.hifDliq) {
      console.warn(
        `warning: account ${index + 1} has no hifDliq value; its completion request will omit x-hif-dliq.`,
      );
    }
  });

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
