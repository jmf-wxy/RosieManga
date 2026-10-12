package eu.kanade.presentation.more.settings.screen.browse

import androidx.compose.runtime.Immutable
import cafe.adriel.voyager.core.model.StateScreenModel
import cafe.adriel.voyager.core.model.screenModelScope
import eu.kanade.tachiyomi.source.manga.js.JsAccountMode
import eu.kanade.tachiyomi.source.manga.js.JsDebugLog
import eu.kanade.tachiyomi.source.manga.js.JsSourceInfo
import eu.kanade.tachiyomi.source.manga.js.JsSourceManager
import eu.kanade.tachiyomi.source.manga.js.JsSourceMeta
import eu.kanade.tachiyomi.source.manga.js.JsSourceUpdater
import eu.kanade.tachiyomi.source.manga.js.JsUiEvents
import kotlinx.collections.immutable.ImmutableList
import kotlinx.collections.immutable.ImmutableMap
import kotlinx.collections.immutable.toImmutableList
import kotlinx.collections.immutable.toImmutableMap
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import tachiyomi.core.common.util.lang.launchIO
import tachiyomi.domain.entries.manga.repository.MangaRepository
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Screen model for the "漫画源" configuration page — the Aniyomi counterpart of Venera's source
 * management screen.
 *
 * Everything rendered here is *derived from the JS sources themselves*: the settings list and the
 * login mode come from [JsSourceManager.meta], and the current values from
 * [JsSourceManager.settingValue], which applies Venera's `saved → declared default` chain.
 */
