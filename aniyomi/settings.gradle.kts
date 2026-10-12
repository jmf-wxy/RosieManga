pluginManagement {
    resolutionStrategy {
        eachPlugin {
            val regex = "com.android.(library|application)".toRegex()
            if (regex matches requested.id.id) {
                useModule("com.android.tools.build:gradle:${requested.version}")
            }
        }
    }
    repositories {
        // === 本机网络适配（个人自用 fork，非上游配置）===
        // 本机访问 mavenCentral 实测约 108 KB/s，依赖体积 1GB+ 会耗时数小时；
        // 阿里云镜像实测 4.7 MB/s。镜像必须排在最前，Gradle 按声明顺序查找。
        // dl.google.com 本身较快（12 MB/s），故 google() 保留在后。
        // 若将来网络畅通或迁移到境外环境，删掉这 3 行即可。
        maven(url = "https://maven.aliyun.com/repository/gradle-plugin")
        maven(url = "https://maven.aliyun.com/repository/public")
        maven(url = "https://maven.aliyun.com/repository/google")
        // 以下两个源在本机实测仅 ~60–85 KB/s，且会长时间挂起（对端 Cloudflare/Fastly）；
        // 阿里云镜像已覆盖 Plugin Portal 与 Maven Central 的内容，故默认停用。
        // 若报「找不到某插件」，再逐条放开。
        // gradlePluginPortal()
        // mavenCentral()
        google()
        maven(url = "https://jitpack.io")
    }
}

dependencyResolutionManagement {
    versionCatalogs {
        create("kotlinx") {
            from(files("gradle/kotlinx.versions.toml"))
        }
        create("androidx") {
            from(files("gradle/androidx.versions.toml"))
        }
        create("compose") {
            from(files("gradle/compose.versions.toml"))
        }
        create("aniyomilibs") {
            from(files("gradle/aniyomi.versions.toml"))
        }
    }
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // === 本机网络适配（个人自用 fork，非上游配置）===
        // 同上：mavenCentral 实测 108 KB/s，阿里云镜像 4.7 MB/s，必须排最前。
        maven(url = "https://maven.aliyun.com/repository/public")
        maven(url = "https://maven.aliyun.com/repository/google")
        // mavenCentral()  // 本机实测 ~83 KB/s 且会挂起，阿里云 public 已覆盖其内容
        google()
        maven(url = "https://jitpack.io")
    }
}

plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.9.0"
}

enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

rootProject.name = "Aniyomi"
include(":app")
include(":core-metadata")
include(":core:archive")
include(":core:common")
include(":data")
include(":domain")
include(":i18n")
include(":i18n-aniyomi")
include(":js-source")
include(":macrobenchmark")
include(":presentation-core")
include(":presentation-widget")
include(":source-api")
include(":source-local")
