/**
 * Hestia™ Home Dashboard v1.4.0
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
@Field static final String APP_VERSION        = "1.4.0"
@Field static final String TOKEN_FILENAME      = "hestia-token.json"
@Field static final String CONFIG_FILENAME     = "hestia-config.json"
@Field static final String DASHBOARD_FILENAME  = "index.html"
@Field static final String DASHBOARD_URL       = "https://raw.githubusercontent.com/h4ven88/hestia-dashboard/main/index.html"

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
            paragraph "App version: ${APP_VERSION}\n" +
                "Dashboard file: ${state.dashboardInstalled ? '✓ /local/' + DASHBOARD_FILENAME + ' (v' + (state.dashboardVersion ?: '?') + ')' : '⚠ not installed — click Done to download'}\n" +
                "Discovery file: ${state.discoveryWritten ? '✓ /local/' + TOKEN_FILENAME : '⚠ not written — click Done to refresh'}\n" +
                "Config stored: ${state.configSize ? state.configSize + ' bytes' : 'none'}\n" +
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
    downloadDashboard(false)
    writeDiscovery()
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
    if (!force && state.dashboardVersion == APP_VERSION) return
    try {
        httpGet([uri: DASHBOARD_URL, textParser: true, timeout: 30]) { response ->
            if (response.status == 200) {
                def content = response.data.text
                uploadHubFile(DASHBOARD_FILENAME, content.getBytes("UTF-8"))
                state.dashboardVersion  = APP_VERSION
                state.dashboardInstalled = true
                log.info "Hestia: dashboard v${APP_VERSION} installed → /local/${DASHBOARD_FILENAME} (${content.length()} bytes)"
            } else {
                log.warn "Hestia: dashboard download failed — HTTP ${response.status}"
            }
        }
    } catch(e) {
        log.warn "Hestia: could not download dashboard: ${e.message}"
    }
}

// ── Config endpoints ──────────────────────────────────────────────────────
def getConfig() {
    render contentType: "application/json", headers: CORS_HEADERS,
           data: (state.config ?: "null")
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
        state.config     = body
        state.configSize = body.length()
        try { uploadHubFile(CONFIG_FILENAME, body.getBytes("UTF-8")) } catch(e) {}
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
