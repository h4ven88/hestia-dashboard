import java.io.FileInputStream
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.google.services)
}

/* ── Release signing ──────────────────────────────────────────────────────
 * Read from keystore.properties at the repo root, which is GITIGNORED along
 * with the keystore itself. Neither is ever committed: this repository is
 * public, and a signing key in it means anyone can publish an update that
 * Android accepts as genuinely Hestia.
 *
 * Absent, the release build simply stays unsigned rather than failing. A
 * contributor, a fresh clone and CI can all still build and run the app; only
 * producing a distributable artifact needs the key. Failing the whole build on
 * a missing file nobody but the maintainer can supply would be hostile.
 *
 * To set up (the key is yours to generate and hold -- do not let anyone else
 * create it for you):
 *   keytool -genkeypair -v -keystore hestia-release.jks -keyalg RSA \
 *           -keysize 4096 -validity 10000 -alias hestia
 * then write keystore.properties beside it:
 *   storeFile=hestia-release.jks
 *   storePassword=...
 *   keyAlias=hestia
 *   keyPassword=...
 *
 * ⛔ Back the keystore up somewhere you will still have in five years. Play
 * ties the app identity to it; losing it means never updating this listing
 * again, under any circumstances. */
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) FileInputStream(keystorePropsFile).use { load(it) }
}

android {
    namespace = "com.hestari.hestia"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.hestari.hestia"
        minSdk = 26
        targetSdk = 37

        /* Kept in step with HESTIA_VERSION by build.js, which refuses to build
           when the dashboard, the manifest, the Groovy app, the Groovy header
           and this disagree. The comment here used to CLAIM that check existed
           while build.js checked only the other four -- and this string had
           already drifted to 2.2.0 against a 2.2.1 release. It is checked now.

           It matters more than it looks: versionName is what Android shows in
           app info and what a crash report is filed against, so a stale one
           points a bug report at the wrong build. */
        versionName = "2.2.3"

        /* DERIVED, never hand-maintained. Play refuses an upload whose
           versionCode is not strictly greater than the last, and a number
           edited by hand beside one that is edited by a different habit is the
           same drift this file just demonstrated. major*10000 + minor*100 +
           patch keeps it monotonic for any version ordering we can express,
           and leaves room for 100 patches per minor. */
        versionCode = versionName!!.split(".").let { p ->
            require(p.size == 3) { "versionName must be major.minor.patch, got: $versionName" }
            p[0].toInt() * 10000 + p[1].toInt() * 100 + p[2].toInt()
        }
    }

    signingConfigs {
        /* Created only when the maintainer's keystore.properties is present --
           see the note at the top of this file. */
        if (keystorePropsFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    /* Opt-in since AGP 8. MainActivity reads BuildConfig.VERSION_NAME to hand
       the app's version across the bridge, so the handshake can report it and
       a version mismatch is diagnosable rather than invisible. */
    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            /* Null when no keystore.properties is present, which Gradle treats
               as "leave it unsigned" rather than as an error -- see the top of
               this file for why that is the right failure mode here. */
            signingConfig = signingConfigs.findByName("release")

            /* Deliberately off, and not an oversight to tidy up later. R8 would
               rewrite the names @JavascriptInterface exposes to the page, and
               the whole native/web contract is name-based: a renamed method is
               invisible to JavaScript and fails SILENTLY, which is the one
               failure mode this bridge was designed to avoid. Turning it on
               needs keep rules for the bridge, the FCM service and anything
               Firebase reaches reflectively, each verified on a device. That is
               its own piece of work, not a flag flip. */
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    /* android.util.Log is a framework stub on the JVM and THROWS by default,
       so a unit test of logic that merely logs fails for the logging. Default
       values turn those into no-ops. It does not make framework classes work --
       anything security-critical here parses with java.net.URI precisely so it
       does not depend on them. */
    testOptions {
        unitTests.isReturnDefaultValues = true
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
    implementation(libs.okhttp)
    implementation(libs.coroutines.android)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    testImplementation(libs.junit)
}
