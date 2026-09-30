import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  InvalidReportPeriod, istStart, reportTrialBalance, reportProfitLoss, reportBalanceSheet,
  reportSalesRegister, reportPurchaseRegister, reportStockRegister, reportStockIntegrity,
  reportCashBook, reportDayBook,
} from '../src/reports.js';

// Explicit allowlist: never load the unreviewed 0006 RBAC/audit draft.
const migrations = ['0001_initial.sql', '0002_foundation.sql', '0003_items_images.sql',
  '0004_refunds.sql', '0005_actor_identity.sql'];
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  const db = { prepare(sql) {
    const stmt = sqlite.prepare(sql);
    let args = [];
    const query = {
      bind(...values) { args = values; return query; },
      all() { return { results: stmt.all(...args) }; },
      first() { return stmt.get(...args) ?? null; },
    };
    return query;
  } };
  const insert = (table, row) => sqlite.prepare(
    `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`
  ).run(...Object.values(row)).lastInsertRowid;
  const voucher = (date, lines, ref = null) => {
    assert.equal(lines.reduce((sum, [, debit, credit]) => sum + debit - credit, 0), 0);
    const id = insert('vouchers', { type: 'journal', date, ref });
    for (const [account_code, debit_paise, credit_paise] of lines)
      insert('voucher_lines', { voucher_id: id, account_code, debit_paise, credit_paise });
  };
  return { sqlite, db, insert, voucher };
}
const april = { from: '2026-04-01', to: '2026-04-30' };

function returnsFixture(t) {
  const f = fixture(t);
  const { insert, voucher } = f;
  insert('products', { id: 'report-good', name: 'Report good', price: 1000 });
  const purchase = insert('purchases', { invoice_date: istStart('2026-04-01'), taxable_paise: 900,
    igst_paise: 101, total_paise: 1001, payment_mode: 'credit' });
  const purchaseLine = insert('purchase_lines', { purchase_id: purchase, product_id: 'report-good', qty: 3, taxable_paise: 900 });
  // Non-creditable tax is part of carrying cost, not taxable value.
  const lot = insert('stock_lots', { product_id: 'report-good', qty_in: 3, qty_remaining: 1,
    cost_in_paise: 1001, cost_remaining_paise: 333, received_at: istStart('2026-04-01'), purchase_line_id: purchaseLine });
  voucher(istStart('2026-04-01'), [['1200', 1001, 0], ['2000', 0, 1001]], 'purchase');
  insert('sales', { client_ref: 'sale', total: 1800, items: '[]', sold_at: istStart('2026-04-02'),
    invoice_no: 'A/26-27/0001', taxable_paise: 1501, cgst_paise: 150, sgst_paise: 150,
    round_off_paise: -1, total_paise: 1800, cogs_paise: 1001, place_of_supply: '19', customer_gstin: 'snapshot', payment_mode: 'bank' });
  const saleLine = insert('sale_lines', { sale_ref: 'sale', product_id: 'report-good', name: 'Frozen name', qty: 3, price_paise: 600 });
  const allocation = insert('cogs_allocations', { sale_line_id: saleLine, lot_id: lot, qty: 3, cost_paise: 1001 });
  voucher(istStart('2026-04-02'), [['1010', 1800, 0], ['4000', 0, 1501], ['2100', 0, 150],
    ['2110', 0, 150], ['5900', 1, 0], ['5000', 1001, 0], ['1200', 0, 1001]], 'sale');
  const costs = [333, 334, 334];
  for (const [i, mode] of ['original_lot', 'new_lot', 'none'].entries()) {
    const ref = `note-${i}`;
    const date = istStart(`2026-04-0${i + 3}`);
    const taxable = i === 0 ? 501 : 500;
    const round = i === 0 ? -1 : 0;
    insert('credit_notes', { client_ref: ref, sale_ref: 'sale', note_no: `CN/26-27/000${i + 1}`, note_date: date,
      original_invoice_no: 'A/26-27/0001', original_invoice_date: istStart('2026-04-02'),
      registration: 'regular', place_of_supply: '19', customer_gstin: 'snapshot', customer_registered: 1,
      taxable_paise: taxable, cgst_paise: 50, sgst_paise: 50, round_off_paise: round, total_paise: 600,
      cogs_reversed_paise: costs[i], stock_return_mode: mode, tax_adjusted: i === 2 ? 0 : 1,
      gstr1_table: i === 2 ? 'none' : 'cdnr', refund_mode: 'cash' });
    const noteLine = insert('credit_note_lines', { note_ref: ref, sale_line_id: saleLine,
      product_id: 'report-good', name: 'Frozen name', qty: 1, cogs_reversed_paise: costs[i] });
    // A return lot may retain its purchase provenance AND copied receipt date.
    const returnedLot = mode === 'new_lot' ? insert('stock_lots', { product_id: 'report-good', qty_in: 1,
      qty_remaining: 1, cost_in_paise: 334, cost_remaining_paise: 334,
      received_at: istStart('2026-04-01'), purchase_line_id: purchaseLine }) : mode === 'none' ? null : lot;
    insert('return_allocations', { credit_note_line_id: noteLine, cogs_allocation_id: allocation,
      lot_id: returnedLot, qty: 1, cost_paise: costs[i], mode });
    const lines = [['4000', taxable, 0], ['1000', 0, 600], ['5000', 0, costs[i]],
      [mode === 'none' ? '5100' : '1200', costs[i], 0]];
    if (round) lines.push(['5900', 0, -round]);
    if (i === 2) lines.push(['5910', 100, 0]);
    else lines.push(['2100', 50, 0], ['2110', 50, 0]);
    voucher(date, lines, ref);
  }
  return f;
}

