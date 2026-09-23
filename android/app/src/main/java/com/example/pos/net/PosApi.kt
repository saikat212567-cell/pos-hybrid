package com.example.pos.net

import com.example.pos.BuildConfig
import com.example.pos.data.ProductEntity
import com.example.pos.data.SaleEntity
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Client for the POS Worker API (Cloudflare Workers + D1).
 *
 * Two endpoints, so no SDK and no JSON library: org.json ships with Android.
 *
 * The bearer token is compiled into the APK and can be extracted from it, so
 * it only keeps strangers out of a write-only sales endpoint. Rotate it by
 * setting a new Worker secret and rebuilding.
 */
object PosApi {

    private val BASE = BuildConfig.API_BASE.trimEnd('/')
    private val TOKEN = BuildConfig.API_TOKEN

    val configured: Boolean get() = BASE.isNotBlank() && TOKEN.isNotBlank()

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json".toMediaType()

    private fun Request.Builder.auth() = header("Authorization", "Bearer $TOKEN")

    /**
     * Pull the catalog for local caching. Throws on network/HTTP failure.
     *
     * Reads /items rather than /products: the legacy route reports a large
     * sentinel stock for services so that older builds can still sell them, and
     * carries no GST rate, HSN, entry code or image. This client needs all of
     * those, and gets an honest null stock for a service.
     */
    fun fetchProducts(): List<ProductEntity> {
        val req = Request.Builder().url("$BASE/items").auth().build()

        http.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            require(res.isSuccessful) { "items ${res.code}: $body" }

            val arr = JSONArray(body)
            return List(arr.length()) { i ->
                val o = arr.getJSONObject(i)
                ProductEntity(
                    id = o.getString("id"),
                    name = o.getString("name"),
                    pricePaise = o.getInt("price_paise"),
                    // null, not 0: a service has no stock rather than none left.
                    stock = if (o.isNull("stock")) null else o.getInt("stock"),
                    kind = o.optString("kind", "good"),
                    taxCode = o.optString("tax_code", ""),
                    gstRateBps = o.optInt("gst_rate_bps", 0),
                    unit = o.optString("unit", "PCS"),
                    priceMode = o.optStringOrNull("price_mode"),
                    code = o.optStringOrNull("code"),
                    barcode = o.optStringOrNull("barcode"),
                    imageKey = o.optStringOrNull("image_key"),
                )
            }
        }
    }

    /**
     * optString() returns "" for JSON null, which would turn an absent barcode
     * into an empty string that then matches an empty search term.
     */
    private fun JSONObject.optStringOrNull(key: String): String? =
        if (isNull(key)) null else optString(key).ifEmpty { null }

    /**
     * URL for an item's tile image.
     *
     * The token rides in the query string because an ImageView load cannot set an
     * Authorization header. It leaks nothing new — this token is already
     * extractable from the APK, which is why it only opens catalog-read and
     * sale-insert.
     */
    fun imageUrl(imageKey: String): String = "$BASE/images/$imageKey?t=$TOKEN"

    /**
     * Shop-wide display settings: pricing mode and whether to round.
     *
     * Needed to draw a correct cart. Guessing "inclusive" at an exclusive-pricing
     * shop understates every total on screen by the tax, so the counter would
     * quote one figure and the bill would print a higher one.
     *
     * Returns null on any failure, and the caller keeps whatever it had — a
     * network blip must not silently change how prices are read.
     */
    fun fetchShop(): Shop? {
        val req = Request.Builder().url("$BASE/shop").auth().build()
        return http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) return@use null
            val o = JSONObject(res.body?.string().orEmpty())
            Shop(
                priceMode = o.optString("price_mode", "inclusive"),
                roundOff = o.optBoolean("round_off_enabled", true),
                registration = o.optString("gst_registration", "regular"),
                billFormat = o.optString("bill_format", "58mm"),
            )
        }
    }

    /**
     * `registration` decides whether the till charges tax at all. A composition
     * or unregistered dealer must show no tax, or the counter quotes a figure the
     * bill contradicts.
     */
    data class Shop(
        val priceMode: String,
        val roundOff: Boolean,
        val billFormat: String,
        val registration: String = "regular",
    )

    /** A rendered bill, plus the invoice number to name the file after. */
    data class Bill(val html: String, val invoiceNo: String?)

    /**
     * The rendered bill for a sale. Null if it cannot be fetched — which for an
     * unsynced sale is the normal case, since the invoice number is assigned
     * server-side.
     *
     * The invoice number is read out of the document's own <title>, which the
     * Worker sets to "<DOC TYPE> <invoice no>" precisely so a client can name a
     * saved or shared file without a second request.
     */
    fun fetchBill(clientRef: String, format: String): Bill? {
        val req = Request.Builder()
            .url("$BASE/sales/$clientRef?format=$format").auth().build()

        return http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) return@use null
            val html = res.body?.string() ?: return@use null
            val title = Regex("<title>([^<]*)</title>").find(html)?.groupValues?.get(1)
            Bill(html, title?.trim()?.substringAfterLast(' ')?.ifBlank { null })
        }
    }

    /**
     * Push one queued sale.
     *
     * @return true only when the server has genuinely stored the sale — a
     *   `{ok:true}` body at 201 (new) or 200 (`duplicate:true`, an earlier
     *   attempt that succeeded and only lost its response). Returns false for
     *   anything worth retrying: 5xx, a lost stock race, or a 2xx whose body is
     *   NOT that acknowledgement (a captive portal or proxy answering 200 with
     *   its own HTML).
     * @throws PermanentRejection when the server refused this exact sale for
     *   good — a bad token/payload, or stock that is genuinely gone.
     *
     * The HTTP-status-to-outcome decision lives in [classifySaleResponse],
     * which is pure and unit-tested; this method only does the I/O.
     */
    fun pushSale(sale: SaleEntity): Boolean {
        val payload = JSONObject()
            .put("client_ref", sale.clientRef)
            .put("source", "android")
            .put("total", sale.totalPaise)
            .put("items", JSONArray(sale.itemsJson))
            // Decides which account the sale settles against server-side: cash,
            // bank, or Sundry Debtors when it is unpaid credit.
            .put("payment_mode", sale.paymentMode)
            .toString()

        val req = Request.Builder()
            .url("$BASE/sales")
            .auth()
            .header("Content-Type", "application/json")
            .post(payload.toRequestBody(JSON))
            .build()

        return http.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            when (classifySaleResponse(res.code, body)) {
                SaleVerdict.STORED    -> true
                SaleVerdict.RETRY     -> false
                SaleVerdict.PERMANENT -> throw PermanentRejection("sale ${res.code}: $body")
            }
        }
    }

    /** What the server's answer to POST /sales means for the local queue row. */
    enum class SaleVerdict {
        /** Stored server-side. Mark the local row synced. */
        STORED,
        /** Not stored, but trying later may work. Leave it queued. */
        RETRY,
        /** Refused for good. Take it out of the loop for a human to see. */
        PERMANENT,
    }

    /**
     * Classify the server's answer to POST /sales from the HTTP status and raw
     * body alone. Pure and network-free, so it is unit-tested directly against
     * every response `recordSale` in worker/src/index.js can return.
     *
     * The contract this codes against, read off that handler:
     *   201 {ok:true}                         -> STORED  (new sale)
     *   200 {ok:true, duplicate:true}         -> STORED  (retry of a stored sale)
     *   2xx without a {ok:true} body          -> RETRY   (captive portal / proxy)
     *   409 {..., retryable:true}             -> RETRY   (lost a stock write-race)
     *   409 {error, product, available}       -> PERMANENT (stock genuinely gone)
     *   other 4xx (400/401/403/…)             -> PERMANENT (bad payload/token)
     *   5xx and anything else                 -> RETRY
     *
     * Two deliberate calls:
     *
     *  - A bare 2xx is NOT treated as success. Only a real `{ok:true}` body is.
     *    A captive portal or transparent proxy returns 200 with its own HTML;
     *    marking that sale synced would delete a sale that never reached the
     *    server. An unrecognised 2xx is deferred, not failed: the sale is intact
     *    and unsent, so a later drain against a real connection stores it. RETRY
     *    keeps it pending and visible and does NOT block the sales behind it —
     *    SyncWorker's loop continues past a deferred row. Marking it PERMANENT
     *    would instead file a sale the server never rejected into the failed
     *    bucket, which is the more damaging error, so retry is the safe side.
     *
     *  - 409 is split on the server's own `retryable` flag rather than on the
     *    status. recordSale emits `retryable:true` for exactly one case — a lost
     *    race for stock, where nothing was committed and re-planning succeeds.
     *    Its other 409 (InsufficientStock) is stock that is really gone, which no
     *    retry conjures; that stays PERMANENT so it surfaces instead of spinning.
     */
    fun classifySaleResponse(status: Int, body: String): SaleVerdict = when {
        status == 201 && body.trim() == "{\"ok\":true}" -> SaleVerdict.STORED
        status == 200 && body.trim() == "{\"ok\":true,\"duplicate\":true}" -> SaleVerdict.STORED
        status in 200..299 -> SaleVerdict.RETRY
        status == 409 && RETRYABLE_TRUE.containsMatchIn(body) -> SaleVerdict.RETRY
        status in 400..499 -> SaleVerdict.PERMANENT
        else -> SaleVerdict.RETRY
    }

    /**
     * Retryable is deliberately a tolerant flag check: a false positive keeps a
     * row queued rather than losing it. Stored acknowledgements above are exact
     * status/body pairs because a false positive there deletes the only copy.
     *
     * No JSON dependency is added for three fixed machine-generated responses,
     * and this stays runnable in plain JVM tests (android.jar's org.json is a
     * throwing stub there).
     */
    private val RETRYABLE_TRUE = Regex("\"retryable\"\\s*:\\s*true")

    class PermanentRejection(message: String) : Exception(message)
}
