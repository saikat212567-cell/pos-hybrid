/**
 * POS API on Cloudflare Workers + D1.
 *
 * Endpoints:
 *   GET  /products  -> catalog
 *   POST /sales     -> record a sale (idempotent on client_ref)
 *
 * Money is integer cents everywhere. The clients convert for display only.
 *
 * AUTH: every request needs `Authorization: Bearer <POS_TOKEN>`. This is a
 * shared secret, set with `wrangler secret put POS_TOKEN`. It ships inside the
 * APK and the web page, so treat it as "keeps strangers out", not "keeps a
 * determined attacker out" — it's a write-only sales endpoint with no reads of
 * historical data, so the blast radius of a leaked token is bounded to junk
 * sales. Rotate it by setting a new secret and rebuilding the clients.
 */

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(), ...extra },
  });

// The web app is a static file that may be opened from anywhere (file://,
// Pages, a LAN host), so the origin isn't predictable. The bearer token is the
// real check; CORS here just lets the browser through.
const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
});

/** Constant-time-ish compare so the token check doesn't leak length by timing. */
function tokenOk(header, secret) {
  if (!secret) return false;                       // misconfigured: fail closed
  const got = (header || '').replace(/^Bearer\s+/i, '');
  if (got.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (!tokenOk(request.headers.get('Authorization'), env.POS_TOKEN)) {
      return json({ error: 'unauthorized' }, 401);
    }

    try {
      if (url.pathname === '/products' && request.method === 'GET') {
        return await listProducts(env);
      }
      if (url.pathname === '/sales' && request.method === 'POST') {
        return await recordSale(request, env);
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      // Log for `wrangler tail`; don't leak internals to the client.
      console.error('unhandled', err);
      return json({ error: 'internal error' }, 500);
    }
  },
};

async function listProducts(env) {
  const { results } = await env.DB
    .prepare('SELECT id, name, price, stock FROM products ORDER BY name')
    .all();
  return json(results);
}

async function recordSale(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'malformed json' }, 400);
  }

  // --- validate at the trust boundary -------------------------------------
  const { client_ref, source, total, items } = body ?? {};

  if (typeof client_ref !== 'string' || client_ref.length < 8 || client_ref.length > 64) {
    return json({ error: 'client_ref must be a string of 8-64 chars' }, 400);
  }
  if (!Number.isInteger(total) || total < 0) {
    return json({ error: 'total must be a non-negative integer (cents)' }, 400);
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) {
    return json({ error: 'items must be a non-empty array (max 200)' }, 400);
  }
  for (const it of items) {
    if (typeof it?.id !== 'string' || !Number.isInteger(it?.qty) || it.qty <= 0) {
      return json({ error: 'each item needs a string id and positive integer qty' }, 400);
    }
  }
  const src = source === 'android' ? 'android' : 'web';

  // --- write ---------------------------------------------------------------
  // batch() is one atomic transaction: the sale and every stock decrement
  // land together, or nothing does. Without this a crash mid-loop leaves
  // stock decremented for a sale that was never recorded.
  const stmts = [
    env.DB.prepare(
      'INSERT INTO sales (client_ref, source, total, items) VALUES (?, ?, ?, ?)'
    ).bind(client_ref, src, total, JSON.stringify(items)),
    ...items.map(it =>
      env.DB.prepare(
        'UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?'
      ).bind(it.qty, it.id)
    ),
  ];

  try {
    await env.DB.batch(stmts);
  } catch (err) {
    // The client_ref PRIMARY KEY collided: this exact sale is already stored.
    // That means a previous attempt succeeded and only its response was lost,
    // so report success — this is what makes offline retries safe.
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(err.message ?? '')) {
      return json({ ok: true, duplicate: true }, 200);
    }
    throw err;
  }

  return json({ ok: true }, 201);
}
