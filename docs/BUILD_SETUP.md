# Aniyomi 构建环境搭建与排障记录（Windows / 本机实战版）

> 项目路径：`D:\VScode\26年\07-animeVenera\aniyomi`
> 记录时间：2026-09-29
> 结论：**配置阶段已 BUILD SUCCESSFUL**，可正常构建。

---

## 0. 一句话总结

本机有三类硬伤：**① 什么都没装（无 SDK / JDK 版本不对）；② 境外源大面积不可用；③ 项目路径含中文**。
逐条修复后构建打通。所有修改都带 `本机网络适配 / 个人自用 fork` 注释，便于回溯。

---

## 1. 最终环境状态

| 组件 | 位置 / 版本 | 说明 |
|---|---|---|
| Android Studio | `D:\AndroidStudio`，**Quail 4 / 2026.1.4** | 自带 JBR **25.0.3** |
| Android SDK | `C:\Users\wengx\AppData\Local\Android\Sdk` | 向导装的 |
| └ platforms | `android-36`（手工补）、`android-37.0` | 项目需 **36** |
| └ build-tools | `35.0.1`（手工补）、`36.0.0` | 项目需 **35.0.1** |
| └ platform-tools | 37.0.1（含 `adb`） | 真机调试用 |
| └ cmdline-tools | `…\Sdk\cmdline-tools\latest` | 手工装，便于命令行构建 |
| Gradle 用 JDK | **`D:\Java\temurin-17`**（Temurin 17.0.20.1） | 手工装，从清华镜像下 |
| Gradle | 8.13（wrapper） | 腾讯云镜像下载 |
| AGP | 8.9.1 | 项目自带 |

---

## 2. 三个致命坑与修复（按重要性）

### 坑 1｜网络：境外源几乎全废 ⚠️ 最关键

本机实测（**直连，非代理**）：

| 源 | 实测速度 | 处理 |
|---|---|---|
| `mirrors.cloud.tencent.com`（Gradle 分发版） | **4.5 MB/s** | ✅ 改用 |
| `maven.aliyun.com` | **3.8 MB/s** | ✅ 改用 |
| `dl.google.com` | 5.9 MB/s | ✅ 保留 |
| `repo1.maven.org`（Maven Central） | **83 KB/s** | ❌ 停用 |
| `plugins.gradle.org` | **61 KB/s 且会挂死** | ❌ 停用 |
| `services.gradle.org`（Gradle 官方） | **10 KB/s** | ❌ 改用腾讯镜像 |
| `api.foojay.io` → github（JDK 下载） | **16 KB/s**，最终地址超时 | ❌ 改用本地 JDK |
| `www.jitpack.io` | **完全超时** | ❌ 换成 `jitpack.io` |
| `jitpack.io`（无 www） | **正常，253 KB/s** | ✅ |
| `github.com` | **不可达（超时）** | 注意规避 |

**症状**：Gradle 卡死不动——缓存 0 增长、日志 10 分钟无输出、进程 CPU 时间几乎为 0、`netstat` 能看到指向 Cloudflare 的 ESTABLISHED 连接。

**修复清单**（均已落地）：

| 文件 | 改动 |
|---|---|
| `gradle/wrapper/gradle-wrapper.properties` | distributionUrl → 腾讯云镜像 |
| `settings.gradle.kts`（2 处 repositories） | 阿里云 3 个镜像排最前 |
| `buildSrc/build.gradle.kts` | 同上 |
| `buildSrc/settings.gradle.kts` | 新增 `pluginManagement` + 阿里云镜像 |
| `settings.gradle.kts` | `https://www.jitpack.io` → `https://jitpack.io` |

> ⚠️ `repositoriesMode = FAIL_ON_PROJECT_REPOS`，所以**不能**用 `~/.gradle/init.gradle` 注入仓库，必须改 `settings.gradle.kts`。

### 坑 2｜JDK 版本：AS 自带 JBR 25 不够用

- Android Studio 自带 **JBR 25**，Gradle 8.13 启动器能跑（只有警告），**项目也要求守护进程用 Java 17**。
- 项目根目录有 `gradle/gradle-daemon-jvm.properties`，把守护进程锁定为 **Eclipse Temurin 17**，并指定从 foojay 下载 → 本机必然失败/挂死。

**修复**：
1. 从清华镜像装 Temurin 17 到 `D:\Java\temurin-17`（9.5 MB/s，19 秒）
2. `gradle/gradle-daemon-jvm.properties` → **改名为 `.disabled`**，停用自动供给
3. `gradle.properties` 指定：
   ```properties
   org.gradle.java.home=D:\\Java\\temurin-17
   org.gradle.java.installations.paths=D:\\Java\\temurin-17
   org.gradle.java.installations.auto-download=false
   ```

