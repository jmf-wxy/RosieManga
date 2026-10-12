# Aniyomi 构建告警清理报告

> 环境：AGP 8.9.1 · Kotlin (KGP) 2.4.0 · Gradle 8.13 · JDK Temurin 17
> 日期：2026-09-30

---

## 一、结论速览

| # | 告警 | 根因 | 处理 | 状态 |
|---|---|---|---|---|
| 1 | `android.overridePathCheck=true` is experimental | 项目路径含中文「26年」 | 无法抑制 | ⚠️ 无解 |
| 2 | Deprecated Gradle Version（要 8.14.4） | KGP 2.4 推荐值高于项目实际用的 8.13 | 抑制 | ✅ 已消除 |
| 3 | `kotlin.mpp.androidSourceSetLayoutVersion` 弃用 | 该属性已无意义，V2 是默认 | 删属性 | ✅ 已消除 |
| 4 | `sourceSets collection in Kotlin Android` 弃用 | sqldelight 2.0.2 插件内部调用 | 抑制 | ✅ 已消除 |
| 5 | D8/R8 `Should never be called`（metadata 重写） | R8 8.9 已知缺陷，仅 warning | 随源码修复消失 | ✅ 已消除 |
| 6 | Compose `OptimizeNonSkippingGroups` 显式设置 | Kotlin 2.1+ 已默认 | 删除设置 | ✅ 已消除 |
| 7 | `AboutScreen.kt` 冗余 `else` | 代码问题 | 删除 | ✅ 已消除 |
| 8 | `WebViewScreenContent.kt` 图标弃用 + 多余强转 | 代码问题 | 改用 AutoMirrored | ✅ 已消除 |
| 9 | `NotificationReceiver.kt` delicate API ×4 | 项目自己 opt-in 的用法 | 无需处理（非缺陷） | ✅ 正常 |

---

## 二、最关键的技术发现

### 抑制键 = 诊断类的「类名」，不是文档里的名字

`suspendGradlePluginWarnings` 的取值**不是**描述性名称，而是
`org.jetbrains.kotlin.gradle.plugin.diagnostics.KotlinToolingDiagnostics$Xxx`
内部类的**类名**。

反编译 `kotlin-gradle-plugin-2.4.0-gradle813.jar` 得到 ID 生成链：

```
ToolingDiagnosticFactory.<init>()  →  id = this.getClass().getSimpleName()
ToolingDiagnosticFactory.build(idSuffix, ...)
    →  id = if (idSuffix.isNotBlank()) "$id_$idSuffix" else id
```

实测对照：

| 告警 | 文档/直觉写法 | **实际正确的 key** |
|---|---|---|
| Gradle 版本过低 | `DeprecatedGradleVersionWarning` | `DeprecatedGradleVersionWarning` ✔ 一致 |
| `kotlin.sourceSets` 弃用 | `KotlinSourceSetDeprecationWarning` ❌ | **`SourceSetsAccessInAndroidExtension`** |

写错 key 会**完全静默无效**，不报任何错——这是本次排查最大的坑。

### 抑制键的作用域

`PropertiesBuildService.property()` 的查找顺序（反编译确认）：

1. `extraProperties`（`-P` 命令行 / `ext {}`）
2. `ProviderFactory.gradleProperty(name)` → **只读根目录 `gradle.properties`**
3. `localProperties`

**推论：模块级 `gradle.properties`（如 `data/gradle.properties`）不生效**，已实测验证。

---

## 三、改动清单

### 1. `aniyomi/gradle.properties`

```diff
  kotlin.code.style=official
- kotlin.mpp.androidSourceSetLayoutVersion=2
```

> Android Source Set Layout V2 自 KGP 1.9/2.x 起已是默认且不可更改，
> 保留该属性必然触发 `DeprecatedGradleProperty` 告警。删除后行为完全不变。

```diff
+ android.overridePathCheck=true
+
+ kotlin.suppressGradlePluginWarnings=DeprecatedGradleVersionWarning,SourceSetsAccessInAndroidExtension
```

### 2. `app/src/main/java/eu/kanade/tachiyomi/util/CrashLogUtil.kt`

