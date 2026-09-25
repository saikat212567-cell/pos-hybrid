import { divRound } from "./gst.js";

function assert(cond) { if (!cond) throw new Error("Assertion failed"); }

export class InsufficientStock extends Error {
  constructor(productId, wanted, available) {
    super(`insufficient stock for ${productId}: wanted ${wanted}, have ${available}`);
    this.productId = productId;
    this.wanted = wanted;
    this.available = available;
  }
}

/**
 * Plan the consumption of `qty` units of `item`, oldest lot first.
 *
 * Read-only: returns the allocations and the UPDATE statements that would
 * apply them, without running anything. The caller puts those statements into
 * the same D1 batch() as the sale itself, so stock cannot move unless the
 * sale is also recorded.
 *
 * @param db    D1 database binding
 * @param item  {{id, kind}} — `kind: "service"` consumes nothing
 * @param qty   positive integer
 * @returns {Promise<{allocations: Array, cogsPaise: number, statements: Array}>}
 * @throws {InsufficientStock} when the lots cannot cover `qty`
 */
export async function planConsume(db, item, qty) {
  if (item.kind === 'service') {
    // A service has nothing to deplete and no cost of goods. One early return
    // here is why no caller downstream needs to know the difference, and why
    // a service line can never trip an oversell check.
    return { allocations: [], cogsPaise: 0, statements: [] };
  }

  const { results: lots } = await db
    .prepare(
      `SELECT id, qty_remaining, cost_remaining_paise
         FROM stock_lots
        WHERE product_id = ? AND qty_remaining > 0
        ORDER BY received_at, id`   // this ordering is the FIFO queue
    )
    .bind(item.id)
    .all();

  const available = lots.reduce((s, l) => s + l.qty_remaining, 0);
  if (available < qty) throw new InsufficientStock(item.id, qty, available);

  const allocations = [];
  const statements = [];
  let need = qty;
  let cogsPaise = 0;

  for (const lot of lots) {
    if (need === 0) break;

    const take = Math.min(need, lot.qty_remaining);

    // Taking the whole lot takes the whole remaining cost. Computing it as a
    // proportion instead could round to a paisa less and strand it in a lot
    // with zero quantity, where it would sit in the stock valuation forever.
    const cost = take === lot.qty_remaining
      ? lot.cost_remaining_paise
      : divRound(lot.cost_remaining_paise * take, lot.qty_remaining);

    allocations.push({ lotId: lot.id, qty: take, costPaise: cost });

    // Unguarded subtraction, deliberately: the CHECK constraints on
    // stock_lots (qty_remaining >= 0, cost_remaining_paise >= 0) are the
    // concurrency control.
    //
    // The SELECT above runs before the batch opens, so two tills selling the
    // last units of an item can both see the same lots and both pass the
    // availability check. The loser's subtraction then drives a remainder
    // negative, the CHECK fires, and the whole batch rolls back — so no sale,
    // no stock movement, no ledger entry, and the caller reports a conflict.
    //
    // A `WHERE qty_remaining >= ?` guard would be worse: the UPDATE would match
    // no rows and succeed silently, committing a sale that never moved stock.
    // An error that rolls everything back is the safe failure here.
    statements.push(
      db.prepare(
        `UPDATE stock_lots
            SET qty_remaining = qty_remaining - ?,
                cost_remaining_paise = cost_remaining_paise - ?
          WHERE id = ?`
      ).bind(take, cost, lot.id)
    );

    cogsPaise += cost;
    need -= take;
  }

  return { allocations, cogsPaise, statements };
}

/**
 * Current quantity and value of stock on hand, per item.
 *
 * Value is the sum of cost remaining, which is the FIFO carrying value by
 * construction — there is no separate valuation pass to disagree with it.
 * Services are excluded: they have no stock to report.
 */
export async function stockReport(db) {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.unit, p.tax_code,
              COALESCE(SUM(l.qty_remaining), 0)        AS qty,
              COALESCE(SUM(l.cost_remaining_paise), 0) AS value_paise
         FROM products p
         LEFT JOIN stock_lots l ON l.product_id = p.id
        WHERE p.kind = 'good'
        GROUP BY p.id
        ORDER BY p.name`
    )
    .all();
  return results;
}

/**
 * A costed lot: qty and cost in, both fully remaining.
 *
 * `linkPurchaseLine` decides where purchase_line_id comes from:
 *
 *  - true  (a purchase): fill it with (SELECT MAX(id) FROM purchase_lines). The
 *    line was inserted immediately before this lot in the same ordered batch,
 *    and an uncommitted row of a concurrent transaction is not visible, so
 *    MAX(id) is exactly that line.
 *
 *  - false (opening stock): there is NO purchase line, so purchase_line_id must
 *    be NULL — the column is nullable precisely for this "opening stock rather
 *    than a recorded purchase" case. Defaulting to the MAX(id) sub-select here
 *    was a real bug: it attributed every opening-stock lot to whatever supplier
 *    line happened to be inserted last, from an unrelated product, producing a
 *    false audit trail. See test/api.test.js.
 */
export function lotInsert(db, { productId, qty, costPaise, receivedAt = null, linkPurchaseLine = false }) {
  const purchaseLine = linkPurchaseLine ? '(SELECT MAX(id) FROM purchase_lines)' : 'NULL';
  return db.prepare(
    `INSERT INTO stock_lots
       (product_id, qty_in, qty_remaining, cost_in_paise, cost_remaining_paise,
        purchase_line_id, received_at)
     VALUES (?, ?, ?, ?, ?, ${purchaseLine}, COALESCE(?, CURRENT_TIMESTAMP))`
  ).bind(productId, qty, qty, costPaise, costPaise, receivedAt);
}