> 验证方法：守护进程日志里应出现
> `javaHome=D:\Java\temurin-17, javaVersion=17, javaVendor=Eclipse Adoptium`

### 坑 3｜路径含中文 → AGP 直接报错

`D:\VScode\26年\07-animeVenera` 含「26年」，AGP 会硬性报错中止：

```
> Your project path contains non-ASCII characters.
```

**修复**：`android.overridePathCheck=true`
- 必须**同时**放在 `aniyomi/gradle.properties` **和** `~/.gradle/gradle.properties`（`C:\Users\wengx\.gradle\gradle.properties`）
- 原因：报错发生在 **`buildSrc` 这个独立子构建**里，它**不读取**项目目录的 `gradle.properties`
- 本项目不用 NDK，实测绕过可行

> ⚠️ 长期更稳妥的做法是把项目迁到纯英文路径（如 `D:\dev\animeVenera`）并删掉这些开关。
> 若后续出现资源/aapt2 相关的诡异报错，优先考虑迁移。

---

## 3. 必须做的初始化操作

### 3.1 补装 SDK 组件（向导给的是 37，项目要 36）

```bash
SDK="$LOCALAPPDATA/Android/Sdk"
SM="$SDK/cmdline-tools/latest/bin/sdkmanager.bat"
export JAVA_HOME='D:\Java\temurin-17'
"$SM" --install "platforms;android-36" "build-tools;35.0.1"
```

### 3.2 `local.properties`（指向 SDK，已被 .gitignore 忽略）

```properties
sdk.dir=C\:\\Users\\wengx\\AppData\\Local\\Android\\Sdk
```

### 3.3 ⚠️ 必须有一次 git 提交

`app/build.gradle.kts` 会调用 `getCommitCount()` / `getGitSha()` 读 git 历史。
**仓库若没有任何提交，构建会报 `Process 'command 'git'' finished with non-zero exit value 128`。**

```bash
git add -A && git commit -m "init"
```

---

## 4. 日常构建命令

```bash
cd "D:/VScode/26年/07-animeVenera/aniyomi"
export JAVA_HOME=/d/AndroidStudio/jbr        # 启动器用哪个都行

# 编译 debug APK
./gradlew :app:assembleDebug

# 产物
# aniyomi/app/build/outputs/apk/debug/app-debug.apk

# 装到真机
"$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" install -r \
  app/build/outputs/apk/debug/app-debug.apk
```

> 命令行构建的好处：报错日志可直接抓取分析，不用在 Android Studio 弹窗间来回复制。

---

## 5. Android Studio 里要改的两处设置

| 位置 | 设置 |
|---|---|
| `Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK` | 选 **jbr-25** 即可（启动器用），真正的守护进程由 `org.gradle.java.home` 控制 |
| `Settings → … → Gradle → Gradle user home` | 建议改到 `D:\Android\gradle-home`（C 盘仅剩 ~20G，缓存已占 1G+） |

**注意**：打开的项目目录是 `D:\VScode\26年\07-animeVenera\aniyomi`（**不是**工作区根目录）。

---

## 6. 踩坑速查表

| 症状 | 原因 | 解法 |
|---|---|---|
| Gradle 卡住 10 分钟无输出、缓存不增长 | 撞上境外慢源/不可达源（Cloudflare） | 见坑 1，全部换国内镜像 |
| `Unable to download toolchain … Eclipse Temurin` / `Could not HEAD github.com` | 守护进程 JDK 自动供给走 foojay→github | 见坑 2 |
| `Your project path contains non-ASCII characters` | 路径含「26年」 | 见坑 3（根 + buildSrc 双处） |
| `Process 'command 'git'' finished with non-zero exit value 128` | 仓库无提交 | `git add -A && git commit` |
| `SDK location not found` | 缺 `local.properties` | 见 3.2 |
| `compileSdk 36 requires …` | Android Studio 版本太旧 | 装最新稳定版 |
| C 盘爆满 | SDK / Gradle 缓存在 C 盘 | 见第 5 节 |
| 下载依赖极慢 | Maven Central | 阿里云镜像（已在仓库配置里） |
| 构建慢到怀疑人生 | 杀软实时扫描 | 把项目目录、`~/.gradle`、SDK 目录加白名单 |

---

## 7. 下一步

配置阶段已通。`:js-source` 模块骨架（`JsEngine.kt` 等 4 个文件）**是按接口推断写的、尚未经真实编译**，
首次编译预计会在 `wang.harlon.quickjs:wrapper-android` 的 API 签名上有若干错误（代码里标了 `TODO`），按报错逐条修正即可。

里程碑参考 `docs/IMPLEMENTATION_PLAN.md` 第 8 节（M0–M6）。
