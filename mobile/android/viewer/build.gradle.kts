import java.util.Properties


plugins {
    id("com.android.application")
}

dependencies { implementation(project(":updatecore")) }

val releaseSigningFile = rootProject.file("keystore.properties")
val releaseSigning = Properties().apply {
    if (releaseSigningFile.isFile) {
        releaseSigningFile.inputStream().use { load(it) }
    }
}
val releaseRequested = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }
if (releaseRequested && !releaseSigningFile.isFile) {
    throw GradleException("mobile/android/keystore.properties is required for a signed release APK.")
}

android {
    namespace = "com.wonremote.viewer"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.wonremote.viewer"
        minSdk = 26
        targetSdk = 35
        versionCode = rootProject.extra["wonRemoteVersionCode"] as Int
        versionName = rootProject.extra["wonRemoteVersionName"] as String
    }

    signingConfigs {
        if (releaseSigningFile.isFile) {
            create("release") {
                storeFile = file(releaseSigning.getProperty("storeFile"))
                storePassword = releaseSigning.getProperty("storePassword")
                keyAlias = releaseSigning.getProperty("keyAlias")
                keyPassword = releaseSigning.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
