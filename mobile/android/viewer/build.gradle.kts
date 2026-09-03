plugins {
    id("com.android.application")
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

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
