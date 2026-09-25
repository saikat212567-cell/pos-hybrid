/**
 * Credit note and refund logic.
 *
 * The all-or-nothing batch relies on the same concurrency pattern as
 * recordSale: unguarded decrements with CHECK (>=0) constraints; the
 * loser's UPDATE drives a remainder negative, the CHECK fires, the batch
 * rolls back and the client gets a retryable 409.
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

/**
 * Plan the return of qty units from a specific sale line.
 *
 * Walks cogs_allocations in descending id order (LIFO within that line)
 * to put back the exact cost that came out of each lot, applying the
 * same remainder rule as planConsume.
 *
 * Returns {allocations, cogsPaise, statements} ready for D1 batch().
 */
export async function planReturn(db, saleLineId, qty) {
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
    if (remaining <= 0) break;
    const take = Math.min(remaining, alloc.qty_returnable);
    remaining -= take;
    // divRound as per the lot-remainder rule.
    const cost = divRound(alloc.cost_returnable_paise * take, alloc.qty_returnable);
    allocations.push({
      cogs_allocation_id: alloc.id,
      lot_id: alloc.lot_id,
      qty: take,
      cost_paise: cost,
    });
    cogsPaise += cost;
    statements.push(
      db.prepare(`
        UPDATE cogs_allocations
           SET qty_returnable = qty_returnable - ?,
               cost_returnable_paise = cost_returnable_paise - ?
         WHERE id = ?
      `).bind(take, cost, alloc.id)
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
