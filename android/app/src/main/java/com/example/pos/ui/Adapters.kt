package com.example.pos.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.example.pos.data.ProductEntity
import com.example.pos.databinding.ItemCartBinding
import com.example.pos.databinding.ItemProductBinding

/** One cart line: a product plus how many. */
data class CartLine(val product: ProductEntity, var qty: Int)

/**
 * Catalog grid. Tapping a tile adds one to the cart.
 * Plain notifyDataSetChanged: the list is tens of items, not thousands.
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
        holder.b.name.text = p.name
        holder.b.price.text = formatMoney(p.priceCents)
        holder.b.stock.text = "${p.stock} left"
        holder.b.root.isEnabled = p.stock > 0
        holder.b.root.alpha = if (p.stock > 0) 1f else 0.4f
        holder.b.root.contentDescription =
            "${p.name}, ${formatMoney(p.priceCents)}, add to cart"
        holder.b.root.setOnClickListener { if (p.stock > 0) onTap(p) }
    }
}

/** Cart list with +/- per line. */
class CartAdapter(
    private val onQtyChange: (CartLine, Int) -> Unit,
) : RecyclerView.Adapter<CartAdapter.VH>() {

    private var lines: List<CartLine> = emptyList()

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
        holder.b.line.text =
            "${l.product.name}  ×${l.qty}   ${formatMoney(l.product.priceCents * l.qty)}"
        holder.b.plus.setOnClickListener { onQtyChange(l, l.qty + 1) }
        holder.b.minus.setOnClickListener { onQtyChange(l, l.qty - 1) }
    }
}
