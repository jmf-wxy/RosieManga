plugins {
    `kotlin-dsl`
}

dependencies {
    implementation(androidx.gradle)
    implementation(kotlinx.gradle)
    implementation(kotlinx.compose.compiler.gradle)
    implementation(libs.spotless.gradle)
    implementation(gradleApi())

    implementation(files(libs.javaClass.superclass.protectionDomain.codeSource.location))
    implementation(files(androidx.javaClass.superclass.protectionDomain.codeSource.location))
    implementation(files(compose.javaClass.superclass.protectionDomain.codeSource.location))
    implementation(files(kotlinx.javaClass.superclass.protectionDomain.codeSource.location))
}

repositories {
    // === 本机网络适配（个人自用 fork，非上游配置）===
    // gradlePluginPortal 直连走 Cloudflare，本机实测会挂死（0 B/s 卡住）；
    // mavenCentral 直连实测仅 83 KB/s。故把阿里云镜像排在前面。
    // 若网络环境改善，删掉前 3 行即可还原上游行为。
    maven(url = "https://maven.aliyun.com/repository/gradle-plugin")
    maven(url = "https://maven.aliyun.com/repository/public")
    maven(url = "https://maven.aliyun.com/repository/google")
    // 本机实测：gradlePluginPortal ~61 KB/s、mavenCentral ~83 KB/s，且会长时间挂起。
    // 阿里云镜像已覆盖二者内容，故默认停用；如报缺失再放开。
    // gradlePluginPortal()
    // mavenCentral()
    google()
}
