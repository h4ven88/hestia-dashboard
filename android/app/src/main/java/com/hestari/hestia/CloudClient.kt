package com.hestari.hestia

import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.time.Duration

/**
 * Relays the page's calls to Hestia's own backend.
 *
 * WHY THIS EXISTS. The page is served from
 * https://appassets.androidplatform.net, so its `/api/...` paths resolve to
 * the asset origin and reach nothing. Making them absolute to hestari.com
 * instead just trades one failure for another: that is a cross-origin request,
 * the Workers send no CORS headers, and the preflight would fail.
 *
 * Adding CORS to the backend would work and was rejected. It is a change to
 * the one channel with no staged rollout, reaching every household the instant
 * it deploys, to serve an app nobody runs yet. Relaying here costs those
 * households nothing and is CORS-free by construction, because the request is
 * made by the app rather than by the page.
 *
 * ⛔ ONE ORIGIN, AND IT IS HARDCODED. The page supplies a path, never a host.
 * Everything the WebView runs can reach this bridge, so a method that fetched
 * whatever URL it was handed would make the app a general-purpose proxy on
 * whatever network it is attached to -- including the private one, which is
 * the whole point of the local network permission it holds.
 */
object CloudClient {

    const val ORIGIN = "https://hestari.com"

    class BadPath(path: String) : Exception("cloud paths must be absolute and host-relative: $path")

    data class Result(val status: Int, val body: String)

    /* Shared, for the same reason the pinned hub client is: a client per
       request means a new pool, dispatcher and TLS handshake every time. */
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(8))
            .readTimeout(Duration.ofSeconds(15))
            /* Or "ONE ORIGIN, AND IT IS HARDCODED" holds for the first hop
               only. OkHttp strips Authorization across hosts but NOT the
               X-Hestia-* credentials, so a redirect off this origin would carry
               them with it. `_redirects` has no open redirect today; this makes
               that a property of the client rather than of a file somebody
               edits for an unrelated reason. Same setting HubTrust uses, for
               the same reason. */
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }

    /* Headers a page is NOT allowed to set on a fetch, which is the rule this
       relay stands in for. Everything else is forwarded verbatim, deliberately:
       the backend reads X-Hestia-Token, X-Hestia-Proof and X-Hestia-Recovery,
       and an allow-list naming them would silently drop the next credential
       header somebody adds. That is exactly the bug this list replaced -- the
       relay forwarded only Content-Type, so every authorised call arrived with
       no credential at all and the backend answered 401.
     *
     * Three groups, and the middle one is the one that matters:
     *
     *  - transport framing, which OkHttp owns. A forged Host on a request to
     *    Cloudflare's anycast edge is domain fronting; a wrong Content-Length
     *    corrupts the request rather than annoying the server.
     *  - CLIENT ADDRESS. CF-Connecting-IP is the ONLY thing identifying a
     *    household across the whole backend, and every handler reads it.
     *    Cloudflare is believed to overwrite a client-supplied value, but its
     *    own reference page documents that overwrite for other headers and not
     *    for this one, so the guarantee rests on behaviour documented by
     *    implication. Not forwarding it costs nothing and removes the
     *    dependency.
     *  - the rest of fetch's forbidden-header-name list, so the comment above
     *    is true as written rather than true of a subset. None is read by any
     *    handler today; an Origin allow-list added with the hub-served CORS
     *    work would otherwise be bypassable from here on day one, silently,
     *    because the relay is the only caller that could forge one. */
    private val FORWARD_NEVER = setOf(
        "host", "content-length", "connection", "transfer-encoding",
        "upgrade", "keep-alive", "te", "trailer", "proxy-connection",
        "cookie", "cookie2",

        "cf-connecting-ip", "x-forwarded-for", "x-forwarded-host",
        "x-forwarded-proto", "x-real-ip", "true-client-ip",

        "origin", "referer", "date", "dnt", "via", "expect",
        "accept-charset", "accept-encoding",
    )

    private val FORWARD_NEVER_PREFIX = listOf("proxy-", "sec-", "access-control-request-")

    /**
     * Whether one header may be relayed. Pure, so it can be tested without a
     * network: the deny-list IS the control here, and a control nothing
     * exercises is a control that can be deleted without a suite noticing.
     *
     * The name must be an HTTP token. OkHttp accepts any byte in 0x21..0x7e,
     * which is wider, so without this check ":authority" and "Host:" are names
     * it would accept and that an exact lowercased match could never catch.
     * Enumerating names cannot close that; rejecting non-tokens can.
     */
    fun forwardable(name: String): Boolean {
        if (name.isEmpty()) return false
        /* ASCII ranges spelled out, not isLetterOrDigit(), which is Unicode
           aware in Kotlin and would admit a non-ASCII name OkHttp then rejects
           by throwing -- turning a denied header into a failed request. */
        if (!name.all {
                it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' ||
                it in "!#\$%&'*+-.^_`|~"
            }) return false
        val lower = name.lowercase()
        if (lower in FORWARD_NEVER) return false
        return FORWARD_NEVER_PREFIX.none { lower.startsWith(it) }
    }

    /**
     * One request to the backend. Never the main thread.
     *
     * Reuses HubClient.isSafePath, which already rejects the cases that matter
     * here for the same reason: a protocol-relative "//evil.example" resolves
     * against the origin to a DIFFERENT HOST, and a naive "starts with /"
     * check passes it.
     */
    fun request(
        path: String,
        method: String,
        body: String?,
        contentType: String?,
        headers: Map<String, String> = emptyMap(),
        timeoutMs: Long = 0,
    ): Result {
        if (!HubClient.isSafePath(path)) throw BadPath(path)

        val mediaType = (contentType ?: "application/json").toMediaTypeOrNull()
        val req = Request.Builder().url(ORIGIN + path)
        /* A malformed VALUE makes OkHttp throw, and that throw is allowed to
           escape: the bridge turns it into a rejected promise the page can
           report. Skipping it instead would send the request anyway, minus the
           credential, which is how this failed the first time. A denied NAME is
           different -- the page was never allowed to set it, so dropping it is
           what a browser does. */
        for ((name, value) in headers) {
            if (!forwardable(name)) continue
            req.header(name, value)
        }
        when (method.uppercase()) {
            "GET"    -> req.get()
            "DELETE" -> if (body == null) req.delete() else req.delete(body.toRequestBody(mediaType))
            else     -> req.method(method.uppercase(), (body ?: "").toRequestBody(mediaType))
        }

        /* A CALL timeout, not a read timeout: the page's `ms` bounds the whole
           operation the way AbortController does on the browser path, and the
           callers that pass one are boot-path guards whose entire job is to
           bound a stall. newBuilder() shares the pool and dispatcher, so this
           is a wrapper rather than a second client per request. */
        val c = if (timeoutMs > 0) {
            client.newBuilder().callTimeout(Duration.ofMillis(timeoutMs)).build()
        } else client

        c.newCall(req.build()).execute().use { res ->
            return Result(res.code, res.body?.string().orEmpty())
        }
    }

    fun toJson(r: Result): JSONObject =
        JSONObject().put("status", r.status).put("body", r.body)
}