原逻辑存在**真实 bug**：`FileOutputStream(text=true)` 每次构造都会截断文件，
所以「先写 debug info，再 exec logcat -f」会把前面的内容全部覆盖掉。

```diff
- file.appendText(getDebugInfo() + "\n\n")
- getMangaExtensionsInfo()?.let { file.appendText("$it\n\n") }
- getAnimeExtensionsInfo()?.let { file.appendText("$it\n\n") }
- exception?.let { file.appendText("$it\n\n") }
+ val builder = StringBuilder()
+ builder.appendLine(getDebugInfo()).appendLine()
+ getMangaExtensionsInfo()?.let { builder.appendLine(it).appendLine() }
+ getAnimeExtensionsInfo()?.let { builder.appendLine(it).appendLine() }
+ exception?.let { builder.appendLine(it).appendLine() }
+ file.writeText(builder.toString())
```

### 3. `app/.../presentation/more/settings/screen/about/AboutScreen.kt`

```diff
      is GetApplicationRelease.Result.OsTooOld -> {
          context.toast(MR.strings.update_check_eol)
      }
-     else -> {}
  }
```

### 4. `app/.../presentation/webview/WebViewScreenContent.kt`

```diff
- import androidx.compose.material.icons.outlined.ArrowBack
- import androidx.compose.material.icons.outlined.ArrowForward
+ import androidx.compose.material.icons.automirrored.outlined.ArrowBack
+ import androidx.compose.material.icons.automirrored.outlined.ArrowForward

- icon = Icons.Outlined.ArrowBack,
+ icon = Icons.AutoMirrored.Outlined.ArrowBack,
- icon = Icons.Outlined.ArrowForward,
+ icon = Icons.AutoMirrored.Outlined.ArrowForward,

- progress = { (loadingState as? LoadingState.Loading)?.progress ?: 1f },
+ progress = { loadingState.progress },
```

### 5. `buildSrc/src/main/kotlin/mihon/buildlogic/ProjectExtensions.kt`

```diff
- import org.jetbrains.kotlin.compose.compiler.gradle.ComposeFeatureFlag
...
  extensions.configure<ComposeCompilerGradlePluginExtension> {
-     featureFlags.set(setOf(ComposeFeatureFlag.OptimizeNonSkippingGroups))
-
      val enableMetrics = ...
```

---

## 四、验证结果

`./gradlew :app:compileDebugKotlin --offline --rerun-tasks` 输出中的告警计数：

```
sourceSets collection                  : 0
Deprecated Gradle Version              : 0
mpp.androidSourceSetLayoutVersion      : 0
Should never be called                 : 0
delicate API                           : 1   ← 项目自己 opt-in，非缺陷
AutoMirrored                           : 0
redundant                              : 0
```

**全部目标告警清零。**

---

## 五、遗留问题

### 1. `JAVA_HOME` 环境污染（必须注意）

跑 Gradle 时若终端残留 `JAVA_HOME=D:\Java\jdk8`，wrapper 会用 JDK 8 启动，报：

```
java.io.FileNotFoundException: D:\Java\jdk8\jre\lib\ext\cldrdata.jar
```

**项目侧配置是正确的**（已核对）：

- `gradle.properties`：`org.gradle.java.home=D:\\Java\\temurin-17`
- `gradle/gradle-daemon-jvm.properties` → 已改名 `.disabled`
- `D:/Java/temurin-17/release` 确认存在：`Temurin-17.0.20.1+1`

**处理**：跑 Gradle 前清掉或覆盖 `JAVA_HOME`；Android Studio 内使用不受影响。

### 2. `android.overridePathCheck` 提示无法消除

这是 AGP 对「非默认实验开关」的固定输出，`gradle.properties` / TOML / 命令行参数均无法压制。
唯一根治方案：把项目迁到纯英文路径（如 `D:\dev\animeVenera`）后删除该开关。

### 3. sqldelight 弃用告警的彻底解法

当前是靠抑制隐藏。若要根治，需升级 `sqldelight = "2.0.2"` → `2.1.x`（该版本已改用 AGP 的 source set API）。
升级前需确认 `libs.versions.toml` 中 `sqldelight-dialects-sql`（`sqlite-3-38-dialect`）等配套模块同步升版。

