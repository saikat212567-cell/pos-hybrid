package com.example.pos.ui

/**
 * Money math, kept out of the Activity so it's testable.
 *
 * Everything is integer cents. Tax is applied to the whole subtotal and
 * rounded once, at the end: rounding each line and summing produces a total
 * that doesn't match the sum of the printed line amounts.
 */
fun subtotalCents(lines: Collection<CartLine>): Int =
    lines.sumOf { it.product.priceCents * it.qty }

fun totalCents(lines: Collection<CartLine>, taxRate: Double): Int =
    Math.round(subtotalCents(lines) * (1 + taxRate)).toInt()

/** Cents -> "12.34" for display. The only place money becomes a decimal. */
fun formatMoney(cents: Int): String = "%.2f".format(cents / 100.0)
