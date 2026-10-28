#!/usr/bin/env node
import { loadConfig } from './config.js';
import { LOG_FILE, PID_FILE, startDetached, status, stopDetached, tailLog } from './daemon.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('-')));
const command = args.find((arg) => !arg.startsWith('-')) || (flags.size ? null : 'start');

function printUsage(out = process.stdout) {
  out.write(
    [
      'deepseek-router - OpenAI-compatible router for chat.deepseek.com',
      '',
      'Usage:',
      '  deepseek-router                  start in the background (default)',
      '  deepseek-router start            same as above',
      '  deepseek-router start --foreground',
      '                                   run in this terminal with live logs',
      '  deepseek-router stop             stop the background server',
      '  deepseek-router status           show pid/log paths and state',
      '  deepseek-router logs [-n N]      print the last N log lines',
      '  deepseek-router dashboard        open the FTXUI dashboard',
      '',
      'Options:',
      '  -f, --foreground                 stay attached to the terminal',
      '  -p, --port PORT                  listen port (default 8788)',
      '  -H, --host HOST                  listen host (default 127.0.0.1)',
      '  -n, --lines N                    lines for `logs` (default 50)',
      '  -h, --help                       show this help',
      '',
    ].join('\n'),
  );
}

function valueFor(...names) {
  for (let i = 0; i < args.length; i += 1) {
    if (names.includes(args[i])) return args[i + 1];
  }
  return null;
}

if (flags.has('-h') || flags.has('--help')) {
  printUsage();
  process.exit(0);
}

if (command === 'status') {
  const info = status();
  process.stdout.write(
    [
      `state:    ${info.running ? 'running' : 'stopped'}`,
      `pid:      ${info.pid ?? '-'}`,
      `pid file: ${PID_FILE}`,
      `log file: ${LOG_FILE}`,
      '',
    ].join('\n'),
  );
  process.exit(info.running ? 0 : 3);
}

if (command === 'stop') {
  const result = stopDetached();
  process.stdout.write(result.stopped ? `stopped pid ${result.pid}\n` : 'not running\n');
  process.exit(0);
}

if (command === 'logs') {
  const count = Number(valueFor('-n', '--lines') || 50);
  const text = tailLog(Number.isFinite(count) ? count : 50);
  process.stdout.write(text ? `${text.replace(/\n?$/, '\n')}` : `no log file at ${LOG_FILE}\n`);
  process.exit(0);
}

if (command === 'dashboard') {
  const { spawnSync } = await import('node:child_process');
  const { ROOT } = await import('./config.js');
  const path = await import('node:path');
  const fs = await import('node:fs');

  const binary = path.join(ROOT, 'tui', 'deepseek-router-tui');
  if (!fs.existsSync(binary)) {
    process.stderr.write(
      `dashboard binary not built: ${binary}\n` +
        'build it with: make tui   (needs system FTXUI, see tui/Makefile)\n',
    );
    process.exit(1);
  }

  const config = loadConfig();
  const tuiArgs = [binary, '--port', String(config.port)];
  const interval = valueFor('-i', '--interval');
  const lines = valueFor('-n', '--lines');
  const url = valueFor('-u', '--url');
  if (url) tuiArgs.push('--url', String(url));
  if (interval) tuiArgs.push('--interval', String(interval));
  if (lines) tuiArgs.push('--lines', String(lines));

  const result = spawnSync(tuiArgs[0], tuiArgs.slice(1), { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

if (command && command !== 'start') {
  process.stderr.write(`deepseek-router: unknown command '${command}'\n\n`);
  printUsage(process.stderr);
  process.exit(2);
}

const foreground =
  flags.has('-f') ||
  flags.has('--foreground') ||
  process.env.DEEPSEEK_ROUTER_FOREGROUND === '1';

if (foreground) {
  const { runForeground } = await import('./index.js');
  await runForeground();
} else {
  const port = valueFor('-p', '--port');
  const host = valueFor('-H', '--host');
  const env = {};
  if (port) env.PORT = String(port);
  if (host) env.HOST = String(host);

  const config = loadConfig();
  if (env.PORT) config.port = Number(env.PORT);
  if (env.HOST) config.host = env.HOST;

  const result = startDetached({ env });
  if (!result.started) {
    process.stdout.write(
      `already running (pid ${result.pid}); use \`deepseek-router logs\` or \`deepseek-router stop\`\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    [
      `started deepseek-router in the background (pid ${result.pid})`,
      `  url:      http://${config.host}:${config.port}`,
      `  logs:     ${LOG_FILE}`,
      '  stop:     deepseek-router stop',
      '  attached: deepseek-router start --foreground',
      '',
    ].join('\n'),
  );
}
