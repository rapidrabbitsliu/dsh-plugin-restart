import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startSupervisor } from '../supervisor.js';

// A real subprocess mounts the real Host plugin; only DSH service injection/auth is mocked.
const fixture = `
  import { createServer } from 'node:http';
  import { apply } from ${JSON.stringify(new URL('../index.js', import.meta.url).href)};
  const routes = new Map();
  const server = createServer((req, res) => {
    const route = routes.get(req.url);
    if (route) void route.handler(req, res);
    else { res.statusCode = 404; res.end(); }
  });
  const peer = { id: 'test-owner', principal: { kind: 'owner' } };
  apply({
    get: key => key === 'appExit' ? code => { server.close(); process.exit(code); } : undefined,
    effect: fn => fn(),
    logger: { warn: console.error },
    connection: { admit: () => ({ peer }), browserPeer: peer },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
  });
  server.listen(0, '127.0.0.1', () => process.send({ url: 'http://127.0.0.1:' + server.address().port, pid: process.pid }));
`;

test('real Host plugin handshake exits and supervisor starts a new instance exactly once', { timeout: 10000 }, async () => {
  const supervisor = await startSupervisor({ command: process.execPath, args: ['--input-type=module', '-e', fixture], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    const [initial] = await once(supervisor.child, 'message');
    const status = await fetch(initial.url + '/dsh-restart/status').then(r => r.json());
    assert.equal(status.supported, true);
    const post = async (path, body) => {
      const response = await fetch(initial.url + '/dsh-restart/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Restart': '1', Origin: initial.url }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const prepared = await post('prepare', {});
    assert.equal(prepared.status, 200);
    const accepted = await post('restart', { nonce: prepared.body.nonce, confirmed: true });
    assert.equal(accepted.status, 202);
    const duplicate = await post('restart', { nonce: prepared.body.nonce, confirmed: true });
    assert.equal(duplicate.status, 409);
    // launch() runs in the supervisor's earlier exit listener, before this waiter resolves.
    await once(supervisor.child, 'exit');
    const [replacement] = await once(supervisor.child, 'message');
    assert.notEqual(replacement.pid, initial.pid);
    const next = await fetch(replacement.url + '/dsh-restart/status').then(r => r.json());
    assert.notEqual(next.instance, status.instance);
    assert.equal(next.pending, false);
  } finally { await supervisor.close(); }
});
