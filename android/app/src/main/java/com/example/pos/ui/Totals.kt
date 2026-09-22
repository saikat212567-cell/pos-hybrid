package com.example.pos.ui

/**
 * Money math, pulled out of the Activity so it is testable.
 *
 * Rounds to cents exactly once, at the end. Rounding per line and summing
 * gives a total that does not match the sum of the printed line amounts.
 */
fun cartTotal(lines: Collection<CartLine>, taxRate: Double): Double {
    val subtotal = lines.sumOf { it.product.price * it.qty }
    return Math.round(subtotal * (1 + taxRate) * 100) / 100.0
}
