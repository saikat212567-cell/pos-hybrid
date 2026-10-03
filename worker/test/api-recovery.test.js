/** HTTP handlers against real SQLite and the reviewed 0001–0005 schema, no server. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

const TOKEN = 'test-token';
const ADMIN = 'admin-token-x';
const migrations = [
  '0001_initial.sql', '0002_foundation.sql', '0003_items_images.sql',
  '0004_refunds.sql', '0005_actor_identity.sql',
].map(name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of migrations) sqlite.exec(sql);
  t.after(() => sqlite.close());
  const queries = [];
  function statement(sql, params = []) {
    return {
      bind: (...values) => statement(sql, values),
      async all() { queries.push(sql); return { results: sqlite.prepare(sql).all(...params) }; },
      async first() { queries.push(sql); return sqlite.prepare(sql).get(...params) ?? null; },
      async run() { queries.push(sql); return sqlite.prepare(sql).run(...params); },
    };
  }
  const DB = {
    prepare: sql => statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const env = {
    DB, POS_TOKEN: TOKEN, POS_ADMIN_TOKEN: ADMIN,
    IMAGES: {
      async get(key) {
        if (key !== 'items/espresso') return null;
        return {
          body: new Uint8Array([137, 80, 78, 71]), httpEtag: '"fixture"',
          writeHttpMetadata(headers) { headers.set('Content-Type', 'image/png'); },
        };
      },
    },
  };
  const call = (path, { token = TOKEN, method = 'GET', body, headers = {} } = {}) => {
    const requestHeaders = new Headers(headers);
    if (token !== null) requestHeaders.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    return worker.fetch(new Request(`https://worker.test${path}`, {
      method, headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  };
  return { sqlite, env, queries, call };
}

test('legacy till and admin catalog requests need neither JWT configuration nor user tables', async t => {
  const f = fixture(t);
  for (const token of [TOKEN, ADMIN]) {
    const response = await f.call('/products', { token });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).length >= 8);
  }
  const shop = await f.call('/shop');
  assert.equal(shop.status, 200);
  assert.equal((await shop.json()).gst_registration, 'regular');
  assert.ok(!f.queries.some(sql => /\b(users|roles|api_keys|sessions)\b/.test(sql)));
});

test('malformed and unsupported credentials fail closed as JSON, not thrown errors', async t => {
  const f = fixture(t);
  for (const token of [null, '', 'wrong', 'a.b.c', 'eyJhbGciOiJIUzI1NiJ9.invalid.signature']) {
    const response = await f.call('/products', { token, headers: { 'X-API-Key': 'pos_unprovisioned' } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
  assert.deepEqual(f.queries, []);
});

test('till credentials cannot reach books, settings, purchases, refunds or inventory writes', async t => {
  const f = fixture(t);
  const routes = [
    ['GET', '/sales'], ['GET', '/settings'], ['PUT', '/settings'],
    ['GET', '/reports/stock'], ['GET', '/reports/trial-balance'],
    ['GET', '/reports/profit-loss'], ['GET', '/reports/sales-register'],
    ['GET', '/reports/gstr1'], ['POST', '/purchases'], ['POST', '/credit-notes'],
    ['POST', '/items'], ['PATCH', '/items/espresso'], ['DELETE', '/items/espresso'],
    ['POST', '/items/espresso/image'], ['POST', '/items/espresso/opening-stock'],
  ];
  for (const [method, path] of routes) {
    const response = await f.call(path, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
  assert.deepEqual(f.queries, [], 'denied requests must not access the database');
});

test('till can create and reprint a sale by reference without sales-history access', async t => {
  const f = fixture(t);
  const client_ref = crypto.randomUUID();
  const created = await f.call('/sales', {
    method: 'POST', body: { client_ref, total: 250, items: [{ id: 'espresso', qty: 1 }] },
  });
  assert.equal(created.status, 201);
  const bill = await f.call(`/sales/${client_ref}`);
  assert.equal(bill.status, 200);
  const recorded = (await bill.json()).sale;
  assert.equal(recorded.client_ref, client_ref);
  assert.equal(recorded.lines.length, 1);
  assert.equal(recorded.lines[0].qty, 1);
  const counters = f.sqlite.prepare(`SELECT qty_returnable, taxable_returnable_paise,
    cgst_returnable_paise, sgst_returnable_paise, igst_returnable_paise
    FROM sale_lines WHERE sale_ref = ?`).get(client_ref);
  assert.equal(counters.qty_returnable, 1);
  assert.equal(counters.taxable_returnable_paise, recorded.taxable_paise);
  assert.equal(counters.cgst_returnable_paise, recorded.cgst_paise);
  assert.equal(counters.sgst_returnable_paise, recorded.sgst_paise);
  assert.equal(counters.igst_returnable_paise, recorded.igst_paise);
  const journal = f.sqlite.prepare(`SELECT vl.account_code, vl.debit_paise, vl.credit_paise
    FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
    WHERE v.type = 'sale' AND v.ref = ? ORDER BY vl.account_code`).all(client_ref);
  assert.deepEqual(journal.map(row => [row.account_code, row.debit_paise, row.credit_paise]), [
    ['1000', 300, 0], ['2100', 0, 19], ['2110', 0, 19], ['4000', 0, 212], ['5900', 0, 50],
  ]);
  assert.equal((await f.call('/sales')).status, 401);
});

test('image query credential is restricted to the public till token and image routes', async t => {
  const f = fixture(t);
  const image = await f.call(`/images/items/espresso?t=${TOKEN}`, { token: null });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.equal((await f.call(`/images/items/espresso?t=${ADMIN}`, { token: null })).status, 401);
  assert.equal((await f.call('/images/items/espresso', { token: ADMIN })).status, 200);
  assert.equal((await f.call(`/products?t=${TOKEN}`, { token: null })).status, 401);
  assert.equal((await f.call(`/settings?t=${TOKEN}`, { token: null })).status, 401);
  for (const bad of ['\n', '\u0000', 'अमान्य', 'wrong-token', `${TOKEN}\n`, `${TOKEN} `]) {
    const response = await f.call(`/images/items/espresso?t=${encodeURIComponent(bad)}`, { token: null });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
});

test('catalog remains available without optional image storage and image routes return 503', async t => {
  const f = fixture(t);
  delete f.env.IMAGES;

  const catalog = await f.call('/items');
  assert.equal(catalog.status, 200);
  assert.ok((await catalog.json()).length > 0);

  const upload = await f.call('/items/espresso/image', {
    method: 'POST', token: ADMIN, body: {},
  });
  assert.equal(upload.status, 503);
  assert.deepEqual(await upload.json(), { error: 'image storage not configured' });

  const image = await f.call('/images/items/espresso');
  assert.equal(image.status, 503);
  assert.deepEqual(await image.json(), { error: 'image storage not configured' });

  const denied = await f.call('/images/items/espresso', { token: null });
  assert.equal(denied.status, 401, 'missing image storage must not bypass auth');
});

test('path matching precedes authorization and decoding follows authorization', async t => {
  const f = fixture(t);
  assert.equal((await f.call('/sales/missing-reference')).status, 404);
  assert.equal((await f.call('/sales/%', { token: null })).status, 401);
  assert.equal((await f.call('/sales/%')).status, 400);
  assert.equal((await f.call('/items/%', { method: 'PATCH' })).status, 401);
  assert.equal((await f.call('/items/%', { method: 'PATCH', token: ADMIN })).status, 400);
  assert.equal((await f.call('/unknown/path')).status, 404);
  assert.equal((await f.call('/unknown/path', { token: null })).status, 401);
});

test('unfinished identity and API-key routes are not activated in the legacy API', async t => {
  const f = fixture(t);
  for (const [method, path] of [
    ['POST', '/auth/login'], ['POST', '/auth/register'], ['GET', '/auth/me'],
    ['GET', '/users'], ['GET', '/users/1'], ['POST', '/api-keys'], ['GET', '/audit-log'],
  ]) {
    assert.equal((await f.call(path, { method, token: ADMIN })).status, 404, `${method} ${path}`);
  }
  assert.deepEqual(f.queries, []);
});

test('CORS preflight includes PATCH for the existing item-edit API', async t => {
  const f = fixture(t);
  const response = await f.call('/items/espresso', { method: 'OPTIONS', token: null });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('Access-Control-Allow-Methods').split(/,\s*/).includes('PATCH'));
  assert.deepEqual(f.queries, []);
});