test('trial balance calendar bounds exclude next IST midnight but raw legacy end stays inclusive', async t => {
  const { db, voucher } = fixture(t);
  for (const [date, value] of [['2026-03-31 18:29:59', 1], ['2026-03-31 18:30:00', 10],
    ['2026-04-01 18:29:59', 100], ['2026-04-01 18:30:00', 1000]])
    voucher(date, [['1000', value, 0], ['4000', 0, value]]);
  const report = await reportTrialBalance(db, { from: '2026-04-01', to: '2026-04-01' });
  assert.equal(report.totalDebit, 110);
  assert.equal(report.totalCredit, 110);
  assert.equal(report.net, 0);
  const legacy = await reportTrialBalance(db, { from: '2026-03-31 18:30:00', to: '2026-04-01 18:30:00' });
  assert.equal(legacy.totalDebit, 1110);
  assert.equal((await reportTrialBalance(db)).totalDebit, 1111);
  const iso = await reportTrialBalance(db, { from: '2026-04-01T00:00:00+05:30', to: '2026-04-01T18:30:00Z' });
  assert.equal(iso.totalDebit, 1110);
  const mixed = await reportTrialBalance(db, { from: '2026-03-31 18:30:00', to: '2026-04-01' });
  assert.equal(mixed.totalDebit, 110);
  await assert.rejects(reportTrialBalance(db, { from: '2026-04-02 00:00:00', to: '2026-04-01 00:00:00' }), InvalidReportPeriod);
});

test('trial balance rejects malformed dates rather than treating them as legacy timestamps', async t => {
  const { db } = fixture(t);
  for (const bad of ['', 'bad', '2026-02-30', '2026-04-01 25:00:00', '2026-02-30T00:00:00Z']) {
    await assert.rejects(reportTrialBalance(db, { from: bad, to: '2026-04-30' }), InvalidReportPeriod, bad);
    await assert.rejects(reportTrialBalance(db, { from: '2026-01-01', to: bad }), InvalidReportPeriod, bad);
  }
});

