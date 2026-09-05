plugins {
    id("com.android.application") version "8.7.3" apply false
    id("com.android.library") version "8.7.3" apply false
    id("com.google.gms.google-services") version "4.5.0" apply false
}

val desktopPackage = groovy.json.JsonSlurper().parse(file("../../aether-link-app/package.json")) as Map<*, *>
val wonRemoteVersionName = desktopPackage["version"] as String
val wonRemoteVersionParts = wonRemoteVersionName.split(".").map(String::toInt)
require(wonRemoteVersionParts.size == 3 && wonRemoteVersionParts.all { it in 0..999 }) {
    "WonRemote version must use numeric major.minor.patch components below 1000."
}
val wonRemoteVersionCode = wonRemoteVersionParts[0] * 1_000_000 +
    wonRemoteVersionParts[1] * 1_000 + wonRemoteVersionParts[2]
require(wonRemoteVersionCode > 0) { "WonRemote Android versionCode must be positive." }
extra["wonRemoteVersionName"] = wonRemoteVersionName
extra["wonRemoteVersionCode"] = wonRemoteVersionCode
