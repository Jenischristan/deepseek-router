import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_DIR } from './config.js';

export const PID_FILE = path.join(CONFIG_DIR, 'router.pid');
export const LOG_FILE = path.join(CONFIG_DIR, 'router.log');

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');

export function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isRunning(pid = readPid()) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function status() {
  const pid = readPid();
  const running = isRunning(pid);
  return { pid: running ? pid : null, running, pidFile: PID_FILE, logFile: LOG_FILE };
}

export function startDetached({ env = {}, args = [] } = {}) {
  const existing = status();
  if (existing.running) {
    return { started: false, ...existing };
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const log = fs.openSync(LOG_FILE, 'a', 0o600);

  const child = spawn(process.execPath, [INDEX, '--foreground', ...args], {
    detached: true,
    stdio: ['ignore', log, log],
    cwd: path.dirname(path.dirname(INDEX)),
    env: { ...process.env, ...env, DEEPSEEK_ROUTER_FOREGROUND: '1' },
  });

  child.unref();
  fs.closeSync(log);

  if (child.pid) {
    try {
      fs.writeFileSync(PID_FILE, `${child.pid}\n`, { mode: 0o600 });
    } catch {
      // ignore: status will fall back to "not running"
    }
  }

  return { started: true, pid: child.pid, running: true, pidFile: PID_FILE, logFile: LOG_FILE };
}

export function stopDetached({ timeoutMs = 5000 } = {}) {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
    return { stopped: false, pid: null };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) break;
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    } catch {
      break;
    }
  }

  if (isRunning(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }

  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }

  return { stopped: true, pid };
}

export function tailLog(lines = 50) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8');
    return text.split('\n').slice(-lines - 1).join('\n');
  } catch {
    return '';
  }
}
