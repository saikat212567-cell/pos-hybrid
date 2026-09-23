/**
 * Ledger posting, against a REAL SQLite database rather than a mock.
 *
 * The other unit tests use a hand-written fake `db` because they only exercise
 * arithmetic. These cannot: the defect this file exists to catch lives in how a
 * sub-select resolves against actual rows, which a fake that returns whatever it
 * is told would hide completely.
 *
 * node:sqlite is in the platform, so this still needs no server and no D1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  buildVoucher, voucherStatements, saleVoucherLines, purchaseVoucherLines,
  UnbalancedVoucher, ACC,
} from '../src/ledger.js';

/**
 * Minimal stand-in for the D1 binding that records prepared statements, plus a
 * `batch()` that runs them against real SQLite in one transaction — which is
 * what D1's batch() guarantees, and what the sub-selects rely on.
 */
function realDb() {
  const db = new DatabaseSync(':memory:');

  // The ledger tables exactly as 0002_foundation.sql creates them, including the
  // partial unique index — the partial-ness is central to the bug below.
  db.exec(`
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
    CREATE UNIQUE INDEX vouchers_ref_idx ON vouchers (type, ref) WHERE ref IS NOT NULL;
    CREATE TABLE voucher_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
      account_code TEXT NOT NULL REFERENCES accounts(code),
      debit_paise INTEGER NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
      credit_paise INTEGER NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
      CHECK ((debit_paise = 0) <> (credit_paise = 0))
    );
  `);

  for (const [code, name, type] of [
    ['1000', 'Cash in Hand', 'asset'], ['1010', 'Bank Account', 'asset'],
    ['1100', 'Sundry Debtors', 'asset'], ['1200', 'Stock in Hand', 'asset'],
    ['1300', 'Input CGST', 'asset'], ['1310', 'Input SGST', 'asset'],
    ['1320', 'Input IGST', 'asset'], ['2000', 'Sundry Creditors', 'liability'],
    ['2100', 'Output CGST', 'liability'], ['2110', 'Output SGST', 'liability'],
    ['2120', 'Output IGST', 'liability'], ['3000', 'Capital Account', 'equity'],
    ['3100', 'Opening Stock Adjustment', 'equity'], ['4000', 'Sales', 'income'],
    ['4100', 'Service Income', 'income'], ['5000', 'Cost of Goods Sold', 'expense'],
    ['5900', 'Round Off', 'expense'],
  ]) {
    db.prepare('INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)').run(code, name, type);
  }

  return {
    sqlite: db,
    prepare(sql) {
      return { sql, binds: [], bind(...b) { this.binds = b; return this; } };
    },
    /** Run statements in one transaction, as D1's batch() does. */
    batch(statements) {
      db.exec('BEGIN');
      try {
        for (const s of statements) db.prepare(s.sql).run(...s.binds);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    query(sql, ...binds) { return db.prepare(sql).all(...binds); },
    get(sql, ...binds) { return db.prepare(sql).get(...binds); },
  };
}

// --- buildVoucher: the balance guarantee --------------------------------------

test('a balanced voucher is accepted and zero lines are dropped', () => {
  const v = buildVoucher([
    { account: ACC.CASH, debit: 5000, credit: 0 },
    { account: ACC.SALES, debit: 0, credit: 5000 },
    { account: ACC.COGS, debit: 0, credit: 0 },     // a services-only bill
  ]);
  assert.equal(v.lines.length, 2, 'the zero line should be dropped');
  assert.equal(v.total, 5000);
});

test('an unbalanced voucher is refused', () => {
  assert.throws(() => buildVoucher([
    { account: ACC.CASH, debit: 5000, credit: 0 },
    { account: ACC.SALES, debit: 0, credit: 4999 },
  ]), UnbalancedVoucher);
});

test('a negative amount is refused, not silently filtered', () => {
  // Two negatives on opposite sides would cancel out and pass a naive balance
  // check while posting an entry for the wrong total.
  assert.throws(() => buildVoucher([
    { account: ACC.CASH, debit: -500, credit: 0 },
    { account: ACC.SALES, debit: 0, credit: -500 },
  ]), UnbalancedVoucher);
});

test('a voucher with no lines at all is refused', () => {
  assert.throws(() => buildVoucher([]), UnbalancedVoucher);
  assert.throws(() => buildVoucher([{ account: ACC.CASH, debit: 0, credit: 0 }]), UnbalancedVoucher);
});

// --- voucherStatements: does each voucher get ITS OWN lines? ------------------

test('a voucher with a ref gets exactly its own lines', () => {
  const db = realDb();

  for (const ref of ['sale-1', 'sale-2']) {
    const v = saleVoucherLines({
      total: 5000, goodsTaxable: 4237, serviceTaxable: 0,
      cgst: 381, sgst: 382, igst: 0, roundOff: 0, cogs: 2000, paymentMode: 'cash',
    });
    db.batch(voucherStatements(db, { type: 'sale', ref, narration: ref }, v.lines));
  }

  const rows = db.query(
    `SELECT v.ref, COUNT(vl.id) n, COALESCE(SUM(vl.debit_paise),0) dr
       FROM vouchers v LEFT JOIN voucher_lines vl ON vl.voucher_id = v.id
      GROUP BY v.id ORDER BY v.id`
  );
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(r.n > 0, `voucher ${r.ref} got no lines`);
    assert.equal(r.dr, 5000 + 2000, `voucher ${r.ref} has the wrong debits`);
  }
});

test('TWO NULL-REF VOUCHERS EACH GET THEIR OWN LINES', () => {
  // THE REGRESSION THIS FILE EXISTS FOR.
  //
  // A cash purchase with no supplier invoice number has ref = NULL — the common
  // case for a small shop buying from a local market. Resolving the voucher id
  // with `WHERE type = ? AND ref IS ?` matches the FIRST null-ref voucher of that
  // type, not the one just inserted, so the second purchase's lines are attached
  // to the first purchase's voucher.
  //
  // The partial index `UNIQUE (type, ref) WHERE ref IS NOT NULL` does NOT
  // constrain null refs, so nothing stops two of them existing.
  //
  // What makes this the worst kind of bug: the trial balance still nets to zero,
  // because the lines are all present and balanced — just on the wrong voucher.
  // Every aggregate check passes while the books misattribute money.
  const db = realDb();

  const purchases = [
    { narration: 'Cash purchase A - rice', taxable: 50000, tax: 2500 },
    { narration: 'Cash purchase B - oil', taxable: 30000, tax: 1500 },
  ];

  for (const p of purchases) {
    const v = purchaseVoucherLines({
      taxable: p.taxable,
      cgst: Math.floor(p.tax / 2),
      sgst: p.tax - Math.floor(p.tax / 2),
      igst: 0,
      total: p.taxable + p.tax,
      paymentMode: 'cash',
    });
    db.batch(voucherStatements(
      db, { type: 'purchase', ref: null, narration: p.narration }, v.lines
    ));
  }

  const rows = db.query(
    `SELECT v.id, v.narration, COUNT(vl.id) n, COALESCE(SUM(vl.debit_paise),0) dr
       FROM vouchers v LEFT JOIN voucher_lines vl ON vl.voucher_id = v.id
      GROUP BY v.id ORDER BY v.id`
  );

  assert.equal(rows.length, 2, 'both vouchers should exist');
  for (const r of rows) {
    assert.ok(r.n > 0,
      `voucher ${r.id} ("${r.narration}") got NO lines — they landed on another voucher`);
  }

  // And each must carry its own amount, not the other's as well.
  assert.equal(rows[0].dr, 50000 + 2500, 'purchase A has the wrong debits');
  assert.equal(rows[1].dr, 30000 + 1500, 'purchase B has the wrong debits');
});

test('the trial balance nets to zero even when lines are misattributed', () => {
  // Proof that the balance check cannot catch the bug above, which is why a
  // dedicated test is needed rather than relying on the trial balance.
  const db = realDb();
  for (const n of ['A', 'B']) {
    const v = purchaseVoucherLines({
      taxable: 10000, cgst: 0, sgst: 0, igst: 0, total: 10000, paymentMode: 'cash',
    });
    db.batch(voucherStatements(db, { type: 'purchase', ref: null, narration: n }, v.lines));
  }
  const t = db.get('SELECT SUM(debit_paise) dr, SUM(credit_paise) cr FROM voucher_lines');
  assert.equal(t.dr, t.cr, 'a misattributed ledger still balances — hence this file');
});

test('a null-ref and a non-null-ref voucher of the same type coexist correctly', () => {
  const db = realDb();

  const a = purchaseVoucherLines({
    taxable: 10000, cgst: 0, sgst: 0, igst: 0, total: 10000, paymentMode: 'cash',
  });
  db.batch(voucherStatements(db, { type: 'purchase', ref: null, narration: 'no invoice' }, a.lines));

  const b = purchaseVoucherLines({
    taxable: 20000, cgst: 0, sgst: 0, igst: 0, total: 20000, paymentMode: 'cash',
  });
  db.batch(voucherStatements(db, { type: 'purchase', ref: 'INV-9', narration: 'with invoice' }, b.lines));

  const rows = db.query(
    `SELECT v.id, COALESCE(SUM(vl.debit_paise),0) dr
       FROM vouchers v LEFT JOIN voucher_lines vl ON vl.voucher_id = v.id
      GROUP BY v.id ORDER BY v.id`
  );
  assert.equal(rows[0].dr, 10000);
  assert.equal(rows[1].dr, 20000);
});

test('many null-ref vouchers each keep their own lines', () => {
  // The bug worsens with volume: with the old resolution every one of these
  // piled onto voucher 1.
  const db = realDb();
  const amounts = [1000, 2000, 3000, 4000, 5000];

  for (const amt of amounts) {
    const v = purchaseVoucherLines({
      taxable: amt, cgst: 0, sgst: 0, igst: 0, total: amt, paymentMode: 'cash',
    });
    db.batch(voucherStatements(db, { type: 'purchase', ref: null, narration: `p${amt}` }, v.lines));
  }

  const rows = db.query(
    `SELECT v.id, COALESCE(SUM(vl.debit_paise),0) dr
       FROM vouchers v LEFT JOIN voucher_lines vl ON vl.voucher_id = v.id
      GROUP BY v.id ORDER BY v.id`
  );
  assert.equal(rows.length, amounts.length);
  rows.forEach((r, i) => {
    assert.equal(r.dr, amounts[i], `voucher ${r.id} should carry only its own ${amounts[i]}`);
  });
});

// --- the standard entries -----------------------------------------------------

test('a sale posts revenue split by goods and services', () => {
  const db = realDb();
  const v = saleVoucherLines({
    total: 9000, goodsTaxable: 4237, serviceTaxable: 3390,
    cgst: 686, sgst: 687, igst: 0, roundOff: 0, cogs: 2000, paymentMode: 'cash',
  });
  db.batch(voucherStatements(db, { type: 'sale', ref: 'mixed-1', narration: 'mixed' }, v.lines));

  const byAccount = {};
  for (const r of db.query(
    `SELECT account_code, SUM(debit_paise) dr, SUM(credit_paise) cr
       FROM voucher_lines GROUP BY account_code`
  )) byAccount[r.account_code] = r;

  assert.equal(byAccount[ACC.SALES].cr, 4237, 'goods revenue to Sales');
  assert.equal(byAccount[ACC.SERVICE_INCOME].cr, 3390, 'service revenue separately');
  assert.equal(byAccount[ACC.COGS].dr, 2000);
  assert.equal(byAccount[ACC.STOCK].cr, 2000);
});

test('a credit sale posts to Sundry Debtors, not Cash', () => {
  const db = realDb();
  const v = saleVoucherLines({
    total: 5000, goodsTaxable: 5000, serviceTaxable: 0,
    cgst: 0, sgst: 0, igst: 0, roundOff: 0, cogs: 0, paymentMode: 'credit',
  });
  db.batch(voucherStatements(db, { type: 'sale', ref: 'credit-1', narration: 'unpaid' }, v.lines));

  const debtors = db.get(
    'SELECT SUM(debit_paise) dr FROM voucher_lines WHERE account_code = ?', ACC.DEBTORS);
  assert.equal(debtors.dr, 5000, 'an unpaid sale is a receivable');
});

test('round off posts on the correct side', () => {
  for (const [adj, col] of [[40, 'credit_paise'], [-40, 'debit_paise']]) {
    const db = realDb();
    const v = saleVoucherLines({
      total: 5000 + adj, goodsTaxable: 5000, serviceTaxable: 0,
      cgst: 0, sgst: 0, igst: 0, roundOff: adj, cogs: 0, paymentMode: 'cash',
    });
    db.batch(voucherStatements(db, { type: 'sale', ref: `r${adj}`, narration: 'rounded' }, v.lines));

    const r = db.get(
      `SELECT SUM(${col}) v FROM voucher_lines WHERE account_code = ?`, ACC.ROUND_OFF);
    assert.equal(r.v, Math.abs(adj), `round off ${adj} should be a ${col}`);
  }
});
