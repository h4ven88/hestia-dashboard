/**
 * Hestia™ Home Dashboard v1.3.1
 * ════════════════════════════════════════════════════════════════
 * Lightweight companion app — discovery helper and config store.
 *
 * The dashboard is served from https://www.hestari.com (Cloudflare)
 * or directly from the hub at http://[hub-ip]/local/index.html.
 * This app no longer fetches or hosts the dashboard HTML — Cloudflare
 * handles that. Its sole responsibilities are:
 *
 *   1. Write hestia-token.json  — Maker API credentials for local
 *      network auto-discovery by the dashboard on new devices
 *   2. Store and serve config   — cross-device settings sync
 *   3. Health check + version   — status endpoints
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
@Field static final String APP_VERSION     = "1.3.1"
@Field static final String TOKEN_FILENAME  = "hestia-token.json"
@Field static final String CONFIG_FILENAME = "hestia-config.json"

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
                "<strong>Hosted:</strong> <a href=\"https://www.hestari.com\" target=\"_blank\">https://www.hestari.com</a> — always up to date\n\n" +
                "<strong>Local:</strong> <a href=\"http://${hubIp}/local/index.html\" target=\"_blank\">http://${hubIp}/local/index.html</a> — works without internet\n\n" +
                "To use hestari.com, add to <strong>Maker API → Allowed Hosts (for CORS)</strong>:\n" +
                "<code>https://www.hestari.com, https://hestari.com</code>"
        }

        section("Status") {
            def hubIp = location.hubs[0].localIP
            paragraph "App version: ${APP_VERSION}\n" +
                "Config stored: ${state.configSize ? state.configSize + ' bytes' : 'none'}\n" +
                "Discovery file: ${state.discoveryWritten ? '✓ /local/' + TOKEN_FILENAME : '⚠ not written — click Done to refresh'}\n" +
                "App ID: ${app.id}\n" +
                "Hub IP: ${hubIp}"
        }

        section("Actions") {
            input "resetConfig", "button", title: "🗑 Clear Stored Config"
        }

        section("About") {
            paragraph "Hestia™ v${APP_VERSION} · © 2026 Haven · CC BY-NC 4.0\n" +
                "https://github.com/h4ven88/hestia-dashboard"
        }
    }
}

def appButtonHandler(btn) {
    if (btn == "resetConfig") {
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
