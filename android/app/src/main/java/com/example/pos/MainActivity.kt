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
import com.example.pos.net.PosApi
import com.example.pos.sync.SyncWorker
import com.example.pos.ui.CartAdapter
import com.example.pos.ui.CartLine
import com.example.pos.ui.ProductAdapter
import com.example.pos.ui.formatMoney
import com.example.pos.ui.totalCents
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
    // refresh from the API if the network happens to be up.
    // -----------------------------------------------------------------------
    private fun loadCatalog() = lifecycleScope.launch {
        show(dao.products())

        if (!PosApi.configured) {
            status("API not configured — local catalog only")
            return@launch
        }

        try {
            val fresh = withContext(Dispatchers.IO) { PosApi.fetchProducts() }
            dao.upsertProducts(fresh)
            show(fresh)
            status("Synced — ${fresh.size} products")
        } catch (e: Exception) {
            // Expected whenever offline. Cached catalog stays on screen.
            status("Offline — using cached catalog (${dao.pendingCount()} sales queued)")
        }
    }

    private fun show(list: List<ProductEntity>) = products.submit(list)

    /** Normal status line. Resets the colour in case a rejection turned it red. */
    private fun status(text: String) {
        b.status.text = text
        b.status.setTextColor(getColor(android.R.color.darker_gray))
    }

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
        b.total.text = "Total  ${formatMoney(total())}"
        b.charge.isEnabled = cart.isNotEmpty()
    }

    /** Delegates to the tested top-level function in ui/Totals.kt. */
    private fun total(): Int = totalCents(cart.values, taxRate)

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
                        .put("price", l.product.priceCents)
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
                    totalCents = total,
                    itemsJson = items,
                    soldAtMillis = System.currentTimeMillis(),
                )
            )
            sold.forEach { (id, qty) -> dao.decrementStock(id, qty) }

            cart.clear()
            show(dao.products())
            renderCart()

            SyncWorker.enqueue(this@MainActivity)
            refreshSyncStatus()
            Toast.makeText(
                this@MainActivity, "Paid ${formatMoney(total)}", Toast.LENGTH_SHORT
            ).show()
        }
    }

    override fun onResume() {
        super.onResume()
        // Sync may have finished while backgrounded; refresh the counts.
        lifecycleScope.launch { refreshSyncStatus() }
    }

    /**
     * Rejected sales are the one thing here that needs a human, so they take
     * priority over the pending count in the status line.
     */
    private suspend fun refreshSyncStatus() {
        val failed = dao.failedCount()
        val pending = dao.pendingCount()
        when {
            failed > 0 -> {
                b.status.text = "$failed sale(s) REJECTED — not recorded on the server"
                b.status.setTextColor(getColor(android.R.color.holo_red_dark))
            }
            pending > 0 -> status("$pending sale(s) waiting to sync")
            else -> status("All sales synced")
        }
    }
}
