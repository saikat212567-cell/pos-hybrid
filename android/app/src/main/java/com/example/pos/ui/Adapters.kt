package com.example.pos.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import coil.load
import com.example.pos.data.ProductEntity
import com.example.pos.databinding.ItemCartBinding
import com.example.pos.databinding.ItemProductBinding
import com.example.pos.net.PosApi
import kotlin.math.abs

/** One cart line: a product plus how many. */
data class CartLine(val product: ProductEntity, var qty: Int)

/**
 * Catalog grid. Tapping a tile adds one to the cart.
 *
 * Plain notifyDataSetChanged: a catalog is hundreds of items, not thousands, and
 * a DiffUtil setup here would be more moving parts for no perceptible gain.
 */
class ProductAdapter(
    private val onTap: (ProductEntity) -> Unit,
) : RecyclerView.Adapter<ProductAdapter.VH>() {

    private var items: List<ProductEntity> = emptyList()

    fun submit(products: List<ProductEntity>) {
        items = products
        notifyDataSetChanged()
    }

    class VH(val b: ItemProductBinding) : RecyclerView.ViewHolder(b.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        VH(ItemProductBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun getItemCount() = items.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val p = items[position]
        val b = holder.b

        b.name.text = p.name
        b.price.text = "₹${formatMoney(p.pricePaise)}"

        // A service has no stock to report, so saying "0 left" would be both
        // wrong and alarming. Show what it is instead.
        b.stock.text = when {
            p.kind == "service" -> "service"
            else -> "${p.stock ?: 0} ${p.unit}"
        }
        b.code.text = p.code?.let { "[$it]" } ?: ""

        bindImage(b, p)

        val sellable = inStock(p)
        b.root.isEnabled = sellable
        b.root.alpha = if (sellable) 1f else 0.4f
        b.root.contentDescription =
            "${p.name}, ₹${formatMoney(p.pricePaise)}, ${if (sellable) "add to cart" else "out of stock"}"
        b.root.setOnClickListener { if (sellable) onTap(p) }
    }

    /**
     * Tile face: the photo if there is one, a coloured initial if not.
     *
     * Most items in a real catalog will never get a photo, so the no-image case
     * has to look deliberate rather than broken. The colour comes from the name,
     * so an item is always the same colour wherever it appears — that
     * position-independent recognition is the whole point of an image tile.
     */
    private fun bindImage(b: ItemProductBinding, p: ProductEntity) {
        val key = p.imageKey
        if (key != null && PosApi.configured) {
            b.initial.text = ""
            b.image.load(PosApi.imageUrl(key)) {
                crossfade(true)
                // Coil caches to disk, so a tile image is fetched once per device
                // and then shows offline too.
            }
            b.image.alpha = 1f
        } else {
            b.image.setImageDrawable(null)
            val hue = abs(p.name.hashCode()) % 360
            b.image.setBackgroundColor(
                android.graphics.Color.HSVToColor(floatArrayOf(hue.toFloat(), 0.18f, 0.94f))
            )
            b.initial.text = p.name.trim().split(" ").take(2)
                .mapNotNull { it.firstOrNull()?.uppercase() }.joinToString("")
        }
    }
}

/** Cart list with +/- per line and a remove button. */
class CartAdapter(
    private val onQtyChange: (CartLine, Int) -> Unit,
) : RecyclerView.Adapter<CartAdapter.VH>() {

    private var lines: List<CartLine> = emptyList()
    /** The line +/- keys act on, highlighted so it is never a guess. */
    var lastId: String? = null

    fun submit(newLines: List<CartLine>) {
        lines = newLines
        notifyDataSetChanged()
    }

    class VH(val b: ItemCartBinding) : RecyclerView.ViewHolder(b.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        VH(ItemCartBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun getItemCount() = lines.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val l = lines[position]
        val b = holder.b

        b.name.text = l.product.name
        b.qty.text = l.qty.toString()
        b.amount.text = formatMoney(l.product.pricePaise * l.qty)
        b.root.setBackgroundColor(
            if (l.product.id == lastId) 0xFFEFF6FF.toInt() else 0x00000000
        )

        b.plus.setOnClickListener { onQtyChange(l, l.qty + 1) }
        b.minus.setOnClickListener { onQtyChange(l, l.qty - 1) }
        b.remove.setOnClickListener { onQtyChange(l, 0) }

        b.plus.contentDescription = "One more ${l.product.name}"
        b.minus.contentDescription = "One less ${l.product.name}"
        b.remove.contentDescription = "Remove ${l.product.name}"
    }
}
