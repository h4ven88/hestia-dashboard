package com.hestari.hestia

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import okhttp3.Request

/**
 * Serves hub images that the WebView itself cannot fetch.
 *
 * ── WHAT THIS DOES AND DOES NOT SOLVE ──
 *
 * It does NOT rescue an `http://` image. That was the original intent and it
 * is impossible: Blink decides mixed content in the RENDERER, before any
 * loader exists, while this hook lives in the browser process downstream of
 * it. A blocked request never reaches here. Confirmed twice over -- on a
 * Galaxy A16, where zero interception ran and every snapshot logged "This
 * request has been blocked", and against Chromium's own sources.
 *
 * Changing WebSettings.setMixedContentMode would not help either, and
 * COMPATIBILITY_MODE least of all: Blink blocks IP-LITERAL hosts even with
 * strict mode off, and excludes them from autoupgrade on the stated grounds
 * that a certificate for an IP address may not make sense. A Hubitat hub is
 * reached by IP. So the manifest keeps usesCleartextTraffic=false and the
 * WebView stays on MIXED_CONTENT_NEVER_ALLOW.
 *
 * What makes camera snapshots work is camDeviceUrl() in the web layer, which
 * rewrites hub urls to https BEFORE an <img> is created. THIS file's job is
 * the half that rewrite cannot do: serving that https request over a pinned
 * connection, because the hub's certificate is self-signed with no SAN and a
 * WebView offers no way to accept it the way a browser tab does.
 *
 * Between them they replace a capability the app removes: "accept the
 * certificate once on this device", which every camera household relies on.
 *
 * Scope is the PINNED host only. A camera on its own address is not covered;
 * widening to configured camera hosts means trusting hosts we hold no pin
 * for, which is a decision rather than an extension.
 */
object HubProxy {

    private const val TAG = "HestiaProxy"

    /**
     * Answers a WebView resource request, or null to let it proceed normally.
     *
     * Called on a background thread. Chromium marks this path MayBlock() and
     * expands its pool for it precisely because embedders do synchronous work
     * here, so a blocking fetch is correct and not an ANR risk.
     */
    fun serve(ctx: Context, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (!request.method.equals("GET", ignoreCase = true)) return null

        /* DECIDED FROM THE REQUEST, NOT THE RESPONSE, and that ordering is the
           point. An earlier version fetched first and filtered on the reply's
           content type, which meant any non-image request reaching here was
           EXECUTED before being declined. Hubitat's device commands are GETs
           (/devices/<id>/on), so that shape could run an action on the hub and
           then tell the page it failed. Nothing routes device commands here
           today, but a gate that only works because of what the callers
           happen to do is not a gate. */
        if (!couldBeImageRequest(request)) {
            android.util.Log.w(TAG, "declined a non-image request for ${url.path}")
            return null
        }

        val pinnedOrigin = HubTrust.storedOrigin(ctx) ?: return null
        val pinnedUri = runCatching { Uri.parse(pinnedOrigin) }.getOrNull() ?: return null
        if (!pinnedUri.host.equals(url.host, ignoreCase = true)) return null
        /* Port is compared, not ignored. Without this a request to
           http://<hub>:8080/x would be answered from https://<hub>:443/x,
           which is a different service wearing the same host. */
        if (!portsMatch(url, pinnedUri)) return null

        val path = url.encodedPath.orEmpty() + (url.encodedQuery?.let { "?$it" } ?: "")
        if (!HubClient.isSafePath(path)) {
            android.util.Log.w(TAG, "refused an unsafe path: $path")
            return null
        }

        var res: okhttp3.Response? = null
        return try {
            res = HubTrust.pinnedClient(ctx)
                .newCall(Request.Builder().url(pinnedOrigin.trimEnd('/') + path).get().build())
                .execute()
            val body = res.body ?: run { res.close(); return null }

            val mime = body.contentType()?.let { "${it.type}/${it.subtype}" } ?: ""
            /* Second line of defence, after the request-shape gate above. A
               hub answering a snapshot url with its login page returns
               text/html, and handing that to an <img> renders nothing while
               looking like success -- the camera module's own "Not an image"
               diagnostic exists for that and should keep firing. */
            if (!mime.startsWith("image/")) {
                android.util.Log.w(TAG, "not serving $mime for $path")
                res.close()
                return null
            }

            /* VALIDATED BEFORE CONSTRUCTING, because the constructor throws --
               on a 3xx, on a blank or non-ASCII reason phrase, on a status
               outside 100..599 -- and a throw after byteStream() was opened
               leaks the connection and blanks the camera with only a log
               line. OkHttp follows redirects, so a 3xx only survives when it
               carries no Location, but "only when" is not "never". */
            val code = res.code
            if (code < 100 || code > 599 || (code in 300..399)) {
                android.util.Log.w(TAG, "unusable status $code for $path")
                res.close()
                return null
            }
            val reason = res.message.trim()
                .filter { it.code in 0x20..0x7e }
                .ifEmpty { "OK" }

            /* Encoding is null for images, per the platform's own guidance:
               content with no defined character encoding passes null, and the
               value must never be a combined Content-Type. A hub that sent
               "image/jpeg; charset=UTF-8" would otherwise have us declare a
               charset on binary data. */
            WebResourceResponse(
                mime, null, code, reason,
                mapOf("Cache-Control" to "no-store"),
                body.byteStream()   // closed by the WebView, which is why res is not
            )
        } catch (e: Exception) {
            runCatching { res?.close() }
            /* WARN, not DEBUG. Debug is stripped at the default level, so
               "cameras are blank in the app" would arrive with no record of
               why -- the silent-failure shape this project keeps paying for. */
            if (pinMismatchIn(e)) {
                android.util.Log.w(TAG, "pin mismatch serving $path: the hub's certificate changed, " +
                    "or something on this network is answering for it")
            } else {
                android.util.Log.w(TAG, "could not serve $path: ${e.javaClass.simpleName}: ${e.message}")
            }
            null
        }
    }

