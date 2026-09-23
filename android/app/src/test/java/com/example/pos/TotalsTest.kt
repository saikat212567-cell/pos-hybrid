package com.example.pos

import com.example.pos.data.ProductEntity
import com.example.pos.ui.CartLine
import com.example.pos.ui.Entry
import com.example.pos.ui.availableOf
import com.example.pos.ui.chargesTax
import com.example.pos.ui.findItem
import com.example.pos.ui.formatMoney
import com.example.pos.ui.inStock
import com.example.pos.ui.lineTax
import com.example.pos.ui.parseEntry
import com.example.pos.ui.subtotalPaise
import com.example.pos.ui.taxPaise
import com.example.pos.ui.totalPaise
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure logic: money arithmetic and entry parsing. No Android, no database, so
 * these run on the JVM in milliseconds via `gradle test`.
 *
 * The assertions are about exactness. A ₹50 sticker must ring up as exactly ₹50,
 * and a total shown at the counter must match the one printed on the bill.
 */
class TotalsTest {

    private fun good(
        id: String = "p",
        name: String = "Item",
        paise: Int = 5000,
        stock: Int? = 100,
        rate: Int = 1800,
        code: String? = null,
        barcode: String? = null,
        mode: String? = null,
    ) = ProductEntity(
        id = id, name = name, pricePaise = paise, stock = stock, kind = "good",
        gstRateBps = rate, code = code, barcode = barcode, priceMode = mode,
    )

    private fun service(id: String = "s", name: String = "Delivery", paise: Int = 4000) =
        ProductEntity(
            id = id, name = name, pricePaise = paise, stock = null, kind = "service",
            gstRateBps = 1800, unit = "NA",
        )

    // --- subtotal ----------------------------------------------------------

    @Test fun `subtotal multiplies and sums`() {
        val lines = listOf(CartLine(good(paise = 2500), 2), CartLine(good(paise = 375), 4))
        assertEquals(2500 * 2 + 375 * 4, subtotalPaise(lines))
    }

    @Test fun `empty cart totals zero`() {
        assertEquals(0, subtotalPaise(emptyList()))
        assertEquals(0, totalPaise(emptyList()))
    }

    // --- inclusive pricing (Indian retail MRP) -----------------------------

    @Test fun `inclusive split round-trips exactly`() {
        // ₹50 at 18%: taxable 4237, tax the remainder. They must sum to 5000, or
        // a round sticker price rings up a paisa off.
        val (taxable, tax) = lineTax(CartLine(good(paise = 5000, rate = 1800), 1), "inclusive")
        assertEquals(5000, taxable + tax)
        assertEquals(4237, taxable)
        assertEquals(763, tax)
    }

    @Test fun `inclusive never loses a paisa at any amount or rate`() {
        for (rate in listOf(0, 500, 1200, 1800, 2800)) {
            for (paise in 1..2000) {
                val (taxable, tax) = lineTax(CartLine(good(paise = paise, rate = rate), 1), "inclusive")
                assertEquals("$paise paise at $rate bps", paise, taxable + tax)
                assertTrue("negative tax at $paise/$rate", tax >= 0)
            }
        }
    }

    @Test fun `three fifty-rupee items come to exactly one fifty`() {
        val lines = listOf(CartLine(good(paise = 5000, rate = 1800), 3))
        assertEquals(15000, totalPaise(lines, "inclusive"))
    }

    // --- exclusive pricing (B2B) -------------------------------------------

    @Test fun `exclusive adds tax on top`() {
        val (taxable, tax) = lineTax(CartLine(good(paise = 10000, rate = 1800), 1), "exclusive")
        assertEquals(10000, taxable)
        assertEquals(1800, tax)
    }

    @Test fun `a per-item price mode overrides the default`() {
        val line = CartLine(good(paise = 5000, rate = 1800, mode = "exclusive"), 1)
        val (taxable, tax) = lineTax(line, "inclusive")
        assertEquals("the item's own mode should win", 5000, taxable)
        assertEquals(900, tax)
    }

