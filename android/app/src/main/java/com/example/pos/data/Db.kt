package com.example.pos.data

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Local storage. Two tables:
 *
 *  - [ProductEntity]: a cache of the server catalog so the terminal opens
 *    and sells with no network at all.
 *  - [SaleEntity]: the offline queue. Every sale lands here first, always,
 *    even when online. The sync worker is the only thing that talks to the
 *    server, so there is exactly one code path to get wrong.
 */

@Entity(tableName = "products")
data class ProductEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** Money in integer paise, matching the API. Doubles lose fractions once
     *  you sum them, and a POS sums every line of every sale. */
    val pricePaise: Int,
    /** Null for a service: it has no stock to run out of, which is different
     *  from having none left. A zero here would make it unsellable. */
    val stock: Int?,
    /** "good" or "service". Drives whether stock is checked at all. */
    val kind: String = "good",
    /** HSN for a good, SAC for a service. Copied onto the bill. */
    val taxCode: String = "",
    /** GST rate in basis points (1800 = 18%). Integers, so a rate can never
     *  arrive as 0.17999999999999999. */
    val gstRateBps: Int = 0,
    /** Unit Quantity Code. "NA" for services. */
    val unit: String = "PCS",
    /** Null means follow the shop-wide setting. */
    val priceMode: String? = null,
    /** Short number typed at the counter. */
    val code: String? = null,
    /** What a scanner emits. */
    val barcode: String? = null,
    /** R2 object key for the tile image; null renders a coloured initial. */
    val imageKey: String? = null,
)

@Entity(tableName = "sales")
data class SaleEntity(
    /** Device-generated UUID. Sent to the server as `client_ref`, where a
     *  unique index turns a retried upload into a no-op instead of a
     *  duplicate sale. This is the whole offline-safety story. */
    @PrimaryKey val clientRef: String,
    /** Money in integer paise, matching the API. */
    val totalPaise: Int,
    /** Line items as a JSON array string: [{"id","name","price","qty"}].
     *  Stored pre-serialized so the worker can forward it untouched. */
    val itemsJson: String,
    val soldAtMillis: Long,
    val synced: Boolean = false,
    /**
     * Set when the server rejected this sale in a way retrying can't fix
     * (4xx). The row leaves the retry loop but is NOT marked synced — marking
     * it synced would disguise a lost sale as a successful one, so real money
     * would vanish with nothing to show it. Surfaced in the UI instead.
     */
    val failed: Boolean = false,
    /**
     * cash | upi | card | bank | credit. Decides which account the sale settles
     * against server-side — credit posts to Sundry Debtors rather than Cash.
     *
     * @ColumnInfo(defaultValue) is required, not decorative: a Kotlin default is
     * not a SQL DEFAULT, and SQLite cannot ADD COLUMN ... NOT NULL without one.
     * Room compares column defaults when it validates the schema after a
     * migration, so without this annotation the entity and MIGRATION_1_2 would
     * disagree and the app would crash on upgrade.
     */
    @ColumnInfo(defaultValue = "cash") val paymentMode: String = "cash",
)

@Dao
interface PosDao {

    // --- catalog -----------------------------------------------------------
    @Query("SELECT * FROM products ORDER BY name")
    suspend fun products(): List<ProductEntity>

    @Insert(onConflict = androidx.room.OnConflictStrategy.REPLACE)
    suspend fun upsertProducts(products: List<ProductEntity>)

    @Query("DELETE FROM products")
    suspend fun clearProducts()

    /**
     * Replace the whole cached catalog in one transaction.
     *
     * An upsert alone would never remove anything, so an item deactivated on the
     * server would stay sellable on this device forever — the tile would keep
     * working offline and every sale of it would be rejected at sync. Replacing
     * wholesale is also simpler than diffing, and the catalog is small.
     *
     * @Transaction matters: without it a crash between the delete and the insert
     * would leave the till with an empty catalog and no way to sell anything
     * until the network came back.
     */
    @androidx.room.Transaction
    suspend fun replaceCatalog(products: List<ProductEntity>) {
        clearProducts()
        upsertProducts(products)
    }

    /**
     * Local stock decrement so an offline device stops selling air.
     *
     * `stock IS NOT NULL` leaves services alone: their stock is null by design,
     * and MAX(0, NULL - n) would write a 0, which every stock check reads as
     * "out of stock" — a service would become unsellable after being sold once.
     */
    @Query("UPDATE products SET stock = MAX(0, stock - :qty) WHERE id = :id AND stock IS NOT NULL")
    suspend fun decrementStock(id: String, qty: Int)

    // No per-term lookup queries here on purpose. A catalog is hundreds of rows,
    // the till already holds all of them in memory to draw the tiles, and
    // `findItem` in ui/Totals.kt searches that list — synchronously, with no
    // coroutine hop between a keystroke and a result, and unit-tested without a
    // database. A DAO round trip per keypress would be slower and harder to test.

    // --- offline queue -----------------------------------------------------
    @Insert
    suspend fun queueSale(sale: SaleEntity)

