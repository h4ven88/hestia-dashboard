package com.hestari.hestia

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * The pin decision, which is the whole of the app's trust in the hub.
 *
 * This matters more than its size suggests. The hub's certificate is
 * self-signed and carries no subjectAltName, so NOTHING else is validating it:
 * the chain reaches no trusted root and hostname verification is deliberately
 * replaced because there is no name to verify. If the pin comparison is wrong,
 * the app trusts whatever answers on that address and nothing anywhere else
 * would notice.
 *
 * Two throwaway certificates, generated for this test and used nowhere else.
 * The real hub's certificate is deliberately NOT embedded: it would publish
 * one household's key material into a public repository for no benefit.
 */
class HubTrustTest {

    private fun load(name: String): X509Certificate {
        val stream = javaClass.classLoader!!.getResourceAsStream(name)
            ?: error("missing test resource $name")
        return CertificateFactory.getInstance("X.509")
            .generateCertificate(stream) as X509Certificate
    }

    private val certA by lazy { load("hub-a.pem") }
    private val certB by lazy { load("hub-b.pem") }

    @Test
    fun `a pin is stable for the same certificate`() {
        assertEquals(HubTrust.pinOf(certA), HubTrust.pinOf(certA))
    }

    @Test
    fun `different certificates produce different pins`() {
        assertNotEquals(HubTrust.pinOf(certA), HubTrust.pinOf(certB))
    }

    @Test
    fun `a pin looks like base64 sha-256`() {
        // 32 bytes base64 with padding is 44 characters. A pin of the wrong
        // shape usually means the digest or the encoder was changed.
        val pin = HubTrust.pinOf(certA)
        assertEquals(44, pin.length)
        assertTrue(pin.endsWith("="))
    }

    @Test
    fun `first use accepts whatever is presented and reports it`() {
        val seen = HubTrust.checkChain(null, arrayOf(certA))
        assertEquals(HubTrust.pinOf(certA), seen)
    }

    @Test
    fun `the pinned certificate is accepted`() {
        val pin = HubTrust.pinOf(certA)
        assertEquals(pin, HubTrust.checkChain(pin, arrayOf(certA)))
    }

    /** The one that matters. */
    @Test
    fun `a different certificate is refused`() {
        val pin = HubTrust.pinOf(certA)
        try {
            HubTrust.checkChain(pin, arrayOf(certB))
            fail("a changed key must be refused, not silently re-pinned")
        } catch (e: HubTrust.PinMismatch) {
            assertEquals(pin, e.expected)
            assertEquals(HubTrust.pinOf(certB), e.actual)
        }
    }

    @Test
    fun `an empty chain is refused rather than treated as a match`() {
        try {
            HubTrust.checkChain(HubTrust.pinOf(certA), emptyArray())
            fail("an empty chain proves nothing and must not pass")
        } catch (e: HubTrust.PinMismatch) {
            assertEquals("", e.actual)
        }
    }

    @Test
    fun `only the leaf is pinned, not something further up the chain`() {
        /* checkServerTrusted receives the chain leaf-first. Pinning anything
           but the leaf would let a certificate signed by the same issuer
           impersonate the hub. */
        val pinOfLeaf = HubTrust.pinOf(certA)
        assertEquals(pinOfLeaf, HubTrust.checkChain(null, arrayOf(certA, certB)))
    }
}
