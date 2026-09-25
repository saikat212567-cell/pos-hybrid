/**
 * GST arithmetic. Pure functions, no database, no I/O — so the tax rules can
 * be tested exhaustively without a Worker or a D1 instance.
 *
 * EVERYTHING IS INTEGER PAISE. Rates are basis points (1800 = 18%), also
 * integers: a rate stored as 0.18 eventually arrives as 0.17999999999999999
 * and one invoice in a few thousand is then a paisa out.
 *
 * Two rounding rules that are not interchangeable:
 *
 *  1. Round per line, not per invoice. A tax invoice must state a rate-wise
 *     breakup, and the stated numbers have to add up to the stated total. If
 *     tax is computed on the invoice subtotal instead, the printed line
 *     amounts sum to something slightly different from the printed total and
 *     the customer is looking at arithmetic that does not work.
 *
 *  2. Split CGST/SGST by halving and giving the remainder to one side, never
 *     by rounding both halves. Rounding both halves of an odd amount either
 *     loses or invents a paisa.
 */

/** Half-up rounding on a rational, in integers. Math.round() on a float
 *  would reintroduce exactly the imprecision the paise representation is
 *  there to avoid. */
export const divRound = (numerator, denominator) =>
  Math.floor((numerator + Math.floor(denominator / 2)) / denominator);

const BPS = 10000;

/**
 * Tax-exclusive: the price is the taxable value, tax goes on top.
 * @returns {{taxable: number, tax: number}} paise
 */
export function splitExclusive(amountPaise, rateBps) {
  const tax = divRound(amountPaise * rateBps, BPS);
  return { taxable: amountPaise, tax };
}

/**
 * Tax-inclusive (Indian retail MRP): the price already contains the tax, so
 * work backwards. taxable = amount * 10000 / (10000 + rate).
 *
 * Tax is the remainder rather than a second rounded division, which is what
 * guarantees taxable + tax === amount exactly. Compute both independently and
 * a ₹50 sticker can ring up as ₹49.99.
 *
 * @returns {{taxable: number, tax: number}} paise
 */
export function splitInclusive(amountPaise, rateBps) {
  const taxable = divRound(amountPaise * BPS, BPS + rateBps);
  return { taxable, tax: amountPaise - taxable };
}

/**
 * Canonicalise a GST state code, or return null if it is not one.
 *
 * Place of supply decides whether a sale is taxed as CGST+SGST or as IGST, and
 * `splitByPlace` compares the two codes as strings. So an uncanonical spelling of
 * the seller's own state — "19 " with a trailing space, "019", "1 9" — compares
 * unequal and routes an intrastate sale entirely to IGST. That is the wrong tax
 * head on a filed return, and it was reachable from a till-token request.
 *
 * Valid codes are 01-38 plus 97 (Other Territory) and 99 (Centre Jurisdiction).
 * The range is checked rather than enumerating all forty, and the historical gaps
 * (25 Daman & Diu, 28 the old Andhra Pradesh) are accepted deliberately: they
 * still appear on documents predating their mergers.
 *
 * @returns a zero-padded 2-digit string, or null
 */
export function normalizeStateCode(value) {
  if (value === null || value === undefined) return null;

  const s = String(value).trim();
  // Digits only, and at most one leading zero: "019" is a real spelling of state
  // 19 on documents and forms, but "0019" or a 4-digit value is not a state code
  // and should be refused rather than quietly truncated. Rejects letters and any
  // internal space, so "1 9" and "nineteen" do not get through.
  if (!/^0?\d{1,2}$/.test(s)) return null;

  const n = Number(s);
  const valid = (n >= 1 && n <= 38) || n === 97 || n === 99;
  return valid ? String(n).padStart(2, '0') : null;
}

/**
 * Split a line's tax into CGST+SGST (same state) or IGST (different state).
 *
 * The halves are derived from each other so they always sum to `tax`: an odd
 * 1501 paise becomes 750 + 751, never 750 + 750 or 751 + 751.
 *
 * Both codes must already be canonical — see normalizeStateCode. Comparing raw
 * strings here is deliberate and cheap, but only sound once the callers have
 * normalised.
 *
 * @param sellerState 2-digit GST state code of the seller
 * @param buyerState  place of supply; falls back to the seller's own state,
 *                    which is the right default for a walk-in counter sale
 * @returns {{cgst: number, sgst: number, igst: number}} paise
 */
export function splitByPlace(taxPaise, sellerState, buyerState) {
  const interState = Boolean(buyerState) && buyerState !== sellerState;
  if (interState) return { cgst: 0, sgst: 0, igst: taxPaise };

  const cgst = Math.floor(taxPaise / 2);
  return { cgst, sgst: taxPaise - cgst, igst: 0 };
}

/**
 * Whether this registration charges GST to the customer at all.
 *
 * A composition dealer pays a flat percentage of turnover and is forbidden
 * from collecting tax; their bill is a "bill of supply" with no tax columns.
 * An unregistered business has no GSTIN and likewise cannot charge it.
 * Returning zero tax here is what makes those two cases fall out of the rest
 * of the engine with no special-casing downstream.
 */
export const chargesTax = registration => registration === 'regular';

/**
 * Tax for one invoice line.
 *
 * @param line {{price_paise, qty, gst_rate_bps, price_mode}}
 * @param ctx  {{registration, sellerState, buyerState, defaultPriceMode}}
 * @returns {{gross, taxable, tax, cgst, sgst, igst, rateBps}} paise
 */
export function lineTax(line, ctx) {
  const gross = line.price_paise * line.qty;

  // Not a regular dealer: no tax, and the gross IS the taxable value. Doing
  // this before reading the rate means a stale rate on an item cannot leak
  // tax onto a bill of supply.
  if (!chargesTax(ctx.registration)) {
    return { gross, taxable: gross, tax: 0, cgst: 0, sgst: 0, igst: 0, rateBps: 0 };
  }

  const rateBps = line.gst_rate_bps ?? 0;
  const mode = line.price_mode ?? ctx.defaultPriceMode ?? 'inclusive';

  const { taxable, tax } = mode === 'exclusive'
    ? splitExclusive(gross, rateBps)
    : splitInclusive(gross, rateBps);

  return { gross, taxable, tax, ...splitByPlace(tax, ctx.sellerState, ctx.buyerState), rateBps };
}

/**
 * Round an invoice total to the nearest rupee.
 *
 * Indian bills are conventionally rounded so the counter does not deal in
 * paise coins that no longer circulate. The adjustment is returned rather
 * than silently folded in, because it has to be posted to a Round Off account
 * for the books to balance.
 *
 * @returns {{total: number, adjustment: number}} adjustment is what was added
 */
export function roundOff(totalPaise, enabled = true) {
  if (!enabled) return { total: totalPaise, adjustment: 0 };
  const rounded = divRound(totalPaise, 100) * 100;
  return { total: rounded, adjustment: rounded - totalPaise };
}

/**
 * Total an invoice from its already-taxed lines.
 *
 * Line figures are summed as-is, never recomputed from the subtotal: these
 * are the numbers printed on the invoice, so they are the numbers that must
 * add up.
 */
export function invoiceTotals(taxedLines, { roundOffEnabled = true } = {}) {
  const sum = key => taxedLines.reduce((s, l) => s + l[key], 0);

  const taxable = sum('taxable');
  const cgst = sum('cgst');
  const sgst = sum('sgst');
  const igst = sum('igst');
  const { total, adjustment } = roundOff(taxable + cgst + sgst + igst, roundOffEnabled);

  return { taxable, cgst, sgst, igst, roundOff: adjustment, total };
}
