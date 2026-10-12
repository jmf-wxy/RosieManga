pluginManagement {
    repositories {
        // === 本机网络适配（个人自用 fork，非上游配置）===
        // buildSrc 若没有这段，插件解析会默认走 gradlePluginPortal，
        // 本机实测该源仅 ~61 KB/s 且会长时间挂起（对端 Cloudflare）。
        maven(url = "https://maven.aliyun.com/repository/gradle-plugin")
        maven(url = "https://maven.aliyun.com/repository/public")
        maven(url = "https://maven.aliyun.com/repository/google")
    }
}

dependencyResolutionManagement {
    versionCatalogs {
        create("libs") {
            from(files("../gradle/libs.versions.toml"))
        }
        create("androidx") {
            from(files("../gradle/androidx.versions.toml"))
        }
        create("compose") {
            from(files("../gradle/compose.versions.toml"))
        }
        create("kotlinx") {
            from(files("../gradle/kotlinx.versions.toml"))
        }
        create("aniyomilibs") {
            from(files("../gradle/aniyomi.versions.toml"))
        }
    }
}

rootProject.name = "Aniyomi"
