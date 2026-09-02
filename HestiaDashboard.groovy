/**
 * Hestia™ Home Dashboard v1.6.3
 * ════════════════════════════════════════════════════════════════
 * Lightweight companion app — discovery helper and config store.
 *
 * The dashboard is served from https://hestari.com (Cloudflare)
 * or directly from the hub at http://[hub-ip]/local/index.html.
 * This companion app handles:
 *
 *   1. Download index.html      — fetch from GitHub on install/upgrade
 *   2. Write hestia-token.json  — Maker API credentials for local
 *      network auto-discovery by the dashboard on new devices
 *   3. Store and serve config   — cross-device settings sync
 *   4. Health check + version   — status endpoints
 *   5. Push notifications (arm-state) — subscribes to HSM directly and
 *      relays arm-state to Cloudflare, so it keeps working even when
 *      nobody has the dashboard open. Device-level events (doors, windows,
 *      locks, motion, smoke, water) are NOT handled here -- Maker API's own
 *      "POST URL" webhook feature sends those straight to Cloudflare,
 *      registered automatically by dashboard.html the first time push is
 *      enabled. Groovy apps can't reliably make outbound HTTP calls back to
 *      their own hub's Maker API, so this app never polls anything.
 *
 * Copyright © 2026 Haven. All rights reserved.
 * License: CC BY-NC 4.0 — personal use only.
 * https://github.com/h4ven88/hestia-dashboard
 *
 * ── ENDPOINTS ───────────────────────────────────────────────────
 * GET     /config    Returns stored config JSON
 * POST    /config    Saves config JSON
 * OPTIONS /config    CORS preflight
 * GET     /version   Returns app version info
 * GET     /ping      Health check
 */

import groovy.transform.Field

definition(
    name:         "Hestia Dashboard",
    namespace:    "h4ven88",
    author:       "Haven",
    description:  "Hestia™ companion app — local discovery and config sync.",
    category:     "Utility",
    iconUrl:      "",
    iconX2Url:    "",
    oauthEnabled: true
)

preferences {
    page(name: "mainPage")
}

// ── Constants ─────────────────────────────────────────────────────────────
@Field static final String APP_VERSION        = "1.6.4"
@Field static final String TOKEN_FILENAME      = "hestia-token.json"
@Field static final String CONFIG_FILENAME     = "hestia-config.json"
@Field static final String DASHBOARD_FILENAME  = "index.html"
@Field static final String DASHBOARD_URL       = "https://raw.githubusercontent.com/h4ven88/hestia-dashboard/main/index.html"
@Field static final String BUILD_INFO_URL      = "https://raw.githubusercontent.com/h4ven88/hestia-dashboard/main/build-info.json"

// ── Push notifications ───────────────────────────────────────────────────
@Field static final String PUSH_SEND_URL  = "https://hestari.com/api/push/send"
@Field static final String PUSH_ARMED_URL = "https://hestari.com/api/push/armed"

// ── CORS headers ──────────────────────────────────────────────────────────
// Enabled by default — endpoints require OAuth tokens so there is no
// security risk. The dashboard at hestari.com needs cross-origin access
// to sync config and generate wall panel URLs.
@Field static final Map CORS_HEADERS = [
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
]

// ── Endpoint mappings ─────────────────────────────────────────────────────
mappings {
    path("/config") {
        action: [ GET: "getConfig", POST: "saveConfig", OPTIONS: "preflight" ]
    }
    path("/version") {
        action: [ GET: "getVersion", OPTIONS: "preflight" ]
    }
    path("/ping") {
        action: [ GET: "ping", OPTIONS: "preflight" ]
    }
}

// ── CORS preflight handler ────────────────────────────────────────────────
def preflight() {
    render contentType: "text/plain", headers: CORS_HEADERS, data: ""
}

