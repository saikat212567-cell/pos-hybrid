/** Credit-note HTTP creation against the reviewed 0001–0005 schema. */
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

  function statement(sql, params = []) {
    return {
      bind: (...values) => statement(sql, values),
      async all() { return { results: sqlite.prepare(sql).all(...params) }; },
      async first() { return sqlite.prepare(sql).get(...params) ?? null; },
      async run() { return sqlite.prepare(sql).run(...params); },
    };
  }
  let beforeBatch;
  const DB = {
    prepare: sql => statement(sql),
    async batch(statements) {
      if (beforeBatch) {
        const hook = beforeBatch;
        beforeBatch = null;
        hook();
      }
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const env = { DB, POS_TOKEN: TOKEN, POS_ADMIN_TOKEN: ADMIN };
  const call = (path, { token = ADMIN, method = 'GET', body } = {}) => {
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return worker.fetch(new Request(`https://worker.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  };
  return {
    sqlite,
    call,
    setBeforeBatch(hook) { beforeBatch = hook; },
  };
}

test('creates an atomic credit note against a real sale', async t => {
  const f = fixture(t);
  f.sqlite.prepare(`INSERT INTO products
    (id, name, price, category, kind, tax_code, gst_rate_bps, unit)
    VALUES ('refund-good', 'Refund good', 250, 'refunds', 'good', '2106', 1800, 'PCS')`).run();
  f.sqlite.prepare(`INSERT INTO stock_lots
    (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise, received_at)
    VALUES ('refund-good', 2, 2, 1000, 1000, '2026-01-01 00:00:00')`).run();

  const saleRef = 'sale-for-credit-note-1';
  const sale = await f.call('/sales', {
    method: 'POST',
    body: {
      client_ref: saleRef,
      total: 500,
      items: [{ id: 'refund-good', qty: 2 }],
      payment_mode: 'card',
    },
  });
  assert.equal(sale.status, 201);

  const saleLine = f.sqlite.prepare(
    'SELECT id FROM sale_lines WHERE sale_ref = ?'
  ).get(saleRef);
  const body = {
    client_ref: 'credit-note-http-1',
    original_sale_ref: saleRef,
    lines: [{ sale_line_id: saleLine.id, qty: 1 }],
    refund_mode: 'cash',
    stock_return_mode: 'original_lot',
    tax_adjusted: 0,
  };

  const response = await f.call('/credit-notes', { method: 'POST', body });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.credit_note_no, /^CN\/\d{2}-\d{2}\/\d{4}$/);

  const note = f.sqlite.prepare(
    'SELECT * FROM credit_notes WHERE client_ref = ?'
  ).get(body.client_ref);
  assert.equal(note.sale_ref, saleRef);
  assert.equal(note.total_paise, 300);
  assert.equal(note.cogs_reversed_paise, 500);
  assert.equal(note.tax_adjusted, 0);
  assert.equal(note.gstr1_table, 'none');

  const counter = f.sqlite.prepare(`
    SELECT qty_returnable, taxable_returnable_paise, cgst_returnable_paise,
           sgst_returnable_paise, igst_returnable_paise
      FROM sale_lines WHERE id = ?
  `).get(saleLine.id);
  assert.deepEqual({ ...counter }, {
    qty_returnable: 1, taxable_returnable_paise: 212,
    cgst_returnable_paise: 19, sgst_returnable_paise: 19,
    igst_returnable_paise: 0,
  });

  const allocation = f.sqlite.prepare(`
    SELECT qty, cost_paise, mode, lot_id
      FROM return_allocations
     WHERE credit_note_line_id = (SELECT id FROM credit_note_lines WHERE note_ref = ?)
  `).get(body.client_ref);
  assert.equal(allocation.qty, 1);
  assert.equal(allocation.cost_paise, 500);
  assert.equal(allocation.mode, 'original_lot');
  assert.ok(allocation.lot_id > 0);

  const lot = f.sqlite.prepare(
    'SELECT qty_remaining, cost_remaining_paise FROM stock_lots WHERE product_id = ?'
  ).get('refund-good');
  assert.deepEqual({ ...lot }, { qty_remaining: 1, cost_remaining_paise: 500 });

  const journal = f.sqlite.prepare(`
    SELECT vl.account_code, vl.debit_paise, vl.credit_paise
      FROM voucher_lines vl
      JOIN vouchers v ON v.id = vl.voucher_id
     WHERE v.type = 'credit_note' AND v.ref = ?
     ORDER BY vl.account_code
  `).all(body.client_ref);
  assert.deepEqual(journal.map(row => [row.account_code, row.debit_paise, row.credit_paise]), [
    ['1000', 0, 300], ['1200', 500, 0], ['4000', 212, 0],
    ['5000', 0, 500], ['5900', 50, 0], ['5910', 38, 0],
  ]);
  const trialBalance = f.sqlite.prepare(`
    SELECT COALESCE(SUM(debit_paise), 0) AS debits,
           COALESCE(SUM(credit_paise), 0) AS credits
      FROM voucher_lines
  `).get();
  assert.equal(trialBalance.debits, trialBalance.credits);
});

test('credit-note retries are idempotent and do not consume another number', async t => {
  const f = fixture(t);
  f.sqlite.prepare(`INSERT INTO products
    (id, name, price, category, kind, tax_code, gst_rate_bps, unit)
    VALUES ('retry-good', 'Retry good', 100, 'refunds', 'good', '2106', 0, 'PCS')`).run();
  f.sqlite.prepare(`INSERT INTO stock_lots
    (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise, received_at)
    VALUES ('retry-good', 1, 1, 100, 100, '2026-01-01 00:00:00')`).run();
  const saleRef = 'sale-for-credit-note-retry';
  assert.equal((await f.call('/sales', { method: 'POST', body: {
    client_ref: saleRef, total: 100, items: [{ id: 'retry-good', qty: 1 }],
  } })).status, 201);
  const saleLine = f.sqlite.prepare('SELECT id FROM sale_lines WHERE sale_ref = ?').get(saleRef);
  const body = { client_ref: 'credit-note-retry-1', original_sale_ref: saleRef,
    lines: [{ sale_line_id: saleLine.id, qty: 1 }], refund_mode: 'cash' };

  const first = await f.call('/credit-notes', { method: 'POST', body });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const second = await f.call('/credit-notes', { method: 'POST', body });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, duplicate: true, credit_note_no: firstBody.credit_note_no });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM credit_notes').get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT last_no FROM invoice_series WHERE series = 'CN'").get().last_no, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE type = 'credit_note'").get().n, 1);
});

test('partial credit notes conserve invoice total, round-off, and FIFO cost', async t => {
  const f = fixture(t);
  f.sqlite.prepare(`INSERT INTO products
    (id, name, price, category, kind, tax_code, gst_rate_bps, unit)
    VALUES ('partial-good', 'Partial good', 100, 'refunds', 'good', '2106', 0, 'PCS')`).run();
  f.sqlite.prepare(`INSERT INTO stock_lots
    (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise, received_at)
    VALUES ('partial-good', 3, 3, 1000, 1000, '2026-01-01 00:00:00')`).run();
  const saleRef = 'sale-for-credit-note-partial';
  assert.equal((await f.call('/sales', { method: 'POST', body: {
    client_ref: saleRef, total: 300, items: [{ id: 'partial-good', qty: 3 }],
  } })).status, 201);
  const saleLine = f.sqlite.prepare('SELECT id FROM sale_lines WHERE sale_ref = ?').get(saleRef);
  const notes = [];
  for (const [i, client_ref] of ['credit-note-partial-1', 'credit-note-partial-2', 'credit-note-partial-3'].entries()) {
    const response = await f.call('/credit-notes', { method: 'POST', body: {
      client_ref, original_sale_ref: saleRef,
      lines: [{ sale_line_id: saleLine.id, qty: 1 }], refund_mode: 'cash',
    }});
    assert.equal(response.status, 201, `partial ${i + 1}`);
    const note = f.sqlite.prepare('SELECT total_paise, round_off_paise, cogs_reversed_paise FROM credit_notes WHERE client_ref = ?').get(client_ref);
    notes.push({ ...note });
  }
  assert.deepEqual(notes, [
    { total_paise: 100, round_off_paise: 0, cogs_reversed_paise: 333 },
    { total_paise: 100, round_off_paise: 0, cogs_reversed_paise: 334 },
    { total_paise: 100, round_off_paise: 0, cogs_reversed_paise: 333 },
  ]);
  const lot = f.sqlite.prepare('SELECT qty_remaining, cost_remaining_paise FROM stock_lots WHERE product_id = ?').get('partial-good');
  assert.deepEqual({ ...lot }, { qty_remaining: 3, cost_remaining_paise: 1000 });
  assert.equal(f.sqlite.prepare('SELECT COALESCE(SUM(total_paise), 0) AS total FROM credit_notes WHERE sale_ref = ?').get(saleRef).total, 300);
  assert.equal(f.sqlite.prepare('SELECT COALESCE(SUM(round_off_paise), 0) AS round_off FROM credit_notes WHERE sale_ref = ?').get(saleRef).round_off, 0);
  assert.equal(f.sqlite.prepare('SELECT qty_returnable, cost_returnable_paise FROM cogs_allocations').get().qty_returnable, 0);
  assert.equal(f.sqlite.prepare('SELECT cost_returnable_paise FROM cogs_allocations').get().cost_returnable_paise, 0);
});

test('a stale allocation aborts the complete credit-note batch', async t => {
  const f = fixture(t);
  f.sqlite.prepare(`INSERT INTO products
    (id, name, price, category, kind, tax_code, gst_rate_bps, unit)
    VALUES ('stale-good', 'Stale good', 100, 'refunds', 'good', '2106', 0, 'PCS')`).run();
  f.sqlite.prepare(`INSERT INTO stock_lots
    (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise, received_at)
    VALUES ('stale-good', 1, 1, 100, 100, '2026-01-01 00:00:00')`).run();
  const saleRef = 'sale-for-credit-note-stale';
  assert.equal((await f.call('/sales', { method: 'POST', body: {
    client_ref: saleRef, total: 100, items: [{ id: 'stale-good', qty: 1 }],
  } })).status, 201);
  const saleLine = f.sqlite.prepare('SELECT id FROM sale_lines WHERE sale_ref = ?').get(saleRef);
  const allocation = f.sqlite.prepare('SELECT id FROM cogs_allocations WHERE sale_line_id = ?').get(saleLine.id);
  const beforeLot = f.sqlite.prepare('SELECT qty_remaining, cost_remaining_paise FROM stock_lots WHERE product_id = ?').get('stale-good');
  f.setBeforeBatch(() => f.sqlite.prepare(
    'UPDATE cogs_allocations SET cost_returnable_paise = 99 WHERE id = ?'
  ).run(allocation.id));
  const response = await f.call('/credit-notes', { method: 'POST', body: {
    client_ref: 'credit-note-stale-1', original_sale_ref: saleRef,
    lines: [{ sale_line_id: saleLine.id, qty: 1 }], refund_mode: 'cash',
  }});
  assert.equal(response.status, 409);
  assert.deepEqual({ ...f.sqlite.prepare('SELECT qty_remaining, cost_remaining_paise FROM stock_lots WHERE product_id = ?').get('stale-good') }, { ...beforeLot });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM credit_notes').get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE type = 'credit_note'").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT last_no FROM invoice_series WHERE series = 'CN'").get(), undefined);
});

test('unsafe stock modes are rejected before any note is written', async t => {
  const f = fixture(t);
  f.sqlite.prepare(`INSERT INTO products
    (id, name, price, category, kind, tax_code, gst_rate_bps, unit)
    VALUES ('mode-good', 'Mode good', 100, 'refunds', 'good', '2106', 0, 'PCS')`).run();
  f.sqlite.prepare(`INSERT INTO stock_lots
    (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise, received_at)
    VALUES ('mode-good', 1, 1, 100, 100, '2026-01-01 00:00:00')`).run();
  const saleRef = 'sale-for-credit-note-mode';
  assert.equal((await f.call('/sales', { method: 'POST', body: {
    client_ref: saleRef, total: 100, items: [{ id: 'mode-good', qty: 1 }],
  } })).status, 201);
  const saleLine = f.sqlite.prepare('SELECT id FROM sale_lines WHERE sale_ref = ?').get(saleRef);
  for (const [i, mode] of ['none', 'new_lot'].entries()) {
    const response = await f.call('/credit-notes', { method: 'POST', body: {
      client_ref: `credit-note-mode-${i}`, original_sale_ref: saleRef,
      lines: [{ sale_line_id: saleLine.id, qty: 1 }], refund_mode: 'cash',
      stock_return_mode: mode,
    }});
    assert.equal(response.status, 409, mode);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM credit_notes').get().n, 0);
});

test('over-return is rejected atomically and tax-adjusting notes stay disabled', async t => {
  const f = fixture(t);
  f.sqlite.prepare(`INSERT INTO products
    (id, name, price, category, kind, tax_code, gst_rate_bps, unit)
    VALUES ('over-good', 'Over good', 100, 'refunds', 'good', '2106', 0, 'PCS')`).run();
  f.sqlite.prepare(`INSERT INTO stock_lots
    (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise, received_at)
    VALUES ('over-good', 1, 1, 100, 100, '2026-01-01 00:00:00')`).run();
  const saleRef = 'sale-for-credit-note-over';
  assert.equal((await f.call('/sales', { method: 'POST', body: {
    client_ref: saleRef, total: 100, items: [{ id: 'over-good', qty: 1 }],
  } })).status, 201);
  const saleLine = f.sqlite.prepare('SELECT id FROM sale_lines WHERE sale_ref = ?').get(saleRef);
  const before = f.sqlite.prepare(`SELECT qty_returnable, taxable_returnable_paise
    FROM sale_lines WHERE id = ?`).get(saleLine.id);
  const response = await f.call('/credit-notes', { method: 'POST', body: {
    client_ref: 'credit-note-over-1', original_sale_ref: saleRef,
    lines: [{ sale_line_id: saleLine.id, qty: 2 }], refund_mode: 'cash',
  }});
  assert.equal(response.status, 409);
  assert.deepEqual({ ...f.sqlite.prepare(`SELECT qty_returnable, taxable_returnable_paise
    FROM sale_lines WHERE id = ?`).get(saleLine.id) }, { ...before });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM credit_notes').get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE type = 'credit_note'").get().n, 0);

  const taxResponse = await f.call('/credit-notes', { method: 'POST', body: {
    client_ref: 'credit-note-tax-1', original_sale_ref: saleRef,
    lines: [{ sale_line_id: saleLine.id, qty: 1 }], refund_mode: 'cash', tax_adjusted: 1,
  }});
  assert.equal(taxResponse.status, 409);
});