    // --- rounding ----------------------------------------------------------

    @Test fun `total rounds to the nearest rupee`() {
        // 3 x ₹1.20 inclusive = 360 paise, which rounds to ₹4.00.
        assertEquals(400, totalPaise(listOf(CartLine(good(paise = 120, rate = 0), 3))))
    }

    @Test fun `rounding can be switched off`() {
        assertEquals(360, totalPaise(listOf(CartLine(good(paise = 120, rate = 0), 3)),
            roundToRupee = false))
    }

    @Test fun `a rounded total is always whole rupees`() {
        for (paise in 1..500) {
            assertEquals(0, totalPaise(listOf(CartLine(good(paise = paise, rate = 1800), 1))) % 100)
        }
    }

    // --- tax total ---------------------------------------------------------

    @Test fun `cart tax is the sum of the line taxes`() {
        val lines = listOf(
            CartLine(good(paise = 5000, rate = 1800), 1),
            CartLine(good(paise = 2000, rate = 500), 2),
        )
        val expected = lines.sumOf { lineTax(it, "inclusive").second }
        assertEquals(expected, taxPaise(lines))
    }

    @Test fun `a zero-rated item contributes no tax`() {
        assertEquals(0, taxPaise(listOf(CartLine(good(rate = 0), 3))))
    }

    // --- registration: who may charge tax ----------------------------------

    @Test fun `a composition dealer shows no tax`() {
        // Forbidden from collecting GST; issues a bill of supply. The till must
        // agree with the server, which records and prints no tax — otherwise the
        // counter quotes a figure the bill contradicts.
        val lines = listOf(CartLine(good(paise = 5000, rate = 1800), 1))
        assertEquals(0, taxPaise(lines, "inclusive", "composition"))
        val (taxable, tax) = lineTax(lines.first(), "inclusive", "composition")
        assertEquals("the whole amount is turnover", 5000, taxable)
        assertEquals(0, tax)
    }

    @Test fun `an unregistered business shows no tax`() {
        val lines = listOf(CartLine(good(paise = 5000, rate = 2800), 1))
        assertEquals(0, taxPaise(lines, "inclusive", "unregistered"))
    }

    @Test fun `a stale rate cannot leak tax onto a bill of supply`() {
        // registration is checked before the rate is read, so an item left at 28%
        // from a previous registration still charges nothing.
        val (_, tax) = lineTax(CartLine(good(rate = 2800), 3), "exclusive", "composition")
        assertEquals(0, tax)
    }

    @Test fun `exclusive pricing does not inflate the total for a composition dealer`() {
        // THE REGRESSION. Under exclusive pricing the till added tax on top, so a
        // composition dealer's on-screen total was HIGHER than the amount actually
        // charged and printed.
        val lines = listOf(CartLine(good(paise = 10000, rate = 1800, mode = "exclusive"), 1))
        assertEquals("regular dealer pays tax on top", 11800, totalPaise(lines, "inclusive", false, "regular"))
        assertEquals("composition dealer pays the price only", 10000,
            totalPaise(lines, "inclusive", false, "composition"))
    }

    @Test fun `a regular dealer still charges tax`() {
        val lines = listOf(CartLine(good(paise = 5000, rate = 1800), 1))
        assertTrue(taxPaise(lines, "inclusive", "regular") > 0)
        assertTrue(chargesTax("regular"))
        assertFalse(chargesTax("composition"))
        assertFalse(chargesTax("unregistered"))
    }

    @Test fun `registration defaults to regular`() {
        // An older build, or a /shop fetch that failed, must not silently stop
        // charging tax for a shop that owes it.
        val lines = listOf(CartLine(good(paise = 5000, rate = 1800), 1))
        assertEquals(taxPaise(lines, "inclusive", "regular"), taxPaise(lines, "inclusive"))
    }

    // --- services ----------------------------------------------------------

