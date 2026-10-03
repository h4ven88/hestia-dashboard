package com.hestari.hestia

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/**
 * The native half of the bridge. See android/BRIDGE.md for the contract.
 *
 * PHASE 1 IMPLEMENTS NOTHING. `capabilities` is empty and [call] refuses every
 * method. That is the deliverable: the contract exists and the web layer
 * behaves exactly as it does in a browser. Capabilities arrive in their own
 * phases, each behind its own capability string.
 *
 * Two platform facts shape this class, both verified against Android's own
 * documentation rather than assumed:
 *
 *  - `@JavascriptInterface` is required from targetSdk 17 and the method must
 *    be public. A method without it is simply invisible to JavaScript, which
 *    fails silently rather than loudly.
 *  - "The object that is bound to your JavaScript runs in another thread and
 *    not in the thread in which it is constructed." So nothing here may touch
 *    the WebView directly; replies marshal back to the UI thread via [post].
 *
 * SECURITY. Everything exposed here is reachable by any script the WebView
 * runs. Android's documentation is explicit: "don't use
 * addJavascriptInterface() unless you wrote all of the HTML and JavaScript
 * that appears in your WebView." That is why build.js bundles ONNX Runtime and
 * the fonts instead of letting the page pull them from a CDN, and why
 * [MainActivity] locks navigation to the asset origin.
 */
class HestiaBridge(
    private val webView: WebView,
    private val appVersion: String,
) {

    /**
     * Static facts, fetched once by the shim. Synchronous on purpose: a
     * `@JavascriptInterface` method may return a String, and the shim needs
     * these before the page's own scripts run.
     */
    @JavascriptInterface
    fun handshake(): String = JSONObject().apply {
        put("version", CONTRACT_VERSION)
        put("platform", "android")
        put("appVersion", appVersion)
        // Phase 1: empty, and the page must behave exactly as the browser
        // build does. This is the state the gate tests hardest, because it is
        // the one that ships and therefore the one that can regress.
        put("capabilities", JSONArray())
    }.toString()

    /**
     * One-way request. Returns immediately, either empty (accepted, a reply
     * will follow through the dispatcher) or a JSON error (refused outright).
     *
     * A refusal MUST come back, because the shim turns silence into a Promise
     * that nothing will ever settle. A hang in a settings save or an arm
     * command is a worse failure than an error.
     */
    @JavascriptInterface
    fun call(request: String): String {
        val id: String
        val method: String
        try {
            val req = JSONObject(request)
            id = req.optString("id")
            method = req.optString("method")
        } catch (e: Exception) {
            return error("malformed bridge request")
        }
        if (id.isEmpty() || method.isEmpty()) return error("bridge request needs an id and a method")

        // Phase 1 implements no capabilities, so every method is unknown. The
        // page should never reach here: it is required to check
        // hestiaNative.capabilities first, and this refusal is what makes a
        // violation of that loud instead of silent.
        return error("no such capability: $method")
    }

    private fun error(message: String): String =
        JSONObject().put("error", message).toString()

    /** Settles a pending call. UI thread, because it touches the WebView. */
    fun settle(id: String, result: Any?, errorMessage: String? = null) {
        val payload = JSONObject().put("id", id)
        if (errorMessage != null) payload.put("error", errorMessage) else payload.put("result", result)
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
