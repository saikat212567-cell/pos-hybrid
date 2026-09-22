package com.example.pos

import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import com.example.pos.data.PosDb
import com.example.pos.data.ProductEntity
import com.example.pos.data.SaleEntity
import com.example.pos.databinding.ActivityMainBinding
import com.example.pos.net.Supabase
import com.example.pos.sync.SyncWorker
import com.example.pos.ui.CartAdapter
import com.example.pos.ui.CartLine
import com.example.pos.ui.ProductAdapter
import com.example.pos.ui.cartTotal
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Offline-first POS screen.
 *
 * Flow on Charge:
 *   1. Write the sale to Room (never fails offline).
 *   2. Decrement local stock.
 *   3. Ask WorkManager to drain the queue — it fires now if online, or the
 *      moment connectivity returns if not.
 *
 * The UI never waits on the network, so a sale is instant either way.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private val dao by lazy { PosDb.get(this).dao() }

    /** Cart state, keyed by product id. */
    private val cart = linkedMapOf<String, CartLine>()

    private val products = ProductAdapter(::addToCart)
    private val cartView = CartAdapter(::changeQty)

    private val taxRate = 0.05

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.products.layoutManager = GridLayoutManager(this, 3)
        b.products.adapter = products
        b.cart.layoutManager = LinearLayoutManager(this)
        b.cart.adapter = cartView

        b.charge.setOnClickListener { charge() }

        renderCart()
        loadCatalog()
        SyncWorker.enqueue(this)   // drain anything left over from last session
    }

    // -----------------------------------------------------------------------
    // Catalog: local cache first so the screen is usable immediately, then a
    // refresh from Supabase if the network happens to be up.
    // -----------------------------------------------------------------------
    private fun loadCatalog() = lifecycleScope.launch {
        show(dao.products())

        if (!Supabase.configured) {
            status("Supabase not configured — local catalog only")
            return@launch
        }

        try {
            val fresh = withContext(Dispatchers.IO) { Supabase.fetchProducts() }
            dao.upsertProducts(fresh)
            show(fresh)
            status("Synced — ${fresh.size} products")
        } catch (e: Exception) {
            // Expected whenever offline. Cached catalog stays on screen.
            status("Offline — using cached catalog (${dao.pendingCount()} sales queued)")
        }
    }

    private fun show(list: List<ProductEntity>) = products.submit(list)

    private fun status(text: String) { b.status.text = text }

    // -----------------------------------------------------------------------
    // Cart
    // -----------------------------------------------------------------------
    private fun addToCart(p: ProductEntity) {
        val line = cart.getOrPut(p.id) { CartLine(p, 0) }
        if (line.qty >= p.stock) {
            Toast.makeText(this, "No more ${p.name} in stock", Toast.LENGTH_SHORT).show()
            return
        }
        line.qty++
        renderCart()
    }

    private fun changeQty(line: CartLine, qty: Int) {
        when {
            qty <= 0 -> cart.remove(line.product.id)
            qty > line.product.stock -> return
            else -> line.qty = qty
        }
        renderCart()
    }

    private fun renderCart() {
        cartView.submit(cart.values.toList())
        b.total.text = "Total  %.2f".format(total())
        b.charge.isEnabled = cart.isNotEmpty()
    }

    /** Delegates to the tested top-level function in ui/Totals.kt. */
    private fun total(): Double = cartTotal(cart.values, taxRate)

    // -----------------------------------------------------------------------
    // Checkout
    // -----------------------------------------------------------------------
    private fun charge() {
        if (cart.isEmpty()) return

        val total = total()
        val items = JSONArray().apply {
            cart.values.forEach { l ->
                put(
                    JSONObject()
                        .put("id", l.product.id)
                        .put("name", l.product.name)
                        .put("price", l.product.price)
                        .put("qty", l.qty)
                )
            }
        }.toString()

        val sold = cart.values.map { it.product.id to it.qty }

        b.charge.isEnabled = false
        lifecycleScope.launch {
            dao.queueSale(
                SaleEntity(
                    clientRef = UUID.randomUUID().toString(),
                    total = total,
                    itemsJson = items,
                    soldAtMillis = System.currentTimeMillis(),
                )
            )
            sold.forEach { (id, qty) -> dao.decrementStock(id, qty) }

            cart.clear()
            show(dao.products())
            renderCart()

            SyncWorker.enqueue(this@MainActivity)
            status("Sale recorded — ${dao.pendingCount()} pending sync")
            Toast.makeText(this@MainActivity, "Paid %.2f".format(total), Toast.LENGTH_SHORT).show()
        }
    }

    override fun onResume() {
        super.onResume()
        // Sync may have completed while backgrounded; refresh the pending count.
        lifecycleScope.launch {
            val pending = dao.pendingCount()
            if (pending > 0) status("$pending sales waiting to sync")
        }
    }
}
