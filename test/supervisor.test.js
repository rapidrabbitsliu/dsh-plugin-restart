import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startSupervisor } from '../supervisor.js';

const fixture = `
  process.on('message', message => {
    if (message.exit !== undefined) process.exit(message.exit);
  });
  process.send({ pid: process.pid, cwd: process.cwd(), url: process.env.DSH_RESTART_CONTROL_URL, token: process.env.DSH_RESTART_CONTROL_TOKEN });
`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function supervised(t, options = {}) {
  const supervisor = await startSupervisor({ command: process.execPath, args: ['-e', fixture], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], ...options });
  t.after(() => supervisor.close());
  const [ready] = await once(supervisor.child, 'message');
  return { supervisor, ready };
}
function post(supervisor, { method = 'POST', path, headers = {}, body } = {}) {
  const url = new URL(path ?? supervisor.url, supervisor.url);
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { Authorization: `Bearer ${supervisor.token}`, ...headers } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.once('error', reject);
    req.end(body);
  });
}

// These tests execute only small Node fixtures, never a DSH process.
test('exports fixed command, inherited cwd and authenticated loopback environment', async t => {
  const { supervisor, ready } = await supervised(t);
  assert.equal(new URL(supervisor.url).hostname, '127.0.0.1');
  assert.equal(ready.url, new URL('/', supervisor.url).href);
  assert.equal(ready.token, supervisor.token);
  assert.match(supervisor.token, /^[a-f0-9]{64}$/);
  assert.equal(ready.cwd, process.cwd());
  const child = supervisor.child;
  child.send({ exit: 0 });
  assert.equal(await supervisor.done, 0);
  assert.equal(supervisor.child, child, 'normal exit must not restart');
  await assert.rejects(post(supervisor));
});

test('rejects browser, unauthenticated, malformed and command-bearing requests', async t => {
  const { supervisor } = await supervised(t);
  assert.equal(await post(supervisor, { headers: { Authorization: 'Bearer wrong' } }), 401);
  assert.equal(await post(supervisor, { headers: { Authorization: '' } }), 401);
  assert.equal(await post(supervisor, { headers: { Origin: 'http://localhost' } }), 403);
  assert.equal(await post(supervisor, { headers: { 'Sec-Fetch-Site': 'none' } }), 403);
  assert.equal(await post(supervisor, { method: 'GET' }), 405);
  assert.equal(await post(supervisor, { path: '/other' }), 404);
  assert.equal(await post(supervisor, { path: '/restart?command=evil' }), 404);
  assert.equal(await post(supervisor, { body: '{"command":"evil"}', headers: { 'Content-Length': '18' } }), 400);
  const child = supervisor.child;
  child.send({ exit: 0 });
  assert.equal(await supervisor.done, 0);
  assert.equal(supervisor.child, child, 'rejected requests must never arm restart');
});

test('duplicate accepted requests arm exactly one replacement of identical command', async t => {
  const { supervisor, ready } = await supervised(t);
  const first = supervisor.child;
  assert.deepEqual(await Promise.all([post(supervisor), post(supervisor), post(supervisor)]), [202, 202, 202]);
  const exited = once(first, 'exit');
  first.send({ exit: 0 });
  await exited;
  const second = supervisor.child;
  assert.notEqual(second.pid, first.pid);
  const [secondReady] = await once(second, 'message');
  assert.equal(secondReady.url, ready.url);
  assert.equal(secondReady.token, ready.token);
  assert.equal(secondReady.cwd, ready.cwd);
  second.send({ exit: 0 });
  assert.equal(await supervisor.done, 0);
  assert.equal(supervisor.child, second, 'pending request must be consumed');
});

test('nonzero exits stop and propagate even when restart is pending', async t => {
  const { supervisor } = await supervised(t);
  const child = supervisor.child;
  assert.equal(await post(supervisor), 202);
  child.send({ exit: 7 });
  assert.equal(await supervisor.done, 7);
  assert.equal(supervisor.child, child);
});

test('expiry does not kill child, duplicate requests do not extend pending deadline', async t => {
  const { supervisor } = await supervised(t, { restartTimeoutMs: 200 });
  const child = supervisor.child;
  assert.equal(await post(supervisor), 202);
  await pause(130);
  assert.equal(await post(supervisor), 202);
  await pause(110);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  child.send({ exit: 0 });
  assert.equal(await supervisor.done, 0);
  assert.equal(supervisor.child, child);
});

test('a fresh request after expiry can arm a new restart', async t => {
  const { supervisor } = await supervised(t, { restartTimeoutMs: 100 });
  assert.equal(await post(supervisor), 202);
  await pause(140);
  assert.equal(await post(supervisor), 202);
  const first = supervisor.child;
  const exited = once(first, 'exit');
  first.send({ exit: 0 });
  await exited;
  await once(supervisor.child, 'message');
  assert.notEqual(supervisor.child, first);
});

test('close forwards signal, disables pending restart and closes HTTP listener', async t => {
  const { supervisor } = await supervised(t);
  const child = supervisor.child;
  assert.equal(await post(supervisor), 202);
  assert.equal(await supervisor.close('SIGTERM'), 143);
  assert.equal(supervisor.child, child);
  assert.equal(await supervisor.close(), 143);
  await assert.rejects(post(supervisor));
});

test('unexpected signal exits do not respawn', async t => {
  const { supervisor } = await supervised(t);
  const child = supervisor.child;
  child.kill('SIGTERM');
  const code = await supervisor.done;
  // Windows may report its native termination status instead of a signal.
  assert.notEqual(code, 0);
  assert.equal(supervisor.child, child);
});

test('spawn errors settle done and close listener', async t => {
  const supervisor = await startSupervisor({ command: `nonexistent-supervisor-command-${process.pid}`, stdio: 'ignore' });
  t.after(() => supervisor.close());
  assert.equal(await supervisor.done, 127);
  await assert.rejects(post(supervisor));
});

test('validates API options without spawning', async () => {
  await assert.rejects(startSupervisor(), TypeError);
  await assert.rejects(startSupervisor({ command: process.execPath, args: [1] }), TypeError);
  await assert.rejects(startSupervisor({ command: process.execPath, restartTimeoutMs: 0 }), TypeError);
});

test('CLI requires -- and propagates fixed executable exit status', async t => {
  const script = fileURLToPath(new URL('../supervisor.js', import.meta.url));
  for (const [args, expected] of [[[], 2], [['--', process.execPath, '-e', 'process.exit(9)'], 9]]) {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'ignore', shell: false });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const [code] = await once(child, 'exit');
    assert.equal(code, expected);
  }
});
