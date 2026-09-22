package com.example.pos

import com.example.pos.data.ProductEntity
import com.example.pos.ui.CartLine
import com.example.pos.ui.formatMoney
import com.example.pos.ui.subtotalCents
import com.example.pos.ui.totalCents
import org.junit.Assert.assertEquals
import org.junit.Test

/** Guards the arithmetic a customer would notice being wrong. */
class TotalsTest {

    private fun line(cents: Int, qty: Int) =
        CartLine(ProductEntity("id-$cents", "p", cents, 99), qty)

    @Test fun `empty cart is zero`() {
        assertEquals(0, totalCents(emptyList(), 0.05))
    }

    @Test fun `tax applied to subtotal and rounded to cents`() {
        // 3 x 333 = 999 cents, +5% = 1048.95 -> 1049
        assertEquals(1049, totalCents(listOf(line(333, 3)), 0.05))
    }

    @Test fun `multiple lines sum before tax`() {
        // 250*2 + 120 = 620; 620 * 1.05 = 651
        assertEquals(651, totalCents(listOf(line(250, 2), line(120, 1)), 0.05))
    }

    @Test fun `no tax leaves subtotal untouched`() {
        assertEquals(620, totalCents(listOf(line(250, 2), line(120, 1)), 0.0))
    }

    @Test fun `subtotal ignores tax`() {
        assertEquals(999, subtotalCents(listOf(line(333, 3))))
    }

    @Test fun `integer cents do not drift when summed`() {
        // The classic float failure: 0.10 + 0.20 != 0.30 in binary floating
        // point. In cents it's exact, even over many lines.
        val lines = List(100) { line(10, 1) }
        assertEquals(1000, subtotalCents(lines))
    }

    @Test fun `formats cents for display`() {
        assertEquals("10.49", formatMoney(1049))
        assertEquals("0.05", formatMoney(5))
        assertEquals("0.00", formatMoney(0))
    }
}
