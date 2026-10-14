package com.hestari.hestia

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The cloud relay's two controls, exercised directly.
 *
 * They had none. An appsec pass pointed out that deleting the isSafePath call
 * or dropping "host" from the deny-list left all 759 JavaScript tests green,
 * because no JS test can reach Kotlin -- a control nothing exercises is one
 * that can be removed without a suite noticing.
 */
class CloudClientTest {

    /* The whole point of the relay: a path, never a host.
     *
     * Asserted through request() rather than against isSafePath directly. The
     * first version of this test called the predicate, and a mutation deleting
     * the CALL to it from request() survived: the control could be removed
     * entirely and the suite stayed green, which is the exact shape the review
     * that prompted this file warned about. No network happens here -- the
     * check throws before a client is touched. */
    @Test
    fun `request refuses anything that is not a host-relative path`() {
        assertFalse(CloudClient.ORIGIN.endsWith("/"))
        for (p in listOf(
            "https://evil.example/api",
            "api/config",
            // Protocol-relative: resolves against the origin to a DIFFERENT
            // HOST, and a naive "must start with /" check passes it.
            "//evil.example/api",
            "\\\\evil.example/api",
        )) {
            try {
                CloudClient.request(p, "GET", null, null)
                throw AssertionError("relayed a non-path: $p")
            } catch (e: CloudClient.BadPath) {
                // expected
            }
        }
        assertTrue(HubClient.isSafePath("/api/push/subscribe"))
    }

    @Test
    fun `the credential headers the backend authorises on are forwarded`() {
        for (h in listOf("X-Hestia-Token", "X-Hestia-Proof", "X-Hestia-Recovery")) {
            assertTrue(h, CloudClient.forwardable(h))
        }
        assertTrue(CloudClient.forwardable("Content-Type"))
        assertTrue(CloudClient.forwardable("If-None-Match"))
    }

    @Test
    fun `transport framing belongs to OkHttp, not the page`() {
        // Host is the one that mattered: forging it on a request to Cloudflare's
        // anycast edge is domain fronting.
        for (h in listOf("Host", "Content-Length", "Connection", "Transfer-Encoding",
                         "Upgrade", "Keep-Alive", "TE", "Trailer", "Proxy-Connection",
                         "Cookie", "Cookie2")) {
            assertFalse(h, CloudClient.forwardable(h))
        }
    }

    /* CF-Connecting-IP is the ONLY thing identifying a household anywhere in
       the backend. Cloudflare is believed to overwrite a supplied value, but
       its reference page documents that for other headers and not this one, so
       not forwarding it removes a dependency on behaviour documented by
       implication. */
    @Test
    fun `nothing the page sends can claim to be a different client address`() {
        for (h in listOf("CF-Connecting-IP", "cf-connecting-ip", "X-Forwarded-For",
                         "X-Real-IP", "True-Client-IP", "X-Forwarded-Host",
                         "X-Forwarded-Proto")) {
            assertFalse(h, CloudClient.forwardable(h))
        }
    }

    /* No handler reads these today. The hub-served CORS work is an open design
       conversation, and an Origin allow-list added then would be bypassable
       from here on day one -- silently, because the relay is the only caller
       that could forge one. */
    @Test
    fun `the rest of fetch's forbidden list is denied too`() {
        for (h in listOf("Origin", "Referer", "Date", "DNT", "Via", "Expect",
                         "Accept-Charset", "Accept-Encoding",
                         "Proxy-Authorization", "Sec-Fetch-Mode",
                         "Access-Control-Request-Method")) {
            assertFalse(h, CloudClient.forwardable(h))
        }
    }

    /* OkHttp accepts any byte in 0x21..0x7e as a header name, which is wider
       than an HTTP token. So ":authority" and "Host:" are names it would take
       and that an exact lowercased match could never catch. Enumerating names
       cannot close that; rejecting non-tokens can. */
    @Test
    fun `a name that is not an HTTP token is refused whatever it spells`() {
        for (h in listOf(":authority", "Host:", "Host ", " Host", "X Hestia Token",
                         "X-Hestia-Tokén", "", "X-Hestia-Token\u0001")) {
            assertFalse("[$h]", CloudClient.forwardable(h))
        }
    }
}
