package com.hestari.hestia

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests the real shipped functions from [HubDiscovery], not a reimplementation
 * of what they are supposed to do. Two copies of the same assumption agreeing
 * proves nothing.
 *
 * Only the pure half is covered here: turning an mDNS record into a hub, and
 * collapsing repeat sightings. The multicast browse itself needs a network and
 * a real hub, and is verified on hardware instead -- a stubbed NsdManager
 * would be exactly the drifting mirror this project has been burned by.
 */
class HubDiscoveryTest {

    /** Exactly what a C-8 Pro published on 2026-10-13, field for field. */
    private val realHub = mapOf(
        "IPv4" to "192.168.50.139",
        "platformVersion" to "2.5.1.183",
        "name" to "Haven's Hubitat",
        "id" to "34:E1:D1:82:32:0A",
        "hubUID" to "2ba960c9-7f3a-4199-8d6d-87e4160bf1ad",
        "hubVersion" to "C-8 Pro",
    )

    @Test
    fun `reads a real hub record`() {
        val h = HubDiscovery.hubFrom("Hubitat Haven's Hubitat", "192.168.50.139", realHub, true)
        assertEquals("https://192.168.50.139", h.origin)
        assertEquals("192.168.50.139", h.ip)
        assertEquals("2ba960c9-7f3a-4199-8d6d-87e4160bf1ad", h.hubId)
        assertEquals("Haven's Hubitat", h.name)
        assertEquals("C-8 Pro", h.model)
        assertEquals("2.5.1.183", h.version)
        assertTrue(h.reachable)
    }

    /* THE POINT OF THIS ONE. The hub advertises port 80 in its SRV record and
       this app never sends cleartext -- usesCleartextTraffic is false, so an
       http origin is a hub the app can never talk to. No input may produce
       one. */
    @Test
    fun `origin is always https, never the advertised port`() {
        val withPort = realHub + mapOf("port" to "80", "IPv4" to "10.0.0.5")
        val h = HubDiscovery.hubFrom("x", "10.0.0.5", withPort, true)
        assertEquals("https://10.0.0.5", h.origin)
        assertFalse(h.origin.contains(":80"))
        assertFalse(h.origin.startsWith("http://"))
    }

    @Test
    fun `falls back to the MAC when the platform publishes no UID`() {
        val older = realHub - "hubUID"
        assertEquals("34:E1:D1:82:32:0A", HubDiscovery.hubFrom("x", "1.2.3.4", older, true).hubId)
    }

    @Test
    fun `falls back to the address when the record identifies nothing`() {
        val bare = realHub - "hubUID" - "id"
        assertEquals("1.2.3.4", HubDiscovery.hubFrom("x", "1.2.3.4", bare, true).hubId)
    }

    /* An empty TXT value and a missing key must behave identically. A hub
       publishing hubUID= with nothing after it would otherwise get "" as its
       identity, and every such hub would dedupe into one row. */
    @Test
    fun `an empty value is treated as absent, not as an identity`() {
        val blank = realHub + mapOf("hubUID" to "", "id" to "")
        assertEquals("1.2.3.4", HubDiscovery.hubFrom("x", "1.2.3.4", blank, true).hubId)
    }

    @Test
    fun `falls back to the service name when the record is unnamed`() {
        val unnamed = realHub - "name"
        assertEquals("Hubitat Kitchen", HubDiscovery.hubFrom("Hubitat Kitchen", "1.2.3.4", unnamed, true).name)
    }

    @Test
    fun `an unreachable hub is still named, so the picker can say why`() {
        val h = HubDiscovery.hubFrom("x", "192.168.50.139", realHub, false)
        assertFalse(h.reachable)
        assertEquals("Haven's Hubitat", h.name)
        assertEquals("C-8 Pro", h.model)
    }

    // ---- dedupe ----

    private fun hub(id: String, ip: String, reachable: Boolean) =
        HubDiscovery.hubFrom("x", ip, realHub + mapOf("hubUID" to id), reachable)

    @Test
    fun `one hub seen twice is one row`() {
        val out = HubDiscovery.dedupe(listOf(hub("A", "1.1.1.1", true), hub("A", "1.1.1.1", true)))
        assertEquals(1, out.size)
    }

    /* The mDNS reflector case, observed on the test network: a router
       rebroadcasts the hub's record as its own address, so the same hubUID
       arrives twice at different addresses and only one of them answers. */
    @Test
    fun `a reachable sighting beats an unreachable one for the same hub`() {
        val out = HubDiscovery.dedupe(listOf(
            hub("A", "192.168.50.37", false),     // the reflector, serves nothing
            hub("A", "192.168.50.139", true),     // the hub itself
        ))
        assertEquals(1, out.size)
        assertEquals("192.168.50.139", out[0].ip)
        assertTrue(out[0].reachable)
    }

    @Test
    fun `an already reachable sighting is not displaced by a later one`() {
        val out = HubDiscovery.dedupe(listOf(
            hub("A", "192.168.50.139", true),
            hub("A", "192.168.50.37", true),
        ))
        assertEquals(1, out.size)
        assertEquals("192.168.50.139", out[0].ip)
    }

    @Test
    fun `two genuinely different hubs both survive, in the order found`() {
        val out = HubDiscovery.dedupe(listOf(hub("A", "1.1.1.1", true), hub("B", "2.2.2.2", true)))
        assertEquals(2, out.size)
        assertEquals(listOf("A", "B"), out.map { it.hubId })
    }

    @Test
    fun `nothing found is not an error`() {
        assertEquals(emptyList<HubDiscovery.Found>(), HubDiscovery.dedupe(emptyList()))
    }
}
