/** Live report-route contract checks; use the same isolated Worker as api.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.POS_API ?? 'http://127.0.0.1:8801';
const ADMIN = process.env.POS_ADMIN_TOKEN ?? 'admin-token-x';
const TILL = process.env.POS_TOKEN ?? 'test-token';
const call = (path, token = ADMIN) => fetch(BASE + path, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10000),
});
const routes = [
  ['stock', 'items', 'as_of'],
  ['trial-balance', 'accounts', 'from'],
  ['profit-loss', 'revenue', 'from'],
  ['balance-sheet', 'assets', 'as_of'],
  ['sales-register', 'documents', 'from'],
  ['purchase-register', 'purchases', 'from'],
  ['cash-book', 'entries', 'from'],
  ['day-book', 'vouchers', 'from'],
  ['integrity/stock', 'reconciled', 'as_of'],
];

for (const [name, field, dateKey] of routes) {
  test(`live ${name} report supplies its default period and JSON response`, async () => {
    const response = await call(`/reports/${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    const body = await response.json();
    assert.ok(Object.hasOwn(body, field), `${name} lacks ${field}`);
    if (name === 'trial-balance') assert.equal(body.net, 0);
    if (name === 'balance-sheet') assert.equal(body.balanced, true);
    if (name === 'stock') {
      assert.ok(body.items.every(row => Number.isInteger(row.qty) && Number.isInteger(row.value_paise)));
      assert.equal(body.totalValuePaise, body.items.reduce((sum, row) => sum + row.value_paise, 0));
    }
  });

  test(`live ${name} report rejects invalid dates as JSON 400`, async () => {
    for (const date of ['2026-02-30', 'not-a-date', '']) {
      const response = await call(`/reports/${name}?${dateKey}=${date}`);
      assert.equal(response.status, 400, `${dateKey}=${date}`);
      assert.equal(response.headers.get('Content-Type'), 'application/json');
      assert.equal(typeof (await response.json()).error, 'string');
    }
  });

  test(`live ${name} report denies the public till credential`, async () => {
    const response = await call(`/reports/${name}`, TILL);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  });
}