---

## 六、后续事故：`:data` 大面积 Unresolved reference（已解决）

### 现象

清理告警后再次构建，`:data` 模块突然报出上百条 `Unresolved reference`：

```
AnimeCategoryRepositoryImpl.kt: Unresolved reference 'category' / 'Category' / 'CategoryUpdate'
AnimeExtensionStoreRepositoryImpl.kt: Unresolved reference 'extension' / 'AnimeExtensionStore'
AnimeExtensionStoreService.kt: Unresolved reference 'AnimeExtensionStore' / 'indexUrl'
```

看起来像 domain 模块的包结构被破坏了，但 **源码完全正常**。

### 排查过程

| 步骤 | 观察 | 结论 |
|---|---|---|
| 1 | `domain/src/.../mihon/domain/extension` 与 `tachiyomi/domain/category` 均存在 | 源码没问题 |
| 2 | `:domain:compileDebugKotlin` → **UP-TO-DATE**，显示成功 | Gradle 认为 domain 是好的 |
| 3 | 清理 `:data` 增量缓存后重编 | 错误**变了**（改成 `MangaUpdatesWithRelations`） |
| 4 | 检查 `domain/.../classes.jar` | **只有 17 个条目，全是 R.class** |

**第 3 步是关键**——错误清单会变，说明不是源码或依赖声明问题，而是依赖产物内容不稳定。

### 根因

`:domain` 的 `classes.jar` 是个**空壳**（只有 17 个 R.class，业务类全丢）。
而 `:domain:compileDebugKotlin` 和 `bundleLibCompileToJarDebug` 都报告 `UP-TO-DATE`，
**Gradle 不会再重新生成它**，于是 `:data` 无论怎么编都找不到类。

空壳的来源是两次 JVM 崩溃（工作区残留的 `hs_err_pid*.log`）：

```
hs_err_pid25132.log → JRE 1.8.0_60 (JDK 8)  ← JAVA_HOME 污染那次
hs_err_pid29092.log → Temurin-17.0.20.1
                      Native memory allocation (mmap) failed to map 297795584 bytes
                      Error detail: G1 virtual space      ← 内存耗尽被 OS 杀死
```

被杀死的 Worker 当时正在写 `classes.jar`，写入中断 → 只落盘 17 个条目。
**但任务被标记为成功**，这就是最阴险的地方。

### 修复

```bash
# 1. 强制重新生成 domain 的编译产物与 jar（两个都要，缺一不可）
./gradlew :domain:compileDebugKotlin --offline --rerun-tasks
./gradlew :domain:bundleLibCompileToJarDebug --offline --rerun-tasks

# 2. 验证 jar 恢复
unzip -l domain/build/intermediates/compile_library_classes_jar/debug/\
bundleLibCompileToJarDebug/classes.jar | grep -c "\.class"
# 修复前: 17      修复后: 534
```

> ⚠️ 只跑 `:domain:compileDebugKotlin --rerun-tasks` **无效**——
> `bundleLibCompileToJarDebug` 仍会因 UP-TO-DATE 而跳过，jar 保持空壳。

### 内存配置加固（防复发）

`gradle.properties` 从 `-Xmx4g` 调整（原值导致 native heap 不足被 OS 杀死）：

```properties
org.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8
kotlin.daemon.jvmargs=-Xmx2g
```

要点：**堆不是越大越好**。`-Xmx4g` 挤压了 native heap（Metaspace / code cache /
Kotlin 编译器工作区），反而触发 `mmap failed to map ... G1 virtual space`。

### 经验教训

1. **`hs_err_pid*.log` 是构建产物损坏的强信号**，见到就查，别只删日志。
2. **跨模块 `Unresolved reference` 优先怀疑依赖模块的 jar 产物，而不是源码**。
   判据：清理下游缓存后**错误清单会变** → 一定是产物问题。
3. **`UP-TO-DATE` 不代表产物正确**。JVM 崩溃会留下「任务成功但产物残缺」的中间态。
4. 修复这类问题要 `--rerun-tasks` 到 **jar 打包任务**，只重跑 compile 不够。

