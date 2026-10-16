package com.hestari.hestia

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.Inet6Address
import java.net.InetAddress
import java.time.Duration

/**
 * Serves camera snapshots the WebView is not allowed to fetch.
 *
 * ── WHY THIS IS SEPARATE FROM HubProxy ──
 *
 * HubProxy serves the PINNED hub over a connection whose identity is proved by
 * a key we hold. This file serves hosts we hold no pin for, so it cannot borrow
 * that trust and must earn its own. The two scopes are deliberately not merged.
 *
 * ── WHAT IT RESTORES ──
 *
 * A browser lets a household accept a camera's situation once and move on. The
 * app removes that: the page is served from https, so a plain
 * `http://192.168.1.50/snap.jpeg` is mixed content and dies in the renderer.
 * One real tester (UniFi, anonymous snapshot, cleartext on the camera's own
 * address) sees black tiles where his cameras were. Those are the same bytes
 * his browser fetched before the app existed.
 *
 * ── THE ORDERING THAT MAKES IT POSSIBLE ──
 *
 * ⛔ This hook NEVER fires for an http:// subresource. Blink decides mixed
 * content in the RENDERER, before a loader exists, and this lives in the
 * browser process downstream. So, exactly as for the hub, the page rewrites the
 * url to https BEFORE an <img> exists; the request then reaches here and we
 * fetch the original over cleartext ourselves.
 *
 * ── THE TRUST GRANTED, STATED PLAINLY ──
 *
 * Two guards, and both must hold:
 *
 *  1. The page registered this origin as a camera. The destination comes from
 *     user configuration, which is the first time anything in this app fetches
 *     an address it did not have compiled in.
 *  2. The destination resolves to a PRIVATE address. So even a config entry
 *     written by something other than the user can only aim at the household's
 *     own network, never at an arbitrary host on the internet.
 *
 * Guard 2 is what keeps this from being a general-purpose proxy. Guard 1 alone
 * would not: config is writable by anything that can write config.
 *
 * NOT granted: certificate skipping. A recorder on the LAN with a self-signed
 * certificate is still refused, because "fetch cleartext the user asked for" and
 * "stop verifying identity" are different permissions and only the first has a
 * household asking for it.
 */
object CameraProxy {

    private const val TAG = "HestiaCamProxy"

    /** rewritten https origin -> the cleartext origin it stands for. */
    private var allowed: Map<String, String> = emptyMap()

    class Refused(val reason: String) : Exception(reason)

