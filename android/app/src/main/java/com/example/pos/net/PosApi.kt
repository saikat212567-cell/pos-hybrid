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

    /** Pull the catalog for local caching. Throws on network/HTTP failure. */
    fun fetchProducts(): List<ProductEntity> {
        val req = Request.Builder().url("$BASE/products").auth().build()

        http.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            require(res.isSuccessful) { "products ${res.code}: $body" }

            val arr = JSONArray(body)
            return List(arr.length()) { i ->
                val o = arr.getJSONObject(i)
                ProductEntity(
                    id = o.getString("id"),
                    name = o.getString("name"),
                    priceCents = o.getInt("price"),
                    stock = o.getInt("stock"),
                )
            }
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
            .put("total", sale.totalCents)
            .put("items", JSONArray(sale.itemsJson))
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