class JsSourceConfigScreenModel(
    private val defaultRepoUrl: String = JsSourcesScreenModel.DEFAULT_REPO_URL,
    private val mangaRepository: MangaRepository = Injekt.get(),
) : StateScreenModel<JsSourceConfigState>(JsSourceConfigState()) {

    private val TAG = "JsSourceConfigModel"

    private val _events: Channel<JsSourceConfigEvent> = Channel(Int.MAX_VALUE)
    val events = _events.receiveAsFlow()

    /**
     * Venera `UI.*` requests raised by sources, bridged straight through from [JsUiEvents].
     *
     * Exposed as a `Flow` (not merged into [events]) because these are *ambient*: they can arrive
     * while a callback is running, when the screen is not focused, or from another source entirely.
     */
    val uiEvents = JsUiEvents.events

    init {
        screenModelScope.launchIO {
            JsSourceManager.installed.collectLatest { refresh(it) }
        }
        screenModelScope.launchIO {
            JsSourceManager.configVersion.collectLatest { refresh(JsSourceManager.installed.value) }
        }
    }

    /** Re-reads metadata + current values for every installed source. */
    private suspend fun refresh(installed: List<JsSourceInfo>) {
        // Reflect metadata off the JS thread first — `loadSetting` inside a source resolves against
        // this cache, so it must be warm before any source code runs.
        val metas = installed.associate { info ->
            info.key to (JsSourceManager.meta(info.key) ?: JsSourceMeta())
        }
        val values = installed.associate { info ->
            info.key to metas.getValue(info.key).settings.associate { item ->
                item.key to JsSourceManager.settingValue(info.key, item.key)
            }
        }
        mutableState.update {
            it.copy(
                sources = installed.toImmutableList(),
                metas = metas.toImmutableMap(),
                values = values.toImmutableMap(),
            )
        }
    }

    /** Re-scans `comic_source/` so a source edited on disk shows up without restarting. */
    fun reloadAll() {
        screenModelScope.launchIO {
            mutableState.update { it.copy(pendingKeys = it.pendingKeys + RELOAD_MARKER) }
            JsSourceManager.reload()
            mutableState.update { it.copy(pendingKeys = it.pendingKeys - RELOAD_MARKER) }
            _events.send(JsSourceConfigEvent.Reloaded)
        }
    }

    /**
     * Refreshes **only the sources the user already installed**.
     *
     * Deliberately not [JsSourceUpdater.syncRepo]: that installs the whole catalogue, which would
     * silently add ~30 sources the user never asked for.
     *
     * ### Upgrade self-heal (S41)
     *
     * A source upgrade frequently fixes what the *old* version had already written to the library —
     * a scrambled chapter list, 未知作者, a stale chapter count. But an already-initialized library
     * manga never re-pulls on its own (`MangaScreenModel`: `needRefreshChapter = chapters.isEmpty()`),
     * so the fix stays invisible until the user manually pulls to refresh. After a **higher-version**
     * replacement we therefore mark that source's library movies for a fresh pull (see
     * [markSourceForResync]) — a lightweight `initialized = false` UPDATE, never a schema migration.
     */
    fun checkUpdates() {
        screenModelScope.launchIO {
            mutableState.update { it.copy(pendingKeys = it.pendingKeys + RELOAD_MARKER) }
            val upgradedKeys = mutableListOf<String>()
            val count = JsSourceUpdater.updateInstalled(
                repoUrl = defaultRepoUrl,
                onProgress = { done, total ->
                    mutableState.update { it.copy(syncProgress = done to total) }
                },
                onUpgraded = { upgradedKeys += it },
            )
            if (count > 0) JsSourceManager.reload()
            // Heal AFTER the reload so the new source classes are the ones that will be queried.
            val healed = upgradedKeys.sumOf { key -> runCatching { markSourceForResync(key) }.getOrDefault(0) }
            mutableState.update { it.copy(pendingKeys = it.pendingKeys - RELOAD_MARKER, syncProgress = null) }
            _events.send(JsSourceConfigEvent.Updated(count))
            if (healed > 0) _events.send(JsSourceConfigEvent.Resynced(healed))
        }
    }

    /**
     * Manual「重新同步此源」— forces this source's library manga to be re-pulled from the source.
     *
     * The same mechanism as the automatic post-upgrade heal ([checkUpdates]), exposed as an explicit
     * button because a source can also be fixed by a *local* import (a locally-patched `.js` that
     * never appears in the repo index, so [JsSourceUpdater.updateInstalled] never sees an upgrade).
     */
    fun resyncSource(key: String) {
        screenModelScope.launchIO {
            mutableState.update { it.copy(pendingKeys = it.pendingKeys + key) }
            try {
                val healed = markSourceForResync(key)
                _events.send(JsSourceConfigEvent.Resynced(healed))
            } finally {
                // `pendingKeys` gates every button on the card — a leaked key greys them all out
                // permanently, so the clear is in `finally` (same reasoning as `onRunCallback`).
                mutableState.update { it.copy(pendingKeys = it.pendingKeys - key) }
            }
        }
    }

    /**
     * Marks every **library** manga of the source with [key] as needing a fresh pull, and returns how
     * many rows changed.
     *
     * Thin delegate to [JsSourceResync.markSourceForResync], which owns the `initialized = false`
     * semantics and the red-line rationale (read progress untouched, no schema migration, batch
     * write). Kept as a method so the two call sites below stay symmetric.
     */
    private suspend fun markSourceForResync(key: String): Int =
        JsSourceResync.markSourceForResync(mangaRepository, key)

    fun uninstall(key: String) {
        // `JsSourceManager.uninstall` re-enters QuickJS (`evalBlocking`) and deletes files, so it
        // must not run on the UI thread. The list refreshes itself off the `installed` flow.
        screenModelScope.launchIO { JsSourceManager.uninstall(key) }
    }

    // --- settings ----------------------------------------------------------------------------------

    fun onSettingChange(key: String, settingKey: String, value: Any?) {
        // Optimistic: reflect the new value immediately; the configVersion flow also fires but this
        // avoids a flicker.
        mutableState.update { state ->
            val perSource = state.values[key].orEmpty().toMutableMap().apply { put(settingKey, value) }
            state.copy(values = state.values.toMutableMap().apply { put(key, perSource) }.toImmutableMap())
        }
        // The write itself is `@Synchronized` and serialises the source's whole data blob to disk,
        // so it belongs on IO — doing it inline here meant a disk write on the main thread for every
        // switch/select the user taps.
        screenModelScope.launchIO { JsSourceManager.saveSetting(key, settingKey, value) }
    }

    /**
     * Runs a `callback` setting (刷新域名列表 / 手动签到 …).
     *
     * Two states are tracked on purpose, because they mean different things to the user:
     *  - [JsSourceConfigState.pendingKeys] (source key) drives the card header spinner;
     *  - [JsSourceConfigState.pendingCallbacks] (`"<sourceKey>#<settingKey>"`) drives the **button's
     *    own** inline spinner, which is what Venera shows. Without the second one a 3–5s network
     *    refresh looks like nothing happened — the header spinner is easy to miss off-screen.
     */
    fun onRunCallback(key: String, settingKey: String) {
        val token = callbackToken(key, settingKey)
        JsDebugLog.d(TAG, "onRunCallback($key, $settingKey) token=$token pendingKeys=${mutableState.value.pendingKeys}")
        screenModelScope.launchIO {
            mutableState.update {
                it.copy(
                    pendingKeys = it.pendingKeys + key,
                    pendingCallbacks = it.pendingCallbacks + token,
                )
            }
            // ⚠️ The clear MUST be in `finally`. `pendingKeys` is what makes the buttons
            // `enabled = false`, so leaving a key behind on an exception (or on cancellation when
            // the user leaves the screen mid-call) permanently greys out **every** button on that
            // card — the exact "点了没反应" symptom, with no log to explain it. A stuck entry is
            // invisible from the UI: the row just looks normal but does nothing.
            try {
                val outcome = JsSourceManager.runSettingCallback(key, settingKey)
                JsDebugLog.d(TAG, "onRunCallback outcome=${outcome::class.simpleName} reason=${outcome.reasonOrNull()}")
                // Only speak up on failure: a successful callback usually shows its own dialog or
                // message through `UI.*`, and adding a toast on top would be noise.
                outcome.reasonOrNull()?.let { _events.send(JsSourceConfigEvent.CallbackFailed(it)) }
            } finally {
                mutableState.update {
                    it.copy(
                        pendingKeys = it.pendingKeys - key,
                        pendingCallbacks = it.pendingCallbacks - token,
                    )
                }
                JsDebugLog.d(TAG, "onRunCallback cleared token=$token")
            }
        }
    }

    // --- account -----------------------------------------------------------------------------------

    fun onLogin(key: String, credentials: List<String>) {
        JsDebugLog.d(TAG, "onLogin($key) fields=${credentials.size}")
        screenModelScope.launchIO {
            mutableState.update {
                it.copy(
                    pendingKeys = it.pendingKeys + key,
                    // Drop any previous verdict first. Leaving "登录成功" on screen while a new
                    // attempt is in flight reads as the *new* credentials already having worked.
                    loginStatus = it.loginStatus.toMutableMap().apply { remove(key) }.toImmutableMap(),
                )
            }
            try {
                // Both branches are normalised to `LoginResult`: they are different login modes, but
                // the UI must not care which one ran — only whether it worked and why it did not.
                val result = when (JsSourceManager.meta(key)?.accountMode) {
                    is JsAccountMode.Cookies ->
                        if (JsSourceManager.loginWithCookies(key, credentials)) {
                            JsSourceManager.LoginResult.Success
                        } else {
                            // `validate` only ever answers true/false, so there is no source message
                            // to relay — name the field that is most likely wrong instead.
                            JsSourceManager.LoginResult.Failure("Cookie 校验失败，请检查填写内容")
                        }

                    else -> JsSourceManager.login(
                        key = key,
                        account = credentials.getOrElse(0) { "" },
                        password = credentials.getOrElse(1) { "" },
                    )
                }

                val status = when (result) {
                    is JsSourceManager.LoginResult.Success -> LoginStatus(success = true, message = "登录成功")
                    // Carry the source's own reason through: "账号或密码错误" is far more useful than
                    // a generic "登录失败", and it is what Venera displays too.
                    is JsSourceManager.LoginResult.Failure ->
                        LoginStatus(success = false, message = result.reason.ifBlank { "登录失败，请检查账号密码" })
                }
                // Rendered inline on the source card. The toast below is a bonus, NOT the primary
                // channel: `Toast.makeText(applicationContext, ...)` is routinely rate-limited or
                // dropped outright by vivo/OriginOS, so relying on it alone (as this did) meant a
                // login could succeed or fail with no visible trace at all.
                mutableState.update {
                    it.copy(
                        loginStatus = it.loginStatus.toMutableMap().apply { put(key, status) }.toImmutableMap(),
                    )
                }
                _events.send(
                    when (result) {
                        is JsSourceManager.LoginResult.Success -> JsSourceConfigEvent.LoggedIn
                        is JsSourceManager.LoginResult.Failure ->
                            JsSourceConfigEvent.LoginFailed(result.reason)
                    },
                )
                JsDebugLog.d(TAG, "onLogin result=${result::class.simpleName} shown='${status.message}'")
            } finally {
                // See `onRunCallback`: a leaked key here disables the login button *and* every
                // callback button on the card, silently and permanently.
                mutableState.update { it.copy(pendingKeys = it.pendingKeys - key) }
            }
        }
    }

    fun onLogout(key: String) {
        screenModelScope.launchIO {
            JsSourceManager.logout(key)
            mutableState.update {
                it.copy(loginStatus = it.loginStatus.toMutableMap().apply { remove(key) }.toImmutableMap())
            }
        }
    }

    /** Stable per-button identity; must match what the content composable computes. */
    private fun callbackToken(key: String, settingKey: String) = "$key#$settingKey"

    /** `null` for [JsSourceManager.CallbackOutcome.Ok]; otherwise the failure's message. */
    private fun JsSourceManager.CallbackOutcome.reasonOrNull(): String? =
        (this as? JsSourceManager.CallbackOutcome.Failed)?.reason

    // --- Venera UI.* -----------------------------------------------------------------------------

    /** Runs a button of a JS-declared dialog, then releases the JS-side action array. */
    fun onDialogAction(handle: String?, actionIndex: Int) {
        screenModelScope.launchIO {
            JsSourceManager.runUiDialogAction(handle.orEmpty(), actionIndex)
            JsSourceManager.releaseDialogActions(handle)
        }
    }

    /** Dismissal without a choice still has to free the JS-side array. */
    fun onDialogDismissed(handle: String?) {
        JsSourceManager.releaseDialogActions(handle)
    }

    private companion object {
        /** Sentinel used to show the list-wide spinner without pointing at a specific source. */
        const val RELOAD_MARKER = "\u0000reload"
    }
}

