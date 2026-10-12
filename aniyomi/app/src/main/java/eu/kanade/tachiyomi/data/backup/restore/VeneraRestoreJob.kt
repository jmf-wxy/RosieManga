package eu.kanade.tachiyomi.data.backup.restore

import android.content.Context
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import androidx.core.net.toUri
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import eu.kanade.tachiyomi.data.backup.BackupNotifier
import eu.kanade.tachiyomi.data.backup.venera.VeneraBackupRestorer
import eu.kanade.tachiyomi.data.backup.venera.VeneraRestoreOptions
import eu.kanade.tachiyomi.data.backup.venera.VeneraRestoreResult
import eu.kanade.tachiyomi.data.notification.Notifications
import eu.kanade.tachiyomi.util.system.cancelNotification
import eu.kanade.tachiyomi.util.system.isRunning
import eu.kanade.tachiyomi.util.system.workManager
import kotlinx.coroutines.CancellationException
import logcat.LogPriority
import tachiyomi.core.common.i18n.stringResource
import tachiyomi.core.common.util.system.logcat
import tachiyomi.i18n.MR

/**
 * Foreground worker that imports a Venera `.venera` archive.
 *
 * Deliberately a sibling of [BackupRestoreJob] rather than a branch inside it: the two read
 * completely different formats and share nothing beyond the notification channel. Keeping them
 * apart means a bug in the Venera path can never break ordinary `.tachibk` restores.
 */
class VeneraRestoreJob(private val context: Context, workerParams: WorkerParameters) :
    CoroutineWorker(context, workerParams) {

    private val notifier = BackupNotifier(context)

    override suspend fun doWork(): Result {
        val uri = inputData.getString(LOCATION_URI_KEY)?.toUri()
        val options = inputData.getBooleanArray(OPTIONS_KEY)?.let { VeneraRestoreOptions.fromBooleanArray(it) }

        if (uri == null || options == null) {
            return Result.failure()
        }

        try {
            setForeground(getForegroundInfo())
        } catch (e: IllegalStateException) {
            logcat(LogPriority.ERROR, e) { "Not allowed to run on foreground service" }
        }

        val restorer = VeneraBackupRestorer(context)
        val startedAt = System.currentTimeMillis()

        return try {
            val result = restorer.restore(uri, options) { status ->
                notifier.showImportProgress(status)
            }
            val logFile = restorer.writeErrorLog().takeIf { it.exists() }

            notifier.showImportComplete(
                summary = summarize(result, System.currentTimeMillis() - startedAt),
                logFile = logFile,
            )
            Result.success()
        } catch (e: Exception) {
            if (e is CancellationException) {
                notifier.showRestoreError(context.stringResource(MR.strings.restoring_backup_canceled))
                Result.success()
            } else {
                logcat(LogPriority.ERROR, e)
                notifier.showRestoreError(e.message)
                Result.failure()
            }
        } finally {
            context.cancelNotification(Notifications.ID_RESTORE_PROGRESS)
        }
    }

    /**
     * Builds the human-readable result line.
     *
     * The summary is assembled here rather than in the notifier because only this layer knows which
     * of the three optional halves actually ran.
     */
    private fun summarize(result: VeneraRestoreResult, elapsedMs: Long): String {
        val parts = buildList {
            if (result.sourcesInstalled > 0) add("漫画源 ${result.sourcesInstalled} 个")
            if (result.sourcesFailed > 0) add("源失败 ${result.sourcesFailed} 个")
            if (result.categories > 0) add("分类 ${result.categories} 个")
            if (result.favorites > 0) add("收藏 ${result.favorites} 部")
            if (result.historyEntries > 0) add("阅读历史 ${result.historyEntries} 条")
            if (result.errorCount > 0) add("失败 ${result.errorCount} 条")
        }
        val body = parts.joinToString("、").ifEmpty { "没有可导入的内容" }
        return "$body（用时 ${elapsedMs / 1000}s）"
    }

    override suspend fun getForegroundInfo(): ForegroundInfo {
        return ForegroundInfo(
            Notifications.ID_RESTORE_PROGRESS,
            notifier.showImportProgress("正在读取 Venera 备份…").build(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            } else {
                0
            },
        )
    }

    companion object {
        fun isRunning(context: Context): Boolean = context.workManager.isRunning(TAG)

        fun start(context: Context, uri: Uri, options: VeneraRestoreOptions) {
            val inputData = workDataOf(
                LOCATION_URI_KEY to uri.toString(),
                OPTIONS_KEY to options.asBooleanArray(),
            )
            val request = OneTimeWorkRequestBuilder<VeneraRestoreJob>()
                .addTag(TAG)
                .setInputData(inputData)
                .build()
            context.workManager.enqueueUniqueWork(TAG, ExistingWorkPolicy.KEEP, request)
        }

        fun stop(context: Context) {
            context.workManager.cancelUniqueWork(TAG)
        }
    }
}

private const val TAG = "VeneraRestore"

private const val LOCATION_URI_KEY = "location_uri" // String
private const val OPTIONS_KEY = "options" // BooleanArray