    @Test fun `a service is always sellable`() {
        // Its stock is null, not zero: nothing runs out. A zero would read as out
        // of stock everywhere and make it unsellable.
        val s = service()
        assertTrue(inStock(s))
        assertEquals(Int.MAX_VALUE, availableOf(s))
    }

    @Test fun `a good with no stock is not sellable`() {
        assertFalse(inStock(good(stock = 0)))
        assertEquals(0, availableOf(good(stock = 0)))
    }

    @Test fun `a null stock on a good is treated as none`() {
        // Should not happen, but reading it as unlimited would let the till
        // oversell on bad data.
        assertEquals(0, availableOf(good(stock = null)))
    }

    @Test fun `a mixed cart totals both`() {
        val lines = listOf(CartLine(good(paise = 5000, rate = 1800), 1), CartLine(service(), 1))
        assertEquals(5000 + 4000, subtotalPaise(lines))
        assertEquals(9000, totalPaise(lines, "inclusive"))
    }

    // --- formatting --------------------------------------------------------

    @Test fun `money formats as two decimals`() {
        assertEquals("50.00", formatMoney(5000))
        assertEquals("0.05", formatMoney(5))
        assertEquals("0.00", formatMoney(0))
        assertEquals("1234.50", formatMoney(123450))
    }

    // --- entry parsing -----------------------------------------------------

    @Test fun `a bare term is quantity one`() {
        assertEquals(Entry(1, "12"), parseEntry("12"))
        assertEquals(Entry(1, "rice"), parseEntry("  rice  "))
    }

    @Test fun `the star prefix sets a quantity`() {
        assertEquals(Entry(3, "12"), parseEntry("3*12"))
        assertEquals(Entry(3, "rice"), parseEntry("3 * rice"))
        assertEquals(Entry(12, "7"), parseEntry("12*7"))
    }

    @Test fun `a zero quantity is treated as one`() {
        // Adding nothing is never what was meant.
        assertEquals(Entry(1, "12"), parseEntry("0*12"))
    }

    @Test fun `an empty entry yields an empty term`() {
        assertEquals(Entry(1, ""), parseEntry(""))
        assertEquals(Entry(2, ""), parseEntry("2*"))
    }

    // --- lookup order ------------------------------------------------------

    private val catalog = listOf(
        good(id = "rice", name = "Basmati Rice", code = "12", barcode = "8901234567890"),
        good(id = "oil", name = "12 Year Oil", code = "34"),
        good(id = "riceflour", name = "Rice Flour", code = "56"),
    )

    @Test fun `an exact barcode wins over everything`() {
        assertEquals("rice", findItem(catalog, "8901234567890")?.id)
    }

    @Test fun `a code beats a name that happens to contain the digits`() {
        // "12 Year Oil" contains 12, but the counter typing 12 means code 12.
        assertEquals("rice", findItem(catalog, "12")?.id)
    }

    @Test fun `an exact name beats a prefix match`() {
        val list = listOf(good(id = "a", name = "Rice"), good(id = "b", name = "Rice Flour"))
        assertEquals("a", findItem(list, "Rice")?.id)
    }

    @Test fun `a prefix match beats a contains match`() {
        assertEquals("riceflour", findItem(catalog, "Rice F")?.id)
    }

    @Test fun `lookup is case-insensitive`() {
        assertEquals("rice", findItem(catalog, "basmati")?.id)
        assertEquals("rice", findItem(catalog, "BASMATI")?.id)
    }

    @Test fun `no match returns null rather than a wrong item`() {
        assertNull(findItem(catalog, "zzzz"))
        assertNull(findItem(catalog, ""))
        assertNull(findItem(catalog, "   "))
    }

    @Test fun `a null code or barcode never matches an empty term`() {
        // optString-style empty values must not make every blank search hit.
        val list = listOf(good(id = "x", name = "Thing", code = null, barcode = null))
        assertNull(findItem(list, ""))
    }
}