test('legacy settings update succeeds without activating the draft audit schema', async t => {
  const f = fixture(t);
  const response = await f.call('/settings', {
    token: ADMIN, method: 'PUT', body: { price_mode: 'exclusive', round_off_enabled: false },
  });
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.equal(settings.price_mode, 'exclusive');
  assert.equal(settings.round_off_enabled, '0');
  assert.ok(!f.queries.some(sql => /\baudit_log\b/.test(sql)));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'audit_log'").get().n, 0);
});

const reports = [
  'stock', 'trial-balance', 'profit-loss', 'balance-sheet', 'sales-register',
  'purchase-register', 'cash-book', 'day-book', 'integrity/stock',
];

test('all report HTTP adapters return JSON Responses with omitted date defaults', async t => {
  const f = fixture(t);
  for (const name of reports) {
    const response = await f.call(`/reports/${name}`, { token: ADMIN });
    assert.ok(response instanceof Response, name);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('Content-Type'), 'application/json', name);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*', name);
    assert.ok(await response.json(), name);
  }
});

test('invalid report dates produce controlled HTTP 400 responses', async t => {
  const f = fixture(t);
  for (const name of reports) {
    const key = ['stock', 'balance-sheet', 'integrity/stock'].includes(name) ? 'as_of' : 'from';
    for (const value of ['bad-date', '2026-02-30', '']) {
      const response = await f.call(`/reports/${name}?${key}=${value}`, { token: ADMIN });
      assert.equal(response.status, 400, `${name} ${key}=${value}`);
      assert.equal(typeof (await response.json()).error, 'string');
    }
  }
});

