package com.hestari.hestia

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import okhttp3.Request

/**
 * Serves resources the page asks for directly, when the page cannot fetch them
 * itself. Camera snapshots are the reason this exists.
 *
 * THE PROBLEM. Camera tiles are plain `<img src="http://<hub>/apps/api/.../
 * snapshot/...">`. In a browser served from the hub that is same-origin and
 * fine. In the app the page lives at https://appassets.androidplatform.net, so
 * an http:// image is mixed content and is refused before a byte moves. Making
 * it https:// does not help either: the hub's certificate is self-signed with
 * no SAN, and a WebView gives no way to accept it the way a browser tab does.
 *
 * **The app therefore REMOVES a capability camera households rely on today** --
 * "accept the certificate once on this device" -- so it has to replace it.
 *
 * THE MECHANISM is the same one that makes the whole bundled-page design work.
 * shouldInterceptRequest is already how https://appassets.androidplatform.net
 * resolves to files in the APK: the WebView asks, we answer with bytes, and no
 * request ever goes to a network. Here we answer with bytes fetched over the
 * connection we pinned, so the page keeps using an ordinary <img> and the
 * camera module needs no change at all. No CORS either, because this is not a
 * cross-origin fetch from JavaScript.
 *
 * SCOPE, deliberately narrow for now: only the host this device has PINNED.
 * That covers hub-served snapshots. It does NOT cover a camera on its own
 * address, which is how at least one real household is set up, and widening it
 * to "any host the household configured as a camera" is a separate decision
 * because it means trusting a host we hold no pin for.
 */
object HubProxy {

    private const val TAG = "HestiaProxy"

    /* Snapshots are images. Anything else aimed at the hub is either the page's
       own API traffic -- which goes through the bridge, not here -- or
       something we have no business fetching on the page's behalf. */
    private val SERVE_PREFIXES = listOf("image/")

    /**
     * Answers a WebView resource request, or null to let it proceed normally.
     *
     * Called on a background thread by the WebView, so a synchronous network
     * call is correct here. It must NOT be called on the main thread.
     */
    fun serve(ctx: Context, url: Uri, method: String): WebResourceResponse? {
        if (!method.equals("GET", ignoreCase = true)) return null

        val pinnedOrigin = HubTrust.storedOrigin(ctx) ?: return null
        val pinnedHost = runCatching { Uri.parse(pinnedOrigin).host }.getOrNull() ?: return null
        if (!pinnedHost.equals(url.host, ignoreCase = true)) return null

        /* Rebuilt onto the PINNED origin rather than the one the page asked
           for. That is the whole point: the page may have said http://, and
           the pinned origin is where we actually have a key to check. */
        val path = url.encodedPath.orEmpty() + (url.encodedQuery?.let { "?$it" } ?: "")
        if (!HubClient.isSafePath(path)) {
            android.util.Log.w(TAG, "refused an unsafe path: $path")
            return null
        }
        val target = pinnedOrigin.trimEnd('/') + path

        return try {
            val pinned = HubTrust.Pinned(HubTrust.storedPin(ctx))
            val res = pinned.client.newCall(Request.Builder().url(target).get().build()).execute()
            val body = res.body
            if (body == null) { res.close(); return null }

            val contentType = body.contentType()
            val mime = contentType?.let { "${it.type}/${it.subtype}" } ?: "application/octet-stream"

            /* Only images are served. A hub that answers a snapshot URL with
               its login page returns text/html, and handing that to an <img>
               would render nothing while looking like a successful fetch --
               the camera module's own "Not an image" diagnostic exists for
               exactly that case and should keep firing. */
            if (SERVE_PREFIXES.none { mime.startsWith(it) }) {
                android.util.Log.i(TAG, "not serving $mime for $path")
                res.close()
                return null
            }

            /* The stream is handed to the WebView OPEN. Closing the response
               here would close it underneath the reader; the WebView closes
               the InputStream when it is done. */
            WebResourceResponse(
                mime,
                contentType?.charset()?.name(),
                res.code,
                res.message.ifEmpty { "OK" },
                mapOf(
                    // Snapshots change without the URL changing, and the page
                    // already appends its own cache-busting token.
                    "Cache-Control" to "no-store",
                ),
                body.byteStream()
            )
        } catch (e: HubTrust.PinMismatch) {
            /* Not an ordinary failure: either the hub regenerated its
               certificate or something is impersonating it. Serving nothing is
               right, and the page shows the camera as offline. */
            android.util.Log.w(TAG, "pin mismatch serving $path: ${e.message}")
            null
        } catch (e: Exception) {
            android.util.Log.d(TAG, "could not serve $path: ${e.javaClass.simpleName}: ${e.message}")
            null
        }
    }
}
