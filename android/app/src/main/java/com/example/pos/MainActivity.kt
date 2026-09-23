package com.example.pos

import android.os.Bundle
import android.view.inputmethod.EditorInfo
import android.widget.ArrayAdapter
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
import com.example.pos.ui.BillPrinter
import com.example.pos.ui.CartAdapter
import com.example.pos.ui.CartLine
import com.example.pos.ui.ProductAdapter
import com.example.pos.ui.availableOf
import com.example.pos.ui.findItem
import com.example.pos.ui.formatMoney
import com.example.pos.ui.parseEntry
import com.example.pos.ui.subtotalPaise
import com.example.pos.ui.taxPaise
import com.example.pos.ui.totalPaise
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Offline-first POS till with fast entry.
 *
 * ENTRY: one field owns the keyboard. A barcode scanner is a keyboard that types
 * fast and sends Enter, so it needs no library, no camera permission and no
 * device SDK — it just types into this field. Codes, barcodes and names are told
 * apart by what was typed, not by a mode the user has to remember. Tiles remain
 * for the many items with no code, which on a touchscreen is the faster path
 * anyway.
 *
 * CHARGE: the sale goes to Room first, always, even when online. Then WorkManager
 * is asked to drain the queue. The UI never waits on the network, so charging is
 * instant with or without signal.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private val dao by lazy { PosDb.get(this).dao() }

    /** Cart state, keyed by product id, in insertion order. */
    private val cart = linkedMapOf<String, CartLine>()

    private var catalog: List<ProductEntity> = emptyList()
    private val products = ProductAdapter(::addToCart)
    private val cartView = CartAdapter(::changeQty)

    /**
     * Shop-wide pricing default, fetched from the server and overridden per item.
     *
     * "inclusive" only until the first successful /shop call. At an
     * exclusive-pricing shop the wrong value understates every on-screen total by
     * the tax, so this is refreshed with the catalog rather than assumed.
     */
    private var priceMode = "inclusive"
    private var roundOff = true

    /**
     * Whether this shop charges GST. A composition or unregistered dealer shows
     * no tax on the till, matching what the server records and prints. "regular"
     * only until the first /shop fetch.
     */
    private var registration = "regular"

    /** The last sale, so the bill can be printed or reprinted. */
    private var lastRef: String? = null
    private var lastInvoiceNo: String? = null

    private val payModes = listOf("cash", "upi", "card", "bank", "credit")
    private val formats = listOf("58mm", "80mm", "a4")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.products.layoutManager = GridLayoutManager(this, 3)
        b.products.adapter = products
        b.cart.layoutManager = LinearLayoutManager(this)
        b.cart.adapter = cartView

        b.paymode.adapter = spinner(payModes.map { it.uppercase() })
        b.format.adapter = spinner(listOf("58mm roll", "80mm roll", "A4 invoice"))

        b.charge.setOnClickListener { charge() }
        b.print.setOnClickListener { bill(share = false) }
        b.share.setOnClickListener { bill(share = true) }

        wireEntry()
        renderCart()
        loadCatalog()
        SyncWorker.enqueue(this)   // drain anything left from last session
    }

    private fun spinner(values: List<String>) = ArrayAdapter(
        this, android.R.layout.simple_spinner_dropdown_item, values
    )

    // -----------------------------------------------------------------------
    // Entry
    // -----------------------------------------------------------------------

    private fun wireEntry() {
        // A scanner ends its burst with Enter, which arrives as IME_ACTION_DONE.
        b.entry.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_DONE ||
                event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER
            ) {
                submitEntry()
                true
            } else false
        }

        // Filter the tiles as the counter types, so a partial name narrows the
        // grid instead of requiring an exact match.
        b.entry.addTextChangedListener(object : android.text.TextWatcher {
            override fun afterTextChanged(s: android.text.Editable?) = showFiltered()
            override fun beforeTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })

        b.entry.requestFocus()
    }

    private fun submitEntry() {
        val (qty, term) = parseEntry(b.entry.text?.toString() ?: "")
        if (term.isBlank()) return

        val item = findItem(catalog, term)
        if (item == null) {
            toast("No item matching \"$term\"")
            return
        }

        addToCart(item, qty)
        b.entry.setText("")
    }

    /** Tiles matching what has been typed; everything when the field is empty. */
    private fun showFiltered() {
        val (_, term) = parseEntry(b.entry.text?.toString() ?: "")
        if (term.isBlank()) {
            products.submit(catalog)
            return
        }
        // An exact code or barcode means that one item; showing name matches
        // beside it would be noise.
        val exact = catalog.filter { it.code == term || it.barcode == term }
        products.submit(
            exact.ifEmpty {
                catalog.filter {
                    it.name.contains(term, ignoreCase = true) ||
                        (it.code?.startsWith(term) == true)
                }
            }
        )
    }

    // -----------------------------------------------------------------------
    // Catalog: local cache first so the screen is usable immediately, then a
    // refresh if the network happens to be up.
    // -----------------------------------------------------------------------
    private fun loadCatalog() = lifecycleScope.launch {
        catalog = dao.products()
        showFiltered()

        if (!PosApi.configured) {
            status("API not configured — local catalog only")
            return@launch
        }

        try {
            val fresh = withContext(Dispatchers.IO) { PosApi.fetchProducts() }
            // Replace rather than upsert: an item deactivated on the server must
            // disappear from this device, or its tile keeps working offline and
            // every sale of it is rejected at sync.
            dao.replaceCatalog(fresh)
            catalog = fresh

            // How prices are read. Fetched after the catalog so a failure here
            // leaves the previous value standing rather than resetting it.
            withContext(Dispatchers.IO) { PosApi.fetchShop() }?.let {
                priceMode = it.priceMode
                roundOff = it.roundOff
                registration = it.registration
            }

            showFiltered()
            renderCart()   // totals may change if the pricing mode just did
            status("Synced — ${fresh.size} items")
        } catch (e: Exception) {
            // Expected whenever offline. The cached catalog stays on screen.
            status("Offline — cached catalog (${dao.pendingCount()} sales queued)")
        }
    }

    private fun status(text: String) {
        b.status.text = text
        b.status.setTextColor(getColor(android.R.color.darker_gray))
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    // -----------------------------------------------------------------------
    // Cart
    // -----------------------------------------------------------------------

    private fun addToCart(p: ProductEntity, qty: Int = 1) {
        val line = cart.getOrPut(p.id) { CartLine(p, 0) }
        val want = line.qty + qty
        val limit = availableOf(p)

        // Refuse here rather than letting the server 409 at checkout: the counter
        // finds out now, with the customer in front of them.
        if (want > limit) {
            toast("Only $limit ${p.name} in stock")
            if (line.qty == 0) cart.remove(p.id) else line.qty = limit
        } else {
            line.qty = want
        }

        cartView.lastId = p.id
        renderCart()
    }

    private fun changeQty(line: CartLine, qty: Int) {
        when {
            qty <= 0 -> {
                cart.remove(line.product.id)
                if (cartView.lastId == line.product.id) cartView.lastId = null
            }
            qty > availableOf(line.product) -> {
                toast("Only ${availableOf(line.product)} in stock")
                return
            }
            else -> line.qty = qty
        }
        renderCart()
    }

    private fun renderCart() {
        val lines = cart.values.toList()
        cartView.submit(lines)

        val total = totalPaise(lines, priceMode, roundOff, registration)
        val tax = taxPaise(lines, priceMode, registration)
        val count = lines.sumOf { it.qty }

        // A composition or unregistered dealer collects no tax, so a "GST 0.00"
        // line would be noise on a bill of supply.
        b.breakdown.text = when {
            lines.isEmpty() -> ""
            tax == 0 -> "$count item(s)   taxable ${formatMoney(subtotalPaise(lines))}"
            else ->
                "$count item(s)   taxable ${formatMoney(subtotalPaise(lines) - tax)}   GST ${formatMoney(tax)}"
        }
        b.total.text = "Total  ₹${formatMoney(total)}"
        b.charge.isEnabled = lines.isNotEmpty()
    }

    // -----------------------------------------------------------------------
    // Checkout
    // -----------------------------------------------------------------------

    private fun charge() {
        if (cart.isEmpty()) return

        val lines = cart.values.toList()
        val total = totalPaise(lines, priceMode, roundOff, registration)

        // Only ids and quantities matter to the server, which recomputes price
        // and tax from its own catalog. The rest is sent for the record.
        val items = JSONArray().apply {
            lines.forEach { l ->
                put(
                    JSONObject()
                        .put("id", l.product.id)
                        .put("name", l.product.name)
                        .put("price", l.product.pricePaise)
                        .put("qty", l.qty)
                )
            }
        }.toString()

        val sold = lines.map { it.product.id to it.qty }
        val ref = UUID.randomUUID().toString()

        b.charge.isEnabled = false
        lifecycleScope.launch {
            dao.queueSale(
                SaleEntity(
                    clientRef = ref,
                    totalPaise = total,
                    itemsJson = items,
                    soldAtMillis = System.currentTimeMillis(),
                    paymentMode = payModes[b.paymode.selectedItemPosition],
                )
            )
            sold.forEach { (id, qty) -> dao.decrementStock(id, qty) }

            cart.clear()
            cartView.lastId = null
            catalog = dao.products()
            showFiltered()
            renderCart()

            lastRef = ref
            lastInvoiceNo = null
            b.print.isEnabled = true
            b.share.isEnabled = true

            SyncWorker.enqueue(this@MainActivity)
            refreshSyncStatus()
            toast("Paid ₹${formatMoney(total)}")
            b.entry.requestFocus()
        }
    }

    // -----------------------------------------------------------------------
    // Bill
    // -----------------------------------------------------------------------

    /**
     * Fetch and either print or share the last bill.
     *
     * The bill is rendered by the Worker, so this needs the sale to have reached
     * the server. An offline sale therefore cannot be printed yet — and that is
     * reported plainly rather than printing a bill with no invoice number, which
     * would be worse than none: an invoice number is assigned server-side and
     * inventing one locally would break the gapless series the law requires.
     */
    private fun bill(share: Boolean) {
        val ref = lastRef ?: return toast("No sale to print")
        val format = formats[b.format.selectedItemPosition]

        lifecycleScope.launch {
            val bill = withContext(Dispatchers.IO) {
                runCatching { PosApi.fetchBill(ref, format) }.getOrNull()
            }

            if (bill == null) {
                toast(
                    if (dao.pendingCount() > 0)
                        "Bill needs the server — this sale hasn't synced yet"
                    else "Could not fetch the bill"
                )
                return@launch
            }

            // Remember the number so a reprint or share names the file after the
            // invoice rather than "draft".
            lastInvoiceNo = bill.invoiceNo

            if (share) BillPrinter.share(this@MainActivity, bill.html, bill.invoiceNo)
            else BillPrinter.print(this@MainActivity, bill.html, bill.invoiceNo ?: "Bill")
        }
    }

    override fun onResume() {
        super.onResume()
        // Sync may have finished while backgrounded; refresh the counts.
        lifecycleScope.launch { refreshSyncStatus() }

        // Also re-read the catalog and the shop settings. A till stays open all
        // day, and the pricing mode, rounding rule or registration can change
        // mid-shift — with stale values the counter quotes one figure while the
        // server records and prints another. Skipped when a cart is open so a
        // sale in progress is never repriced under the cashier.
        if (cart.isEmpty()) loadCatalog()
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