test('report defaults apply to omitted dates, never empty or malformed dates', async t => {
  const { db } = fixture(t);
  for (const report of [reportProfitLoss, reportSalesRegister, reportPurchaseRegister, reportCashBook, reportDayBook]) {
    assert.equal((await report(db, { to: april.to })).period.from, april.from);
    for (const bad of ['', 'bad', '2026-02-30', false, 0]) {
      await assert.rejects(report(db, { from: bad, to: april.to }), InvalidReportPeriod);
      await assert.rejects(report(db, { from: april.from, to: bad }), InvalidReportPeriod);
    }
  }
  await assert.rejects(reportBalanceSheet(db, { from: '', as_of: april.to }), InvalidReportPeriod);
  await assert.rejects(reportStockRegister(db, { from: '', as_of: april.to }), InvalidReportPeriod);
  await assert.rejects(reportStockIntegrity(db, { as_of: '' }), InvalidReportPeriod);
});

test('all dated registers and ledger reports share the IST half-open interval', async t => {
  const { db, insert, voucher } = fixture(t);
  for (const [i, date] of ['2026-03-31 18:29:59', '2026-03-31 18:30:00', '2026-04-30 18:29:59', '2026-04-30 18:30:00'].entries()) {
    const value = 10 ** i;
    voucher(date, [['1000', value, 0], ['4000', 0, value]], `boundary-${i}`);
    insert('sales', { client_ref: `boundary-${i}`, sold_at: date, total: value, total_paise: value, items: '[]' });
    insert('purchases', { invoice_date: date, total_paise: value });
  }
  assert.equal((await reportProfitLoss(db, april)).net_profit_paise, 110);
  assert.equal((await reportSalesRegister(db, april)).totals.total_paise, 110);
  assert.equal((await reportPurchaseRegister(db, april)).totals.total_paise, 110);
  const cash = await reportCashBook(db, april);
  assert.equal(cash.opening_paise, 1);
  assert.equal(cash.closing_paise, 111);
  assert.equal(cash.entries.length, 2);
  assert.equal((await reportDayBook(db, april)).count, 2);
  const bs = await reportBalanceSheet(db, { ...april, as_of: april.to });
  assert.equal(bs.earnings_to_date_paise, 111);
  assert.equal(bs.period_net_profit_paise, 110);
});

test('balance sheet period earnings include income and expense accounts with zero closing balance', async t => {
  const { db, voucher } = fixture(t);
  voucher(istStart('2026-03-31'), [['1000', 700, 0], ['4000', 0, 1000], ['5900', 300, 0]]);
  voucher(istStart('2026-04-01'), [['1000', 0, 700], ['4000', 1000, 0], ['5900', 0, 300]]);
  const bs = await reportBalanceSheet(db, { from: april.from, as_of: april.to });
  assert.equal(bs.earnings_to_date_paise, 0);
  assert.equal(bs.period_net_profit_paise, -700);
  assert.equal(bs.period_net_profit_paise, (await reportProfitLoss(db, april)).net_profit_paise);
  assert.equal(bs.balanced, true);
});

test('sales register signs credit notes and separates commercial GST from GST-return adjustments', async t => {
  const { db, sqlite } = returnsFixture(t);
  sqlite.exec("UPDATE settings SET value = 'composition' WHERE key = 'gst_registration'");
  const report = await reportSalesRegister(db, april);
  assert.equal(report.count, 4);
  assert.deepEqual(report.documents.map(row => row.document_ref), ['sale', 'note-0', 'note-1', 'note-2']);
  const financial = report.documents[3];
  assert.equal(financial.taxable_paise, -500);
  assert.equal(financial.total_paise, -600);
  assert.equal(financial.cogs_paise, -334);
  assert.equal(financial.cgst_paise, -50);
  assert.equal(financial.gst_return_cgst_paise, 0);
  assert.equal(financial.gst_return_sgst_paise, 0);
  assert.equal(financial.gst_not_recoverable_paise, 100);
  assert.equal(financial.registration, 'regular');
  assert.equal(financial.gstr1_table, 'none');
  assert.equal(financial.refund_mode, 'cash');
  assert.equal(financial.original_invoice_no, 'A/26-27/0001');
  assert.equal(financial.sale_ref, 'sale');
  assert.equal(financial.customer_gstin, 'snapshot');
  assert.equal(report.documents[0].registration, null);
  assert.equal(report.documents[0].gstr1_table, null);
  assert.equal(report.documents[1].gstr1_table, 'cdnr');
  assert.equal(report.documents[1].gst_return_cgst_paise, -50);
  assert.equal(report.documents[1].round_off_paise, 1);
  assert.equal(report.totals.total_paise, 0);
  assert.equal(report.totals.taxable_paise, 0);
  assert.equal(report.totals.cgst_paise, 0);
  assert.equal(report.totals.gst_return_cgst_paise, 50);
  assert.equal(report.totals.gst_return_sgst_paise, 50);
  assert.equal(report.totals.cogs_paise, 0);
  assert.equal(report.totals.gst_not_recoverable_paise, 100);
  assert.equal((await reportSalesRegister(db, { from: '2026-04-05', to: '2026-04-05' })).count, 1);
});

