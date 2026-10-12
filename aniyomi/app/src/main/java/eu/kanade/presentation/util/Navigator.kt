package eu.kanade.presentation.util

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import cafe.adriel.voyager.core.model.ScreenModel
import cafe.adriel.voyager.core.model.ScreenModelStore
import cafe.adriel.voyager.core.screen.Screen
import cafe.adriel.voyager.core.screen.ScreenKey
import cafe.adriel.voyager.core.screen.uniqueScreenKey
import cafe.adriel.voyager.core.stack.StackEvent
import cafe.adriel.voyager.navigator.Navigator
import cafe.adriel.voyager.transitions.ScreenTransitionContent
import eu.kanade.domain.ui.UiPreferences
import eu.kanade.domain.ui.model.NavStyle
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.plus
import soup.compose.material.motion.animation.materialSharedAxisXIn
import soup.compose.material.motion.animation.materialSharedAxisXOut
import soup.compose.material.motion.animation.rememberSlideDistance
import tachiyomi.presentation.core.util.collectAsState
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * For invoking back press to the parent activity
 */
val LocalBackPress: ProvidableCompositionLocal<(() -> Unit)?> = staticCompositionLocalOf { null }

private val uiPreferences: UiPreferences = Injekt.get()

interface Tab : cafe.adriel.voyager.navigator.tab.Tab {
    suspend fun onReselect(navigator: Navigator) {}

    @Composable
    fun currentNavigationStyle(): NavStyle = uiPreferences.navStyle().collectAsState().value
}

abstract class Screen : Screen {

    override val key: ScreenKey = uniqueScreenKey
}

/**
 * A variant of ScreenModel.coroutineScope except with the IO dispatcher instead of the
 * main dispatcher.
 */
val ScreenModel.ioCoroutineScope: CoroutineScope
    get() = ScreenModelStore.getOrPutDependency(
        screenModel = this,
        name = "ScreenModelIoCoroutineScope",
        factory = { key -> CoroutineScope(Dispatchers.IO + SupervisorJob()) + CoroutineName(key) },
        onDispose = { scope -> scope.cancel() },
    )

interface AssistContentScreen {
    fun onProvideAssistUrl(): String?
}

@Composable
fun DefaultNavigatorScreenTransition(
    navigator: Navigator,
    modifier: Modifier = Modifier,
) {
    val slideDistance = rememberSlideDistance()
    ScreenTransition(
        navigator = navigator,
        transition = {
            val forward = navigator.lastEvent != StackEvent.Pop
            // 离场腿单独缩短。
            //
            // `materialSharedAxisX` 默认把**同一条** 300ms 时长同时给进/离两腿，也就是说旧屏会
            // 一直滑动 + 绘制到动画结束 —— 整段 300ms 里都是「两个全屏图层并存」。而这次要解决的
            // 就是「跳转/返回卡」：进来的那一屏本来就重（首帧组合），再叠一个还在动的旧屏，峰值
            // 工作量被拉满。
            //
            // 让旧屏 170ms 内走完（含它自己的 0~59ms 淡出），之后只剩新屏在动 ⇒ 两屏并存的窗口
            // 从 300ms 砍到 170ms，观感上依旧是「旧页先让开、新页随后到位」，与 Material 的
            // shared-axis 语义一致（M3 规范里离场本来就比进场短）。
            materialSharedAxisXIn(
                forward = forward,
                slideDistance = slideDistance,
                durationMillis = 260,
            ) togetherWith materialSharedAxisXOut(
                forward = forward,
                slideDistance = slideDistance,
                durationMillis = 170,
            )
        },
        modifier = modifier,
    )
}

@Composable
fun ScreenTransition(
    navigator: Navigator,
    transition: AnimatedContentTransitionScope<Screen>.() -> ContentTransform,
    modifier: Modifier = Modifier,
    content: ScreenTransitionContent = { it.Content() },
) {
    AnimatedContent(
        targetState = navigator.lastItem,
        transitionSpec = transition,
        modifier = modifier,
        label = "transition",
    ) { screen ->
        navigator.saveableState("transition", screen) {
            content(screen)
        }
    }
}