@Immutable
data class JsSourceConfigState(
    val sources: ImmutableList<JsSourceInfo> = emptyList<JsSourceInfo>().toImmutableList(),
    val metas: ImmutableMap<String, JsSourceMeta> = emptyMap<String, JsSourceMeta>().toImmutableMap(),
    /** Current value per source → setting key, after the default fallback chain. */
    val values: ImmutableMap<String, Map<String, Any?>> = emptyMap<String, Map<String, Any?>>().toImmutableMap(),
    /** Source keys with work in flight, so their row shows a spinner. */
    val pendingKeys: Set<String> = emptySet(),
    /**
     * Individual buttons with work in flight, keyed `"<sourceKey>#<settingKey>"`.
     *
     * Distinct from [pendingKeys]: that one spins the *card header*, which is easy to miss when a
     * 3–5s network refresh happens further down the page. Venera spins the tapped button itself, so
     * the user gets feedback exactly where they tapped.
     */
    val pendingCallbacks: Set<String> = emptySet(),
    /**
     * Last login verdict per source key, shown **inline on the card**.
     *
     * Deliberately part of the state rather than a one-shot event: a toast is easy to miss (and on
     * vivo/OriginOS is often suppressed entirely), and "did my password work?" is a question the
     * user comes back to. Keeping it on screen until the next attempt or a logout answers it
     * permanently, and it costs nothing.
     */
    val loginStatus: ImmutableMap<String, LoginStatus> = emptyMap<String, LoginStatus>().toImmutableMap(),
    val syncProgress: Pair<Int, Int>? = null,
)