    /* Short. A camera that cannot answer in a few seconds has already failed
       for the user's purposes, and these run on the WebView's resource thread
       where a long stall is a visibly frozen tile. */
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(4))
            .readTimeout(Duration.ofSeconds(6))
            /* A camera redirecting us is not a case worth following: the
               redirect target gets none of the checks the original passed. */
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }

    /**
     * Replaces the set of origins this proxy will serve.
     *
     * Called by the page whenever the camera list changes. `from` must share a
     * host with `to`, so the page cannot register a mapping that makes some
     * unrelated origin answer from the LAN -- the only thing it may do is point
     * an origin at its own cleartext self, which is precisely the rewrite.
     */
    @Synchronized
    fun setAllowed(pairs: List<Pair<String, String>>) {
        val out = LinkedHashMap<String, String>()
        for ((from, to) in pairs) {
            val f = parse(from) ?: continue
            val t = parse(to) ?: continue
            if (!"https".equals(f.scheme, true)) continue
            if (!"http".equals(t.scheme, true)) continue
            if (f.host.isNullOrEmpty() || !f.host.equals(t.host, ignoreCase = true)) continue
            out[originOf(f)] = originOf(t)
        }
        allowed = out
        android.util.Log.i(TAG, "serving ${out.size} camera origin(s)")
    }

    @Synchronized
    private fun lookupAllowed(origin: String): String? = allowed[origin]

    /* java.net.URI, NOT android.net.Uri. Two reasons, and the second is the
       real one: it keeps every security decision in this file testable on a
       plain JVM, where android.net.Uri is a stub that silently returns null and
       would make a refusal look like a pass. It is also stricter, which is the
       direction to err when the input comes from configuration. */
    fun parse(s: String): java.net.URI? =
        runCatching { java.net.URI(s.trim()) }.getOrNull()

    private fun originOf(u: java.net.URI): String {
        val port = if (u.port != -1) ":${u.port}" else ""
        return "${u.scheme?.lowercase()}://${u.host?.lowercase()}$port"
    }

    /**
     * Is this address one on the household's own network?
     *
     * Loopback is DENIED on purpose. No camera lives on the phone itself, and
     * allowing it would turn this into a way for page script to reach whatever
     * the app happens to be listening on locally -- a door with no use case
     * behind it.
     *
     * Java's isSiteLocalAddress covers IPv4's 10/8, 172.16/12 and 192.168/16,
     * but for IPv6 it only knows the DEPRECATED fec0::/10 and not fc00::/7, so
     * unique-local is checked explicitly rather than assumed.
     */
    fun isPrivate(addr: InetAddress): Boolean {
        /* REDUNDANT, and kept on purpose to state the intent. The mutation gate
           showed this line can be deleted without a test going red, and that is
           correct rather than a gap: none of loopback, any-local or multicast
           is site-local or link-local, so the allow-list structure below
           refuses them anyway by falling through to `return false`. It is the
           inner guard; the shape of the function is the outer one. */
        if (addr.isLoopbackAddress || addr.isAnyLocalAddress || addr.isMulticastAddress) return false
        if (addr.isSiteLocalAddress || addr.isLinkLocalAddress) return true
        if (addr is Inet6Address) {
            // fc00::/7 -- unique local, which isSiteLocalAddress does not cover.
            return (addr.address[0].toInt() and 0xFE) == 0xFC
        }
        // Anything else is public, and the default is refusal.
        return false
    }

    /**
     * Resolves a host and proves every answer is private.
     *
     * ⛔ RETURNS THE ADDRESS, and the caller connects to THAT. Re-resolving
     * after the check is a DNS-rebinding hole: a name that answers private
     * while being checked and public while being connected to. Pinning the
     * resolved address closes it by construction.
     *
     * ALL answers must be private, not merely one. A name resolving to both a
     * LAN address and a public one is not a camera, and picking the private
     * answer would let the other be reached on a retry.
     */
    fun resolvePrivate(host: String): InetAddress {
        val addrs = runCatching { InetAddress.getAllByName(host) }.getOrNull()
            ?: throw Refused("could not resolve $host")
        /* Also redundant, also kept: getAllByName THROWS UnknownHostException
           rather than returning an empty array (verified, not assumed), so the
           elvis above already handles an unresolvable name. This survives the
           mutation gate for that reason and not because the case is untested. */
        if (addrs.isEmpty()) throw Refused("could not resolve $host")
        for (a in addrs) {
            if (!isPrivate(a)) {
                throw Refused("$host is on the public internet (${a.hostAddress}); " +
                    "cameras must be on your own network over https")
            }
        }
        return addrs[0]
    }

    /** One fetch over cleartext to an address already proved private. */
    private fun fetch(origin: String, pathAndQuery: String, pinned: InetAddress): okhttp3.Response {
        /* An object expression, not a lambda: okhttp3.Dns is a plain Kotlin
           interface rather than a `fun interface`, so SAM conversion does not
           apply to it. */
        val dns = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = listOf(pinned)
        }
        return client.newBuilder().dns(dns).build()
            .newCall(Request.Builder().url(origin + pathAndQuery).get().build())
            .execute()
    }

    /**
     * Answers a WebView resource request, or null to let it proceed normally.
     *
     * Runs on a background thread Chromium marks MayBlock(), so the synchronous
     * fetch is correct here rather than an ANR risk.
     */
    fun serve(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (!request.method.equals("GET", ignoreCase = true)) return null
        if (request.isForMainFrame) return null
        if (!url.scheme.equals("https", true)) return null

        val asked = parse(url.toString()) ?: return null
        val target = lookupAllowed(originOf(asked)) ?: return null

        val pathAndQuery = url.encodedPath.orEmpty() + (url.encodedQuery?.let { "?$it" } ?: "")
        var res: okhttp3.Response? = null
        return try {
            val host = parse(target)?.host ?: return null
            res = fetch(target, pathAndQuery, resolvePrivate(host))
            val body = res.body ?: run { res.close(); return null }

            val mime = body.contentType()?.let { "${it.type}/${it.subtype}" } ?: ""
            /* A camera answering a snapshot url with its login page returns
               text/html, and handing that to an <img> renders nothing while
               looking like success. The camera module's own "Not an image"
               diagnostic exists for exactly that and must keep firing. */
            if (!mime.startsWith("image/")) {
                android.util.Log.w(TAG, "not serving $mime from $target")
                res.close()
                return null
            }

            /* Validated BEFORE constructing: the constructor throws on a 3xx,
               on a blank or non-ASCII reason phrase, and outside 100..599 -- and
               a throw after byteStream() leaks the connection and blanks the
               tile with only a log line. */
            val code = res.code
            if (code < 100 || code > 599 || code in 300..399) {
                android.util.Log.w(TAG, "unusable status $code from $target")
                res.close()
                return null
            }
            val reason = res.message.trim().filter { it.code in 0x20..0x7e }.ifEmpty { "OK" }

            // Encoding is null for images; a combined Content-Type here would
            // declare a charset on binary data.
            WebResourceResponse(
                mime, null, code, reason,
                mapOf("Cache-Control" to "no-store"),
                body.byteStream()   // the WebView closes this, which is why res is not
            )
        } catch (e: Exception) {
            runCatching { res?.close() }
            /* WARN, not DEBUG: debug is stripped at the default level, so
               "cameras are blank in the app" would arrive with no record of
               why. That silent shape is one this project keeps paying for. */
            // Query stripped: a snapshot url can carry an access token, and a
            // warning that prints a live credential into logcat is its own bug.
            android.util.Log.w(TAG, "could not serve $target${HubProxy.safeToLog(pathAndQuery)}: ${e.message}")
            null
        }
    }

    /**
     * Probes one url for the Settings "Test connection" button.
     *
     * Exists because that button used an <img>, which in the app is mixed
     * content and always reported failure -- so a household with perfectly good
     * cameras was told they were broken BEFORE saving, and would reasonably give
     * up before the proxy above ever got a chance. A test that disagrees with
     * what the app will actually do is worse than no test.
     *
     * Takes a url not yet in the camera list, by necessity: it is still in the
     * input box. Guard 2 still applies, and the reply carries no bytes -- only
     * whether it worked and why not.
     */
    fun test(rawUrl: String): Map<String, Any?> {
        val u = parse(rawUrl)
            ?: return mapOf("ok" to false, "reason" to "that is not a valid address")
        val host = u.host
        if (host.isNullOrEmpty()) return mapOf("ok" to false, "reason" to "that address has no host")
        if (!"http".equals(u.scheme, true)) {
            return mapOf("ok" to false, "reason" to "only http:// cameras need testing through the app")
        }
        var res: okhttp3.Response? = null
        return try {
            val pinned = resolvePrivate(host)
            val path = u.rawPath.orEmpty().ifEmpty { "/" } + (u.rawQuery?.let { "?$it" } ?: "")
            res = fetch(originOf(u), path, pinned)
            val mime = res.body?.contentType()?.let { "${it.type}/${it.subtype}" } ?: ""
            val ok = res.code in 200..299 && mime.startsWith("image/")
            mapOf(
                "ok" to ok,
                "status" to res.code,
                "mime" to mime,
                "reason" to when {
                    ok -> null
                    res.code !in 200..299 -> "the camera answered ${res.code}"
                    else -> "the camera answered with $mime, not an image"
                },
            )
        } catch (e: Refused) {
            mapOf("ok" to false, "reason" to e.reason)
        } catch (e: Exception) {
            mapOf("ok" to false, "reason" to "could not reach it: ${e.javaClass.simpleName}")
        } finally {
            runCatching { res?.close() }
        }
    }
}