// ── UI Page ───────────────────────────────────────────────────────────────
def mainPage() {
    if (!state.accessToken) {
        try { createAccessToken() } catch(e) {
            log.error "Hestia: enable OAuth in Apps Code first: ${e.message}"
        }
    }

    dynamicPage(name: "mainPage", title: "Hestia™ Dashboard",
                install: true, uninstall: true, refreshInterval: 0) {

        section("") {
            paragraph "<h2>Hestia™ Home Dashboard</h2><em>Your safe haven, at a glance.</em>"
        }

        section("Access") {
            def hubIp = location.hubs[0].localIP
            paragraph "Open your dashboard:\n\n" +
                "<strong>Cloud:</strong> <a href=\"https://hestari.com\" target=\"_blank\">https://hestari.com</a> — always the latest version, requires internet for initial page load\n\n" +
                "<strong>Local:</strong> <a href=\"http://${hubIp}/local/${DASHBOARD_FILENAME}\" target=\"_blank\">http://${hubIp}/local/${DASHBOARD_FILENAME}</a> — runs entirely on your LAN, no internet required\n\n" +
                "Both versions connect to your hub the same way. The local file is updated automatically when the app is installed or upgraded.\n\n" +
                "To use hestari.com, add to <strong>Maker API → Allowed Hosts (for CORS)</strong>:\n" +
                "<code>https://hestari.com, https://www.hestari.com</code>"
        }

        section("Status") {
            def hubIp = location.hubs[0].localIP
            def push  = getPushSettings()
            paragraph "App version: ${APP_VERSION}\n" +
                "Dashboard file: ${state.dashboardInstalled ? '✓ /local/' + DASHBOARD_FILENAME + ' (v' + (state.dashboardVersion ?: '?') + ')' : '⚠ not installed — click Done to download'}\n" +
                "Discovery file: ${state.discoveryWritten ? '✓ /local/' + TOKEN_FILENAME : '⚠ not written — click Done to refresh'}\n" +
                "Config stored: ${state.configSize ? state.configSize + ' bytes' : 'none'}\n" +
                "Push notifications: ${push?.pushEnabled == true ? '✓ active (via Maker API webhook)' : '— disabled'}\n" +
                "App ID: ${app.id}\n" +
                "Hub IP: ${hubIp}"
        }

        section("Actions") {
            input "updateDashboard", "button", title: "⬇ Update Dashboard File"
            input "resetConfig", "button", title: "🗑 Clear Stored Config"
        }

        section("About") {
            paragraph "Hestia™ v${APP_VERSION} · © 2026 Haven · CC BY-NC 4.0\n" +
                "https://github.com/h4ven88/hestia-dashboard"
        }
    }
}

def appButtonHandler(btn) {
    if (btn == "updateDashboard") {
        downloadDashboard(true)
    } else if (btn == "resetConfig") {
        state.config     = null
        state.configSize = null
        try { uploadHubFile(CONFIG_FILENAME, "null".getBytes("UTF-8")) } catch(e) {}
        log.info "Hestia: config cleared"
    }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
def installed() { initialize() }
def updated()   { initialize() }

def initialize() {
    if (!state.accessToken) {
        try { createAccessToken() } catch(e) {
            log.error "Hestia: could not create access token: ${e.message}"
        }
    }
    unschedule()
    unsubscribe()
    downloadDashboard(false)
    writeDiscovery()
    subscribe(location, "hsmStatus", "pushHsmStatusHandler")
    subscribe(location, "hsmAlert",  "pushHsmAlertHandler")
    pushSeedArmedStatus()
    log.info "Hestia: initialized v${APP_VERSION} — app ID: ${app.id}"
}

// ── Discovery file ────────────────────────────────────────────────────────
def writeDiscovery() {
    if (!state.accessToken) return
    try {
        def hubIp      = location.hubs[0].localIP
        def makerAppId = ""
        def makerToken = ""
        if (state.config) {
            try {
                def cfg = new groovy.json.JsonSlurper().parseText(state.config)
                makerAppId = cfg?.config?.appId ?: ""
                makerToken = cfg?.config?.token ?: ""
            } catch(e) {}
        }
        def json = new groovy.json.JsonBuilder([
            appId:         app.id.toString(),
            token:         state.accessToken,
            hubIp:         hubIp,
            version:       APP_VERSION,
            makerApiAppId: makerAppId,
            makerApiToken: makerToken
        ]).toString()
        uploadHubFile(TOKEN_FILENAME, json.getBytes("UTF-8"))
        state.discoveryWritten = true
        log.info "Hestia: discovery file written → /local/${TOKEN_FILENAME}"
    } catch(e) {
        state.discoveryWritten = false
        log.warn "Hestia: could not write discovery file: ${e.message}"
    }
}

// ── Dashboard file download ───────────────────────────────────────────────
def downloadDashboard(Boolean force) {
    if (!force) {
        try {
            def latestVersion = null
            httpGet([uri: BUILD_INFO_URL, textParser: false, timeout: 15]) { resp ->
                if (resp.status == 200) latestVersion = resp.data?.version
            }
            if (!latestVersion || latestVersion == state.dashboardVersion) return
            log.info "Hestia: dashboard update available — local v${state.dashboardVersion ?: '?'}, latest v${latestVersion}"
        } catch(e) {
            log.debug "Hestia: could not check for dashboard updates: ${e.message}"
            return
        }
    }
    try {
        httpGet([uri: DASHBOARD_URL, textParser: true, timeout: 30]) { response ->
            if (response.status == 200) {
                def content = response.data.text
                uploadHubFile(DASHBOARD_FILENAME, content.getBytes("UTF-8"))
                def version = (content =~ /HESTIA_VERSION\s*=\s*'([^']+)'/)
                state.dashboardVersion  = version ? version[0][1] : APP_VERSION
                state.dashboardInstalled = true
                log.info "Hestia: dashboard v${state.dashboardVersion} installed → /local/${DASHBOARD_FILENAME} (${content.length()} bytes)"
            } else {
                log.warn "Hestia: dashboard download failed — HTTP ${response.status}"
            }
        }
    } catch(e) {
        log.warn "Hestia: could not download dashboard: ${e.message}"
    }
}