test('service credit notes with zero quantity affect revenue, not stock', async t => {
  const { db, insert, voucher } = returnsFixture(t);
  const date = istStart('2026-04-10');
  insert('sales', { client_ref: 'service', total: 2360, total_paise: 2360, items: '[]', sold_at: date,
    taxable_paise: 2000, cgst_paise: 180, sgst_paise: 180 });
  const line = insert('sale_lines', { sale_ref: 'service', product_id: 'delivery', kind: 'service',
    name: 'Frozen delivery', qty: 1, price_paise: 2360 });
  voucher(date, [['1000', 2360, 0], ['4100', 0, 2000], ['2100', 0, 180], ['2110', 0, 180]], 'service');
  insert('credit_notes', { client_ref: 'service-note', sale_ref: 'service', note_date: date,
    original_invoice_date: date, registration: 'regular', stock_return_mode: 'none',
    reason: 'deficient', taxable_paise: 123, total_paise: 123, gstr1_table: 'b2cs_net' });
  insert('credit_note_lines', { note_ref: 'service-note', sale_line_id: line, product_id: 'delivery',
    kind: 'service', name: 'Frozen delivery', qty: 0, taxable_paise: 123 });
  voucher(date, [['4100', 123, 0], ['1000', 0, 123]], 'service-note');
  const note = (await reportSalesRegister(db, april)).documents.find(row => row.document_ref === 'service-note');
  assert.equal(note.total_paise, -123);
  assert.equal(note.cogs_paise, 0);
  const pl = await reportProfitLoss(db, april);
  assert.equal(pl.revenue.services_paise, 1877);
  assert.equal(pl.net_profit_paise, 1443);
  const bs = await reportBalanceSheet(db, { as_of: april.to });
  assert.equal(bs.earnings_to_date_paise, pl.net_profit_paise);
  assert.equal(bs.balanced, true);
  const stock = await reportStockRegister(db, { as_of: april.to });
  assert.equal(stock.totals.closing_value_paise, 667);
  assert.equal(stock.items.some(row => row.id === 'delivery'), false);
  assert.equal(stock.reconciliation.reconciled, true);
});

test('stored IGST adjustments retain financial-note GST exposure without recalculating tax', async t => {
  const { db, sqlite } = returnsFixture(t);
  // Alternate document snapshots exercise IGST; this register never recalculates
  // values from rates or needs the test's independent ledger for document totals.
  sqlite.exec(`UPDATE sales SET igst_paise = cgst_paise + sgst_paise, cgst_paise = 0, sgst_paise = 0;
    UPDATE credit_notes SET igst_paise = cgst_paise + sgst_paise, cgst_paise = 0, sgst_paise = 0`);
  const report = await reportSalesRegister(db, april);
  assert.equal(report.totals.igst_paise, 0);
  assert.equal(report.totals.gst_return_igst_paise, 100);
  assert.equal(report.totals.gst_not_recoverable_paise, 100);
  assert.equal(report.documents[1].gst_return_igst_paise, -100);
  assert.equal(report.documents[3].igst_paise, -100);
  assert.equal(report.documents[3].gst_return_igst_paise, 0);
});

