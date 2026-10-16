package com.hestari.hestia

import android.content.Context
import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.util.Base64
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.time.Duration
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Trust for a Hubitat hub, which cannot be established any ordinary way.
 *
 * MEASURED AGAINST A REAL HUB, 2026-10-03, not assumed:
 *
 *     subject = C=US, ST=AZ, L=Scottsdale, O=Hubitat, OU=Engineering,
 *               CN=Hubitat Elevation
 *     issuer  = identical, so self-signed
 *     "No extensions in certificate"
 *     valid   2024-08-07 .. 2034-08-05
 *
 * Two independent reasons a stock client rejects it:
 *
 *  1. Self-signed, so no chain reaches a trusted root.
 *  2. NO subjectAltName at all. Hostname verification has nothing to match,
 *     and the CN fallback it would otherwise use was removed from modern TLS
 *     stacks years ago. The CN is the literal string "Hubitat Elevation",
 *     which is not an address in any case.
 *
 * So importing the certificate as a trusted CA would NOT be enough either:
 * trust would pass and hostname verification would still fail. Pinning the
 * public key, with hostname verification deliberately replaced, is the only
 * route. The project plan listed this as unresolved; it is now resolved in
 * that direction, with evidence.
 *
 * WHAT IT BUYS. Browser users must visit the hub and accept a warning on every
 * device, which has produced support traffic for months and is why people fall
 * back to plain http and then meet mixed content. A pinned app never asks,
 * never warns, and never sends cleartext.
 *
 * TRUST ON FIRST USE, for the same reason the household record uses it. The
 * pin is per-hub so it cannot ship in the binary. The first connection records
 * the key; every later one must present the same key or be refused. The window
 * is that first connection, on the user's own LAN, which this project's
 * settled threat model already places inside the trust boundary -- the hub
 * publishes its Maker API token unauthenticated at /local/hestia-token.json.
 *
 * A CHANGED KEY IS REFUSED AND SURFACED, never silently re-pinned. Re-pinning
 * on change would make the pin decorative: anyone on the LAN could present
 * their own key and be adopted. A hub that genuinely regenerates its
 * certificate needs a deliberate re-pin by the user.
 */
object HubTrust {

    private const val PREFS = "hestia_hub_trust"
    private const val KEY_PIN = "spki_pin"
    private const val KEY_ORIGIN = "origin"

