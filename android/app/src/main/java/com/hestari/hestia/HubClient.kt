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
        /* Normalised the way pinnedClient normalises it, so the two agree on
           what "this device holds a pin" means. "" is what an http-configured
           hub used to store, and treating it as a real pin would demand a key
           nothing can present. */
        val pin = HubTrust.storedPin(ctx)?.ifEmpty { null }

        /* ⛔ THE STEADY-STATE PATH MUST NOT BUILD A CLIENT PER REQUEST, and it
           did. HubTrust.pinnedClient exists for precisely this reason, and its
           own comment names camera snapshots as the motivation -- but THIS
           function is the device poll, which runs about once a second for as
           long as the app is open. HubProxy was migrated to the shared client.
           The hotter caller never was.

           What that cost, measured on a Galaxy A16 against a healthy hub: a
           full TLS handshake on every poll with no connection reuse, plus a
           Dispatcher and ConnectionPool abandoned per poll, each holding
           threads and idle sockets until collected. The app reached the
           dashboard, ran for a minute or two, then every relayed request
           failed with SocketTimeoutException: Read timed out, and the page
           showed "Lost connection to your hub".

           Three things were ruled out by measurement first, so do not go
           looking there again: the same /devices/all returned 47 KB in 0.15s
           from a PC on the same network five times running; the hub served 16
           concurrent requests with zero errors and a 2.31s worst case; and
           logcat showed no Wi-Fi disconnection events. The hub, the link and
           the dispatcher cap were all fine. The client was the fault.

           TOFU still builds its own, because observedPin lives on the wrapper
           and a shared client cannot report which key it saw. That path runs
           once per hub rather than once per second, so it costs nothing. */
        val tofu = if (pin == null) HubTrust.Pinned(null) else null
        val client = tofu?.client ?: HubTrust.pinnedClient(ctx)

        val requestBody = body?.toRequestBody((contentType ?: "application/json").toMediaType())
        val req = Request.Builder()
            .url(origin.trimEnd('/') + path)
            .method(method.uppercase(), requestBody)
            .build()

        client.newCall(req).execute().use { res ->
            /* A hub whose key changed is refused by the trust manager before
               we get here, so reaching this point means the pin held. If we
               connected with no pin stored, record what we saw -- that is the
               trust-on-first-use moment, and it happens exactly once.
               remember() invalidates the cached client, so the very next
               request is served by one that enforces the key just stored. */
            tofu?.observedPin?.let { HubTrust.remember(ctx, origin, it) }
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
    fun configure(ctx: Context, origin: String, commit: Boolean = true): JSONObject {
        val normalised = origin.trimEnd('/')
        /* HTTPS ONLY, and this tightened deliberately. It accepted http:// and
           relied on the manifest's usesCleartextTraffic="false" to make that
           unreachable -- which stopped being true the moment cameras needed
           cleartext. Every caller already builds https:// (HubDiscovery, and
           the manual-entry screen), so nothing legitimate is refused; what is
           refused is a hub relay carrying the Maker API token in the clear. */
        if (!normalised.startsWith("https://", ignoreCase = true)) {
            throw IllegalArgumentException(
                "hub origin must be https:// -- Hestia will not send your hub credentials in the clear")
        }

        /* ⛔ AND IT MUST BE ON THIS NETWORK. The scheme check above was the ONLY
         * check, which is the asymmetry the pre-production sweep found:
         * CameraProxy.resolvePrivate refuses a destination on the public
         * internet, and this function -- which carries far more, every
         * apiUrl() call with the Maker API token in its query -- did not.
         *
         * So an mDNS record advertising `IPv4=hub.attacker.example` produced a
         * trust screen showing the ATTACKER's certificate fingerprint as the
         * thing to trust, and one tap pinned a host on the open internet as
         * the household's hub. HubDiscovery now validates that field, but a
         * manual-entry screen and the page's own hub.configure call both reach
         * here too, so the guard belongs at the doorway, not only upstream.
         *
         * "The LAN is inside the trust boundary" justifies trusting the
         * household's OWN network, because the hub publishes its token
         * unauthenticated there. It does not justify trusting a hotel's. This
         * EXTENDS that model rather than reopening it. */
        val host = runCatching { java.net.URI(normalised).host }.getOrNull()
        if (host.isNullOrEmpty()) {
            throw IllegalArgumentException("hub origin has no host: $normalised")
        }
        CameraProxy.resolvePrivate(host)   // throws CameraProxy.Refused if public

        val pinned = HubTrust.Pinned(null)   // first use: accept and record
        val req = Request.Builder().url("$normalised/hub2/hubData").get().build()

        /* ⛔ FIRST CONTACT NEEDS A LONGER LEASH THAN STEADY STATE, and using
           the shared client's 5s connect budget here was a real first-run
           failure on a real phone: discovery found the hub and confirmed it
           reachable, then this call -- same host, same port, same path, seconds
           later -- timed out, and the user saw "No answer from that address."
           on a hub that was answering. Tapping the same row again worked.
           Intermittent is the worst shape for this: it lands on the very first
           screen a new tester sees, and it tells them the truthful-sounding
           lie that their hub is unreachable.

           Why this call and not discovery's: HubDiscovery already overrides to
           6s for exactly the same reason, so the shared default was only ever
           tuned for the warm steady-state path (device polling at ~1s against
           a hub this app has already talked to). A cold TLS handshake against a
           C-8 Pro's self-signed certificate is a different workload.

           retryOnConnectionFailure stays FALSE. That is a deliberate control --
           it stops OkHttp silently re-routing a pinned request -- and widening
           a timeout is not a reason to weaken it. Budget, not retries. */
        val firstContact = pinned.client.newBuilder()
            .connectTimeout(java.time.Duration.ofSeconds(20))
            .readTimeout(java.time.Duration.ofSeconds(20))
            .build()

        firstContact.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                throw Exception("hub answered ${res.code} rather than identifying itself")
            }
            val seen = pinned.observedPin
            /* commit=false looks without remembering, so first-run can SHOW the
               fingerprint on the screen that asks the user to trust it. Pinning
               first and displaying afterwards would make that screen a
               notification rather than a decision. */
            // http:// has no key to pin. Allowed, but recorded as unpinned so
            // the UI can say so rather than implying a protection it lacks.
            if (commit) HubTrust.remember(ctx, normalised, seen.orEmpty())

            val info = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            return JSONObject()
                .put("origin", normalised)
                .put("pinned", seen != null)
                .put("committed", commit)
                .put("fingerprint", HubTrust.fingerprintOf(seen.orEmpty()))
                .put("hubId", info.optString("hubId"))
                .put("name", info.optString("name"))
                .put("model", info.optString("model"))
                .put("version", info.optString("version"))
        }
    }
}
