package com.example.pos

import com.example.pos.data.ProductEntity
import com.example.pos.ui.CartLine
import com.example.pos.ui.cartTotal
import org.junit.Assert.assertEquals
import org.junit.Test

/** Guards the one piece of arithmetic a customer would notice being wrong. */
class TotalsTest {

    private fun line(price: Double, qty: Int) =
        CartLine(ProductEntity("id-$price", "p", price, 99), qty)

    @Test fun `empty cart is zero`() {
        assertEquals(0.0, cartTotal(emptyList(), 0.05), 0.0)
    }

    @Test fun `tax applied to subtotal and rounded to cents`() {
        // 3 x 3.33 = 9.99, +5% = 10.4895 -> 10.49
        assertEquals(10.49, cartTotal(listOf(line(3.33, 3)), 0.05), 0.0)
    }

    @Test fun `rounds once at the end, not per line`() {
        // Per-line rounding would give 0.02 + 0.02 = 0.04.
        // Correct: (0.015 + 0.015) = 0.03 with no tax.
        assertEquals(0.03, cartTotal(listOf(line(0.015, 1), line(0.015, 1)), 0.0), 0.0)
    }

    @Test fun `multiple lines sum before tax`() {
        val total = cartTotal(listOf(line(2.50, 2), line(1.20, 1)), 0.05)
        assertEquals(6.51, total, 0.0)   // 6.20 * 1.05 = 6.51
    }
}
