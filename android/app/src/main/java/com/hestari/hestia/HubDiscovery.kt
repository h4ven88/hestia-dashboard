package com.hestari.hestia

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkAddress
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import kotlin.coroutines.resume

/**
 * Finds Hubitat hubs on the local network, by asking the network rather than
 * searching it.
 *
 * "Install it, it finds your hub, you add your devices" is the sentence that
 * justifies building a native app at all. Today a new device needs a hub
 * address, an app id and a token pasted in by hand, then a certificate
 * accepted once per device, and that has been the largest single source of
 * support traffic in this project's history.
 *
 * ── THE SUBNET SWEEP IS GONE, AND IT IS NOT COMING BACK ──
 *
 * The first design connected to port 443 on every address in the subnet and
 * fingerprinted whatever answered. It never found the hub, and five rounds of
 * tuning timeouts, concurrency, socket factories and source-address binding
 * never made it. The logs eventually said why, on a Galaxy A16 against a real
 * hub at .139:
 *
 *   scan 192.168.50.106: SocketException: Binding socket to network 105
 *                        failed: EPERM (Operation not permitted)
 *   WifiConnectivityMonitor: NETWORK_DISCONNECTION_EVENT local=0 reason=10014
 *   ConnectivityService: [105 WIFI] going from CONNECTED to DISCONNECTED
 *
 * `local=0` is the whole story: the ACCESS POINT deauthenticated the phone.
 * Around a hundred addresses in, the router's flood protection classified the
 * sweep as what it is -- a port scan of its own subnet -- and dropped the
 * client. netId 105 then no longer existed, so every remaining socket failed
 * EPERM instantly. The hub sits at .139, past the point where the link died,
 * so the sweep had never once reached it.
 *
 * Both observed runs died at ~11s and ~100 addresses. This is not a tuning
 * problem: a sweep broad enough to find a hub anywhere in the subnet is a port
 * scan, and lowering concurrency only postpones the deauth. Shipping it would
 * mean a discovery feature whose failure mode is knocking the user off their
 * own Wi-Fi, which is worse than not having the feature.
 *
 * ── WHAT THE HUB ACTUALLY DOES ──
 *
 * SSDP was tried first and failed: thirteen devices answered multicast on the
 * test network and every one was the router. That result said nothing about
 * mDNS, which is a different protocol, and the hub speaks it fluently. Probed
 * against real hardware on 2026-10-13, the hub advertises a service type of
 * its own, carrying its full identity in TXT:
 *
 *   PTR  _hubitat._tcp.local = Hubitat Haven's Hubitat._hubitat._tcp.local
 *   SRV  ...                 = port 80 -> HUBITAT.local
 *   A    HUBITAT.local       = 192.168.50.139
 *   TXT  ...                 = IPv4=192.168.50.139 | platformVersion=2.5.1.183
 *                              | name=Haven's Hubitat | id=34:E1:D1:82:32:0A
 *                              | hubUID=2ba960c9-7f3a-... | hubVersion=C-8 Pro
 *
 * So identity arrives for free, from one multicast query instead of 253 TCP
 * connects, and a second hub on the same network answers the same question.
 * `_hubitat._tcp` is specific to Hubitat, so nothing else on a home network
 * answers it by accident.
 *
 * THE ADVERTISED PORT IS DELIBERATELY IGNORED. SRV says 80, and this app never
 * sends cleartext -- that is what lets AndroidManifest keep
 * usesCleartextTraffic false. Every origin built here is https on 443.
 * Trusting the advertised port would produce a hub the app can never talk to.
 *
 * NO PIN DURING DISCOVERY. There is nothing to pin against yet, so any
 * certificate is accepted for the reachability check. The pin is established
 * when the user picks a hub and [HubClient.configure] runs. That window is on
 * the user's own LAN, which this project's threat model already places inside
 * the trust boundary, and the user confirms which hub they chose.
 *
 * mDNS is unauthenticated, so anything on the LAN can claim to be a hub. That
 * is why [Found.reachable] is confirmed over HTTPS against the hub's own
 * /hub2/hubData rather than taken on the advertiser's word -- one request per
 * hub found, which is why the thing that killed the sweep cannot recur here.
 */
object HubDiscovery {

    private const val TAG = "HestiaDiscovery"

    /** Hubitat's own service type. Android appends ".local." itself. */
    private const val SERVICE_TYPE = "_hubitat._tcp"

    /* How long to listen before answering.
     *
     * A fixed window rather than "return on the first hit", because returning
     * early would mean a household with two hubs sometimes sees one and
     * sometimes the other. Silently finding a subset is the exact failure this
     * feature exists to remove, and six seconds once on first run is cheap
     * next to showing the user the wrong hub. */
    private const val BROWSE_WINDOW_MS = 6_000L

