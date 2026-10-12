-dontobfuscate

-keep,allowoptimization class eu.kanade.**
-keep,allowoptimization class tachiyomi.**
-keep,allowoptimization class mihon.**

# Keep common dependencies used in extensions
-keep,allowoptimization class androidx.preference.** { public protected *; }
-keep,allowoptimization class android.content.** { *; }
-keep,allowoptimization class uy.kohesive.injekt.** { public protected *; }
-keep,allowoptimization class android.test.base.** { *; }
-keep,allowoptimization class kotlin.** { public protected *; }
-keep,allowoptimization class kotlinx.coroutines.** { public protected *; }
-keep,allowoptimization class kotlinx.serialization.** { public protected *; }
-keep,allowoptimization class okhttp3.** { public protected *; }
-keep,allowoptimization class okio.** { public protected *; }
-keep,allowoptimization class org.jsoup.** { public protected *; }
-keep,allowoptimization class rx.** { public protected *; }
-keep,allowoptimization class app.cash.quickjs.** { public protected *; }
# QuickJS Java<->native bindings actually used by :js-source
# (`wang.harlon.quickjs:wrapper-android` → Java package `com.whl.quickjs.wrapper`).
#
# ⚠️ The rule above only covers `app.cash.quickjs.**`, which is NOT the library we ship — the real
# one is `com.whl.quickjs.**`. Without this keep, release R8 is free to strip/optimise the wrapper
# and, critically, the JNI-facing members it resolves by name:
#   • `com.whl.quickjs.android.QuickJSLoader.init()` (loads libquickjs*.so);
#   • `QuickJSContext` / `JSObject` / `JSArray` / `JSFunction` and their `native` methods;
#   • the `JSCallFunction` we hand to `global.setProperty("__sendMessageSync", …)`.
# Shrinking any of these turns every JS source into a silent no-op in release while debug (which
# does not run R8) keeps working — the classic "only the release build is broken" class of bug.
-keep class com.whl.quickjs.** { *; }
-keepclassmembers class com.whl.quickjs.** {
    native <methods>;
}
-keep,allowoptimization class uy.kohesive.injekt.** { public protected *; }
-keep,allowoptimization class is.xyz.mpv.** { public protected *; }
-keep,allowoptimization class com.arthenica.** { public protected *; }

# From extensions-lib
-keep,allowoptimization class eu.kanade.tachiyomi.network.interceptor.RateLimitInterceptorKt { public protected *; }
-keep,allowoptimization class eu.kanade.tachiyomi.network.interceptor.SpecificHostRateLimitInterceptorKt { public protected *; }
-keep,allowoptimization class eu.kanade.tachiyomi.network.NetworkHelper { public protected *; }
-keep,allowoptimization class eu.kanade.tachiyomi.network.OkHttpExtensionsKt { public protected *; }
-keep,allowoptimization class eu.kanade.tachiyomi.network.RequestsKt { public protected *; }
-keep,allowoptimization class eu.kanade.tachiyomi.AppInfo { public protected *; }
-keep,allowoptimization class eu.kanade.tachiyomi.torrentutils.** { public protected *; }

##---------------Begin: proguard configuration for RxJava 1.x  ----------
-dontwarn sun.misc.**

-keepclassmembers class rx.internal.util.unsafe.*ArrayQueue*Field* {
   long producerIndex;
   long consumerIndex;
}

-keepclassmembers class rx.internal.util.unsafe.BaseLinkedQueueProducerNodeRef {
    rx.internal.util.atomic.LinkedQueueNode producerNode;
}

-keepclassmembers class rx.internal.util.unsafe.BaseLinkedQueueConsumerNodeRef {
    rx.internal.util.atomic.LinkedQueueNode consumerNode;
}

-dontnote rx.internal.util.PlatformDependent
##---------------End: proguard configuration for RxJava 1.x  ----------

##---------------Begin: proguard configuration for okhttp  ----------
-keepclasseswithmembers class okhttp3.MultipartBody$Builder { *; }
##---------------End: proguard configuration for okhttp  ----------

##---------------Begin: proguard configuration for kotlinx.serialization  ----------
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.** # core serialization annotations

# kotlinx-serialization-json specific. Add this if you have java.lang.NoClassDefFoundError kotlinx.serialization.json.JsonObjectSerializer
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

-keep,includedescriptorclasses class eu.kanade.**$$serializer { *; }
-keepclassmembers class eu.kanade.** {
    *** Companion;
}
-keepclasseswithmembers class eu.kanade.** {
    kotlinx.serialization.KSerializer serializer(...);
}

-keep class kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.** {
    <methods>;
}
##---------------End: proguard configuration for kotlinx.serialization  ----------

# XmlUtil
-keep public enum nl.adaptivity.xmlutil.EventType { *; }

##---------------Begin: Venera JS comic-source subsystem  ----------
# The JS assets themselves need NO keep rule: `assets/init.js` and the runtime-installed
# `comic_source/*.js` are plain assets, and neither R8 (classes only) nor `isShrinkResources`
# (rewrites `res/` references only) ever looks inside `assets/`. The Kotlin side that reads and
# evaluates them lives under `eu.kanade.**`, already kept above. The bridge it uses dispatches on
# the *string* `msg["method"]`, which never becomes an R8 rename target.
#
# Kept explicit only as documentation so a future reader does not "fix" the perceived gap by adding
# a bogus asset rule.
-keep,allowoptimization class eu.kanade.tachiyomi.source.manga.js.** { *; }
##---------------End: Venera JS comic-source subsystem  ----------
