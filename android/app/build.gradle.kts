plugins {
    id("com.android.application")
}

android {
    namespace = "com.musichelper.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.musichelper.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation(files("libs/musichelper.aar"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("com.squareup.okhttp3:okhttp:5.4.0")
}
