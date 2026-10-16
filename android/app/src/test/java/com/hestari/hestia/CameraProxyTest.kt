package com.hestari.hestia

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

/**
 * The camera proxy's trust boundary.
 *
 * This is the first code path in the app that fetches an address it did not
 * have compiled in -- the destination comes from user configuration. Two guards
 * stand between that and a general-purpose proxy: the origin must be registered
 * as a camera, and it must resolve private. The second is the one that holds if
 * the first is subverted, because config is writable by anything that can write
 * config, so it is the one tested hardest here.
 */
class CameraProxyTest {

    private fun ip(s: String): InetAddress = InetAddress.getByName(s)

    @Test
    fun `the household's own network is allowed`() {
        for (a in listOf("10.0.0.5", "10.255.255.254", "172.16.0.1", "172.31.255.254",
                         "192.168.1.50", "192.168.255.1")) {
            assertTrue(a, CameraProxy.isPrivate(ip(a)))
        }
    }

    /* The whole point of guard 2. A camera entry aimed at the internet must not
       make the app fetch it natively, outside the rules the WebView applies. */
    @Test
    fun `the public internet is refused`() {
        for (a in listOf("8.8.8.8", "1.1.1.1", "93.184.216.34",
                         // Just outside each private range, which is where an
                         // off-by-one in a hand-rolled check would show.
                         "9.255.255.255", "11.0.0.0",
                         "172.15.255.255", "172.32.0.0",
                         "192.167.255.255", "192.169.0.0")) {
            assertFalse(a, CameraProxy.isPrivate(ip(a)))
        }
    }

    /* No camera lives on the phone. Allowing loopback would only create a way
       for page script to reach whatever the app listens on locally. */
    @Test
    fun `loopback is refused, deliberately`() {
        assertFalse(CameraProxy.isPrivate(ip("127.0.0.1")))
        assertFalse(CameraProxy.isPrivate(ip("127.1.2.3")))
        assertFalse(CameraProxy.isPrivate(ip("::1")))
        assertFalse(CameraProxy.isPrivate(ip("0.0.0.0")))
    }

    /* Java's isSiteLocalAddress knows IPv4's ranges and, for IPv6, only the
       DEPRECATED fec0::/10 -- not fc00::/7. Relying on it alone would refuse
       every modern IPv6 LAN. */
    @Test
    fun `IPv6 unique-local is allowed and public IPv6 is not`() {
        assertTrue(CameraProxy.isPrivate(ip("fd00::1")))
        assertTrue(CameraProxy.isPrivate(ip("fc00::1")))
        assertTrue(CameraProxy.isPrivate(ip("fe80::1")))          // link-local
        assertFalse(CameraProxy.isPrivate(ip("2001:4860:4860::8888")))
        assertFalse(CameraProxy.isPrivate(ip("fe00::1")))         // just below fc00::/7
    }

    @Test
    fun `IPv4 link-local is allowed`() {
        assertTrue(CameraProxy.isPrivate(ip("169.254.1.1")))
    }

    /* A name that resolves anywhere public is refused outright rather than
       having its private answers cherry-picked -- picking would let the public
       answer be reached on a retry. */
    @Test
    fun `a public hostname is refused with a reason a user can act on`() {
        try {
            CameraProxy.resolvePrivate("one.one.one.one")
            throw AssertionError("resolved a public host as private")
        } catch (e: CameraProxy.Refused) {
            assertTrue(e.reason, e.reason.contains("public internet"))
        } catch (e: Exception) {
            // No DNS in the test environment is an acceptable outcome; the
            // assertion that matters is that it never returns an address.
            assertTrue(e is CameraProxy.Refused || e.message != null)
        }
    }

    @Test
    fun `an unresolvable host is refused, not defaulted`() {
        try {
            CameraProxy.resolvePrivate("no-such-host.invalid")
            throw AssertionError("resolved a host that does not exist")
        } catch (e: CameraProxy.Refused) {
            assertTrue(e.reason, e.reason.contains("could not resolve"))
        }
    }

