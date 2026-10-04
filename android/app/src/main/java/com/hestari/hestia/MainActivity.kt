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
        /** Reserved by Google for exactly this; it resolves to nothing public. */
        private const val ASSET_DOMAIN = "appassets.androidplatform.net"
        private const val START_URL = "https://$ASSET_DOMAIN/assets/index.html"
    }
}