// ── Push notifications ────────────────────────────────────────────────────
// The actual device-event trigger lives in Cloudflare now: dashboard.html
// registers a webhook URL with Maker API's own built-in "POST URL"
// device-event feature (pushRegisterMakerApiWebhook() in dashboard.html),
// and Maker API POSTs every device event straight there, where the
// categorization/gating logic runs against the same synced config. This
// app doesn't poll Maker API for device state at all anymore -- a Groovy
// app running on the hub can't reliably make outbound HTTP calls back to
// its own hub's Maker API (confirmed the hard way: connection-refused on
// both the hub's LAN IP and 127.0.0.1), so polling was a dead end
// regardless of hub URL scheme.
//
// What's left here is native subscribe(location, ...) for HSM, which was
// never affected by any of that since it's an internal event bus
// subscription, not a network call. Arm-state gets relayed outward to
// Cloudflare -- an ordinary outbound call, exactly like the alarm send
// below -- so the webhook handler knows current arm state when a device
// event needs "armed only" gating.

// Parses state.config once and returns just the fields push notifications
// need, or null if config/token isn't available yet.
def getPushSettings() {
    if (!state.config || state.config == "null") return null
    try {
        def cfg = new groovy.json.JsonSlurper().parseText(state.config)
        def c = cfg?.config
        if (!c?.appId || !c?.token) return null
        return c
    } catch (e) {
        return null
    }
}

// HSM status → armed/disarmed, mirrors the dashboard's own artemisHsmSync()
// classification (armedAway/armedHome/armedNight count as armed; anything
// mid-transition or disarmed does not, so "armed only" devices don't fire
// during the entry/exit delay countdown).
def pushHsmStatusHandler(evt) {
    def v = (evt.value ?: "").toLowerCase()
    def armed = (v.contains("armed") && !v.contains("disarmed") && !v.contains("arming"))
    state.pushArmed = armed
    pushRelayArmedState(armed)
}

// Seeds state.pushArmed from location.hsmStatus directly -- a native
// property on the app's own location object, no network call needed at
// all, unlike the old HTTP-based seed this replaced.
def pushSeedArmedStatus() {
    def v = (location.hsmStatus ?: "").toString().toLowerCase()
    def armed = (v.contains("armed") && !v.contains("disarmed") && !v.contains("arming"))
    state.pushArmed = armed
    pushRelayArmedState(armed)
}