    /* Resolves run ONE AT A TIME, deliberately. Before API 30 NsdManager
     * permits a single outstanding resolve and fails concurrent ones with
     * FAILURE_ALREADY_ACTIVE; minSdk here is 26. With a handful of hubs the
     * serial cost is irrelevant, so there is no reason to carry two code
     * paths for it. */
    private const val RESOLVE_TIMEOUT_MS = 4_000L
    private const val CONFIRM_TIMEOUT_MS = 6_000L

    /** The TXT keys the hub publishes that this app reads. Verified against a
     *  real C-8 Pro, not taken from documentation. */
    private val TXT_KEYS = listOf("hubUID", "id", "name", "hubVersion", "platformVersion", "IPv4")

    data class Found(
        val origin: String,
        val ip: String,
        val hubId: String,
        val name: String,
        val model: String,
        val version: String,
        /** Did it answer its own API over HTTPS? A hub found but unreachable is
         *  worth telling the user about; it is a different problem from no hub. */
        val reachable: Boolean,
    )

    class NoLocalNetwork : Exception(
        "this device is not on a local network, or local network access is not permitted"
    )

    /** The device's own IPv4 address on the active network. */
    private fun localAddress(ctx: Context): LinkAddress? {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val props = cm.getLinkProperties(cm.activeNetwork ?: return null) ?: return null
        return props.linkAddresses.firstOrNull {
            it.address is Inet4Address && !it.address.isLoopbackAddress
        }
    }

    /**
     * Listens for [SERVICE_TYPE] advertisements for [BROWSE_WINDOW_MS].
     *
     * Keyed by service name so a hub re-announcing itself mid-window counts
     * once. A failure to start is surfaced immediately instead of waiting out
     * the window for an empty answer, because "mDNS is unavailable on this
     * device" and "no hub on this network" need different advice.
     */
    private suspend fun browse(nsd: NsdManager): List<NsdServiceInfo> {
        val seen = LinkedHashMap<String, NsdServiceInfo>()
        val started = CompletableDeferred<Int>()   // 0 = started, otherwise the failure code

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                started.complete(0)
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                started.complete(errorCode)
            }