test('stock HTTP response retains the existing qty/value and totalValuePaise contract', async t => {
  const f = fixture(t);
  const response = await f.call('/reports/stock', { token: ADMIN });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items.find(item => item.id === 'espresso').qty, 100);
  assert.ok(body.items.every(item => Number.isInteger(item.qty) && Number.isInteger(item.value_paise)));
  assert.equal(body.totalValuePaise, body.items.reduce((sum, item) => sum + item.value_paise, 0));
  assert.equal(body.reconciliation.reconciled, true);
});

test('report queries remain bound to the supplied per-shop database', async t => {
  const a = fixture(t);
  const b = fixture(t);
  const client_ref = crypto.randomUUID();
  assert.equal((await a.call('/sales', {
    method: 'POST', body: { client_ref, total: 4000, items: [{ id: 'delivery', qty: 1 }] },
  })).status, 201);
  assert.equal((await a.call('/purchases', {
    token: ADMIN, method: 'POST', body: {
      supplier_name: 'Shop A supplier', supplier_inv_no: 'A-ONLY',
      lines: [{ product_id: 'espresso', qty: 1, taxable_paise: 100 }],
    },
  })).status, 201);
  const own = await (await a.call('/reports/sales-register', { token: ADMIN })).json();
  const other = await (await b.call('/reports/sales-register', { token: ADMIN })).json();
  assert.ok(own.documents.some(row => row.document_ref === client_ref));
  assert.ok(!other.documents.some(row => row.document_ref === client_ref));
  for (const [name, value] of [
    ['stock', body => body.totalValuePaise],
    ['trial-balance', body => body.totalDebit],
    ['profit-loss', body => body.revenue.total_paise],
    ['balance-sheet', body => body.totals.assets_paise],
    ['purchase-register', body => body.count],
    ['cash-book', body => body.entries.length],
    ['day-book', body => body.count],
    ['integrity/stock', body => body.fifo_stock_paise],
  ]) {
    const owned = await (await a.call(`/reports/${name}`, { token: ADMIN })).json();
    const isolated = await (await b.call(`/reports/${name}`, { token: ADMIN })).json();
    assert.ok(value(owned) > 0, `${name} must expose Shop A's own activity`);
    assert.equal(value(isolated), 0, `${name} must not expose Shop A's activity in Shop B`);
  }
});
