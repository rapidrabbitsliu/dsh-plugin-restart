import { randomBytes, randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Admit only the authenticated owner browser and same-origin requests. */
export function authorize(req, connection) {
  const admission = connection.admit(req);
  if ('rejection' in admission) throw new HttpError(admission.rejection, 'Authentication required');
  if (admission.peer.principal.kind !== 'owner' || admission.peer.id !== connection.browserPeer.id) {
    throw new HttpError(403, 'Owner browser required');
  }
  if (req.method !== 'GET') {
    const expected = `${req.socket?.encrypted ? 'https:' : 'http:'}//${req.headers.host}`;
    if (req.headers.origin !== expected || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new HttpError(403, 'Same-origin request required');
    }
    if (req.headers['x-dsh-restart'] !== '1') throw new HttpError(403, 'Confirmation header required');
  }
}

export async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'JSON required');
  let size = 0;
  const chunks = [];
  const timer = setTimeout(() => req.destroy(new Error('Request timeout')), 5000);
  timer.unref?.();
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024) throw new HttpError(413, 'Request too large');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'Invalid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON object required');
    return body;
  } finally { clearTimeout(timer); }
}

/** Validate the private supervisor channel; never accept its address from HTTP. */
export function supervisorChannel(env = process.env) {
  const address = env.DSH_RESTART_CONTROL_URL;
  const token = env.DSH_RESTART_CONTROL_TOKEN;
  if (!address || !token) return null;
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Invalid restart supervisor URL');
  }
  return { url: new URL('restart', url), token };
}

/** Instance-owned one-use confirmations and restart serialization. */
export function createRestartState({ supported, arm, now = Date.now }) {
  const instance = randomUUID();
  const nonces = new Map();
  let pending = false;
  let disposed = false;
  return {
    status: () => ({ instance, supported, pending }),
    prepare() {
      if (disposed || !supported) throw new HttpError(409, 'Start DSH using the restart supervisor first');
      if (pending) throw new HttpError(409, 'Restart already pending');
      for (const [key, expiry] of nonces) if (expiry <= now()) nonces.delete(key);
      if (nonces.size >= 64) throw new HttpError(429, 'Too many confirmations');
      const nonce = randomBytes(32).toString('hex');
      nonces.set(nonce, now() + 60000);
      return { nonce, instance };
    },
    async request(body) {
      if (disposed || !supported || pending) throw new HttpError(409, 'Restart unavailable or already pending');
      if (body.confirmed !== true || typeof body.nonce !== 'string' || (nonces.get(body.nonce) ?? 0) <= now()) {
        throw new HttpError(400, 'Confirmation expired or invalid');
      }
      nonces.delete(body.nonce);
      pending = true;
      try { await arm(); }
      catch (error) { pending = false; throw error; }
      if (disposed) throw new HttpError(409, 'Plugin disabled');
      nonces.clear();
      return { accepted: true, instance };
    },
    dispose() { disposed = true; nonces.clear(); },
  };
}
