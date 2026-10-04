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
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @JavascriptInterface
    fun handshake(): String = JSONObject().apply {
        put("version", CONTRACT_VERSION)
        put("platform", "android")
        put("appVersion", appVersion)
        /* The page branches on these and on nothing else -- never on platform.
           That rule is what keeps one web layer instead of one per target. */
        put("capabilities", JSONArray(listOf("hub")))
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
                    "hub.request" -> hubRequest(params)
                    "hub.configure" -> HubClient.configure(ctx, params.optString("origin"))
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
