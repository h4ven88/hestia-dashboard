package com.hestari.hestia

import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * The native half of the bridge. See android/BRIDGE.md for the contract.
 *
 * Two platform facts shape this class, both verified against Android's own
 * documentation rather than assumed:
 *
 *  - `@JavascriptInterface` is required from targetSdk 17 and the method must
 *    be public. A method without it is simply invisible to JavaScript, which
 *    fails silently rather than loudly.
 *  - "The object that is bound to your JavaScript runs in another thread and
 *    not in the thread in which it is constructed." So nothing here may touch
 *    the WebView directly; replies marshal back via [dispatch].
 *
 * [call] therefore returns IMMEDIATELY and the work happens on IO. Blocking
 * the JavaScript interface thread would serialise every other bridge call
 * behind the slowest one -- and these calls go to a hub over the network.
 *
 * SECURITY. Everything exposed here is reachable by any script the WebView
 * runs. Android's documentation is explicit: "don't use
 * addJavascriptInterface() unless you wrote all of the HTML and JavaScript
 * that appears in your WebView." That is why build.js bundles ONNX Runtime and
 * the fonts rather than letting the page pull them from a CDN, and why
 * [MainActivity] locks navigation to the asset origin.
 */
class HestiaBridge(
    private val ctx: Context,
    private val webView: WebView,
    private val appVersion: String,
    /* Supplied by the Activity, because only an Activity can ask. Called on the
       main thread; answers true once the permission is held. */
    private val ensureLocalNetwork: ((Boolean) -> Unit) -> Unit = { it(true) },
    private val ensureNotifications: ((Boolean) -> Unit) -> Unit = { it(false) },
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Holds a discovery call until the local network permission is settled.
     *
     * Discovery is the first thing that touches the network and the first thing
     * the user asks for, so this is where the question belongs. Scanning without
     * it would find nothing and report "no hub on this network", which is the
     * same words as a genuinely empty network and sends the user to type in an
     * address that was never the problem.
     */
    /** Below 13 there is no runtime notification permission to hold. */
    private fun notificationsPermitted(): Boolean =
        androidx.core.app.NotificationManagerCompat.from(ctx).areNotificationsEnabled()

    private suspend fun awaitNotificationPermission(): Boolean {
        if (notificationsPermitted()) return true
        if (android.os.Build.VERSION.SDK_INT < 33) return false   // disabled in system settings
        return kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            webView.post {
                ensureNotifications { granted ->
                    if (cont.isActive) cont.resumeWith(Result.success(granted))
                }
            }
        }
    }

    /**
     * The device's FCM registration token.
     *
     * Suspends on the Task rather than blocking: this runs on an IO thread but
     * the token can require a network round trip on first call, and a blocking
     * get would hold that thread behind it.
     */
    private suspend fun fcmToken(): String =
        kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnSuccessListener { t ->
                    HestiaMessaging.storeToken(ctx, t)
                    if (cont.isActive) cont.resumeWith(Result.success(t))
                }
                .addOnFailureListener { e ->
                    if (cont.isActive) cont.resumeWith(Result.failure(e))
                }
        }

    private suspend fun awaitLocalNetwork(): Boolean =
        kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            webView.post {
                ensureLocalNetwork { granted ->
                    if (cont.isActive) cont.resumeWith(Result.success(granted))
                }
            }
        }

    @JavascriptInterface
    fun handshake(): String = JSONObject().apply {
        put("version", CONTRACT_VERSION)
        put("platform", "android")
        put("appVersion", appVersion)
        /* The page branches on these and on nothing else -- never on platform.
           That rule is what keeps one web layer instead of one per target. */
        put("capabilities", JSONArray(listOf("hub", "push", "cloud", "camera")))
    }.toString()

    /**
     * One-way request. Returns immediately: empty means accepted and a reply
     * will follow through the dispatcher, a JSON error means refused outright.
     *
     * A refusal MUST come back synchronously where possible, because the shim
     * turns silence into a Promise that nothing will ever settle. A hang in a
     * settings save or an arm command is worse than an error.
     */
    @JavascriptInterface
    fun call(request: String): String {
        val id: String
        val method: String
        val params: JSONObject
        try {
            val req = JSONObject(request)
            id = req.optString("id")
            method = req.optString("method")
            params = req.optJSONObject("params") ?: JSONObject()
        } catch (e: Exception) {
            return error("malformed bridge request")
        }
        if (id.isEmpty() || method.isEmpty()) return error("bridge request needs an id and a method")

        scope.launch {
            try {
                val result: Any = when (method) {
                    "hub.discover" -> {
                        val allowed = awaitLocalNetwork()
                        JSONObject()
                            .put("hubs", if (allowed) HubDiscovery.toJson(HubDiscovery.scan(ctx)) else JSONArray())
                            /* Reported so the page can say "permission denied"
                               rather than "no hub found". They are different
                               problems with different remedies, and only one of
                               them is fixed by typing an address. */
                            .put("permitted", allowed)
                    }
                    "hub.request" -> hubRequest(params)

                    /* The page's own backend. A PATH only: the origin is
                       fixed in CloudClient, because everything the WebView
                       runs can reach this bridge and a method that fetched
                       any URL handed to it would make the app a proxy onto
                       whatever network it is attached to. */
                    "cloud.request" -> CloudClient.toJson(CloudClient.request(
                        params.optString("path"),
                        params.optString("method").ifEmpty { "GET" },
                        if (params.isNull("body")) null else params.optString("body"),
                        if (params.isNull("contentType")) null else params.optString("contentType"),
                        headerMap(params.optJSONObject("headers")),
                        params.optLong("timeoutMs", 0L),
                    ))
                    /* commit defaults TRUE so an older page that knows nothing
                       about the flag still pins, as it always did. */
                    /* Returns the FCM token and whether notifications are
                       permitted, so the page can register this device exactly
                       as it registers a Web Push subscription. The permission
                       is requested HERE, because the page only calls this when
                       the user turns push on. */
                    "push.register" -> {
                        val allowed = awaitNotificationPermission()
                        val token = if (allowed) runCatching { fcmToken() }.getOrNull() else null
                        JSONObject()
                            .put("permitted", allowed)
                            .put("token", token ?: JSONObject.NULL)
                            /* The page needs to tell the backend which
                               transport this is. Without it an FCM token would
                               be stored where a Web Push subscription is
                               expected and fail at send time, which is the
                               worst place to find out. */
                            .put("kind", "fcm")
                    }
                    "push.state" -> JSONObject()
                        .put("permitted", notificationsPermitted())
                        .put("token", HestiaMessaging.storedToken(ctx) ?: JSONObject.NULL)
                        .put("kind", "fcm")

                    /* The camera origins this device may fetch over cleartext.
                       Replaces the whole set each time, so removing a camera in
                       Settings withdraws it rather than leaving it served. */
                    "camera.allow" -> {
                        val arr = params.optJSONArray("pairs") ?: JSONArray()
                        val out = ArrayList<Pair<String, String>>(arr.length())
                        for (i in 0 until arr.length()) {
                            val o = arr.optJSONObject(i) ?: continue
                            out.add(o.optString("from") to o.optString("to"))
                        }
                        CameraProxy.setAllowed(out)
                        JSONObject().put("count", out.size)
                    }
                    /* The Settings "Test connection" probe. It must go through
                       the same path the render will, or it reports failure for
                       a camera that works -- which is what it did before this
                       existed, in the app, for every cleartext camera. */
                    "camera.test" -> JSONObject(CameraProxy.test(params.optString("url")))

                    "hub.configure" -> HubClient.configure(
                        ctx, params.optString("origin"),
                        if (params.has("commit")) params.optBoolean("commit") else true,
                    )
                    "hub.info" -> hubInfo()
                    else -> {
                        settle(id, null, "no such capability: $method")
                        return@launch
                    }
                }
                settle(id, result)
            } catch (e: HubTrust.PinMismatch) {
                /* Given its own reason string because it is not an ordinary
                   failure: either the hub's certificate was regenerated, or
                   something on the network is impersonating it. The page must
                   be able to tell those apart from "the hub is offline". */
                settle(id, null, "pin-mismatch: ${e.message}")
            } catch (e: HubClient.NotConfigured) {
                settle(id, null, "not-configured: ${e.message}")
            } catch (e: Exception) {
                settle(id, null, e.message ?: e.javaClass.simpleName)
            }
        }
        return ""
    }

    /** JSON object to a header map. Absent or malformed means no headers. */
    private fun headerMap(o: JSONObject?): Map<String, String> {
        if (o == null) return emptyMap()
        val out = LinkedHashMap<String, String>(o.length())
        for (name in o.keys()) {
            if (o.isNull(name)) continue
            out[name] = o.optString(name)
        }
        return out
    }

    private fun hubRequest(p: JSONObject): JSONObject {
        val res = HubClient.request(
            ctx,
            path = p.optString("path"),
            method = p.optString("method").ifEmpty { "GET" },
            body = if (p.isNull("body")) null else p.optString("body"),
            contentType = if (p.isNull("contentType")) null else p.optString("contentType"),
        )
        return JSONObject().put("status", res.status).put("body", res.body)
    }

    private fun hubInfo(): JSONObject = JSONObject()
        .put("origin", HubTrust.storedOrigin(ctx) ?: JSONObject.NULL)
        .put("pinned", !HubTrust.storedPin(ctx).isNullOrEmpty())

    private fun error(message: String): String =
        JSONObject().put("error", message).toString()

    /** Settles a pending call. */
    fun settle(id: String, result: Any?, errorMessage: String? = null) {
        val payload = JSONObject().put("id", id)
        if (errorMessage != null) payload.put("error", errorMessage)
        else payload.put("result", result ?: JSONObject.NULL)
        dispatch("window.__hestiaNativeSettle", payload)
    }

    /** The single native-to-page event channel. */
    fun emit(event: String, data: Any?) {
        dispatch("window.__hestiaNativeEmit", JSONObject().put("event", event).put("data", data))
    }

    private fun dispatch(entryPoint: String, payload: JSONObject) {
        // Reaching into the page to call its own functions would couple this
        // class to dashboard.html's private names and break on any refactor of
        // a file nobody diffs against Kotlin. One entry point, always.
        val js = "$entryPoint && $entryPoint(${JSONObject.quote(payload.toString())});"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    companion object {
        /** Bumped only when the contract itself changes shape. */
        const val CONTRACT_VERSION = 1

        /** The name the shim looks for. Must match hestia-bridge.js. */
        const val JS_NAME = "__hestiaNativeRaw"
    }
}
