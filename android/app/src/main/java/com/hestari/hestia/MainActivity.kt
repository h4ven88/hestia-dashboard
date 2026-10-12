package com.hestari.hestia

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Phase 1: load the bundled dashboard, install the bridge, expose nothing.
 *
 * WHY NOT file:// -- THE SINGLE MOST IMPORTANT DECISION IN THIS CLASS.
 * The obvious way to show bundled HTML is `loadUrl("file:///android_asset/...")`
 * and it would quietly break the product. A file:// page is NOT a secure
 * context, and the dashboard's entire household-key system runs on
 * crypto.subtle, which does not exist outside one. getUserMedia, needed for
 * the wake word, is also gated on it. So assets are served over
 * https://appassets.androidplatform.net/ by [WebViewAssetLoader], which gives
 * a real secure origin backed by local files and never touches the network.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var bridge: HestiaBridge

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(ASSET_DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        /* Debug builds only. Without it there is no way to see what the page is
           doing from outside, and this project debugs real households from
           console output. Release builds must not ship it: it would let anyone
           with adb attach a debugger to a WebView holding the household's
           credentials. */
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true          // the dashboard is localStorage-heavy
            settings.mediaPlaybackRequiresUserGesture = false   // TTS and the wake chime
            settings.allowFileAccess = false           // nothing is loaded by file:// path
            settings.allowContentAccess = false

            /* Forwards the page's console to logcat. The dashboard logs its
               boot sequence, the wake word pipeline and every sync decision
               there, and without this none of it is visible from outside the
               WebView -- which would make every future phase a guessing game. */
            webChromeClient = object : android.webkit.WebChromeClient() {
                override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                    android.util.Log.i("HestiaWeb", "${m.message()}  (${m.sourceId()}:${m.lineNumber()})")
                    return true
                }
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView, request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                /**
                 * Navigation is locked to the asset origin. Android's own
                 * guidance for addJavascriptInterface is "don't let the user
                 * navigate within your WebView to web pages that aren't your
                 * own" -- anywhere else would be running somebody else's
                 * JavaScript next to the bridge.
                 */
                override fun shouldOverrideUrlLoading(
                    view: WebView, request: WebResourceRequest
                ): Boolean {
                    val url = request.url
                    if (url.host == ASSET_DOMAIN) return false      // ours, let it load
                    // Everything else opens in the real browser, where it
                    // cannot see the bridge.
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                    return true
                }
            }
        }

        ensureLocalNetworkPermission()

        bridge = HestiaBridge(applicationContext, webView, BuildConfig.VERSION_NAME)
        webView.addJavascriptInterface(bridge, HestiaBridge.JS_NAME)
        installBridgeShim()

        setContentView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (savedInstanceState == null) webView.loadUrl(START_URL)
    }

    /**
     * Without this the app cannot reach the hub AT ALL.
     *
     * Not a nicety, and not only about discovery. Proven on a Galaxy A16 by
     * opting in to the Android 17 behaviour early:
     *
     *   adb shell am compat enable RESTRICT_LOCAL_NETWORK com.hestari.hestia
     *
     * Before opting in, hub access worked and no permission was needed. After,
     * every path failed identically: the subnet sweep found nothing, a bare
     * TCP connect to the hub timed out, and an OkHttp request that had
     * succeeded minutes earlier returned "failed to connect ... after 5000ms".
     * Declaring the permission in the manifest changed none of it, because it
     * is a RUNTIME permission and declaring is not granting.
     *
     * That gap is the trap worth naming: on every device we own today this
     * code is unnecessary, and on every device once they reach Android 17 the
     * app is dead without it. The failure has no distinctive signature either
     * -- it looks exactly like a hub that is switched off.
     *
     * Android 16 names the permission NEARBY_WIFI_DEVICES; Android 17 renames
     * it ACCESS_LOCAL_NETWORK. Both are requested by string rather than by
     * constant, so this compiles against either SDK.
     *
     * Requested here at startup for now. It wants a priming screen that earns
     * the yes before the system dialog appears, which is first-run design work
     * rather than plumbing, and a denial is sticky.
     */
    private fun ensureLocalNetworkPermission() {
        val permission =
            if (android.os.Build.VERSION.SDK_INT >= 37) "android.permission.ACCESS_LOCAL_NETWORK"
            else "android.permission.NEARBY_WIFI_DEVICES"

        val granted = androidx.core.content.ContextCompat.checkSelfPermission(this, permission) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        android.util.Log.i("Hestia", "local network permission ($permission): " +
            if (granted) "granted" else "NOT granted, requesting")
        if (!granted) {
            androidx.core.app.ActivityCompat.requestPermissions(this, arrayOf(permission), REQ_LOCAL_NETWORK)
        }
    }

    /**
     * The shim has to run BEFORE the page's own scripts, or the dashboard
     * would read window.hestiaNative while it does not yet exist and conclude
     * it is in a browser. onPageStarted is too late and not guaranteed to
     * precede script execution; addDocumentStartJavaScript is the API built
     * for exactly this.
     *
     * If the WebView is too old to support it, the shim is simply not
     * installed and the dashboard behaves as the browser build -- which is a
     * supported state by design, not a failure. Better a browser-equivalent
     * app than one with a bridge that half exists.
     */
    private fun installBridgeShim() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val shim = runCatching {
            assets.open("hestia-bridge.js").bufferedReader().use { it.readText() }
        }.getOrNull() ?: return
        WebViewCompat.addDocumentStartJavaScript(webView, shim, setOf("https://$ASSET_DOMAIN"))
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        webView.restoreState(savedInstanceState)
    }

    companion object {
        private const val REQ_LOCAL_NETWORK = 1001

        /** Reserved by Google for exactly this; it resolves to nothing public. */
        private const val ASSET_DOMAIN = "appassets.androidplatform.net"
        private const val START_URL = "https://$ASSET_DOMAIN/assets/index.html"
    }
}
