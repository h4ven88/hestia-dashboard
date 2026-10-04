package com.hestari.hestia

import android.content.Context
import android.util.Base64
import okhttp3.OkHttpClient
import java.security.MessageDigest
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

    /** SHA-256 over the certificate's SubjectPublicKeyInfo, base64. */
    fun pinOf(cert: X509Certificate): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded)
        return Base64.encodeToString(digest, Base64.NO_WRAP)
    }

    fun storedPin(ctx: Context): String? = prefs(ctx).getString(KEY_PIN, null)
    fun storedOrigin(ctx: Context): String? = prefs(ctx).getString(KEY_ORIGIN, null)

    fun remember(ctx: Context, origin: String, pin: String) {
        prefs(ctx).edit().putString(KEY_ORIGIN, origin).putString(KEY_PIN, pin).apply()
    }

    /** Deliberate re-pin, e.g. after the user regenerates the hub's certificate. */
    fun forget(ctx: Context) = prefs(ctx).edit().clear().apply()

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
                val leaf = chain.firstOrNull()
                    ?: throw PinMismatch(expectedPin.orEmpty(), "")
                val presented = pinOf(leaf)
                observedPin = presented
                // null means first use: record it, do not judge it.
                if (expectedPin != null && presented != expectedPin) {
                    throw PinMismatch(expectedPin, presented)
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
                /* Replaced, not weakened by accident. The certificate has no
                   SAN, so there is nothing any verifier could match. Identity
                   is proved by the pinned key instead, which is a stronger
                   claim than a name the certificate's own holder chose. */
                .hostnameVerifier { _: String, _: SSLSession -> true }
                .connectTimeout(Duration.ofSeconds(5))
                .readTimeout(Duration.ofSeconds(10))
                .retryOnConnectionFailure(false)
                .build()
        }
    }
}
