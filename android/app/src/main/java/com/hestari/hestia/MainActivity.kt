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

                /**
                 * WITHOUT THIS, ATHENA CANNOT WORK IN THE APP AT ALL.
                 *
                 * A WebView denies every getUserMedia request when this is not
                 * overridden. It does not ask Android, it does not ask the
                 * user, it just denies -- so the page's own error path runs and
                 * reports a microphone problem the user cannot fix anywhere,
                 * because no permission was ever requested. Reported from the
                 * phone as "[Athena] Mic permission denied: Permission denied"
                 * the instant Athena was tapped.
                 *
                 * Two gates, and both matter. The origin must be the bundled
                 * page: this is the one place a WebView can hand the microphone
                 * to whatever is loaded, so it is checked rather than assumed
                 * even though navigation is already locked to that origin.
                 * And only audio is ever granted, never video, however much
                 * the request asks for -- the product has no use for a camera
                 * and least privilege costs nothing to keep.
                 *
                 * Android's own permission is requested HERE rather than at
                 * startup, so the dialog arrives because the user tapped
                 * Athena. Same rule as the local network one.
                 */
                override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                    val audio = android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE
                    if (request.origin?.host != ASSET_DOMAIN ||
                        !request.resources.contains(audio)) {
                        android.util.Log.w("Hestia", "refused a media request from ${request.origin}")
                        request.deny()
                        return
                    }
                    ensurePermission(android.Manifest.permission.RECORD_AUDIO, REQ_MIC) { granted ->
                        if (granted) request.grant(arrayOf(audio)) else request.deny()
                    }
                }

                /* The page asked and then went away (Athena closed, a reload).
                   Nothing to clean up, but leaving the default would let a
                   stale prompt sit over a screen that no longer wants it. */
                override fun onPermissionRequestCanceled(request: android.webkit.PermissionRequest) {
                    android.util.Log.i("Hestia", "media request cancelled by the page")
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

        bridge = HestiaBridge(applicationContext, webView, BuildConfig.VERSION_NAME,
            ::ensureLocalNetworkPermission)
        webView.addJavascriptInterface(bridge, HestiaBridge.JS_NAME)
        installBridgeShim()

        setContentView(fitToSystemBars(webView))

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (savedInstanceState == null) webView.loadUrl(START_URL)
    }

    /**
     * Keeps the page out from under the status and navigation bars.
     *
     * REPORTED FROM A REAL DEVICE, not anticipated: the dashboard's top ribbon
     * sat beneath the system clock and the edges of the page were cut off, with
     * no way to zoom out of it.
     *
     * The cause is edge-to-edge, which is MANDATORY at the SDK this app
     * targets. From Android 15 an app is laid out edge to edge whether it asks
     * or not, so the WebView filled the whole window including the bar areas.
     *
     * The trap is that themes.xml looks like it already handles this: it sets
     * android:statusBarColor and android:navigationBarColor to the page's own
     * background. Both attributes are DEPRECATED AND IGNORED at this SDK, so
     * they read as a fix while doing nothing at all -- and they were written
     * before any device had run the app.
     *
     * So the insets are applied as padding on a container rather than on the
     * WebView itself. Padding the WebView would reveal the WebView's own
     * background in the bar areas, which is white by default and would frame a
     * dark page in two white strips. The container carries the page's
     * background colour instead.
     *
     * displayCutout is included with systemBars because a punch-hole or notch
     * in landscape is a cut-off edge for exactly the same reason, and a wall
     * tablet is the device most likely to be mounted that way.
     *
     * The keyboard is folded into the bottom inset because first-run asks for
     * an address and two API keys. Without it the keyboard covers the field
     * being typed into, which is the sort of defect that only shows up on a
     * phone and never in a desktop browser.
     *
     * KNOWN LIMIT: the bar area takes the page's DEFAULT (dark) background, not
     * the live theme. A household on the Light or Cream theme gets two dark
     * strips. Fixing that properly means the page telling the native layer
     * which theme is active, which is a web-layer change and belongs with the
     * rest of the theme work rather than smuggled into a layout fix.
     */
    private fun fitToSystemBars(content: WebView): android.view.View {
        val root = android.widget.FrameLayout(this).apply {
            setBackgroundColor(androidx.core.content.ContextCompat.getColor(context, R.color.hestia_bg))
            addView(content)
        }
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars() or
                androidx.core.view.WindowInsetsCompat.Type.displayCutout()
            )
            val ime = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            androidx.core.view.WindowInsetsCompat.CONSUMED
        }
        /* Dark bars need light icons. The default is dark-on-light, which on
           this background renders the clock and battery nearly invisible. */
        androidx.core.view.WindowCompat.getInsetsController(window, root)
            .isAppearanceLightStatusBars = false
        return root
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
     * ASKED WHEN THE PAGE ASKS, NOT AT STARTUP. It used to fire from onCreate,
     * and a screenshot of the first run showed why that is wrong: Android's
     * dialog -- "allow Hestia to find, connect to, and determine the relative
     * position of nearby devices" -- appeared over the welcome screen, covering
     * the button, before the user had read a word about what the app does.
     *
     * A denial is sticky, so that question gets one good asking. It is now
     * requested by the first hub.discover call, which happens the instant the
     * user taps "Get started" underneath a screen that has just said Hestia is
     * about to look for their hub on this network. Same dialog, asked after the
     * reason instead of before it.
     */
    private fun ensureLocalNetworkPermission(onResult: (Boolean) -> Unit) =
        ensurePermission(
            if (android.os.Build.VERSION.SDK_INT >= 37) "android.permission.ACCESS_LOCAL_NETWORK"
            else "android.permission.NEARBY_WIFI_DEVICES",
            REQ_LOCAL_NETWORK, onResult)

    /**
     * Asks for one runtime permission and answers when the user has decided.
     *
     * Keyed by request code rather than a single slot: the mic and the local
     * network are asked for at different moments by different parts of the app,
     * and a single slot would let one overwrite the other's callback, leaving
     * whoever was waiting on it waiting forever. Each code is answered once and
     * then cleared.
     */
    private fun ensurePermission(permission: String, code: Int, onResult: (Boolean) -> Unit) {
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(this, permission) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        android.util.Log.i("Hestia", "permission $permission: " +
            if (granted) "granted" else "NOT granted, requesting")
        if (granted) { onResult(true); return }

        /* One outstanding request per code. A second would orphan the first
           callback, and the caller waiting on it would never be answered. */
        if (permissionWaiters.containsKey(code)) { onResult(false); return }
        permissionWaiters[code] = onResult
        androidx.core.app.ActivityCompat.requestPermissions(this, arrayOf(permission), code)
    }

    private val permissionWaiters = mutableMapOf<Int, (Boolean) -> Unit>()

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val waiter = permissionWaiters.remove(requestCode) ?: return
        /* An empty grantResults means the request was cancelled, which is a
           denial for our purposes: the capability still is not available. */
        waiter(grantResults.isNotEmpty() &&
            grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED)
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
        private const val REQ_MIC = 1002

        /** Reserved by Google for exactly this; it resolves to nothing public. */
        private const val ASSET_DOMAIN = "appassets.androidplatform.net"
        private const val START_URL = "https://$ASSET_DOMAIN/assets/index.html"
    }
}
