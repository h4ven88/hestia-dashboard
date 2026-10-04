package com.hestari.hestia

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Native HTTP to the household's hub.
 *
 * WHY THIS EXISTS AT ALL, demonstrated rather than argued. The app serves its
 * own pages from https://appassets.androidplatform.net, because a file:// page
 * is not a secure context and the dashboard's entire household-key system runs
 * on crypto.subtle. But an https page cannot fetch an http hub: that is mixed
 * content, and Chromium blocks it. The very first run of this app hit exactly
 * that wall. Routing hub traffic through native removes it, and pinning
 * removes the certificate warning that drives people to plain http in the
 * first place.
 *
 * THE PAGE NEVER NAMES A HOST. [request] takes a PATH. The origin comes from
 * [HubTrust]'s stored configuration, and so does the pin. A method that
 * accepted a URL would hand every script in the WebView a pinned, privileged
 * HTTP client pointed wherever it liked, which is request forgery with extra
 * rights attached. Removing the parameter removes the whole class rather than
 * guarding it.
 *
 * Setting the origin is a separate, deliberate operation ([configure]) that
 * persists and re-pins. That distinction is the point: configuration is a
 * user-visible act, a request is not.
 */
object HubClient {

    class NotConfigured : Exception("no hub has been configured on this device yet")
    class BadPath(path: String) : Exception("hub paths must be absolute and host-relative: $path")

    data class Result(val status: Int, val body: String)

    /**
     * Rejects anything that is not a plain, host-relative path.
     *
     * The `//` case is the one that matters and the one that looks harmless:
     * "//example.com/x" is a protocol-relative URL, so resolving it against
     * the hub origin yields a DIFFERENT HOST. A naive "must start with /"
     * check passes it.
     *
     * Written as explicit checks rather than one regex ON PURPOSE. The regex
     * this replaced needed triple-escaped backslashes to survive Kotlin string
     * processing on the way to the regex engine, it looked correct, and it
     * silently did not exclude backslashes at all -- caught only by firing a
     * backslash path at it through the real bridge and watching the request go
     * through. Each line below can be checked by eye.
     */
    fun isSafePath(path: String): Boolean {
        if (!path.startsWith("/")) return false
        if (path.startsWith("//")) return false            // protocol-relative: different host
        if (path.contains('\\')) return false              // some parsers fold \ into /
        // Control characters can split a request line and smuggle headers.
        if (path.any { it.code < 0x20 || it.code == 0x7f }) return false
        return true
    }

    /**
     * One request to the configured hub.
     *
     * Runs on whatever thread the caller provides; it must never be the main
     * thread, and must never be the `@JavascriptInterface` thread either,
     * since blocking that serialises every other bridge call behind it.
     */
    fun request(ctx: Context, path: String, method: String, body: String?, contentType: String?): Result {
        if (!isSafePath(path)) throw BadPath(path)

        val origin = HubTrust.storedOrigin(ctx) ?: throw NotConfigured()
        val pin = HubTrust.storedPin(ctx)
        val pinned = HubTrust.Pinned(pin)

        val requestBody = body?.toRequestBody((contentType ?: "application/json").toMediaType())
        val req = Request.Builder()
            .url(origin.trimEnd('/') + path)
            .method(method.uppercase(), requestBody)
            .build()

        pinned.client.newCall(req).execute().use { res ->
            /* A hub whose key changed is refused by the trust manager before
               we get here, so reaching this point means the pin held. If we
               connected with no pin stored, record what we saw -- that is the
               trust-on-first-use moment, and it happens exactly once. */
            if (pin == null) {
                pinned.observedPin?.let { HubTrust.remember(ctx, origin, it) }
            }
            return Result(res.code, res.body?.string().orEmpty())
        }
    }

    /**
     * Point this device at a hub and pin whatever key it presents.
     *
     * Deliberate and persisted, unlike [request]. Verifies reachability before
     * storing anything, so a typo does not leave the device configured for a
     * hub that is not there -- the failure mode that would otherwise look
     * identical to the hub being offline.
     */
    fun configure(ctx: Context, origin: String): JSONObject {
        val normalised = origin.trimEnd('/')
        if (!normalised.startsWith("https://") && !normalised.startsWith("http://")) {
            throw IllegalArgumentException("hub origin must start with http:// or https://")
        }

        val pinned = HubTrust.Pinned(null)   // first use: accept and record
        val req = Request.Builder().url("$normalised/hub2/hubData").get().build()

        pinned.client.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                throw Exception("hub answered ${res.code} rather than identifying itself")
            }
            val seen = pinned.observedPin
            // http:// has no key to pin. Allowed, but recorded as unpinned so
            // the UI can say so rather than implying a protection it lacks.
            HubTrust.remember(ctx, normalised, seen.orEmpty())

            val info = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            return JSONObject()
                .put("origin", normalised)
                .put("pinned", seen != null)
                .put("hubId", info.optString("hubId"))
                .put("name", info.optString("name"))
                .put("model", info.optString("model"))
                .put("version", info.optString("version"))
        }
    }
}
