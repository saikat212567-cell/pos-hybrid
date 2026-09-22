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
 * Thin wrapper over the Supabase REST (PostgREST) endpoints we actually use.
 * No SDK: two calls do not justify a dependency.
 *
 * The anon key is public — it ships in the APK and anyone can extract it.
 * Row Level Security in supabase/schema.sql is what protects the data.
 */
object Supabase {

    private val URL = BuildConfig.SUPABASE_URL.trimEnd('/')
    private val KEY = BuildConfig.SUPABASE_ANON_KEY

    val configured: Boolean get() = URL.isNotBlank() && KEY.isNotBlank()

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json".toMediaType()

    private fun Request.Builder.auth() = this
        .header("apikey", KEY)
        .header("Authorization", "Bearer $KEY")

    /** Pull the catalog for local caching. Throws on network/HTTP failure. */
    fun fetchProducts(): List<ProductEntity> {
        val req = Request.Builder()
            .url("$URL/rest/v1/products?select=id,name,price,stock&order=name")
            .auth()
            .build()

        http.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            require(res.isSuccessful) { "products ${res.code}: $body" }

            val arr = JSONArray(body)
            return List(arr.length()) { i ->
                val o = arr.getJSONObject(i)
                ProductEntity(
                    id = o.getString("id"),
                    name = o.getString("name"),
                    // numeric comes back as a JSON string sometimes; getDouble
                    // handles both string and number forms.
                    price = o.getDouble("price"),
                    stock = o.getInt("stock"),
                )
            }
        }
    }

    /**
     * Push one queued sale.
     *
     * @return true if the sale is now stored server-side — including the 409
     *   duplicate case, which means a previous attempt actually succeeded and
     *   only its response was lost. Either way the local row is done.
     *   Returns false for anything retryable (network down, 5xx).
     */
    fun pushSale(sale: SaleEntity): Boolean {
        val payload = JSONObject()
            .put("client_ref", sale.clientRef)
            .put("source", "android")
            .put("total", sale.total)
            .put("items", JSONArray(sale.itemsJson))
            .toString()

        val req = Request.Builder()
            .url("$URL/rest/v1/sales")
            .auth()
            .header("Content-Type", "application/json")
            .header("Prefer", "return=minimal")
            .post(payload.toRequestBody(JSON))
            .build()

        return http.newCall(req).execute().use { res ->
            when {
                res.isSuccessful -> true
                res.code == 409 -> true                 // already there, idempotent
                res.code in 400..499 -> {
                    // Malformed or rejected by RLS. Retrying forever will not
                    // fix it; surface it and let the worker drop it from the
                    // retry loop rather than blocking the whole queue.
                    throw PermanentRejection("sale ${res.code}: ${res.body?.string()}")
                }
                else -> false                           // 5xx -> retry later
            }
        }
    }

    class PermanentRejection(message: String) : Exception(message)
}