def pushRelayArmedState(Boolean armed) {
    def push = getPushSettings()
    if (push?.pushEnabled != true) return
    try {
        asynchttpPost("pushSendCallback", [
            uri: PUSH_ARMED_URL,
            contentType: "application/json",
            requestContentType: "application/json",
            timeout: 10,
            body: new groovy.json.JsonBuilder([armed: armed, token: push.token]).toString()
        ])
    } catch (e) {
        log.warn "Hestia Push: armed-state relay error: ${e.message}"
    }
}

// hsmAlert fires on intrusion (the actual burglar-alarm trip). Smoke/CO and
// water go through the Maker API device-event webhook instead of HSM,
// since not everyone has HSM Monitor watching those sensors at all.
def pushHsmAlertHandler(evt) {
    def push = getPushSettings()
    if (!push || push.pushEnabled != true || push.pushAlarming == false) return
    def v = (evt.value ?: "").toLowerCase()
    if (!v.startsWith("intrusion")) return
    def scope = v.contains("home") ? "Home" : "Away"
    pushSendNotification("alarming", "Security Alarm", "${scope} intrusion alarm triggered!", push.token)
}

def pushSendNotification(String category, String title, String body, String token) {
    try {
        asynchttpPost("pushSendCallback", [
            uri: PUSH_SEND_URL,
            contentType: "application/json",
            requestContentType: "application/json",
            timeout: 10,
            body: new groovy.json.JsonBuilder([
                category: category,
                title:    title,
                body:     body,
                armed:    state.pushArmed == true,
                token:    token
            ]).toString()
        ])
    } catch (e) {
        log.warn "Hestia Push: send error: ${e.message}"
    }
}

def pushSendCallback(response, data) {
    if (response?.status != 200) {
        log.warn "Hestia Push: send failed — HTTP ${response?.status}"
    }
}

// ── Config endpoints ──────────────────────────────────────────────────────
def getConfig() {
    def cfg = state.config
    if (!cfg || cfg == "null") {
        try {
            def bytes = downloadHubFile(CONFIG_FILENAME)
            if (bytes) {
                cfg = new String(bytes, "UTF-8")
                state.config = cfg
                state.configSize = cfg.length()
                log.info "Hestia: config restored from hub file (${cfg.length()} bytes)"
            }
        } catch(e) {}
    }
    render contentType: "application/json", headers: CORS_HEADERS,
           data: (cfg ?: "null")
}

def saveConfig() {
    try {
        def body = request.body
        if (!body) {
            render contentType: "application/json", headers: CORS_HEADERS,
                   data: '{"status":"error","message":"empty body"}'
            return
        }
        new groovy.json.JsonSlurper().parseText(body)
        try { uploadHubFile(CONFIG_FILENAME, body.getBytes("UTF-8")) } catch(e) {
            log.warn "Hestia: hub file write failed: ${e.message}"
        }
        state.config     = body
        state.configSize = body.length()
        def verified = state.config?.length() ?: 0
        if (verified < body.length()) {
            log.warn "Hestia: state truncated (wrote ${body.length()}, stored ${verified}) — hub file is primary"
        }
        writeDiscovery()
        log.info "Hestia: config saved (${body.length()} bytes)"
        render contentType: "application/json", headers: CORS_HEADERS,
               data: '{"status":"ok"}'
    } catch(e) {
        log.error "Hestia: config save error: ${e.message}"
        render contentType: "application/json", headers: CORS_HEADERS,
               data: """{"status":"error","message":"${e.message.replace('"','\\"')}"}"""
    }
}

// ── Version + health endpoints ────────────────────────────────────────────
def getVersion() {
    render contentType: "application/json", headers: CORS_HEADERS,
           data: new groovy.json.JsonBuilder([
               appVersion:   APP_VERSION,
               configStored: state.config != null,
               configSize:   state.configSize ?: 0,
               appId:        app.id
           ]).toString()
}

def ping() {
    render contentType: "application/json", headers: CORS_HEADERS,
           data: new groovy.json.JsonBuilder([
               status:       "ok",
               app:          "Hestia Dashboard",
               version:      APP_VERSION,
               appId:        app.id,
               configStored: state.config != null
           ]).toString()
}
