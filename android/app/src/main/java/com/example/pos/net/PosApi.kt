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
     * @return true if the sale is stored server-side. That includes the
     *   duplicate case: the API returns 200 with `duplicate: true` when this
     *   client_ref already exists, which means an earlier attempt succeeded
     *   and only its response was lost. Either way the local row is done.
     *   Returns false for anything worth retrying (network down, 5xx).
     * @throws PermanentRejection for 4xx, which retrying will never fix.
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
            when {
                res.isSuccessful -> true                 // 201 new, or 200 duplicate
                res.code in 400..499 ->
                    // Rejected payload or bad token. Retrying forever won't
                    // fix it and would block every sale behind it.
                    throw PermanentRejection("sale ${res.code}: ${res.body?.string()}")
                else -> false                            // 5xx -> retry later
            }
        }
    }

    class PermanentRejection(message: String) : Exception(message)
}