    /**
     * Could this be an <img> load rather than something else aimed at the hub?
     *
     * A MISSING Accept header means "unknown", not "no". An earlier version
     * required the header to contain image/, and that broke the very thing it
     * was protecting: two of three cameras went offline within one refresh
     * cycle, the WebView attempted the handshake itself and logged
     * ERR_CERT_AUTHORITY_INVALID, and this file logged nothing at all because
     * it returned null before the fetch.
     *
     * getRequestHeaders() does not promise the full set the network stack will
     * send, so keying a decision on a header's presence is keying it on
     * something that is allowed to be absent. The header is still honoured
     * when it IS present and says something other than an image, which is what
     * keeps a JSON fetch from being executed here; the response's own content
     * type remains the real filter.
     */
    private fun couldBeImageRequest(request: WebResourceRequest): Boolean {
        // A navigation must never be answered from here.
        if (request.isForMainFrame) return false
        val accept = request.requestHeaders?.entries
            ?.firstOrNull { it.key.equals("Accept", ignoreCase = true) }?.value
        if (accept.isNullOrBlank()) return true          // unknown, let the mime check decide
        if (accept.contains("image/", ignoreCase = true)) return true
        // Browsers send */* for several subresource kinds; it excludes nothing.
        return accept.trim() == "*/*"
    }

    private fun portsMatch(a: Uri, b: Uri): Boolean {
        fun effective(u: Uri): Int =
            if (u.port != -1) u.port else if (u.scheme.equals("https", true)) 443 else 80
        /* The page's url may be http on 80 while the pin is https on 443, and
           that is the case this whole file exists for. Only an EXPLICIT port
           that disagrees is rejected. */
        if (a.port == -1 || b.port == -1) return true
        return effective(a) == effective(b)
    }

    /**
     * A pin mismatch surfaces wrapped.
     *
     * HubTrust throws PinMismatch from inside checkServerTrusted, whose
     * interface declares CertificateException, so JSSE wraps it during the
     * handshake and OkHttp surfaces an SSLHandshakeException with the real
     * cause buried. Catching PinMismatch directly, as an earlier version did,
     * would never have matched. Walk the chain instead.
     */
    private fun pinMismatchIn(e: Throwable?): Boolean {
        var t: Throwable? = e
        var guard = 0
        while (t != null && guard++ < 12) {
            if (t is HubTrust.PinMismatch) return true
            if (t.cause === t) break
            t = t.cause
        }
        return false
    }
}
