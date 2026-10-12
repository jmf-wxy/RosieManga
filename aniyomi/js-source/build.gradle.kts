plugins {
    id("mihon.library")
    kotlin("android")
    kotlin("plugin.serialization")
}

android {
    namespace = "eu.kanade.tachiyomi.source.manga.js"
}

kotlin {
    compilerOptions {
        freeCompilerArgs.addAll(
            "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi",
            "-opt-in=kotlinx.serialization.ExperimentalSerializationApi",
        )
    }
}

dependencies {
    implementation(projects.sourceApi)
    implementation(projects.core.common)

    api(kotlinx.coroutines.core)
    implementation(kotlinx.serialization.json)

    // HTML parsing for Venera's `Html` API — Jsoup already ships CSS selectors.
    implementation(libs.jsoup)
    // Networking: reuse Aniyomi's shared OkHttp via core:common's NetworkHelper.
    implementation(libs.okhttp.core)

    // QuickJS bindings with Java<->JS interop (JSCallFunction), Promise, ESModule,
    // and 16KB page-size support (required for Google Play submissions in 2025+).
    implementation("wang.harlon.quickjs:wrapper-android:3.2.0")
}
