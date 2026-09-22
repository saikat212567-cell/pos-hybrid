package com.example.pos.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * Local storage. Two tables:
 *
 *  - [ProductEntity]: a cache of the Supabase catalog so the terminal opens
 *    and sells with no network at all.
 *  - [SaleEntity]: the offline queue. Every sale lands here first, always,
 *    even when online. The sync worker is the only thing that talks to the
 *    server, so there is exactly one code path to get wrong.
 */

@Entity(tableName = "products")
data class ProductEntity(
    @PrimaryKey val id: String,
    val name: String,
    val price: Double,
    val stock: Int,
)

@Entity(tableName = "sales")
data class SaleEntity(
    /** Device-generated UUID. Sent to the server as `client_ref`, where a
     *  unique index turns a retried upload into a no-op instead of a
     *  duplicate sale. This is the whole offline-safety story. */
    @PrimaryKey val clientRef: String,
    val total: Double,
    /** Line items as a JSON array string: [{"id","name","price","qty"}].
     *  Stored pre-serialized so the worker can forward it untouched. */
    val itemsJson: String,
    val soldAtMillis: Long,
    val synced: Boolean = false,
)

@Dao
interface PosDao {

    // --- catalog -----------------------------------------------------------
    @Query("SELECT * FROM products ORDER BY name")
    suspend fun products(): List<ProductEntity>

    @Insert(onConflict = androidx.room.OnConflictStrategy.REPLACE)
    suspend fun upsertProducts(products: List<ProductEntity>)

    /** Local stock decrement so an offline device stops selling air. */
    @Query("UPDATE products SET stock = MAX(0, stock - :qty) WHERE id = :id")
    suspend fun decrementStock(id: String, qty: Int)

    // --- offline queue -----------------------------------------------------
    @Insert
    suspend fun queueSale(sale: SaleEntity)

    @Query("SELECT * FROM sales WHERE synced = 0 ORDER BY soldAtMillis")
    suspend fun pendingSales(): List<SaleEntity>

    @Query("SELECT COUNT(*) FROM sales WHERE synced = 0")
    suspend fun pendingCount(): Int

    @Query("UPDATE sales SET synced = 1 WHERE clientRef = :ref")
    suspend fun markSynced(ref: String)
}

@Database(entities = [ProductEntity::class, SaleEntity::class], version = 1)
abstract class PosDb : RoomDatabase() {
    abstract fun dao(): PosDao

    companion object {
        @Volatile private var instance: PosDb? = null

        /** Single shared instance; Room is thread-safe once built. */
        fun get(context: Context): PosDb = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext, PosDb::class.java, "pos.db"
            ).build().also { instance = it }
        }
    }
}