    /**
     * SHA-256 over the certificate's SubjectPublicKeyInfo, base64.
     *
     * java.util.Base64 rather than android.util.Base64 deliberately: it exists
     * from API 26, which is this app's minSdk, and unlike the Android one it
     * is real in a plain JVM unit test. The pin comparison is the most
     * security-critical logic in the app, and it should not need an emulator
     * or a shim to be tested.
     */
    fun pinOf(cert: X509Certificate): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded)
        return Base64.getEncoder().encodeToString(digest)
    }

    /**
     * The same bytes as the pin, in the encoding a person can read.
     *
     * Base64 is for storage and comparison; nobody reads it off a screen or
     * repeats it over the phone. Colon-separated uppercase hex is the form
     * every other tool shows a certificate fingerprint in, which is what makes
     * it comparable against one at all.
     *
     * Empty for an unpinned (http) hub rather than a placeholder, so the UI has
     * to decide what to say instead of displaying something that looks like a
     * fingerprint and is not.
     */
    fun fingerprintOf(pin: String): String = runCatching {
        Base64.getDecoder().decode(pin).joinToString(":") { String.format("%02X", it) }
    }.getOrDefault("")

    /**
     * The whole trust decision, as one pure function so it can be tested
     * without a network, an emulator or a running app.
     *
     * @return the pin actually presented
     * @throws PinMismatch when [expected] is set and the chain does not match
     */
    fun checkChain(expected: String?, chain: Array<X509Certificate>): String {
        val leaf = chain.firstOrNull() ?: throw PinMismatch(expected.orEmpty(), "")
        val presented = pinOf(leaf)
        // null means first use: record it, do not judge it.
        if (expected != null && presented != expected) throw PinMismatch(expected, presented)
        return presented
    }

    fun storedPin(ctx: Context): String? = prefs(ctx).getString(KEY_PIN, null)
    /**
     * The pinned hub origin, or null -- and NEVER a cleartext one.
     *
     * ⛔ THE GUARD HERE IS LOAD-BEARING, and it did not used to be. Until the
     * camera proxy needed cleartext, the manifest set usesCleartextTraffic
     * ="false" and the platform refused http for the whole app. That flag was
     * the ONLY thing stopping the hub relay running in the clear: configure()
     * accepted an http:// origin, and nothing else objected. Permitting
     * cleartext for cameras would have quietly taken that protection away and
     * put the Maker API token on the wire in plaintext.
     *
     * So the rule is code now instead of a side effect of a global setting.
     * Both readers inherit it from here: HubClient.request builds from this,
     * and so does HubProxy.
     *
     * FAILS CLOSED. A non-https value reads as "no hub configured", which sends
     * the device back through first run and re-pins over https, rather than
     * silently downgrading. No shipped install can hold one -- discovery and
     * manual entry both build https:// -- so this recovers a state that should
     * not exist rather than breaking one that does.
     */
    fun storedOrigin(ctx: Context): String? {
        val v = prefs(ctx).getString(KEY_ORIGIN, null) ?: return null
        if (!v.startsWith("https://", ignoreCase = true)) {
            android.util.Log.w("HestiaTrust", "ignoring a non-https stored hub origin; re-pinning is required")
            return null
        }
        return v
    }

    fun remember(ctx: Context, origin: String, pin: String) {
        prefs(ctx).edit().putString(KEY_ORIGIN, origin).putString(KEY_PIN, pin).apply()
        // Or the cached client keeps trusting the key we just replaced.
        invalidatePinnedClient()
    }

    /** Deliberate re-pin, e.g. after the user regenerates the hub's certificate. */
    fun forget(ctx: Context) {
        prefs(ctx).edit().clear().apply()
        invalidatePinnedClient()
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    class PinMismatch(val expected: String, val actual: String) : Exception(
        "the hub presented a different TLS key than this device pinned"
    )

    /**
     * An HTTPS client that accepts exactly one public key.
     *
     * @param expectedPin the key to require, or null to accept and record
     *                    whatever the hub presents (first use only).
     *
     * [observedPin] is readable after a connection completes, which is how a
     * first-use caller learns what to persist.
     */
    class Pinned(private val expectedPin: String?) {

        @Volatile
        var observedPin: String? = null
            private set

        private val trustManager = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
                throw UnsupportedOperationException("this client is never a server")
            }

            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                /* The decision itself lives in checkChain so it is testable
                   without a network. Recording what was seen happens even on
                   a mismatch, so a caller can report WHICH key turned up. */
                try {
                    observedPin = checkChain(expectedPin, chain)
                } catch (e: PinMismatch) {
                    observedPin = e.actual.ifEmpty { null }
                    throw e
                }
            }

            // Empty on purpose. There is no CA involved; trust is the pin.
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }

        val client: OkHttpClient = run {
            val ssl = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
            }
            OkHttpClient.Builder()
                .sslSocketFactory(ssl.socketFactory, trustManager)
                /* ⛔ OkHttp's default is 5 requests per host, and EVERYTHING
                   here is one host: device polling, the companion app store,
                   and every camera snapshot served through HubProxy. A hub
                   snapshot can take seconds, so a household with three cameras
                   refreshing can hold the whole allowance while the 1s device
                   poll queues behind them and times out at 10s. Observed on a
                   real household: "Lost connection to your hub" on a hub that
                   was answering the same request in 75ms, with the poll feeding
                   the jam faster than it drained.
                   The hub is a device on the LAN answering in milliseconds, so
                   the cap is protecting nothing here -- it exists for servers
                   on the open internet. Raised well clear of any realistic
                   camera count plus control traffic. */
                .dispatcher(okhttp3.Dispatcher().apply {
                    maxRequests = 32
                    maxRequestsPerHost = 16
                })
                /* Replaced, not weakened by accident. The certificate has no
                   SAN, so there is nothing any verifier could match. Identity
                   is proved by the pinned key instead, which is a stronger
                   claim than a name the certificate's own holder chose. */
                .hostnameVerifier { _: String, _: SSLSession -> true }
                .connectTimeout(Duration.ofSeconds(5))
                .readTimeout(Duration.ofSeconds(10))
                .retryOnConnectionFailure(false)
                /* Redirects are NOT followed. The hub has no legitimate reason
                   to redirect an API path or a snapshot, and a redirect to
                   http:// would walk a pinned request straight out of TLS.
                   Today that fails closed only because the manifest forbids
                   cleartext, which is an accident rather than a decision. */
                .followRedirects(false)
                .followSslRedirects(false)
                .build()
        }
    }

    /* ── One client per pinned identity ───────────────────────────────────
     * Pinned() builds an SSLContext, a trust manager, a connection pool and a
     * dispatcher every time it is constructed. Camera snapshots refresh as
     * often as once a second across several tiles, so constructing per request
     * meant a full TLS handshake several times a second with no connection
     * reuse, plus abandoned pools holding idle connections and threads until
     * collected. OkHttp's own guidance is to share one instance.
     *
     * Keyed on origin AND pin so a re-pin cannot keep serving over a client
     * that still trusts the old key. */
    private var cachedKey: String? = null
    private var cachedClient: OkHttpClient? = null

    @Synchronized
    fun pinnedClient(ctx: Context): OkHttpClient {
        val origin = storedOrigin(ctx).orEmpty()
        /* Empty is normalised to null: an http-configured hub stores "" rather
           than null, and passing "" as the expected pin would make every TLS
           connection mismatch against a pin nothing can present, while also
           blocking the trust-on-first-use path. */
        val pin = storedPin(ctx)?.ifEmpty { null }
        val key = "$origin|${pin.orEmpty()}"
        cachedClient?.let { if (cachedKey == key) return it }
        val built = Pinned(pin).client
        cachedKey = key
        cachedClient = built
        return built
    }

    @Synchronized
    private fun invalidatePinnedClient() { cachedKey = null; cachedClient = null }
}
