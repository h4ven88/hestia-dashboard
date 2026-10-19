package com.hestari.hestia

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The four guards that replaced one manifest flag.
 *
 * usesCleartextTraffic was "false", and while it was, nothing else had to care:
 * the platform refused http for the entire app. Cameras needed cleartext, and
 * the flag is enforced by the HTTP stack rather than only the WebView, so it had
 * to become "true" for CameraProxy to open a socket at all.
 *
 * That silently removed the ONLY thing stopping the hub relay running in the
 * clear, because HubClient.configure() accepted an http:// origin and nothing
 * objected. The Maker API token would have gone on the wire in plaintext.
 *
 * So these are asserted over the real sources. A unit test cannot open a socket
 * to prove a negative about the network, but it can prove the guards are still
 * written, which is what a later "tidy-up" would remove.
 */
class CleartextPolicyTest {

    private val root = File("../").canonicalFile
    private fun src(rel: String) = File(root, "app/src/main/java/com/hestari/hestia/$rel").readText()
    private fun manifest() = File(root, "app/src/main/AndroidManifest.xml").readText()

    /* Stripped first. Three false greens in this project came from an assertion
       satisfied by the explanatory comment above the code it meant to check,
       and every guard below is heavily commented. */
    private fun code(s: String) = s
        .replace(Regex("""/\*[\s\S]*?\*/"""), " ")
        .lines().joinToString("\n") { it.replace(Regex("""(^|[^:])//.*$"""), "$1") }

    @Test
    fun `the flag really is permitting cleartext, so the guards below are load-bearing`() {
        assertTrue(
            "if this is false again the guards are belt-and-braces, not the line itself",
            manifest().contains("android:usesCleartextTraffic=\"true\"")
        )
    }

    /* Guard 1. Both HubClient.request and HubProxy build from this, so one
       check here covers both readers. Fails CLOSED: a non-https value reads as
       "no hub configured" and sends the device back through first run. */
    @Test
    fun `a stored hub origin that is not https is treated as absent`() {
        val c = code(src("HubTrust.kt"))
        assertTrue(
            "storedOrigin must refuse a non-https value rather than hand it to the relay",
            Regex("""fun storedOrigin[\s\S]{0,400}?!v\.startsWith\("https://"[\s\S]{0,300}?return null""")
                .containsMatchIn(c)
        )
    }

    /* Guard 2. This accepted http:// and relied on the flag. Every caller
       already builds https, so nothing legitimate is refused. */
    @Test
    fun `configure refuses a cleartext hub outright`() {
        val c = code(src("HubClient.kt"))
        assertTrue(
            "configure must reject http:// itself",
            Regex("""!normalised\.startsWith\("https://"[\s\S]{0,200}?throw""").containsMatchIn(c)
        )
        assertTrue(
            "and must no longer accept http:// as valid input",
            !c.contains("""startsWith("http://")""")
        )
    }

    /* Guard 3. ORIGIN is a constant one edit from being http, and this call
       carries the raw Maker token and the household secret proof. */
    @Test
    fun `the cloud client asserts its own origin is https`() {
        val c = code(src("CloudClient.kt"))
        assertTrue(
            "require(ORIGIN.startsWith(\"https://\")) must guard request()",
            Regex("""require\(ORIGIN\.startsWith\("https://"\)\)""").containsMatchIn(c)
        )
        assertTrue("and ORIGIN must be https", c.contains("""ORIGIN = "https://"""))
    }

    /* Guard 4. The one that bounds what cleartext is now FOR: registered camera
       origins whose host resolves private, and nothing else. */
    @Test
    fun `the camera proxy still checks the address before fetching`() {
        val c = code(src("CameraProxy.kt"))
        assertTrue(
            "serve must resolve-and-check before it fetches",
            Regex("""resolvePrivate\(""").containsMatchIn(c)
        )
        assertTrue(
            "and must only serve origins the page registered",
            Regex("""lookupAllowed\(originOf\(asked\)\) \?: return null""").containsMatchIn(c)
        )
    }

    /* The WebView's own protection is separate from the flag and must stay
       separate: nothing may set it to a permissive mode to "fix" a camera. */
    @Test
    fun `nothing loosens the WebView's mixed-content mode`() {
        val c = code(src("MainActivity.kt"))
        assertTrue(
            "MIXED_CONTENT_ALWAYS_ALLOW or COMPATIBILITY_MODE would let the page load http itself",
            !c.contains("MIXED_CONTENT_ALWAYS_ALLOW") && !c.contains("MIXED_CONTENT_COMPATIBILITY_MODE")
        )
    }

    /* ⛔ WHAT THE NEXT TWO ASSERTIONS DO AND DO NOT CATCH. Read this before
       trusting them.
       Both guards live in functions that need an Android Context -- addressOf
       takes an NsdServiceInfo, configure touches SharedPreferences and the
       network -- and there is no Robolectric here, only plain JUnit. So neither
       can be exercised behaviourally, and the mutation gate confirmed it:
       deleting either one left all 65 Kotlin tests green.
       These close the DELETE case, which is the realistic refactor accident.
       They do NOT close present-but-disabled: `if (false && ...)` keeps every
       token and still passes, which the sweep recorded as an open finding for
       the two guards above as well. Pinning the whole STATEMENT rather than an
       identifier is as far as a source assertion can go. The real fix is to
       extract these decisions into pure functions, the way checkChain was
       extracted from the trust manager -- recorded, not done here. */

    @Test
    fun `discovery validates the mDNS address instead of trusting it`() {
        val c = code(src("HubDiscovery.kt"))
        assertTrue(
            "the TXT IPv4 field is an unauthenticated multicast string; used verbatim it " +
                "made an advertised HOSTNAME into a pinnable https origin",
            c.contains("return if (isIpv4Literal(stated)) stated else null")
        )
        assertTrue(
            "resolving it would defeat the point -- a hostname would pass",
            !c.contains("InetAddress.getByName(stated)")
        )
    }

    @Test
    fun `configure requires the hub to be on this network, not merely https`() {
        val c = code(src("HubClient.kt"))
        assertTrue(
            "CameraProxy.resolvePrivate refuses a public destination and this, which carries " +
                "the Maker API token, used to check only the scheme",
            c.contains("CameraProxy.resolvePrivate(host)")
        )
        assertTrue(
            "a host it never extracted could not be checked",
            Regex("""val host\s*=\s*runCatching\s*\{\s*java\.net\.URI\(normalised\)\.host""")
                .containsMatchIn(c)
        )
    }
}