            override fun onServiceFound(info: NsdServiceInfo) {
                android.util.Log.i(TAG, "mDNS found: ${info.serviceName}")
                synchronized(seen) { seen[info.serviceName] = info }
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                synchronized(seen) { seen.remove(info.serviceName) }
            }

            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        }

        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        try {
            val code = withTimeoutOrNull(2_000L) { started.await() }
            if (code == null || code != 0) {
                android.util.Log.w(TAG, "mDNS discovery did not start (code=$code)")
                return emptyList()
            }
            delay(BROWSE_WINDOW_MS)
        } finally {
            // Discovery runs until stopped; leaking it would keep the system
            // daemon working on behalf of a scan nobody is waiting for.
            runCatching { nsd.stopServiceDiscovery(listener) }
        }
        return synchronized(seen) { seen.values.toList() }
    }

    /** Fills in host and TXT for one advertisement. */
    private suspend fun resolve(nsd: NsdManager, info: NsdServiceInfo): NsdServiceInfo? =
        withTimeoutOrNull(RESOLVE_TIMEOUT_MS) {
            suspendCancellableCoroutine { cont ->
                @Suppress("DEPRECATION")  // registerServiceInfoCallback is API 34+; minSdk is 26
                nsd.resolveService(info, object : NsdManager.ResolveListener {
                    override fun onServiceResolved(resolved: NsdServiceInfo) {
                        if (cont.isActive) cont.resume(resolved)
                    }

                    override fun onResolveFailed(failed: NsdServiceInfo, errorCode: Int) {
                        android.util.Log.d(TAG, "resolve ${failed.serviceName} failed: $errorCode")
                        if (cont.isActive) cont.resume(null)
                    }
                })
            }
        }

    private fun txt(info: NsdServiceInfo, key: String): String =
        runCatching { info.attributes?.get(key)?.toString(Charsets.UTF_8) }.getOrNull().orEmpty()

    /**
     * The hub's address, from the resolved A record where it is IPv4 and from
     * the TXT record otherwise.
     *
     * Both are needed. getHost() hands back one address which on a dual-stack
     * hub can be the IPv6 one, and an IPv6 literal would build an origin the
     * pinned client cannot match a certificate against. The hub also publishes
     * its own IPv4 in TXT, so there is a stated answer to fall back to.
     */
    private fun addressOf(info: NsdServiceInfo): String? {
        @Suppress("DEPRECATION")  // getHostAddresses is API 34+; minSdk is 26
        val host = runCatching { info.host }.getOrNull()
        if (host is Inet4Address) return host.hostAddress
        val stated = txt(info, "IPv4")
        return stated.ifEmpty { null }
    }

    /**
     * Does it answer the hub API over HTTPS?
     *
     * Identity is NOT taken from here. It comes from mDNS, one source, so that
     * a hub which fails this check is still named correctly in the picker
     * rather than appearing as a blank row. This call decides reachability and
     * nothing else.
     */
    private suspend fun confirm(client: okhttp3.OkHttpClient, origin: String): Boolean =
        withContext(Dispatchers.IO) {
            try {
                client.newCall(Request.Builder().url("$origin/hub2/hubData").get().build())
                    .execute().use { res ->
                        res.isSuccessful && JSONObject(res.body?.string().orEmpty())
                            .optString("hubId").isNotEmpty()
                    }
            } catch (e: Exception) {
                android.util.Log.d(TAG, "confirm $origin: ${e.javaClass.simpleName}: ${e.message}")
                false
            }
        }

    /**
     * One mDNS record to one hub. Pure, and takes no Android types, so the
     * fallback chains below are reachable by a plain JVM test rather than only
     * by holding a phone.
     *
     * The port is absent from the signature on purpose: there is no input that
     * can make this build anything other than an https origin on 443.
     */
    fun hubFrom(
        serviceName: String,
        ip: String,
        txt: Map<String, String>,
        reachable: Boolean,
    ): Found = Found(
        origin = "https://$ip",
        ip = ip,
        /* hubUID is a real UUID and survives an address change; the MAC in
           `id` is the fallback for an older platform that does not publish it,
           and the address is the last resort so a hub always has SOME stable
           identity to dedupe on. */
        hubId = txt["hubUID"].orEmpty().ifEmpty { txt["id"].orEmpty() }.ifEmpty { ip },
        name = txt["name"].orEmpty().ifEmpty { serviceName },
        model = txt["hubVersion"].orEmpty(),
        version = txt["platformVersion"].orEmpty(),
        reachable = reachable,
    )

    /**
     * Collapses repeat sightings of one hub, keeping the first.
     *
     * Not hypothetical. A home router with an mDNS repeater enabled rebroadcasts
     * other hosts' records as its own, which is what 192.168.50.37 was doing on
     * the test network while serving nothing on any port. Two rows for one hub
     * in the picker is a question the user cannot answer.
     *
     * Reachable sightings win, so a hub seen through a reflector that cannot be
     * reached does not mask the copy that can.
     */
    fun dedupe(hubs: List<Found>): List<Found> {
        val byId = LinkedHashMap<String, Found>()
        for (h in hubs) {
            val existing = byId[h.hubId]
            if (existing == null || (!existing.reachable && h.reachable)) byId[h.hubId] = h
        }
        return byId.values.toList()
    }

    /** Finds every Hubitat hub advertising itself on the local network. */
    suspend fun scan(ctx: Context): List<Found> {
        /* Checked for the error message, not for the sweep that used to need
           it: with no IPv4 link there is nothing to discover, and saying so
           beats an empty list the caller has to interpret. */
        val addr = localAddress(ctx) ?: throw NoLocalNetwork()
        android.util.Log.i(TAG, "browsing $SERVICE_TYPE from ${addr.address.hostAddress}")

        val nsd = ctx.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: throw NoLocalNetwork()
        val advertised = browse(nsd)
        android.util.Log.i(TAG, "mDNS: ${advertised.size} advertisement(s)")
        if (advertised.isEmpty()) return emptyList()

        val client = HubTrust.Pinned(null).client.newBuilder()
            .connectTimeout(java.time.Duration.ofMillis(CONFIRM_TIMEOUT_MS))
            .readTimeout(java.time.Duration.ofMillis(CONFIRM_TIMEOUT_MS))
            .build()

        val seen = mutableListOf<Found>()
        for (ad in advertised) {
            val info = resolve(nsd, ad) ?: continue
            val ip = addressOf(info) ?: continue
            seen += hubFrom(
                serviceName = info.serviceName.orEmpty(),
                ip = ip,
                txt = TXT_KEYS.associateWith { txt(info, it) },
                reachable = confirm(client, "https://$ip"),
            )
        }

        val found = dedupe(seen)
        android.util.Log.i(TAG, "discovered ${found.size} hub(s): " +
            found.joinToString { "${it.ip} ${it.model} reachable=${it.reachable}" })
        return found
    }

    fun toJson(found: List<Found>): JSONArray = JSONArray().apply {
        found.forEach {
            put(JSONObject()
                .put("origin", it.origin)
                .put("ip", it.ip)
                .put("hubId", it.hubId)
                .put("name", it.name)
                .put("model", it.model)
                .put("version", it.version)
                .put("reachable", it.reachable))
        }
    }
}
