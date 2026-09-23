/**
 * Report correctness, against the real D1 tables from `npm run migrate:local`.
 * Pure SQLite, no server — read-only logic is the same either way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  periodBounds, istStart, reportTrialBalance, reportProfitLoss, reportBalanceSheet,
  reportSalesRegister, reportPurchaseRegister, reportStockRegister, reportStockIntegrity,
  reportCashBook, reportDayBook, InvalidReportPeriod,
} from '../src/reports.js';

const db = new DatabaseSync(':memory:');
db.exec(`
  -- Exactly the tables 0002_foundation.sql creates, minus the partial index
  -- that is irrelevant for reports. accounts seeded identically.
  CREATE TABLE accounts (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, parent_code TEXT
  );
  CREATE TABLE vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    narration TEXT NOT NULL DEFAULT '',
    ref TEXT
  );
  CREATE TABLE voucher_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
    account_code TEXT NOT NULL REFERENCES accounts(code),
    debit_paise INTEGER NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
    credit_paise INTEGER NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
    CHECK ((debit_paise = 0) <> (credit_paise = 0))
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  CREATE TABLE sales (
    client_ref TEXT PRIMARY KEY,
    sold_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    invoice_no TEXT,
    taxable_paise INTEGER NOT NULL DEFAULT 0,
    cgst_paise INTEGER NOT NULL DEFAULT 0,
    sgst_paise INTEGER NOT NULL DEFAULT 0,
    igst_paise INTEGER NOT NULL DEFAULT 0,
    round_off_paise INTEGER NOT NULL DEFAULT 0,
    total_paise INTEGER NOT NULL DEFAULT 0,
    cogs_paise INTEGER NOT NULL DEFAULT 0,
    place_of_supply TEXT,
    customer_gstin TEXT,
    payment_mode TEXT NOT NULL DEFAULT 'cash'
  );
  CREATE TABLE sale_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_ref TEXT NOT NULL,
    product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'good',
    qty INTEGER NOT NULL CHECK (qty > 0)
  );
  CREATE TABLE cogs_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_line_id INTEGER,
    lot_id INTEGER,
    qty INTEGER NOT NULL CHECK (qty > 0),
    cost_paise INTEGER NOT NULL CHECK (cost_paise >= 0)
  );
  CREATE TABLE stock_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL,
    qty_in INTEGER NOT NULL CHECK (qty_in > 0),
    qty_remaining INTEGER NOT NULL CHECK (qty_remaining >= 0),
    cost_in_paise INTEGER NOT NULL CHECK (cost_in_paise >= 0),
    cost_remaining_paise INTEGER NOT NULL CHECK (cost_remaining_paise >= 0),
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    purchase_line_id INTEGER
  );
  CREATE TABLE purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    supplier_name TEXT NOT NULL DEFAULT '',
    supplier_gstin TEXT,
    supplier_inv_no TEXT,
    taxable_paise INTEGER NOT NULL DEFAULT 0,
    cgst_paise INTEGER NOT NULL DEFAULT 0,
    sgst_paise INTEGER NOT NULL DEFAULT 0,
    igst_paise INTEGER NOT NULL DEFAULT 0,
    total_paise INTEGER NOT NULL DEFAULT 0,
    payment_mode TEXT NOT NULL DEFAULT 'cash'
  );
  CREATE TABLE purchase_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    product_id TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),
    taxable_paise INTEGER NOT NULL CHECK (taxable_paise >= 0),
    gst_rate_bps INTEGER NOT NULL DEFAULT 0,
    tax_paise INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'good',
    unit TEXT NOT NULL DEFAULT 'PCS',
    tax_code TEXT NOT NULL DEFAULT ''
  );
`);
const INS = db.prepare('INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)');
[
  ['1000', 'Cash in Hand', 'asset'], ['1010', 'Bank Account', 'asset'], ['1100', 'Sundry Debtors', 'asset'],
  ['1200', 'Stock in Hand', 'asset'], ['1300', 'Input CGST', 'asset'], ['1310', 'Input SGST', 'asset'],
  ['1320', 'Input IGST', 'asset'], ['2000', 'Sundry Creditors', 'liability'],
  ['2100', 'Output CGST', 'liability'], ['2110', 'Output SGST', 'liability'], ['2120', 'Output IGST', 'liability'],
  ['3000', 'Capital Account', 'equity'], ['3100', 'Opening Stock Adjustment', 'equity'],
  ['4000', 'Sales', 'income'], ['4100', 'Service Income', 'income'],
  ['5000', 'Cost of Goods Sold', 'expense'], ['5900', 'Round Off', 'expense'],
].forEach(args => INS.run(...args));
db.prepare("INSERT INTO settings (key, value) VALUES ('fy_start', '04-01')").run();
db.prepare("INSERT INTO settings (key, value) VALUES ('gst_registration', 'regular')").run();

const seeded = [
  { code: 'espresso', name: 'Espresso', kind: 'good', unit: 'PCS', tax_code: '2106' },
  { code: 'delivery', name: 'Delivery', kind: 'service', unit: 'NA', tax_code: '996813' },
];
seeded.forEach(p => db.prepare('INSERT INTO products (id, name, kind, unit, tax_code) VALUES (?, ?, ?, ?, ?)')
  .run(p.code, p.name, p.kind, p.unit, p.tax_code));

// Mimic D1's chained binding: prepare(sql).bind(...).all()/.first(). Reports
// also call .all()/.first() with no bind, so both shapes must work.
const wrap = db => ({
  prepare(sql) {
    const stmt = db.prepare(sql);
    let binds = [];
    const api = {
      bind(...b) { binds = b; return api; },
      all: () => ({ results: stmt.all(...binds) }),
      first: () => stmt.get(...binds) ?? null,
    };
    return api;
  },
});

const dbBind = wrap(db);

test('periodBounds rejects invalid dates', () => {
  assert.throws(() => periodBounds({ from: '2026-02-30' }), InvalidReportPeriod);
  assert.throws(() => periodBounds({ from: '2026-01-01', to: '2025-12-31' }), InvalidReportPeriod);
  assert.throws(() => periodBounds({ from: 'not-a-date' }), InvalidReportPeriod);
});

test('periodBounds converts correctly', () => {
  const pb = periodBounds({ from: '2026-04-01', to: '2026-04-30' });
  assert.equal(pb.timezone, 'Asia/Kolkata');
  assert.equal(pb.from, '2026-04-01');
  assert.equal(pb.to, '2026-04-30');
  assert.equal(pb.to_exclusive, '2026-05-01');
  assert.ok(pb.from_utc.endsWith(' 18:30:00'), `from_utc ${pb.from_utc} should be midnight IST`);
  assert.ok(pb.to_exclusive_utc.endsWith(' 18:30:00'), `to_exclusive_utc ${pb.to_exclusive_utc} should be midnight IST`);
});

test('trial balance net zero', async () => {
  const tb = await reportTrialBalance(dbBind);
  assert.equal(tb.net, 0, 'empty ledger must net zero');
  assert.equal(tb.balanced, true);
});

test('profit‑loss with no vouchers returns zeros', async () => {
  const pl = await reportProfitLoss(dbBind, { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(pl.revenue.total_paise, 0);
  assert.equal(pl.cost_of_goods_sold_paise, 0);
  assert.equal(pl.expenses.length, 0);
  assert.equal(pl.net_profit_paise, 0);
  assert.equal(pl.zero_cost_opening_stock_caveat, false);
});

test('balance sheet assets = liabilities + equity + earnings', async () => {
  const bs = await reportBalanceSheet(dbBind);
  assert.ok(bs.balanced, `assets ${bs.totals.assets_paise} ≠ liabilities+equity ${bs.totals.liabilities_and_equity_paise}`);
  assert.equal(bs.earnings_to_date_paise, 0);
  assert.equal(bs.period_net_profit_paise, 0);
});

test('cash book opening equals sum of movements', async () => {
  // No cash entries yet.
  const cb = await reportCashBook(dbBind);
  assert.equal(cb.opening_paise, 0);
  assert.equal(cb.entries.length, 0);
  assert.equal(cb.closing_paise, 0);
});

test('day book returns no vouchers', async () => {
  const db = await reportDayBook(dbBind);
  assert.equal(db.vouchers.length, 0);
  assert.equal(db.totals.debit_paise, 0);
  assert.equal(db.totals.credit_paise, 0);
});

test('sales register returns seeded sales when vouchers exist', async () => {
  // Create a sale voucher.
  const vId = db.prepare('INSERT INTO vouchers (type, date, narration, ref) VALUES (?, ?, ?, ?)')
    .run('sale', istStart('2026-04-15'), 'Test sale', 's-1').lastInsertRowid;
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '1000', 5000, 0);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '4000', 0, 4762);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '2100', 0, 119);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '2110', 0, 119);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '5000', 1000, 0);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '1200', 0, 1000);
  db.prepare(`
    INSERT INTO sales (client_ref, sold_at, invoice_no, taxable_paise, cgst_paise, sgst_paise,
                        total_paise, cogs_paise, payment_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('s-1', istStart('2026-04-15'), 'A/26-27/0001', 4762, 119, 119, 5000, 1000, 'cash');
  db.prepare('INSERT INTO sale_lines (sale_ref, product_id, name, kind, qty) VALUES (?, ?, ?, ?, ?)')
    .run('s-1', 'espresso', 'Espresso', 'good', 5);
  db.prepare('INSERT INTO cogs_allocations (sale_line_id, lot_id, qty, cost_paise) VALUES (?, ?, ?, ?)')
    .run(1, 1, 5, 1000);
  db.prepare('INSERT INTO stock_lots (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise, received_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('espresso', 20, 15, 4000, 3000, istStart('2026-04-10'));
  // The lot and its Stock in Hand posting are inseparable in production. Include
  // both here so this fixture proves reconciliation rather than merely returning
  // two unrelated figures.
  const openingId = db.prepare('INSERT INTO vouchers (type, date, narration, ref) VALUES (?, ?, ?, ?)')
    .run('journal', istStart('2026-04-10'), 'Opening stock Espresso', 'opening:espresso').lastInsertRowid;
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(openingId, '1200', 4000, 0);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(openingId, '3100', 0, 4000);

  const reg = await reportSalesRegister(dbBind, { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(reg.documents.length, 1);
  assert.equal(reg.totals.taxable_paise, 4762);
  assert.equal(reg.totals.total_paise, 5000);
  assert.equal(reg.totals.cogs_paise, 1000);
});

test('purchase register returns seeded purchases', async () => {
  const pId = db.prepare(`
    INSERT INTO purchases (invoice_date, supplier_name, supplier_inv_no, taxable_paise, cgst_paise,
                           sgst_paise, total_paise, payment_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(istStart('2026-04-05'), 'Test Supplier', 'INV-55', 10000, 500, 500, 11000, 'cash').lastInsertRowid;
  db.prepare('INSERT INTO purchase_lines (purchase_id, product_id, qty, taxable_paise) VALUES (?, ?, ?, ?)')
    .run(pId, 'espresso', 20, 10000);
  db.prepare(`
    INSERT INTO stock_lots (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise,
                            received_at, purchase_line_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('espresso', 20, 20, 10000, 10000, istStart('2026-04-05'), 1);
  // Matching voucher.
  const vId = db.prepare('INSERT INTO vouchers (type, date, narration, ref) VALUES (?, ?, ?, ?)')
    .run('purchase', istStart('2026-04-05'), 'Purchase INV-55', 'INV-55').lastInsertRowid;
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '1200', 10000, 0);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '1300', 500, 0);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '1310', 500, 0);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '1000', 0, 11000);

  const pr = await reportPurchaseRegister(dbBind, { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(pr.purchases.length, 1);
  assert.equal(pr.totals.taxable_paise, 10000);
  assert.equal(pr.totals.stock_added_paise, 10000);
});

test('stock register and Stock in Hand reconcile exactly', async () => {
  // Two receipts and one sale were inserted above.
  const sr = await reportStockRegister(dbBind, { as_of: '2026-04-30' });
  const item = sr.items.find(r => r.id === 'espresso');
  assert.ok(item, 'stocked good should appear');
  assert.equal(item.opening_qty, 0);
  assert.equal(item.received_qty, 40);
  assert.equal(item.sold_qty, 5);
  assert.equal(item.closing_qty, 35);
  assert.equal(item.closing_value_paise, 13000);
  assert.equal(sr.reconciliation.fifo_stock_paise, 13000);
  assert.equal(sr.reconciliation.stock_in_hand_paise, 13000);
  assert.equal(sr.reconciliation.difference_paise, 0);
  assert.equal(sr.reconciliation.reconciled, true);
});

test('stock integrity surfaces one-paisa drift instead of hiding it', async () => {
  const line = db.prepare("SELECT id, debit_paise FROM voucher_lines WHERE account_code = '1200' AND debit_paise > 0 ORDER BY id LIMIT 1").get();
  db.prepare('UPDATE voucher_lines SET debit_paise = debit_paise + 1 WHERE id = ?').run(line.id);
  try {
    const integrity = await reportStockIntegrity(dbBind, { as_of: '2026-04-30' });
    assert.equal(integrity.fifo_stock_paise, 13000);
    assert.equal(integrity.stock_in_hand_paise, 13001);
    assert.equal(integrity.difference_paise, -1);
    assert.equal(integrity.reconciled, false);
  } finally {
    db.prepare('UPDATE voucher_lines SET debit_paise = ? WHERE id = ?').run(line.debit_paise, line.id);
  }
});

test('profit-loss after a sale shows correct margin', async () => {
  const pl = await reportProfitLoss(dbBind, { from: '2026-04-01', to: '2026-04-30' });
  const rev = pl.revenue.goods_paise;
  const cogs = pl.cost_of_goods_sold_paise;
  assert.ok(rev >= 0, 'revenue should be non‑negative');
  assert.ok(cogs >= 0, 'COGS should be non‑negative');
  assert.equal(pl.net_profit_paise, rev - cogs - pl.total_other_expenses_paise);
});

test('balance sheet earnings match profit‑loss net', async () => {
  const pl = await reportProfitLoss(dbBind, { from: '2026-04-01', to: '2026-04-30' });
  const bs = await reportBalanceSheet(dbBind, { as_of: '2026-04-30' });
  assert.equal(bs.period_net_profit_paise, pl.net_profit_paise);
});

// Edge case: service-only invoice has no stock movements.
test('service revenue appears without changing COGS', async () => {
  const before = await reportProfitLoss(dbBind, { from: '2026-04-01', to: '2026-04-30' });
  const vId = db.prepare('INSERT INTO vouchers (type, date, narration, ref) VALUES (?, ?, ?, ?)')
    .run('sale', istStart('2026-04-20'), 'Service sale', 's-2').lastInsertRowid;
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '1000', 1180, 0);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '4100', 0, 1000);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '2100', 0, 90);
  db.prepare('INSERT INTO voucher_lines (voucher_id, account_code, debit_paise, credit_paise) VALUES (?, ?, ?, ?)')
    .run(vId, '2110', 0, 90);
  db.prepare(`
    INSERT INTO sales (client_ref, sold_at, invoice_no, taxable_paise, cgst_paise, sgst_paise,
                        total_paise, cogs_paise, payment_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('s-2', istStart('2026-04-20'), 'A/26-27/0002', 1000, 90, 90, 1180, 0, 'cash');

  const pl = await reportProfitLoss(dbBind, { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(pl.revenue.services_paise, before.revenue.services_paise + 1000);
  assert.equal(pl.cost_of_goods_sold_paise, before.cost_of_goods_sold_paise);
});

test('zero‑cost opening stock caveat triggers when a zero‑cost sale occurs', async () => {
  const zeroRow = await reportProfitLoss(dbBind, { from: '2026-04-01', to: '2026-04-30' });
  // Our test sale used cost 1000, not zero, so caveat should be false.
  assert.equal(zeroRow.zero_cost_opening_stock_caveat, false);
});
