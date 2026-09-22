/**
 * POS API on Cloudflare Workers + D1.
 *
 * Endpoints:
 *   GET  /products  -> catalog                    (POS_TOKEN)
 *   POST /sales     -> record a sale, idempotent  (POS_TOKEN)
 *   GET  /sales     -> recent sales history       (POS_ADMIN_TOKEN)
 *
 * Money is integer cents everywhere. The clients convert for display only.
 *
 * TWO TOKENS, deliberately:
 *
 *   POS_TOKEN is compiled into the APK and visible in the web page's source.
 *   Anyone who has either can extract it, so it only gates the two endpoints a
 *   till needs: list products, insert a sale. Worst case with a leaked
 *   POS_TOKEN is junk sales in your data — annoying, not a breach.
 *
 *   POS_ADMIN_TOKEN gates reading sales history, and is deliberately NOT
 *   shipped in either client. You type it when you want to look at takings.
 *   If both tokens were one, extracting the APK would expose your entire
 *   revenue history.
 *
 * Set both with `wrangler secret put`, and rotate by setting a new value.
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

    const auth = request.headers.get('Authorization');
    // Admin token also works on till routes, so you can use one token for
    // everything when testing. The reverse is never true.
    const till = tokenOk(auth, env.POS_TOKEN) || tokenOk(auth, env.POS_ADMIN_TOKEN);
    const admin = tokenOk(auth, env.POS_ADMIN_TOKEN);

    try {
      if (url.pathname === '/products' && request.method === 'GET') {
        if (!till) return json({ error: 'unauthorized' }, 401);
        return await listProducts(env);
      }
      if (url.pathname === '/sales' && request.method === 'POST') {
        if (!till) return json({ error: 'unauthorized' }, 401);
        return await recordSale(request, env);
      }
      if (url.pathname === '/sales' && request.method === 'GET') {
        // Reading revenue history needs the admin token, which is not in any
        // shipped client.
        if (!admin) return json({ error: 'unauthorized' }, 401);
        return await listSales(url, env);
      }
      if (!till) return json({ error: 'unauthorized' }, 401);
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

/**
 * Recent sales, newest first. Admin only.
 *
 * ?limit=N     how many rows (1-500, default 50)
 * ?since=DATE  only sales at/after this ISO date, e.g. 2026-09-01
 */
async function listSales(url, env) {
  // Clamp rather than reject: a silly limit shouldn't 400, and an unbounded
  // one would scan the whole table.
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
  const since = url.searchParams.get('since');

  const { results } = since
    ? await env.DB.prepare(
        'SELECT client_ref, source, total, items, sold_at FROM sales ' +
        'WHERE sold_at >= ? ORDER BY sold_at DESC LIMIT ?'
      ).bind(since, limit).all()
    : await env.DB.prepare(
        'SELECT client_ref, source, total, items, sold_at FROM sales ' +
        'ORDER BY sold_at DESC LIMIT ?'
      ).bind(limit).all();

  // items is stored as a JSON string; parse so callers get real arrays.
  const sales = results.map(r => ({ ...r, items: JSON.parse(r.items) }));

  return json({
    sales,
    count: sales.length,
    // Convenience: what these rows add up to, so a caller doesn't have to.
    totalCents: sales.reduce((s, r) => s + r.total, 0),
  });
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
