import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { authorize, createRestartState, readBody, supervisorChannel } from '../core.js';
import { apply } from '../index.js';

test('only owner browser with exact Origin and custom confirmation header can mutate', () => {
  const peer = { id: 'browser', principal: { kind: 'owner' } };
  const connection = { admit: () => ({ peer }), browserPeer: peer };
  const req = { method: 'POST', headers: { host: 'localhost:3090', origin: 'http://localhost:3090', 'x-dsh-restart': '1' }, socket: {} };
  assert.doesNotThrow(() => authorize(req, connection));
  for (const origin of [undefined, 'null', 'http://evil.test', 'http://localhost:3090.evil.test']) assert.throws(() => authorize({ ...req, headers: { ...req.headers, origin } }, connection), { status: 403 });
  assert.throws(() => authorize({ ...req, headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } }, connection), { status: 403 });
  assert.throws(() => authorize(req, { ...connection, admit: () => ({ rejection: 401 }) }), { status: 401 });
  assert.throws(() => authorize(req, { ...connection, admit: () => ({ peer: { ...peer, id: 'agent' } }) }), { status: 403 });
});

test('one-use expiring confirmations serialize restart and recover on supervisor failure', async () => {
  let now = 1000, calls = 0;
  let resolve;
  const state = createRestartState({ supported: true, now: () => now, arm: () => { calls++; return new Promise(r => { resolve = r; }); } });
  const expired = state.prepare(); now += 60001;
  await assert.rejects(state.request({ nonce: expired.nonce, confirmed: true }), { status: 400 });
  const valid = state.prepare();
  await assert.rejects(state.request({ nonce: valid.nonce, confirmed: false }), { status: 400 });
  const first = state.request({ nonce: valid.nonce, confirmed: true });
  await assert.rejects(state.request({ nonce: valid.nonce, confirmed: true }), { status: 409 });
  resolve(); assert.equal((await first).accepted, true); assert.equal(calls, 1);
  state.dispose(); assert.throws(() => state.prepare(), { status: 409 });
  const failure = createRestartState({ supported: true, arm: async () => { throw new Error('offline'); } });
  await assert.rejects(failure.request({ ...failure.prepare(), confirmed: true }), /offline/);
  assert.equal(failure.status().pending, false);
  assert.throws(() => createRestartState({ supported: false }).prepare(), { status: 409 });
});

test('private supervisor channel accepts only explicit loopback root URL', () => {
  assert.equal(supervisorChannel({}), null);
  assert.equal(supervisorChannel({ DSH_RESTART_CONTROL_URL: 'http://127.0.0.1:1234/', DSH_RESTART_CONTROL_TOKEN: 'secret' }).url.href, 'http://127.0.0.1:1234/restart');
  for (const url of ['http://evil.test/', 'http://127.0.0.1:12/path', 'https://127.0.0.1:12/', 'http://user@127.0.0.1:12/']) assert.throws(() => supervisorChannel({ DSH_RESTART_CONTROL_URL: url, DSH_RESTART_CONTROL_TOKEN: 'x' }));
});

test('body parser rejects invalid types, malformed JSON and oversized bodies', async () => {
  const req = (value, type = 'application/json') => Object.assign(Readable.from([Buffer.from(value)]), { headers: { 'content-type': type } });
  assert.deepEqual(await readBody(req('{}')), {});
  await assert.rejects(readBody(req('{}', 'text/plain')), { status: 415 });
  for (const value of ['[]', 'null', '{']) await assert.rejects(readBody(req(value)), { status: 400 });
  await assert.rejects(readBody(req('x'.repeat(1025))), { status: 413 });
});

test('plugin routes register and dispose without invoking exit when unsupported', async () => {
  const previous = process.env.DSH_RESTART_CONTROL_URL;
  delete process.env.DSH_RESTART_CONTROL_URL;
  const routes = new Map(), disposers = [];
  const ctx = { get: () => undefined, effect(fn) { disposers.push(fn()); }, webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } }, connection: { admit: () => ({ peer: { id: 'b', principal: { kind: 'owner' } } }), browserPeer: { id: 'b' } } };
  try {
    apply(ctx); assert.equal(routes.size, 3);
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await routes.get('/dsh-restart/status').handler({ method: 'GET', headers: {} }, res);
    assert.equal(res.status, 200); assert.equal(res.body.supported, false); assert.ok(res.body.instance);
    for (const dispose of disposers.reverse()) dispose();
    assert.equal(routes.size, 0);
  } finally { if (previous !== undefined) process.env.DSH_RESTART_CONTROL_URL = previous; }
});
