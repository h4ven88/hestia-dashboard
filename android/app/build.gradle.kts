plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.hestari.hestia"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.hestari.hestia"
        minSdk = 26
        targetSdk = 37
        versionCode = 1

        /* Kept in step with HESTIA_VERSION by build.js, which already refuses
           to build when the dashboard, the manifest, the Groovy app and the
           Groovy header disagree. A fifth place to drift is exactly how v1.6.5
           shipped a manifest that told every user they were up to date. */
        versionName = "2.2.0"
    }

    /* Opt-in since AGP 8. MainActivity reads BuildConfig.VERSION_NAME to hand
       the app's version across the bridge, so the handshake can report it and
       a version mismatch is diagnosable rather than invisible. */
    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    /* The web assets are produced by `node build.js` into src/main/assets and
       are gitignored, because they are build OUTPUT: the dashboard, ONNX
       Runtime, the wake word models and the fonts. One source, one build.
       A clean checkout therefore cannot build the app until build.js has run,
       which is called out in the README rather than left to be discovered. */
    androidResources {
        // The models and WASM are already compressed formats; squeezing them
        // again costs build time and install time for nothing.
        noCompress += listOf("onnx", "wasm", "woff2")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.webkit)
}
