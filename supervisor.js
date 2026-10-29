#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Supervise a fixed command. A restart is armed only by an authenticated POST,
 * and consumes exactly one successful child exit within restartTimeoutMs.
 * done resolves to the final numeric exit status; close() disables restarts,
 * forwards its signal, and returns that same promise. No shell is involved.
 */
export async function startSupervisor({ command, args = [], cwd, stdio = 'inherit', restartTimeoutMs = 15_000 } = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new TypeError('command must be a nonempty string and args must be an array of strings');
  }
  if (!Number.isFinite(restartTimeoutMs) || restartTimeoutMs <= 0) {
    throw new TypeError('restartTimeoutMs must be positive');
  }
  // Snapshot invocation details so every replacement uses the same command.
  const childArgs = [...args];
  const childCwd = cwd ?? process.cwd();
  const childEnv = { ...process.env };
  const token = randomBytes(32).toString('hex');
  const secret = Buffer.from(`Bearer ${token}`);
  let child;
  let pendingTimer;
  let stopping = false;
  let finished = false;
  let stopSignal;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const clearPending = () => {
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
  };
  const signalCode = signal => 128 + (constants.signals[signal] || 1);
  const handlers = new Map();
  const server = createServer((request, response) => {
    const reply = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
      response.end(JSON.stringify({ message }));
    };
    // This is a host-to-host channel, not a browser API. Never enable CORS.
    if ('origin' in request.headers || Object.keys(request.headers).some(key => key.startsWith('sec-fetch-'))) {
      reply(403, 'Browser requests are forbidden');
      return;
    }
    const authorization = Buffer.from(request.headers.authorization || '');
    if (authorization.length !== secret.length || !timingSafeEqual(authorization, secret)) {
      reply(401, 'Unauthorized');
      return;
    }
    if (request.url !== '/restart') {
      reply(404, 'Not found');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      reply(405, 'POST required');
      return;
    }
    // The command and arguments come exclusively from startSupervisor/CLI.
    if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) !== 0) {
      reply(400, 'Request body is not supported');
      return;
    }
    if (stopping || finished || !child || child.exitCode !== null || child.signalCode !== null) {
      reply(409, 'Supervisor is stopping');
      return;
    }
    if (!pendingTimer) {
      pendingTimer = setTimeout(clearPending, restartTimeoutMs);
      pendingTimer.unref();
    }
    reply(202, 'Restart accepted');
  });
  // Malformed HTTP must not become an unhandled server error.
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  await new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListening();
    });
  });
  const url = `http://127.0.0.1:${server.address().port}/restart`;
  const finish = code => {
    if (finished) return;
    finished = true;
    stopping = true;
    clearPending();
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    server.close(() => resolveDone(code));
    // Idle/malicious HTTP connections must not keep shutdown pending.
    server.closeAllConnections();
  };
  const launch = () => {
    try {
      child = spawn(command, childArgs, {
        cwd: childCwd,
        stdio,
        shell: false,
        env: { ...childEnv, DSH_RESTART_CONTROL_URL: new URL('/', url).href, DSH_RESTART_CONTROL_TOKEN: token },
      });
    } catch {
      finish(1);
      return;
    }
    const current = child;
    current.once('error', error => finish(error.code === 'ENOENT' ? 127 : 1));
    current.once('exit', (code, signal) => {
      if (finished) return;
      const restart = !stopping && Boolean(pendingTimer) && code === 0;
      clearPending();
      if (restart) launch();
      else finish(stopSignal ? signalCode(stopSignal) : (code ?? signalCode(signal)));
    });
  };
  const close = (signal = 'SIGTERM') => {
    if (stopping || finished) return done;
    stopping = true;
    stopSignal = signal;
    clearPending();
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(signal); } catch { finish(1); }
    } else finish(0);
    return done;
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => { void close(signal); };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  server.on('error', () => { void close(); });
  launch();
  return { url, token, get child() { return child; }, close, done };
}

const directInvocation = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (directInvocation) {
  const separator = process.argv.indexOf('--', 2);
  if (separator !== 2 || !process.argv[separator + 1]) {
    console.error('Usage: node supervisor.js -- <executable> [args...]');
    process.exitCode = 2;
  } else {
    try {
      const supervisor = await startSupervisor({ command: process.argv[3], args: process.argv.slice(4) });
      process.exitCode = await supervisor.done;
    } catch (error) {
      console.error(`Supervisor failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
