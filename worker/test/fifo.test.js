/**
 * FIFO consumption and COGS. No server and no D1: a fake `db` stands in for
 * the binding, holding lots in memory and applying the planned UPDATEs the way
 * a real batch() would.
 *
 * The test that matters most is "no paisa is lost". Unit cost is usually not a
 * whole number of paise, and the naive fix — store a rounded unit cost — leaks
 * a fraction on every sale until inventory shows quantity with no cost against
 * it. These tests exist to keep that from creeping back in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planConsume, InsufficientStock } from '../src/fifo.js';

/**
 * Minimal stand-in for the D1 binding.
 *
 * Only what fifo.js actually uses: the FIFO SELECT, and UPDATE statements that
 * it records so a test can apply them. `apply()` is what makes multi-sale
 * sequences testable without a database.
 */
function fakeDb(lots) {
  const rows = lots.map((l, i) => ({
    id: i + 1,
    product_id: l.product_id,
    qty_remaining: l.qty,
    cost_remaining_paise: l.cost,
    received_at: l.at ?? `2026-01-0${i + 1} 00:00:00`,
  }));

  return {
    rows,
    prepare(sql) {
      return {
        sql,
        binds: [],
        bind(...b) { this.binds = b; return this; },
        async all() {
          const productId = this.binds[0];
          const matching = rows.filter(r => r.product_id === productId && r.qty_remaining > 0);

          // Honour the ORDER BY the SQL actually asks for, rather than assuming
          // ascending.
          //
          // This mock used to hardcode an ascending sort, which made the
          // "consumes the oldest lot first" test below pass no matter what the
          // real query said — including if it were changed to consume
          // newest-first. That is LIFO, which Ind AS 2 forbids outright, and the
          // test would have reported green while COGS came from the wrong lots.
          // A test that cannot fail when the behaviour it names is broken is
          // worse than no test, because the next real failure gets dismissed.
          const desc = /ORDER BY[^`]*\bDESC\b/i.test(this.sql);
          matching.sort((a, b) =>
            (a.received_at.localeCompare(b.received_at) || a.id - b.id) * (desc ? -1 : 1));

          return { results: matching };
        },
      };
    },
    /** Apply planned UPDATEs, as batch() would. */
    apply(statements) {
      for (const s of statements) {
        const [qty, cost, id] = s.binds;
        const row = rows.find(r => r.id === id);
        row.qty_remaining -= qty;
        row.cost_remaining_paise -= cost;
      }
    },
  };
}

const GOOD = { id: 'p1', kind: 'good' };
const SERVICE = { id: 's1', kind: 'service' };

// --- ordering --------------------------------------------------------------

test('consumes the oldest lot first', async () => {
  const db = fakeDb([
    { product_id: 'p1', qty: 10, cost: 1000, at: '2026-01-01 00:00:00' },  // 100p/unit
    { product_id: 'p1', qty: 10, cost: 2000, at: '2026-02-01 00:00:00' },  // 200p/unit
  ]);

  const plan = await planConsume(db, GOOD, 4);
  assert.equal(plan.allocations.length, 1, 'should draw from one lot only');
  assert.equal(plan.allocations[0].lotId, 1, 'the older lot');
  assert.equal(plan.cogsPaise, 400);
});

test('a sale spanning two lots costs the weighted sum, cheaper lot first', async () => {
  const db = fakeDb([
    { product_id: 'p1', qty: 10, cost: 1000, at: '2026-01-01 00:00:00' },
    { product_id: 'p1', qty: 10, cost: 2000, at: '2026-02-01 00:00:00' },
  ]);

  // 12 units: all 10 of the old lot at 100p, then 2 of the new at 200p.
  const plan = await planConsume(db, GOOD, 12);
  assert.equal(plan.cogsPaise, 1000 + 400);
  assert.deepEqual(plan.allocations.map(a => [a.lotId, a.qty]), [[1, 10], [2, 2]]);
});

test('lots received in the same second consume deterministically by id', async () => {
  const at = '2026-01-01 00:00:00';
  const db = fakeDb([
    { product_id: 'p1', qty: 2, cost: 200, at },
    { product_id: 'p1', qty: 2, cost: 999, at },
  ]);
  const plan = await planConsume(db, GOOD, 3);
  assert.deepEqual(plan.allocations.map(a => a.lotId), [1, 2]);
});

test('other products are not touched', async () => {
  const db = fakeDb([
    { product_id: 'other', qty: 99, cost: 9900 },
    { product_id: 'p1', qty: 5, cost: 500 },
  ]);
  const plan = await planConsume(db, GOOD, 5);
  assert.equal(plan.allocations.length, 1);
  assert.equal(plan.cogsPaise, 500);
});

// --- the paisa invariant ---------------------------------------------------

test('no paisa is lost: 3 units bought for 1000p, sold one at a time', async () => {
  // 1000/3 = 333.33p per unit, which no integer column can hold. Total COGS
  // must still come to exactly 1000 and the lot must empty to exactly zero.
  const db = fakeDb([{ product_id: 'p1', qty: 3, cost: 1000 }]);

  let cogs = 0;
  for (let i = 0; i < 3; i++) {
    const plan = await planConsume(db, GOOD, 1);
    cogs += plan.cogsPaise;
    db.apply(plan.statements);
  }

  assert.equal(cogs, 1000, 'total COGS must equal what the goods cost');
  assert.equal(db.rows[0].qty_remaining, 0);
  assert.equal(db.rows[0].cost_remaining_paise, 0, 'no cost may be stranded in an empty lot');
});

test('no paisa is lost for any awkward qty/cost combination', async () => {
  // The general property, not one lucky example.
  for (let qty = 1; qty <= 13; qty++) {
    for (const cost of [1, 100, 999, 1000, 1001, 7777, 100003]) {
      const db = fakeDb([{ product_id: 'p1', qty, cost }]);
      let total = 0;

      for (let i = 0; i < qty; i++) {
        const plan = await planConsume(db, GOOD, 1);
        total += plan.cogsPaise;
        db.apply(plan.statements);
      }

      assert.equal(total, cost, `qty ${qty}, cost ${cost}: COGS drifted`);
      assert.equal(db.rows[0].cost_remaining_paise, 0, `qty ${qty}, cost ${cost}: cost stranded`);
      assert.equal(db.rows[0].qty_remaining, 0);
    }
  }
});

test('draining a lot in uneven chunks still costs exactly the purchase price', async () => {
  const db = fakeDb([{ product_id: 'p1', qty: 10, cost: 3333 }]);
  let total = 0;
  for (const take of [3, 1, 4, 2]) {
    const plan = await planConsume(db, GOOD, take);
    total += plan.cogsPaise;
    db.apply(plan.statements);
  }
  assert.equal(total, 3333);
  assert.equal(db.rows[0].cost_remaining_paise, 0);
});

test('taking a whole lot takes its whole remaining cost', async () => {
  // Proportional arithmetic could round a paisa short here and strand it in a
  // lot with zero quantity, where it would sit in the stock valuation forever.
  const db = fakeDb([{ product_id: 'p1', qty: 3, cost: 1000 }]);
  const plan = await planConsume(db, GOOD, 3);
  assert.equal(plan.cogsPaise, 1000);
  db.apply(plan.statements);
  assert.equal(db.rows[0].cost_remaining_paise, 0);
});

// --- overselling -----------------------------------------------------------

test('refuses to oversell', async () => {
  const db = fakeDb([{ product_id: 'p1', qty: 5, cost: 500 }]);
  await assert.rejects(
    () => planConsume(db, GOOD, 6),
    err => err instanceof InsufficientStock && err.available === 5
  );
});

test('refuses to sell an item with no lots at all', async () => {
  const db = fakeDb([]);
  await assert.rejects(() => planConsume(db, GOOD, 1), InsufficientStock);
});

test('planning does not mutate anything', async () => {
  // The plan has to be inert: its UPDATEs go into the same transaction as the
  // sale, so stock cannot move unless the sale is recorded too.
  const db = fakeDb([{ product_id: 'p1', qty: 5, cost: 500 }]);
  await planConsume(db, GOOD, 3);
  assert.equal(db.rows[0].qty_remaining, 5, 'planning must not touch stock');
});

// --- services --------------------------------------------------------------

test('a service consumes nothing and has no COGS', async () => {
  const db = fakeDb([]);
  const plan = await planConsume(db, SERVICE, 4);
  assert.deepEqual(plan.allocations, []);
  assert.equal(plan.cogsPaise, 0);
  assert.deepEqual(plan.statements, []);
});

test('a service never runs out', async () => {
  // A service with zero stock must stay sellable — that is the whole reason it
  // is not modelled as a good with no lots.
  const db = fakeDb([]);
  const plan = await planConsume(db, SERVICE, 1_000_000);
  assert.equal(plan.cogsPaise, 0);
});