test('purchase register does not count copied purchase links on new return lots as receipts', async t => {
  const { db } = returnsFixture(t);
  const report = await reportPurchaseRegister(db, april);
  assert.equal(report.purchases[0].quantity_received, 3);
  assert.equal(report.purchases[0].stock_added_paise, 1001);
  assert.equal(report.totals.taxable_paise, 900);
});

for (const [day, qty, value] of [['01', 3, 1001], ['02', 0, 0], ['03', 1, 333], ['04', 2, 667], ['05', 2, 667]]) {
  test(`stock history at April ${day} attributes returns to note dates and reconciles account 1200`, async t => {
    const { db } = returnsFixture(t);
    const report = await reportStockRegister(db, { from: april.from, as_of: `2026-04-${day}` });
    const item = report.items.find(row => row.id === 'report-good');
    assert.equal(item.closing_qty, qty);
    assert.equal(item.closing_value_paise, value);
    assert.equal(report.reconciliation.fifo_stock_paise, value);
    assert.equal(report.reconciliation.stock_in_hand_paise, value);
    assert.equal(report.reconciliation.difference_paise, 0);
    assert.equal(report.reconciliation.reconciled, true);
  });
}

test('none return is an audit disposition with zero stock delta and integer paise totals', async t => {
  const { db, sqlite } = returnsFixture(t);
  const report = await reportStockRegister(db, { from: '2026-04-03', as_of: '2026-04-05' });
  const item = report.items.find(row => row.id === 'report-good');
  assert.equal(item.opening_qty, 0);
  assert.equal(item.received_qty, 0);
  assert.equal(item.returned_qty, 2);
  assert.equal(item.returned_value_paise, 667);
  assert.equal(item.written_off_qty, 1);
  assert.equal(item.written_off_value_paise, 334);
  const writtenOff = item.movements.find(row => row.event_type === 'return_written_off');
  assert.equal(writtenOff.qty_delta, 0);
  assert.equal(writtenOff.value_delta_paise, 0);
  assert.equal(writtenOff.occurred_at, istStart('2026-04-05'));
  assert.equal(report.totals.returned_value_paise, 667);
  assert.equal(report.totals.written_off_value_paise, 334);
  const pl = await reportProfitLoss(db, april);
  const bs = await reportBalanceSheet(db, { as_of: april.to });
  assert.equal(pl.cost_of_goods_sold_paise, 0);
  assert.equal(pl.net_profit_paise, -434);
  assert.equal(bs.earnings_to_date_paise, pl.net_profit_paise);
  assert.equal(bs.balanced, true);
  assert.equal((await reportTrialBalance(db, april)).net, 0);
  const cash = await reportCashBook(db, april);
  assert.equal(cash.totals.payments_paise, 1800);
  assert.equal(cash.closing_paise, -1800);
  const day = await reportDayBook(db, april);
  for (const row of day.vouchers) assert.equal(row.debit_paise, row.credit_paise);
  const direct = sqlite.prepare('SELECT SUM(cost_remaining_paise) AS value FROM stock_lots').get();
  assert.equal(direct.value, 667);
  const checkMoney = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, field] of Object.entries(value)) {
      if (key.endsWith('_paise')) assert.equal(Number.isSafeInteger(field), true, key);
      else checkMoney(field);
    }
  };
  for (const value of [report, pl, bs, cash, day, await reportSalesRegister(db, april)]) checkMoney(value);
});

test('historical and current stock integrity surface a one-paisa drift without hiding either source', async t => {
  const { db, voucher } = returnsFixture(t);
  const current = await reportStockRegister(db);
  assert.equal(current.totals.closing_value_paise, 667);
  assert.ok(current.current_lots);
  assert.equal(current.reconciliation.reconciled, true);
  voucher(istStart('2026-04-06'), [['1200', 1, 0], ['3100', 0, 1]], 'drift');
  for (const options of [{ as_of: april.to }, {}]) {
    const report = await reportStockIntegrity(db, options);
    assert.equal(report.fifo_stock_paise, 667);
    assert.equal(report.stock_in_hand_paise, 668);
    assert.equal(report.difference_paise, -1);
    assert.equal(report.reconciled, false);
  }
});
