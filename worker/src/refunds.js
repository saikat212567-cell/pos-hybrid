/**
 * Credit note and refund logic.
 *
 * Allocation planning is read-only. Its snapshot assertions and decrements
 * must run together with the document/stock/voucher writes in ONE DB.batch().
 * A stale assertion raises a constraint error; batch() must roll back every
 * statement, not catch the error and commit an earlier write.
 *
 * The HTTP writer and tax-eligibility helpers below remain deferred drafts.
 */
import { divRound } from './gst.js';
import { saleVoucherLines } from './ledger.js';

export class RefundRejection extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Return the original-sale date from the database, or throw if the sale
 * is not found. Needed for tax_adjusted vs financial cutoff.
 */
async function getOriginalSupplyDate(db, saleRef) {
  const row = await db.prepare(
    'SELECT sold_at FROM sales WHERE client_ref = ?'
  ).bind(saleRef).first();
  if (!row) throw new RefundRejection(`sale ${saleRef} does not exist`);
  return row.sold_at;
}

/**
 * Compute whether a credit note on a given supply date can still adjust
 * output tax, given the current cutoff and GSTR-9 filed date.
 *
 * This is an admin-only gate; a retail cashier cannot choose tax_adjusted.
 */
async function isTaxAdjustedAllowed(db, supplyDate, shopSettings) {
  // TODO: implement using credit_note_cutoff_mmdd and gstr9_filed_<fy>
  // Placeholder: default to true (i.e., tax adjustment allowed) for now.
  return true;
}

/**
 * Determine the GSTR-1 table bucket from customer_gstin and taxable amount.
 */
function gstr1Bucket(customerGstin, taxablePaise, settings) {
  if (customerGstin?.trim()) return 'cdnr';
  if (taxablePaise >= Number(settings.b2cl_threshold_paise ?? 25000000))
    return 'cdnur_b2cl';
  return 'b2cs_net';
}

const positiveSafeInteger = value => Number.isSafeInteger(value) && value > 0;

/**
 * Plan allocation-counter consumption for a return, without writing anything.
 * Reverse the sale's consumption order, not the inventory valuation method.
 * The last returned unit takes the exact remaining cost, as planConsume does.
 *
 * The caller must apply the entire statements array in ONE D1 batch with its
 * own document, stock-restoration and ledger writes. This planner neither
 * restores lots nor chooses GST treatment or cumulative refund rounding.
 */
export async function planReturn(db, saleLineId, qty) {
  if (!positiveSafeInteger(saleLineId) || !positiveSafeInteger(qty)) {
    throw new RefundRejection('saleLineId and qty must be positive safe integers');
  }
  const { results: candidates } = await db.prepare(`
      SELECT id, lot_id, qty_returnable, cost_returnable_paise
        FROM cogs_allocations
       WHERE sale_line_id = ?
         AND qty_returnable > 0
       ORDER BY id DESC
    `).bind(saleLineId).all();

  let remaining = qty;
  const allocations = [];
  const statements = [];
  let cogsPaise = 0;

  for (const alloc of candidates) {
    if (remaining === 0) break;
    if (!positiveSafeInteger(alloc.id) || !positiveSafeInteger(alloc.lot_id) ||
        !positiveSafeInteger(alloc.qty_returnable) ||
        !Number.isSafeInteger(alloc.cost_returnable_paise) || alloc.cost_returnable_paise < 0) {
      throw new RefundRejection('invalid return allocation state');
    }
    const take = Math.min(remaining, alloc.qty_returnable);
    let cost = alloc.cost_returnable_paise;
    if (take !== alloc.qty_returnable) {
      const product = alloc.cost_returnable_paise * take;
      const half = Math.floor(alloc.qty_returnable / 2);
      // divRound adds half the denominator before division. Both operations,
      // not just the final result, must remain within the exact integer range.
      if (!Number.isSafeInteger(product) || product > Number.MAX_SAFE_INTEGER - half) {
        throw new RefundRejection('return allocation arithmetic exceeds safe integer range');
      }
      cost = divRound(product, alloc.qty_returnable);
    }
    if (!Number.isSafeInteger(cost) || cost < 0 || cost > alloc.cost_returnable_paise ||
        cogsPaise > Number.MAX_SAFE_INTEGER - cost) {
      throw new RefundRejection('return allocation total exceeds safe integer range');
    }

    allocations.push({
      cogs_allocation_id: alloc.id,
      lot_id: alloc.lot_id,
      qty: take,
      cost_paise: cost,
    });
    cogsPaise += cost;
    remaining -= take;
    statements.push(
      // Fresh snapshot: SELECT emits no row, so this inserts nothing and does
      // not advance allocation IDs. Stale/missing snapshot: qty=0 violates the
      // existing CHECK(qty > 0). Never use OR IGNORE or a zero-row UPDATE guard:
      // either could let a caller commit a refund without consuming its cost.
      db.prepare(`
        INSERT INTO cogs_allocations
          (sale_line_id, lot_id, qty, cost_paise, qty_returnable, cost_returnable_paise)
        SELECT ?, ?, 0, 0, 0, 0
         WHERE NOT EXISTS (
           SELECT 1 FROM cogs_allocations
            WHERE id = ? AND sale_line_id = ? AND lot_id = ?
              AND qty_returnable = ? AND cost_returnable_paise = ?
         )
      `).bind(saleLineId, alloc.lot_id, alloc.id, saleLineId, alloc.lot_id,
        alloc.qty_returnable, alloc.cost_returnable_paise),
      // Keep this immediately after its assertion, inside the same batch.
      // Original qty, cost and provenance remain immutable.
      db.prepare(`
        UPDATE cogs_allocations
           SET qty_returnable = qty_returnable - ?,
               cost_returnable_paise = cost_returnable_paise - ?
         WHERE id = ? AND sale_line_id = ? AND lot_id = ?
      `).bind(take, cost, alloc.id, saleLineId, alloc.lot_id)
    );
  }

  if (remaining > 0) {
    throw new RefundRejection('insufficient returnable quantity in this sale line');
  }

  return { allocations, cogsPaise, statements };
}

/**
 * Generate the reversing voucher lines for a credit note.
 *
 * Lines up with saleVoucherLines' shape; see docs/phase3-refund-design.md.
 */
export function creditNoteVoucherLines(
  saleRef,
  originalInvoiceDate,
  creditNoteDate,
  taxablePaise,
  cgstPaise,
  sgstPaise,
  igstPaise,
  roundOffPaise,
  totalPaise,
  cogsReversedPaise,
  registration,
  taxAdjusted,
  stockReturnMode,
  refundMode,
  salePaymentMode
) {
  // TODO: implement using saleVoucherLines pattern.
  // This is the most intricate piece of the refund design.
  // For now, placeholder empty array.
  return [];
}

/**
 * Top-level credit note record.
 *
 * Expects a validated request with at least one line; caller ensures
 * client_ref uniqueness and idempotency.
 */
export async function recordCreditNote(request, env) {
  // TODO: implement full request parsing, validation, batch execution.
  throw new RefundRejection('not yet implemented', 501);
}
