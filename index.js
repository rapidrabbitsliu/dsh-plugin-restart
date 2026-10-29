import { request } from 'node:http';
import { authorize, createRestartState, HttpError, readBody, supervisorChannel } from './core.js';

export const name = 'dsh-restart';
export const inject = ['webServer', 'connection'];

/** Register only plugin-local owner-browser endpoints. */
export function apply(ctx) {
  const channel = supervisorChannel();
  const exit = ctx.get('appExit');
  let alive = true;
  let exitTimer;
  const state = createRestartState({
    supported: !!channel && typeof exit === 'function',
    async arm() {
      try {
        await new Promise((resolve, reject) => {
          const outgoing = request(channel.url, { method: 'POST', headers: { Authorization: `Bearer ${channel.token}` }, signal: AbortSignal.timeout(3000) }, response => {
            response.resume();
            if (response.statusCode === 202) resolve();
            else reject(new Error('Supervisor rejected the request'));
          });
          outgoing.on('error', reject);
          outgoing.end();
        });
      } catch (error) {
        ctx.logger?.warn?.('Restart supervisor unavailable: %s', error.message);
        throw new HttpError(503, 'Restart supervisor unavailable');
      }
    },
  });
  ctx.effect(() => () => { alive = false; clearTimeout(exitTimer); state.dispose(); });
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  for (const [path, method] of [['status', 'GET'], ['prepare', 'POST'], ['restart', 'POST']]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `/dsh-restart/${path}`, handler: async (req, res) => {
      try {
        authorize(req, ctx.connection);
        if (req.method !== method) { res.setHeader('Allow', method); throw new HttpError(405, 'Method not allowed'); }
        if (path === 'status') { reply(res, 200, state.status()); return; }
        const body = await readBody(req);
        if (path === 'prepare') { reply(res, 200, state.prepare()); return; }
        const result = await state.request(body);
        // Restart acceptance commits the operation; a lost browser connection must not cancel it.
        if (alive) exitTimer = setTimeout(() => { if (alive) exit(0); }, 400);
        reply(res, 202, result);
      } catch (error) {
        if (!(error instanceof HttpError)) ctx.logger?.warn?.('Restart request failed: %s', error.message);
        if (!res.headersSent && !res.destroyed) reply(res, error instanceof HttpError ? error.status : 500,
          { error: error instanceof HttpError ? error.message : 'Restart request failed' });
      }
    } }));
  }
}