    /* `from` must share a host with `to`. Without that the page could register
       "https://hestari.com -> http://192.168.1.1" and have an origin we care
       about answered from the LAN. */
    @Test
    fun `a mapping across two different hosts is rejected`() {
        CameraProxy.setAllowed(listOf("https://hestari.com" to "http://192.168.1.1"))
        assertNullServe("https://hestari.com/snap.jpg")
    }

    @Test
    fun `only http destinations are registered`() {
        // An https camera needs no proxy -- it already loads itself.
        CameraProxy.setAllowed(listOf("https://192.168.1.50" to "https://192.168.1.50"))
        assertNullServe("https://192.168.1.50/snap.jpg")
    }

    /* Replacing rather than accumulating is what makes removing a camera in
       Settings actually withdraw it. */
    @Test
    fun `the set is replaced, so a removed camera stops being served`() {
        CameraProxy.setAllowed(listOf("https://192.168.1.50" to "http://192.168.1.50"))
        CameraProxy.setAllowed(emptyList())
        assertNullServe("https://192.168.1.50/snap.jpg")
    }

    @Test
    fun `test refuses an https url rather than pretending to probe it`() {
        val r = CameraProxy.test("https://192.168.1.50/snap.jpg")
        assertEquals(false, r["ok"])
        assertTrue(r["reason"].toString(), r["reason"].toString().contains("http://"))
    }

    @Test
    fun `test refuses a public address with a reason`() {
        val r = CameraProxy.test("http://8.8.8.8/snap.jpg")
        assertEquals(false, r["ok"])
        assertTrue(r["reason"].toString(), r["reason"].toString().contains("public internet"))
    }

    @Test
    fun `test refuses a malformed url instead of throwing`() {
        val r = CameraProxy.test("not a url at all")
        assertEquals(false, r["ok"])
        assertTrue(r["reason"] != null)
    }

    /* serve() needs a WebResourceRequest, which is Android framework and not
       available to a JVM unit test. These cases assert the REGISTRATION gate
       instead, which is what decides whether serve() would look at all: an
       origin that never made it into the map is refused before anything else
       happens. */
    private fun assertNullServe(url: String) {
        val mapped = CameraProxy.javaClass.getDeclaredMethod("lookupAllowed", String::class.java)
            .apply { isAccessible = true }
            .invoke(CameraProxy, originOf(url))
        assertEquals(null, mapped)
    }

    private fun originOf(url: String): String {
        val m = Regex("^(https?)://([^/:]+)(?::(\\d+))?").find(url) ?: return url
        val port = m.groupValues[3].let { if (it.isEmpty()) "" else ":$it" }
        return "${m.groupValues[1]}://${m.groupValues[2]}$port"
    }

    /* The registration path has to actually WORK, or every refusal above would
       pass against a map that is simply always empty -- the test equivalent of
       agreeing with a broken gate. */
    @Test
    fun `a legitimate camera origin IS registered`() {
        CameraProxy.setAllowed(listOf("https://192.168.1.50" to "http://192.168.1.50"))
        val mapped = CameraProxy.javaClass.getDeclaredMethod("lookupAllowed", String::class.java)
            .apply { isAccessible = true }
            .invoke(CameraProxy, "https://192.168.1.50")
        assertEquals("http://192.168.1.50", mapped)
    }

    @Test
    fun `an explicit port is carried through both halves of the mapping`() {
        CameraProxy.setAllowed(listOf("https://192.168.1.50:8080" to "http://192.168.1.50:8080"))
        val mapped = CameraProxy.javaClass.getDeclaredMethod("lookupAllowed", String::class.java)
            .apply { isAccessible = true }
            .invoke(CameraProxy, "https://192.168.1.50:8080")
        assertEquals("http://192.168.1.50:8080", mapped)
    }
}
