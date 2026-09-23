package com.example.pos.ui

import com.example.pos.data.ProductEntity

/**
 * Money math and entry parsing, kept out of the Activity so they are testable.
 *
 * EVERYTHING IS INTEGER PAISE. Rates are basis points (1800 = 18%), also
 * integers: a rate held as 0.18 eventually arrives as 0.17999999999999999 and
 * one bill in a few thousand is a paisa out.
 *
 * These figures are shown to the counter only. The server recomputes everything
 * from its own catalog and settings, and its numbers are what get recorded and
 * printed — matching the method here keeps the displayed total from disagreeing
 * with the bill, but the server stays the authority.
 */

/** Half-up rounding on integers, so no float ever touches a money figure. */
private fun divRound(numerator: Long, denominator: Long): Long =
    (numerator + denominator / 2) / denominator

private const val BPS = 10_000L

fun subtotalPaise(lines: Collection<CartLine>): Int =
    lines.sumOf { it.product.pricePaise.toLong() * it.qty }.toInt()

/**
 * Only a regular dealer charges GST.
 *
 * A composition dealer is forbidden from collecting tax and issues a bill of
 * supply; an unregistered business has no GSTIN and likewise cannot charge it.
 * Mirrors chargesTax() in worker/src/gst.js — the server is the authority, and
 * the till must agree with it or the counter quotes a figure the bill contradicts.
 */
fun chargesTax(registration: String): Boolean = registration == "regular"

/**
 * Taxable value and tax for one line.
 *
 * Inclusive (Indian retail MRP) works the tax backwards out of the price, with
 * the tax as the remainder so that taxable + tax always equals the sticker
 * price exactly. Computing both independently is what makes a ₹50 item ring up
 * as ₹49.99.
 *
 * `registration` is checked BEFORE the rate is read, so a stale rate left on an
 * item cannot leak tax onto a bill of supply. Without this the till showed tax to
 * a composition dealer while the server recorded and printed none — and on
 * exclusive pricing the on-screen total was higher than the amount actually
 * charged.
 */
fun lineTax(
    line: CartLine,
    defaultPriceMode: String,
    registration: String = "regular",
): Pair<Int, Int> {
    val gross = line.product.pricePaise.toLong() * line.qty

    // Not a regular dealer: no tax, and the gross IS the taxable value.
    if (!chargesTax(registration)) return gross.toInt() to 0

    val rate = line.product.gstRateBps.toLong()
    val mode = line.product.priceMode ?: defaultPriceMode

    return if (mode == "exclusive") {
        val tax = divRound(gross * rate, BPS)
        gross.toInt() to tax.toInt()
    } else {
        val taxable = divRound(gross * BPS, BPS + rate)
        taxable.toInt() to (gross - taxable).toInt()
    }
}

/**
 * Invoice total: line figures summed as-is, then rounded to the nearest rupee.
 *
 * Tax is rounded per line and then added up, never computed on the subtotal — a
 * bill states a rate-wise breakup, and the printed lines have to add up to the
 * printed total.
 */
fun totalPaise(
    lines: Collection<CartLine>,
    defaultPriceMode: String = "inclusive",
    roundToRupee: Boolean = true,
    registration: String = "regular",
): Int {
    var sum = 0L
    for (line in lines) {
        val (taxable, tax) = lineTax(line, defaultPriceMode, registration)
        sum += taxable + tax
    }
    return if (roundToRupee) (divRound(sum, 100) * 100).toInt() else sum.toInt()
}

/** Total GST across the cart, for the on-screen breakdown. */
fun taxPaise(
    lines: Collection<CartLine>,
    defaultPriceMode: String = "inclusive",
    registration: String = "regular",
): Int =
    lines.sumOf { lineTax(it, defaultPriceMode, registration).second.toLong() }.toInt()

/** Paise -> "12.34" for display. The only place money becomes a decimal. */
fun formatMoney(paise: Int): String = "%.2f".format(paise / 100.0)

/**
 * How many of this item may still be added.
 *
 * A service has no stock to run out of, which is why its stock is null rather
 * than zero — a zero would read as "out of stock" everywhere and make it
 * unsellable.
 */
fun availableOf(p: ProductEntity): Int =
    if (p.kind == "service") Int.MAX_VALUE else (p.stock ?: 0)

fun inStock(p: ProductEntity): Boolean = availableOf(p) > 0

// ---------------------------------------------------------------------------
// Entry parsing — the same grammar as the web till, so muscle memory carries
// between them.
// ---------------------------------------------------------------------------

/** What was typed, split into a quantity and a lookup term. */
data class Entry(val qty: Int, val term: String)

/**
 * Parse the entry field.
 *
 *   "12"      -> 1 of whatever 12 is
 *   "3*12"    -> 3 of it
 *   "3 * rice" -> 3 of rice
 *
 * `*` rather than `x` because x is a letter that appears in item names, and it
 * is on the numeric keypad every counter already has.
 */
fun parseEntry(raw: String): Entry {
    val s = raw.trim()
    val m = Regex("""^(\d+)\s*\*\s*(.*)$""").find(s)
        ?: return Entry(1, s)
    val qty = m.groupValues[1].toIntOrNull()?.coerceAtLeast(1) ?: 1
    return Entry(qty, m.groupValues[2].trim())
}

/**
 * Find the item a typed term refers to, in decreasing order of certainty.
 *
 * An exact barcode is a scanner stating precisely which item; an exact code is
 * the counter stating it; a name is a guess. In that order, so an item whose
 * name contains "12" cannot shadow the item whose code is 12.
 */
fun findItem(items: List<ProductEntity>, term: String): ProductEntity? {
    if (term.isBlank()) return null
    return items.firstOrNull { it.barcode != null && it.barcode == term }
        ?: items.firstOrNull { it.code != null && it.code == term }
        ?: items.firstOrNull { it.name.equals(term, ignoreCase = true) }
        ?: items.firstOrNull { it.name.startsWith(term, ignoreCase = true) }
        ?: items.firstOrNull { it.name.contains(term, ignoreCase = true) }
}
