package com.example.pos.sync

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.example.pos.data.PosDb
import com.example.pos.net.PosApi

/**
 * Drains the offline sale queue to the POS API.
 *
 * WorkManager is doing the hard part: the NetworkType.CONNECTED constraint
 * means the OS starts this worker when connectivity comes back, and the work
 * survives app death and reboot. There is no connectivity listener and no
 * retry timer in this codebase because the platform already has both.
 */
class SyncWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        if (!PosApi.configured) return Result.success()   // nothing to sync to

        val dao = PosDb.get(applicationContext).dao()
        var deferred = false

        for (sale in dao.pendingSales()) {
            try {
                if (PosApi.pushSale(sale)) dao.markSynced(sale.clientRef)
                else deferred = true                        // 5xx: try again later
            } catch (e: PosApi.PermanentRejection) {
                // Server will never accept this row. Mark it done so one bad
                // sale cannot block every sale behind it, and log loudly.
                Log.e(TAG, "dropping sale ${sale.clientRef}", e)
                dao.markSynced(sale.clientRef)
            } catch (e: Exception) {
                // Network died mid-drain. Stop; retry keeps the rest queued.
                Log.w(TAG, "sync interrupted", e)
                return Result.retry()
            }
        }

        return if (deferred) Result.retry() else Result.success()
    }

    companion object {
        private const val TAG = "SyncWorker"
        private const val WORK = "sale-sync"

        /**
         * Request a drain. Safe to call on every sale and on app start:
         * KEEP means an already-queued run is reused rather than stacked.
         */
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .build()

            WorkManager.getInstance(context)
                .enqueueUniqueWork(WORK, ExistingWorkPolicy.KEEP, request)
        }
    }
}