    /** Sales still worth sending. Excludes ones the server permanently refused. */
    @Query("SELECT * FROM sales WHERE synced = 0 AND failed = 0 ORDER BY soldAtMillis")
    suspend fun pendingSales(): List<SaleEntity>

    @Query("SELECT COUNT(*) FROM sales WHERE synced = 0 AND failed = 0")
    suspend fun pendingCount(): Int

    /** Sales the server refused. These need a human to look at them. */
    @Query("SELECT COUNT(*) FROM sales WHERE failed = 1")
    suspend fun failedCount(): Int

    @Query("SELECT * FROM sales WHERE failed = 1 ORDER BY soldAtMillis")
    suspend fun failedSales(): List<SaleEntity>

    @Query("UPDATE sales SET synced = 1 WHERE clientRef = :ref")
    suspend fun markSynced(ref: String)

    @Query("UPDATE sales SET failed = 1 WHERE clientRef = :ref")
    suspend fun markFailed(ref: String)

    /** Put failed sales back in the queue, e.g. after fixing a bad token. */
    @Query("UPDATE sales SET failed = 0 WHERE failed = 1")
    suspend fun retryFailed()
}

/**
 * Schema version 2: `products` gained GST, entry-code and image columns, and
 * `priceCents` became `pricePaise`.
 *
 * A real migration is written even though no APK has shipped yet. The cost is
 * twenty lines; the cost of getting it wrong is a crash loop on a till that
 * holds unsynced sales, and by then the only fix in the field would be
 * uninstalling — which destroys the record of money already taken.
 *
 * NEVER use fallbackToDestructiveMigration() here. It drops tables, and `sales`
 * is the only place an offline sale exists until it reaches the server.
 */
val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        // `products` is only a cache of the server catalog, so it can be rebuilt
        // from scratch — the next successful fetch refills it, and until then the
        // till shows an empty catalog rather than wrong prices. Recreating is
        // safer than a column-by-column rename on a table whose old rows carry a
        // now-ambiguous money unit.
        db.execSQL("DROP TABLE IF EXISTS products")
        // NO SQL DEFAULT clauses here, deliberately.
        //
        // A Kotlin default (`val kind: String = "good"`) is not a SQL DEFAULT, and
        // Room compares column defaults when it validates the schema after a
        // migration. A DEFAULT here that no @ColumnInfo(defaultValue) declares
        // would fail that check and crash the app on upgrade. They would also
        // never be used: Room always supplies every column on insert.
        db.execSQL(
            """CREATE TABLE products (
                 id TEXT NOT NULL PRIMARY KEY,
                 name TEXT NOT NULL,
                 pricePaise INTEGER NOT NULL,
                 stock INTEGER,
                 kind TEXT NOT NULL,
                 taxCode TEXT NOT NULL,
                 gstRateBps INTEGER NOT NULL,
                 unit TEXT NOT NULL,
                 priceMode TEXT,
                 code TEXT,
                 barcode TEXT,
                 imageKey TEXT
               )"""
        )
        // `sales` is migrated by copying, never dropped outright: every unsynced
        // row in it is money that exists nowhere else yet.
        //
        // Copy-and-rename rather than ALTER TABLE ... RENAME COLUMN, which needs
        // SQLite 3.25+ (Android 11 / API 30) while minSdk here is 24. Branching on
        // the version would mean one path that runs on modern phones and one that
        // only runs on old ones and so never gets exercised — on the code that
        // moves unsynced sales. One path that works everywhere is worth more than
        // the three statements it costs.
        //
        // "cents" and "paise" were both already 1/100 of the currency unit, so
        // this renames a column; it does not convert any value.
        //
        // Only `paymentMode` carries a SQL DEFAULT, because only it declares
        // @ColumnInfo(defaultValue). Room compares defaults when validating the
        // schema after a migration, so a DEFAULT here that the entity does not
        // declare would crash the app on upgrade.
        db.execSQL(
            """CREATE TABLE sales_new (
                 clientRef TEXT NOT NULL PRIMARY KEY,
                 totalPaise INTEGER NOT NULL,
                 itemsJson TEXT NOT NULL,
                 soldAtMillis INTEGER NOT NULL,
                 synced INTEGER NOT NULL,
                 failed INTEGER NOT NULL,
                 paymentMode TEXT NOT NULL DEFAULT 'cash'
               )"""
        )
        db.execSQL(
            """INSERT INTO sales_new
                 (clientRef, totalPaise, itemsJson, soldAtMillis, synced, failed, paymentMode)
               SELECT clientRef, totalCents, itemsJson, soldAtMillis, synced, failed, 'cash'
                 FROM sales"""
        )
        db.execSQL("DROP TABLE sales")
        db.execSQL("ALTER TABLE sales_new RENAME TO sales")
    }
}

@Database(entities = [ProductEntity::class, SaleEntity::class], version = 2)
abstract class PosDb : RoomDatabase() {
    abstract fun dao(): PosDao

    companion object {
        @Volatile private var instance: PosDb? = null

        /** Single shared instance; Room is thread-safe once built. */
        fun get(context: Context): PosDb = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext, PosDb::class.java, "pos.db"
            ).addMigrations(MIGRATION_1_2)
                .build().also { instance = it }
        }
    }
}
