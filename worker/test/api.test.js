/**
 * Checks the Worker against a real local D1 (SQLite) via `wrangler dev`.
 *
 * Run: npm test   (from worker/)
 * Assumes `npm run migrate:local` has been run at least once.
 *
 * Plain node:test + fetch. No framework: this is one HTTP surface with two
 * endpoints.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Defaults match `npm run dev:test`.
const TOKEN = process.env.POS_TOKEN ?? 'test-token';
const BASE = process.env.POS_API ?? 'http://127.0.0.1:8801';

// The server is started separately (see `npm test` in package.json) rather
// than spawned here: killing wrangler's process tree from node on Windows is
// unreliable and leaves the test runner hanging forever.
before(async () => {
  try {
    await fetch(`${BASE}/products`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  } catch {
    throw new Error(
      `No server at ${BASE}. Start one in another shell with:\n` +
      `  npm run dev:test`
    );
  }
});

const call = (path, opts = {}, token = TOKEN) =>
  fetch(BASE + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });

const sale = (over = {}) => ({
  client_ref: crypto.randomUUID(),
  source: 'web',
  total: 500,
  items: [{ id: 'espresso', name: 'Espresso', price: 250, qty: 2 }],
  ...over,
});

test('rejects a missing token', async () => {
  const res = await fetch(`${BASE}/products`);
  assert.equal(res.status, 401);
});

test('rejects a wrong token', async () => {
  const res = await call('/products', {}, 'wrong-token');
  assert.equal(res.status, 401);
});

test('serves the seeded catalog', async () => {
  const res = await call('/products');
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(rows.length >= 8, `expected seeded products, got ${rows.length}`);
  // Prices are cents: integers, never floats.
  assert.ok(rows.every(r => Number.isInteger(r.price)));
});

test('records a sale', async () => {
  const res = await call('/sales', { method: 'POST', body: JSON.stringify(sale()) });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true });
});

test('replaying the same client_ref is a no-op, not a double charge', async () => {
  const s = sale();
  const first = await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  assert.equal(first.status, 201);

  // Same payload again: what an offline device does when a response is lost.
  const retry = await call('/sales', { method: 'POST', body: JSON.stringify(s) });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
});

test('a sale decrements stock', async () => {
  const before = (await (await call('/products')).json()).find(p => p.id === 'water').stock;
  await call('/sales', {
    method: 'POST',
    body: JSON.stringify(sale({ items: [{ id: 'water', qty: 3 }], total: 360 })),
  });
  const after = (await (await call('/products')).json()).find(p => p.id === 'water').stock;
  assert.equal(after, before - 3);
});

test('rejects bad payloads', async () => {
  const bad = [
    { body: sale({ client_ref: 'short' }),        why: 'client_ref too short' },
    { body: sale({ total: -1 }),                  why: 'negative total' },
    { body: sale({ total: 1.5 }),                 why: 'fractional cents' },
    { body: sale({ items: [] }),                  why: 'empty items' },
    { body: sale({ items: [{ id: 'x', qty: 0 }] }), why: 'zero qty' },
    { body: sale({ items: [{ qty: 1 }] }),        why: 'item without id' },
  ];
  for (const { body, why } of bad) {
    const res = await call('/sales', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(res.status, 400, `should reject: ${why}`);
  }
});

test('rejects malformed json', async () => {
  const res = await call('/sales', { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
});

test('unknown route is 404', async () => {
  assert.equal((await call('/nope')).status, 404);
});