/** Result of the most recent login attempt for one source. See [JsSourceConfigState.loginStatus]. */
@Immutable
data class LoginStatus(
    val success: Boolean,
    /** Already user-facing: success text, or the source's own failure message. */
    val message: String,
)

sealed class JsSourceConfigEvent {
    data object Reloaded : JsSourceConfigEvent()
    data class Updated(val count: Int) : JsSourceConfigEvent()

    /**
     * A source's library rows were marked for a fresh pull — [count] manga will re-sync on their next
     * open (the upgrade self-heal, or a manual「重新同步此源」). [count] may be 0 when nothing was
     * initialized yet.
     */
    data class Resynced(val count: Int) : JsSourceConfigEvent()

    /**
     * A `callback` setting failed before it could report through `UI.*`.
     *
     * Callbacks normally end in `UI.showDialog(...)`, which the dialog channel renders, so a
     * success needs no event here. This fires only for the silent-failure case (thrown string,
     * unhandled network error, tick-budget timeout) that would otherwise be a dead-looking button.
     */
    data class CallbackFailed(val reason: String) : JsSourceConfigEvent()

    data object LoggedIn : JsSourceConfigEvent()

    /** Login failed; [reason] is the source's own message (`throw '密码错误'`), not a generic string. */
    data class LoginFailed(val reason: String) : JsSourceConfigEvent()
}
