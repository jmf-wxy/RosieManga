package eu.kanade.presentation.more.settings.screen.browse.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.NewReleases
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import eu.kanade.presentation.more.settings.screen.browse.JsSourcesState
import eu.kanade.tachiyomi.source.manga.js.JsSourceIndexEntry
import eu.kanade.tachiyomi.source.manga.js.JsSourceInfo
import tachiyomi.presentation.core.components.material.padding

/**
 * Content for the JS 源 management page.
 *
 * Layout: repo URL field → action row (刷新 / 全部安装) → installed list → available list.
 */
@Composable
fun JsSourcesContent(
    state: JsSourcesState,
    lazyListState: LazyListState,
    paddingValues: PaddingValues,
    onRepoUrlChange: (String) -> Unit,
    onReloadIndex: () -> Unit,
    onSyncAll: () -> Unit,
    onInstall: (JsSourceIndexEntry) -> Unit,
    onUninstall: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        state = lazyListState,
        contentPadding = paddingValues,
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.padding.small),
        modifier = modifier,
    ) {
        item(key = "repo") {
            RepoUrlCard(
                repoUrl = state.repoUrl,
                isLoading = state.isLoadingIndex,
                isSyncing = state.isSyncing,
                syncProgress = state.syncProgress,
                onRepoUrlChange = onRepoUrlChange,
                onReloadIndex = onReloadIndex,
                onSyncAll = onSyncAll,
            )
        }

        if (state.installed.isNotEmpty()) {
            item(key = "installed_header") {
                SectionHeader("已安装 (${state.installed.size})")
            }
            items(state.installed, key = { "inst_${it.key}" }) { info ->
                InstalledSourceItem(
                    info = info,
                    isPending = info.key in state.pendingKeys,
                    onUninstall = { onUninstall(info.key) },
                )
            }
        }

        val installable = state.installable
        if (installable.isNotEmpty()) {
            item(key = "available_header") {
                SectionHeader("可安装 (${installable.size})")
            }
            // Defence in depth: `parseJsSourceIndex` already collapses same-`key` entries, but a
            // duplicate key here kills the whole app, so the key is made unique by construction.
            items(installable, key = { "avail_${it.key}@${it.fileName}" }) { entry ->
                AvailableSourceItem(
                    entry = entry,
                    isPending = entry.key in state.pendingKeys,
                    onInstall = { onInstall(entry) },
                )
            }
        }

        if (state.installed.isEmpty() && state.available.isEmpty()) {
            item(key = "empty") {
                Text(
                    text = "还没有源。填入仓库地址后点「刷新」，或从本地导入 .js 文件。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(MaterialTheme.padding.medium),
                )
            }
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(
            start = MaterialTheme.padding.medium,
            top = MaterialTheme.padding.medium,
            bottom = MaterialTheme.padding.small,
        ),
    )
}

@Composable
private fun RepoUrlCard(
    repoUrl: String,
    isLoading: Boolean,
    isSyncing: Boolean,
    syncProgress: Pair<Int, Int>?,
    onRepoUrlChange: (String) -> Unit,
    onReloadIndex: () -> Unit,
    onSyncAll: () -> Unit,
) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(MaterialTheme.padding.medium)) {
            OutlinedTextField(
                value = repoUrl,
                onValueChange = onRepoUrlChange,
                label = { Text("源仓库地址 (index.json 所在目录)") },
                singleLine = true,
                enabled = !isSyncing,
                modifier = Modifier.fillMaxWidth(),
            )

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = MaterialTheme.padding.small),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .size(20.dp)
                            .padding(end = MaterialTheme.padding.small),
                        strokeWidth = 2.dp,
                    )
                }
                TextButton(onClick = onReloadIndex, enabled = !isSyncing && !isLoading) {
                    Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("刷新", modifier = Modifier.padding(start = MaterialTheme.padding.small))
                }
                TextButton(onClick = onSyncAll, enabled = !isSyncing && repoUrl.isNotBlank()) {
                    Icon(Icons.Outlined.Download, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("全部安装", modifier = Modifier.padding(start = MaterialTheme.padding.small))
                }
            }

            if (isSyncing && syncProgress != null) {
                val (done, total) = syncProgress
                LinearProgressIndicator(
                    progress = { if (total > 0) done.toFloat() / total else 0f },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = MaterialTheme.padding.small),
                )
                Text(
                    text = "$done / $total",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun InstalledSourceItem(
    info: JsSourceInfo,
    isPending: Boolean,
    onUninstall: () -> Unit,
) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = MaterialTheme.padding.medium, top = MaterialTheme.padding.medium),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.NewReleases, contentDescription = null)
            Column(modifier = Modifier.padding(start = MaterialTheme.padding.medium)) {
                Text(text = info.name, style = MaterialTheme.typography.titleMedium)
                val subtitle = buildList {
                    if (info.version.isNotEmpty()) add("v${info.version}")
                    info.fileName?.let { add(it) }
                    add(info.key)
                }.joinToString(" · ")
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
            if (isPending) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .padding(MaterialTheme.padding.medium)
                        .size(20.dp),
                    strokeWidth = 2.dp,
                )
            } else {
                IconButton(onClick = onUninstall) {
                    Icon(Icons.Outlined.Delete, contentDescription = "删除")
                }
            }
        }
    }
}

@Composable
private fun AvailableSourceItem(
    entry: JsSourceIndexEntry,
    isPending: Boolean,
    onInstall: () -> Unit,
) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = MaterialTheme.padding.medium, top = MaterialTheme.padding.medium),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Download, contentDescription = null)
            Column(modifier = Modifier.padding(start = MaterialTheme.padding.medium)) {
                Text(text = entry.name, style = MaterialTheme.typography.titleMedium)
                val subtitle = buildList {
                    if (entry.version.isNotEmpty()) add("v${entry.version}")
                    entry.description?.takeIf { it.isNotBlank() }?.let { add(it) }
                }.joinToString(" · ")
                if (subtitle.isNotEmpty()) {
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
            if (isPending) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .padding(MaterialTheme.padding.medium)
                        .size(20.dp),
                    strokeWidth = 2.dp,
                )
            } else {
                TextButton(onClick = onInstall) {
                    Icon(Icons.Outlined.Download, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("安装", modifier = Modifier.padding(start = MaterialTheme.padding.small))
                }
            }
        }
    }
}
