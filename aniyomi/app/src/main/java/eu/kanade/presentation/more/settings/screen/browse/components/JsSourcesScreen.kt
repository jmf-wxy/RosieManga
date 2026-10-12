package eu.kanade.presentation.more.settings.screen.browse.components

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import eu.kanade.presentation.components.AppBar
import eu.kanade.presentation.more.settings.screen.browse.JsSourcesState
import eu.kanade.tachiyomi.source.manga.js.JsSourceIndexEntry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tachiyomi.presentation.core.components.material.Scaffold
import tachiyomi.presentation.core.components.material.padding
import tachiyomi.presentation.core.components.material.topSmallPaddingValues
import tachiyomi.presentation.core.util.plus
import java.io.File

/**
 * The JS 源 management page content (Scaffold + top bar + FAB).
 *
 * The FAB imports a local `*.js` source file via the system document picker — this is the
 * offline counterpart to installing from a repo.
 */
@Composable
fun JsSourcesScreen(
    state: JsSourcesState,
    onRepoUrlChange: (String) -> Unit,
    onReloadIndex: () -> Unit,
    onSyncAll: () -> Unit,
    onInstall: (JsSourceIndexEntry) -> Unit,
    onUninstall: (String) -> Unit,
    onImportFile: (fileName: String, code: String) -> Unit,
    navigateUp: () -> Unit,
) {
    val context = LocalContext.current
    val lazyListState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    val filePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument(),
    ) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        // ActivityResult callbacks run on the main thread; reading the whole document through the
        // ContentResolver here blocks it. The (heavier) install itself is already dispatched to IO
        // inside the screen model.
        scope.launch {
            val code = withContext(Dispatchers.IO) {
                runCatching {
                    context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                }.getOrNull()
            }
            if (!code.isNullOrBlank()) {
                // Prefer the provider's display name, falling back to the last path segment.
                val name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.endsWith(".js") }
                    ?: "imported_${System.currentTimeMillis()}.js"
                onImportFile(name, code)
            }
        }
    }

    Scaffold(
        topBar = { scrollBehavior ->
            AppBar(
                navigateUp = navigateUp,
                title = "JS 源",
                scrollBehavior = scrollBehavior,
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { filePicker.launch(arrayOf("text/javascript", "application/javascript", "*/*")) },
                icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                text = { Text("导入 .js") },
            )
        },
    ) { paddingValues ->
        JsSourcesContent(
            state = state,
            lazyListState = lazyListState,
            paddingValues = paddingValues +
                topSmallPaddingValues +
                PaddingValues(horizontal = MaterialTheme.padding.medium),
            onRepoUrlChange = onRepoUrlChange,
            onReloadIndex = onReloadIndex,
            onSyncAll = onSyncAll,
            onInstall = onInstall,
            onUninstall = onUninstall,
        )
    }
}
