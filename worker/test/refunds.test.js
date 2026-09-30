/** Reversal foundations against the reviewed 0001–0005 schema; no HTTP writer or tax policy. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { planReturn } from '../src/refunds.js';
import { ACC, creditNoteVoucherLines, voucherStatements } from '../src/ledger.js';

const migrations = [
  '0001_initial.sql', '0002_foundation.sql', '0003_items_images.sql',
  '0004_refunds.sql', '0005_actor_identity.sql',
].map(file => readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrations) sqlite.exec(migration);
  assert.equal(sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  t.after(() => sqlite.close());
  let reads = 0;
  let prepares = 0;
  // Each bind creates a fresh statement: a later prepare/bind cannot mutate an
  // already planned operation's SQL or arguments. batch has D1's atomicity.
  function statement(sql, params = []) {
    return {
      bind: (...values) => statement(sql, [...values]),
      async all() { reads++; return { results: sqlite.prepare(sql).all(...params) }; },
      async first() { reads++; return sqlite.prepare(sql).get(...params) ?? null; },
      async run() { return sqlite.prepare(sql).run(...params); },
    };
  }
  const db = {
    prepare(sql) { prepares++; return statement(sql); },
    async batch(statements) {
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
  return { sqlite, db, get reads() { return reads; }, get prepares() { return prepares; } };
}

let refNo = 0;
function seedSale(f, { qty = 3, cost = 1000, lots = [{ qty, cost }], product = 'espresso' } = {}) {
  const { sqlite } = f;
  const ref = `return-fixture-${++refNo}`;
  sqlite.prepare('INSERT INTO sales (client_ref, total, items) VALUES (?, 0, ?)').run(ref, '[]');
  const lineId = Number(sqlite.prepare(`INSERT INTO sale_lines
    (sale_ref, product_id, name, qty, price_paise, cogs_paise, qty_returnable)
    VALUES (?, ?, ?, ?, 0, ?, ?)`).run(ref, product, product, qty, cost, qty).lastInsertRowid);
  const allocations = lots.map(lot => {
    const lotId = Number(sqlite.prepare(`INSERT INTO stock_lots
      (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise)
      VALUES (?, ?, 0, ?, 0)`).run(product, lot.qty, lot.cost).lastInsertRowid);
    const id = Number(sqlite.prepare(`INSERT INTO cogs_allocations
      (sale_line_id, lot_id, qty, cost_paise, qty_returnable, cost_returnable_paise)
      VALUES (?, ?, ?, ?, ?, ?)`).run(lineId, lotId, lot.qty, lot.cost, lot.qty, lot.cost).lastInsertRowid);
    return { id, lotId, ...lot };
  });
  return { ref, lineId, allocations };
}

function remainder(f, id) {
  const row = f.sqlite.prepare(`SELECT qty, cost_paise, qty_returnable, cost_returnable_paise
    FROM cogs_allocations WHERE id = ?`).get(id);
  return row ? { ...row } : null;
}
const movements = voucher => voucher.lines.map(l => [l.account, l.debit, l.credit]);
const debit = (account, amount) => [account, amount, 0];
const credit = (account, amount) => [account, 0, amount];
function voucher(input, expected) {
  const result = creditNoteVoucherLines({
    totalPaise: 1181, goodsTaxablePaise: 1000, serviceTaxablePaise: 0,
    cgstPaise: 90, sgstPaise: 90, igstPaise: 0, roundOffPaise: 1,
    cogsReversedPaise: 400, stockReturnMode: 'original_lot', taxAdjusted: 1,
    registration: 'regular', paymentMode: 'card', refundMode: 'cash', ...input,
  });
  assert.deepEqual(movements(result).sort((a, b) => a[0].localeCompare(b[0])),
    expected.sort((a, b) => a[0].localeCompare(b[0])));
  assert.equal(result.lines.reduce((sum, l) => sum + l.debit, 0), result.total);
  assert.equal(result.lines.reduce((sum, l) => sum + l.credit, 0), result.total);
  assert.ok(result.lines.every(l => (l.debit > 0) !== (l.credit > 0)));
}

const goodsCash = [credit(ACC.CASH, 1181), debit(ACC.SALES, 1000),
  debit(ACC.OUTPUT_CGST, 90), debit(ACC.OUTPUT_SGST, 90),
  debit(ACC.ROUND_OFF, 1), debit(ACC.STOCK, 400), credit(ACC.COGS, 400)];

test('card-origin sale refunded in cash credits Cash, not Bank or the original settlement', () => {
  voucher({}, goodsCash);
});

test('actual refund mode chooses cash, bank, card, upi or credit independently of original mode', () => {
  for (const original of ['cash', 'bank', 'card', 'upi', 'credit']) {
    for (const [mode, account] of Object.entries({ cash: ACC.CASH, bank: ACC.BANK,
      card: ACC.BANK, upi: ACC.BANK, credit: ACC.DEBTORS })) {
      voucher({ paymentMode: original, refundMode: mode },
        goodsCash.map(l => l[0] === ACC.CASH && l[2] === 1181 ? credit(account, 1181) : l));
    }
  }
});

test('unknown, blank and missing refund modes are rejected rather than falling back to the original sale', () => {
  for (const refundMode of [undefined, null, '', 'cheque', 'CASH', 'toString', 'constructor', '__proto__', ['cash']]) {
    assert.throws(() => creditNoteVoucherLines({
      totalPaise: 100, goodsTaxablePaise: 100, serviceTaxablePaise: 0,
      cgstPaise: 0, sgstPaise: 0, igstPaise: 0, roundOffPaise: 0,
      cogsReversedPaise: 0, stockReturnMode: 'original_lot', taxAdjusted: 1,
      registration: 'regular', paymentMode: 'card', refundMode,
    }));
  }
});

test('service-only, IGST, signed round-off and no-stock branch are exact and balanced', () => {
  voucher({ goodsTaxablePaise: 0, serviceTaxablePaise: 500, cgstPaise: 0,
    sgstPaise: 0, igstPaise: 90, roundOffPaise: 0, totalPaise: 590,
    cogsReversedPaise: 0, stockReturnMode: 'none', refundMode: 'bank' }, [
    credit(ACC.BANK, 590), debit(ACC.SERVICE_INCOME, 500), debit(ACC.OUTPUT_IGST, 90),
  ]);
  voucher({ cgstPaise: 0, sgstPaise: 0, igstPaise: 180,
    roundOffPaise: -1, totalPaise: 1179, stockReturnMode: 'new_lot' }, [
    credit(ACC.CASH, 1179), debit(ACC.SALES, 1000), debit(ACC.OUTPUT_IGST, 180),
    credit(ACC.ROUND_OFF, 1), debit(ACC.STOCK, 400), credit(ACC.COGS, 400),
  ]);
});

test('financial-note GST expense and no-stock disposition use their own accounts (voucher template only)', () => {
  voucher({ taxAdjusted: 0, stockReturnMode: 'none' }, [
    credit(ACC.CASH, 1181), debit(ACC.SALES, 1000), debit(ACC.GST_NOT_RECOVERABLE, 180),
    debit(ACC.ROUND_OFF, 1), debit(ACC.GOODS_WRITTEN_OFF, 400), credit(ACC.COGS, 400),
  ]);
});

test('three sequential one-of-three returns allocate 333, 334, 333 and close exact original cost', async t => {
  const f = fixture(t);
  const { lineId, allocations: [a] } = seedSale(f);
  const costs = [];
  for (const remaining of [2, 1, 0]) {
    const plan = await planReturn(f.db, lineId, 1);
    assert.deepEqual(plan.allocations, [{ cogs_allocation_id: a.id, lot_id: a.lotId,
      qty: 1, cost_paise: plan.cogsPaise }]);
    assert.deepEqual(remainder(f, a.id), { qty: 3, cost_paise: 1000,
      qty_returnable: remaining + 1, cost_returnable_paise: 1000 - costs.reduce((x, y) => x + y, 0) },
    'planning must not write to original or returnable columns');
    await f.db.batch(plan.statements);
    costs.push(plan.cogsPaise);
    assert.equal(remainder(f, a.id).qty_returnable, remaining);
  }
  assert.deepEqual(costs, [333, 334, 333]);
  assert.deepEqual(remainder(f, a.id), { qty: 3, cost_paise: 1000,
    qty_returnable: 0, cost_returnable_paise: 0 });
  await assert.rejects(planReturn(f.db, lineId, 1));
});

test('reverse SQL allocation order restores correct source lot IDs, without modifying original evidence while planning', async t => {
  const f = fixture(t);
  const { lineId, allocations: [older, newer] } = seedSale(f, {
    qty: 5, cost: 1000, lots: [{ qty: 2, cost: 300 }, { qty: 3, cost: 700 }],
  });
  const before = [remainder(f, older.id), remainder(f, newer.id)];
  const plan = await planReturn(f.db, lineId, 4);
  assert.deepEqual(plan.allocations, [
    { cogs_allocation_id: newer.id, lot_id: newer.lotId, qty: 3, cost_paise: 700 },
    { cogs_allocation_id: older.id, lot_id: older.lotId, qty: 1, cost_paise: 150 },
  ]);
  assert.equal(plan.cogsPaise, 850);
  assert.deepEqual([remainder(f, older.id), remainder(f, newer.id)], before);
  await f.db.batch(plan.statements);
  assert.deepEqual(remainder(f, older.id), { qty: 2, cost_paise: 300,
    qty_returnable: 1, cost_returnable_paise: 150 });
  assert.deepEqual(remainder(f, newer.id), { qty: 3, cost_paise: 700,
    qty_returnable: 0, cost_returnable_paise: 0 });
});

test('zero-cost allocations retain quantity evidence without inventing cost', async t => {
  const f = fixture(t);
  const { lineId, allocations: [a] } = seedSale(f, { qty: 2, cost: 0 });
  const plan = await planReturn(f.db, lineId, 2);
  assert.deepEqual(plan.allocations, [{ cogs_allocation_id: a.id, lot_id: a.lotId,
    qty: 2, cost_paise: 0 }]);
  assert.equal(plan.cogsPaise, 0);
  await f.db.batch(plan.statements);
  assert.deepEqual(remainder(f, a.id), { qty: 2, cost_paise: 0,
    qty_returnable: 0, cost_returnable_paise: 0 });
});

test('invalid sale-line IDs and quantities fail before even preparing a DB read', async t => {
  const f = fixture(t);
  for (const bad of [undefined, null, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const before = { reads: f.reads, prepares: f.prepares };
    await assert.rejects(planReturn(f.db, bad, 1), `id ${String(bad)}`);
    await assert.rejects(planReturn(f.db, 1, bad), `qty ${String(bad)}`);
    assert.deepEqual({ reads: f.reads, prepares: f.prepares }, before);
  }
});

test('malformed or unsafe stored remainder is refused, not rounded or coerced', async t => {
  const f = fixture(t);
  const { lineId, allocations: [a] } = seedSale(f);
  for (const [column, bad] of [
    ['qty_returnable', 'oops'], ['qty_returnable', 1.5],
    ['qty_returnable', Number.MAX_SAFE_INTEGER + 1],
    ['cost_returnable_paise', 'oops'], ['cost_returnable_paise', 1.5],
    ['cost_returnable_paise', Number.MAX_SAFE_INTEGER + 1],
  ]) {
    const before = remainder(f, a.id);
    f.sqlite.prepare(`UPDATE cogs_allocations SET ${column} = ? WHERE id = ?`).run(bad, a.id);
    await assert.rejects(planReturn(f.db, lineId, 1), `${column} ${String(bad)}`);
    f.sqlite.prepare(`UPDATE cogs_allocations SET qty_returnable = ?, cost_returnable_paise = ? WHERE id = ?`)
      .run(before.qty_returnable, before.cost_returnable_paise, a.id);
  }
});

test('unsafe partial multiplication, rounding addition and cumulative cost are rejected; full MAX_SAFE allocation stays exact', async t => {
  const f = fixture(t);
  const max = Number.MAX_SAFE_INTEGER;
  const multiply = seedSale(f, { qty: 3, cost: max });
  await assert.rejects(planReturn(f.db, multiply.lineId, 2), 'partial product exceeds safe integer');
  const add = seedSale(f, { qty: 2, cost: max });
  await assert.rejects(planReturn(f.db, add.lineId, 1), 'rounding numerator exceeds safe integer');
  const full = await planReturn(f.db, multiply.lineId, 3);
  assert.equal(full.cogsPaise, max);
  assert.equal(full.allocations[0].cost_paise, max);
  await f.db.batch(full.statements);
  assert.equal(remainder(f, multiply.allocations[0].id).cost_returnable_paise, 0);
  const sum = seedSale(f, { qty: 2, cost: max, lots: [
    { qty: 1, cost: max - 1 }, { qty: 1, cost: 2 },
  ] });
  await assert.rejects(planReturn(f.db, sum.lineId, 2), 'sum of individually safe costs overflows');
});

test('over-return refuses without writing even when earlier allocations could be used', async t => {
  const f = fixture(t);
  const { lineId, allocations } = seedSale(f, { qty: 2, cost: 50,
    lots: [{ qty: 1, cost: 20 }, { qty: 1, cost: 30 }] });
  await assert.rejects(planReturn(f.db, lineId, 3));
  assert.deepEqual(allocations.map(a => remainder(f, a.id).qty_returnable), [1, 1]);
});

test('three plans on the same snapshot cannot all commit; replan closes 1000 exactly', async t => {
  const f = fixture(t);
  const { lineId, allocations: [a] } = seedSale(f);
  const plans = await Promise.all([1, 2, 3].map(() => planReturn(f.db, lineId, 1)));
  await f.db.batch(plans[0].statements);
  for (const stale of plans) {
    await assert.rejects(f.db.batch(stale.statements), 'stale plan must abort its transaction');
    assert.deepEqual(remainder(f, a.id), { qty: 3, cost_paise: 1000,
      qty_returnable: 2, cost_returnable_paise: 667 });
  }
  const fresh2 = await planReturn(f.db, lineId, 1);
  assert.equal(fresh2.cogsPaise, 334);
  await f.db.batch(fresh2.statements);
  const fresh3 = await planReturn(f.db, lineId, 1);
  assert.equal(fresh3.cogsPaise, 333);
  await f.db.batch(fresh3.statements);
  assert.deepEqual(remainder(f, a.id), { qty: 3, cost_paise: 1000,
    qty_returnable: 0, cost_returnable_paise: 0 });
});

function prefix(f, ref) {
  return [
    f.db.prepare('INSERT INTO invoice_series (series, fy, last_no) VALUES (?, ?, ?)')
      .bind('CN', '26-27', 1),
    ...voucherStatements(f.db, { type: 'credit_note', ref, narration: 'rollback test' }, [
      { account: ACC.CASH, debit: 0, credit: 100 },
      { account: ACC.SALES, debit: 100, credit: 0 },
    ]),
  ];
}
function assertPrefixAbsent(f, ref) {
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM invoice_series WHERE series = ?').get('CN').n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE ref = ?').get(ref).n, 0);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM voucher_lines`).get().n, 0);
}

test('multi-allocation stale second row rolls back earlier allocation, numbering and voucher prefix', async t => {
  const f = fixture(t);
  const { lineId, allocations: [older, newer] } = seedSale(f, { qty: 2, cost: 50,
    lots: [{ qty: 1, cost: 20 }, { qty: 1, cost: 30 }] });
  const plan = await planReturn(f.db, lineId, 2);
  assert.deepEqual(plan.allocations.map(a => a.cogs_allocation_id), [newer.id, older.id]);
  f.sqlite.prepare('UPDATE cogs_allocations SET cost_returnable_paise = 21 WHERE id = ?').run(older.id);
  await assert.rejects(f.db.batch([...prefix(f, 'rollback-second'), ...plan.statements]));
  assertPrefixAbsent(f, 'rollback-second');
  assert.deepEqual(remainder(f, newer.id), { qty: 1, cost_paise: 30,
    qty_returnable: 1, cost_returnable_paise: 30 });
  assert.deepEqual(remainder(f, older.id), { qty: 1, cost_paise: 20,
    qty_returnable: 1, cost_returnable_paise: 21 });
});

test('qty-only, cost-only changes and deleted allocation rows fail closed, not zero-row success', async t => {
  for (const change of ['qty', 'cost', 'delete']) {
    const f = fixture(t);
    const { lineId, allocations: [a] } = seedSale(f);
    const plan = await planReturn(f.db, lineId, 1);
    if (change === 'delete') f.sqlite.prepare('DELETE FROM cogs_allocations WHERE id = ?').run(a.id);
    else f.sqlite.prepare(`UPDATE cogs_allocations SET ${change === 'qty' ? 'qty_returnable' : 'cost_returnable_paise'} = ? WHERE id = ?`)
      .run(change === 'qty' ? 2 : 999, a.id);
    const before = remainder(f, a.id);
    await assert.rejects(f.db.batch([...prefix(f, `stale-${change}`), ...plan.statements]), change);
    assertPrefixAbsent(f, `stale-${change}`);
    assert.deepEqual(remainder(f, a.id), before);
  }
});

test('changed allocation ownership aborts instead of restoring to a stale line or lot', async t => {
  for (const column of ['sale_line_id', 'lot_id']) {
    const f = fixture(t);
    const original = seedSale(f);
    const other = seedSale(f);
    const allocation = original.allocations[0];
    const plan = await planReturn(f.db, original.lineId, 1);
    f.sqlite.prepare(`UPDATE cogs_allocations SET ${column} = ? WHERE id = ?`)
      .run(column === 'sale_line_id' ? other.lineId : other.allocations[0].lotId, allocation.id);
    const before = f.sqlite.prepare('SELECT * FROM cogs_allocations ORDER BY id').all();
    await assert.rejects(f.db.batch([...prefix(f, `ownership-${column}`), ...plan.statements]));
    assertPrefixAbsent(f, `ownership-${column}`);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM cogs_allocations ORDER BY id').all(), before);
  }
});

test('successful snapshot guards do not insert allocation rows or advance AUTOINCREMENT', async t => {
  const f = fixture(t);
  const { lineId, allocations: [a] } = seedSale(f);
  const sequence = () => f.sqlite.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
  const beforeSequence = sequence();
  const beforeRow = f.sqlite.prepare('SELECT * FROM cogs_allocations WHERE id = ?').get(a.id);
  const beforeLastId = f.sqlite.prepare('SELECT last_insert_rowid() AS id').get().id;
  await f.db.batch((await planReturn(f.db, lineId, 1)).statements);
  assert.deepEqual(sequence(), beforeSequence);
  assert.equal(f.sqlite.prepare('SELECT last_insert_rowid() AS id').get().id, beforeLastId);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM cogs_allocations').get().n, 1);
  const afterRow = f.sqlite.prepare('SELECT * FROM cogs_allocations WHERE id = ?').get(a.id);
  assert.deepEqual({ ...afterRow }, { ...beforeRow, qty_returnable: 2, cost_returnable_paise: 667 });
});

test('missing second allocation rolls back earlier decrements and all prefix sequence changes', async t => {
  const f = fixture(t);
  const { lineId, allocations: [older, newer] } = seedSale(f, { qty: 2, cost: 50,
    lots: [{ qty: 1, cost: 20 }, { qty: 1, cost: 30 }] });
  const plan = await planReturn(f.db, lineId, 2);
  f.sqlite.prepare('DELETE FROM cogs_allocations WHERE id = ?').run(older.id);
  const sequence = f.sqlite.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
  await assert.rejects(f.db.batch([...prefix(f, 'missing-second'), ...plan.statements]));
  assertPrefixAbsent(f, 'missing-second');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(), sequence);
  assert.equal(remainder(f, newer.id).qty_returnable, 1);
  assert.equal(remainder(f, newer.id).cost_returnable_paise, 30);
  assert.equal(remainder(f, older.id), null);
});

test('accepted boundary partial and large zero-cost quantity remain exact', async t => {
  const f = fixture(t);
  const near = seedSale(f, { qty: 2, cost: Number.MAX_SAFE_INTEGER - 1 });
  const half = await planReturn(f.db, near.lineId, 1);
  assert.equal(half.cogsPaise, 4503599627370495);
  await f.db.batch(half.statements);
  const rest = await planReturn(f.db, near.lineId, 1);
  assert.equal(rest.cogsPaise, half.cogsPaise);
  await f.db.batch(rest.statements);
  assert.equal(remainder(f, near.allocations[0].id).cost_returnable_paise, 0);
  const zero = seedSale(f, { qty: Number.MAX_SAFE_INTEGER, cost: 0 });
  const plan = await planReturn(f.db, zero.lineId, Number.MAX_SAFE_INTEGER);
  assert.equal(plan.cogsPaise, 0);
  await f.db.batch(plan.statements);
  assert.equal(remainder(f, zero.allocations[0].id).qty_returnable, 0);
});

test('stale plan also rolls back preceding physical stock restoration', async t => {
  const f = fixture(t);
  const { lineId, allocations: [a] } = seedSale(f);
  const stale = await planReturn(f.db, lineId, 1);
  await f.db.batch((await planReturn(f.db, lineId, 1)).statements);
  const lotsBefore = f.sqlite.prepare('SELECT * FROM stock_lots ORDER BY id').all();
  const countersBefore = remainder(f, a.id);
  await assert.rejects(f.db.batch([
    ...prefix(f, 'rollback-stock'),
    f.db.prepare('UPDATE stock_lots SET qty_remaining = qty_remaining + ?, cost_remaining_paise = cost_remaining_paise + ? WHERE id = ?')
      .bind(1, stale.cogsPaise, a.lotId),
    ...stale.statements,
  ]), /CHECK constraint failed/);
  assertPrefixAbsent(f, 'rollback-stock');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM stock_lots ORDER BY id').all(), lotsBefore);
  assert.deepEqual(remainder(f, a.id), countersBefore);
});

test('failure after a fresh plan rolls its counters and preceding voucher back', async t => {
  const f = fixture(t);
  const { lineId, allocations: [a] } = seedSale(f);
  const before = remainder(f, a.id);
  const plan = await planReturn(f.db, lineId, 1);
  await assert.rejects(f.db.batch([
    ...prefix(f, 'rollback-after'),
    ...plan.statements,
    f.db.prepare(`INSERT INTO voucher_lines (voucher_id,account_code,debit_paise,credit_paise)
      VALUES ((SELECT MAX(id) FROM vouchers), 'missing-account', 1, 0)`),
  ]), /FOREIGN KEY constraint failed/);
  assertPrefixAbsent(f, 'rollback-after');
  assert.deepEqual(remainder(f, a.id), before);
});

test('sale-line scope prevents another line’s allocations being returned', async t => {
  const f = fixture(t);
  const one = seedSale(f, { qty: 1, cost: 10 });
  const two = seedSale(f, { qty: 1, cost: 50 });
  const plan = await planReturn(f.db, one.lineId, 1);
  assert.deepEqual(plan.allocations.map(a => a.cogs_allocation_id), [one.allocations[0].id]);
  await f.db.batch(plan.statements);
  assert.equal(remainder(f, two.allocations[0].id).qty_returnable, 1);
  await assert.rejects(planReturn(f.db, one.lineId, 1));
  assert.equal((await planReturn(f.db, two.lineId, 1)).cogsPaise, 50);
});

test('independent DB bindings with overlapping IDs cannot cross-update allocations', async t => {
  const a = fixture(t);
  const b = fixture(t);
  const first = seedSale(a);
  const second = seedSale(b);
  assert.equal(first.allocations[0].id, second.allocations[0].id);
  const plan = await planReturn(a.db, first.lineId, 1);
  await a.db.batch(plan.statements);
  assert.equal(remainder(a, first.allocations[0].id).qty_returnable, 2);
  assert.equal(remainder(b, second.allocations[0].id).qty_returnable, 3);
  await b.db.batch((await planReturn(b.db, second.lineId, 1)).statements);
  assert.equal(remainder(a, first.allocations[0].id).cost_returnable_paise, 667);
  assert.equal(remainder(b, second.allocations[0].id).cost_returnable_paise, 667);
});
