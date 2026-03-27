/**
 *  Hestia™ Home Dashboard  v1.0.4
 *  ════════════════════════════════════════════════════════════════
 *  Single Hubitat app — serves the dashboard and stores config.
 *
 *  Copyright © 2025 Haven. All rights reserved.
 *  Licence: CC BY-NC 4.0 — personal use only.
 *  https://github.com/h4ven88/hestia-dashboard
 *
 *  Architecture: dashboard HTML is stored in Hub File Manager
 *  at /local/hestia-dashboard.html — not in state (state has
 *  a ~100KB limit; our dashboard is 214KB).
 *
 *  ── ENDPOINTS ───────────────────────────────────────────────────
 *  GET  /dashboard          Redirects to /local/hestia-dashboard.html
 *  GET  /config             Returns stored config JSON
 *  POST /config             Saves config JSON
 *  GET  /update             Fetches latest dashboard from GitHub
 *  GET  /version            Returns version info JSON
 *  GET  /ping               Health check
 */

import groovy.transform.Field

definition(
    name:        "Hestia Dashboard",
    namespace:   "h4ven88",
    author:      "Haven",
    description: "Hestia™ smart home dashboard — serves the dashboard and syncs config across devices.",
    category:    "Utility",
    iconUrl:     "",
    iconX2Url:   "",
    oauthEnabled: true
)

preferences {
    page(name: "mainPage")
}

// ── Constants ─────────────────────────────────────────────────────────────
@Field static final String GITHUB_RELEASE_URL =
    "https://github.com/h4ven88/hestia-dashboard/releases/download/v1.0.0/dashboard.min.html"

@Field static final String GITHUB_VERSION_URL =
    "https://api.github.com/repos/h4ven88/hestia-dashboard/releases/latest"

@Field static final String APP_VERSION        = "1.0.4"
@Field static final String DASHBOARD_FILENAME = "hestia-dashboard.html"
@Field static final String TOKEN_FILENAME     = "hestia-token.json"
@Field static final String CONFIG_FILENAME    = "hestia-config.json"

// ── Endpoint mappings ─────────────────────────────────────────────────────
mappings {
    path("/dashboard") {
        action: [ GET: "serveDashboard" ]
    }
    path("/config") {
        action: [ GET: "getConfig", POST: "saveConfig" ]
    }
    path("/update") {
        action: [ GET: "triggerUpdate" ]
    }
    path("/version") {
        action: [ GET: "getVersion" ]
    }
    path("/ping") {
        action: [ GET: "ping" ]
    }
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

        section("Dashboard URL") {
            if (state.accessToken && state.dashboardStored) {
                def hubIp   = location.hubs[0].localIP
                def dashUrl = "http://${hubIp}/apps/api/${app.id}/dashboard?access_token=${state.accessToken}"
                paragraph "Open this URL in any browser on your local network:\n\n" +
                          "<b>${dashUrl}</b>\n\n" +
                          "Bookmark it or save it as a PWA on your tablet."
            } else if (!state.dashboardStored) {
                paragraph "⚠ Dashboard not yet fetched. Click 'Fetch Latest Dashboard from GitHub' below."
            } else {
                paragraph "⚠ OAuth token not yet created. Save the app first, then reopen."
            }
        }

        section("Status") {
            def hubIp = location.hubs[0].localIP
            paragraph "Dashboard stored: ${state.dashboardStored ? '✓ /local/' + DASHBOARD_FILENAME + ' (' + (state.dashboardSize ?: '?') + ' bytes, cached ' + (state.dashboardCachedAt ?: '?') + ')' : '⚠ Not yet fetched'}\n" +
                      "Installed version: ${state.installedVersion ?: 'not fetched'}\n" +
                      "Latest on GitHub: ${state.latestVersion ?: 'unknown'}\n" +
                      "Config stored: ${state.configSize ? state.configSize + ' bytes' : 'none'}\n" +
                      "App ID: ${app.id}\n" +
                      "Hub IP: ${hubIp}"
        }

        section("Actions") {
            input "fetchDashboard", "button", title: "⬇ Fetch Latest Dashboard from GitHub"
            input "checkVersion",   "button", title: "🔍 Check for Updates"
            input "clearDashboard", "button", title: "🗑 Clear Dashboard File"
            input "resetConfig",    "button", title: "🗑 Clear Stored Config"
        }

        section("About") {
            paragraph "Hestia™ v${APP_VERSION} · © 2025 Haven · CC BY-NC 4.0\n" +
                      "https://github.com/h4ven88/hestia-dashboard"
        }
    }
}

def appButtonHandler(btn) {
    switch(btn) {
        case "fetchDashboard":
            fetchDashboardFromGitHub()
            break
        case "checkVersion":
            checkLatestVersion()
            break
        case "clearDashboard":
            state.dashboardStored  = false
            state.dashboardSize    = null
            state.dashboardCachedAt = null
            state.installedVersion = null
            try { uploadHubFile(DASHBOARD_FILENAME, "".getBytes("UTF-8")) } catch(e) {}
            log.info "Hestia: dashboard file cleared"
            break
        case "resetConfig":
            state.config     = null
            state.configSize = null
            try { uploadHubFile(CONFIG_FILENAME, "null".getBytes("UTF-8")) } catch(e) {}
            log.info "Hestia: config cleared"
            break
    }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

def installed()  { initialize() }
def updated()    { initialize() }

def initialize() {
    if (!state.accessToken) {
        try { createAccessToken() } catch(e) {
            log.error "Hestia: could not create access token: ${e.message}"
        }
    }
    writeDiscovery()
    if (!state.dashboardStored) fetchDashboardFromGitHub()
    schedule("0 0 3 * * ?", "checkLatestVersion")
    log.info "Hestia: initialized v${APP_VERSION} — app ID: ${app.id}"
}

// ── Discovery file ────────────────────────────────────────────────────────

def writeDiscovery() {
    if (!state.accessToken) return
    try {
        def hubIp = location.hubs[0].localIP
        def json  = new groovy.json.JsonBuilder([
            appId:    app.id,
            token:    state.accessToken,
            hubIp:    hubIp,
            version:  APP_VERSION
        ]).toString()
        uploadHubFile(TOKEN_FILENAME, json.getBytes("UTF-8"))
        log.info "Hestia: discovery file written → /local/${TOKEN_FILENAME}"
    } catch(e) {
        log.warn "Hestia: could not write discovery file: ${e.message}"
    }
}

// ── Dashboard fetch — stores in File Manager, NOT state ───────────────────

def fetchDashboardFromGitHub() {
    log.info "Hestia: fetching dashboard from GitHub → ${GITHUB_RELEASE_URL}"
    try {
        httpGet([
            uri:             GITHUB_RELEASE_URL,
            followRedirects: true,
            textParser:      true,
            headers:         ["User-Agent": "HestiaDashboard/${APP_VERSION}"]
        ]) { resp ->
            if (resp.status == 200) {
                def html = resp.data.text
                if (html && html.length() > 1000) {
                    // Ensure DOCTYPE is first
                    def dtIdx = html.toLowerCase().indexOf("<!doctype html>")
                    if (dtIdx < 0)       html = "<!DOCTYPE html>\n" + html
                    else if (dtIdx > 0)  html = "<!DOCTYPE html>\n" + html.substring(dtIdx + 15)

                    // Store in File Manager — no size limit
                    uploadHubFile(DASHBOARD_FILENAME, html.getBytes("UTF-8"))

                    // Store only metadata in state (tiny)
                    state.dashboardStored   = true
                    state.dashboardSize     = html.length()
                    state.dashboardCachedAt = new Date().format("yyyy-MM-dd HH:mm")

                    def vMatch = (html =~ /HESTIA_VERSION\s*=\s*['"]([^'"]+)['"]/)
                    state.installedVersion  = vMatch ? vMatch[0][1] : APP_VERSION

                    log.info "Hestia: dashboard saved to File Manager — ${html.length()} bytes"
                } else {
                    log.error "Hestia: response too short (${html?.length()} bytes)"
                }
            } else {
                log.error "Hestia: GitHub returned HTTP ${resp.status}"
            }
        }
    } catch(e) {
        log.error "Hestia: fetch failed: ${e.message}"
    }
}

def checkLatestVersion() {
    try {
        httpGet([
            uri:     GITHUB_VERSION_URL,
            headers: ["User-Agent": "HestiaDashboard/${APP_VERSION}",
                      "Accept":     "application/vnd.github.v3+json"]
        ]) { resp ->
            if (resp.status == 200) {
                def latest = resp.data?.tag_name?.replace("v","") ?: APP_VERSION
                state.latestVersion   = latest
                state.updateAvailable = isNewerVersion(latest, state.installedVersion ?: APP_VERSION)
                log.info "Hestia: latest GitHub version: ${latest}, update available: ${state.updateAvailable}"
            }
        }
    } catch(e) {
        log.warn "Hestia: version check failed: ${e.message}"
    }
}

private boolean isNewerVersion(String candidate, String current) {
    try {
        def c = candidate.tokenize('.').collect { it.toInteger() }
        def x = current.tokenize('.').collect  { it.toInteger() }
        for (int i = 0; i < 3; i++) {
            def cv = c.size() > i ? c[i] : 0
            def xv = x.size() > i ? x[i] : 0
            if (cv > xv) return true
            if (cv < xv) return false
        }
        return false
    } catch(e) { return false }
}

// ── Endpoints ─────────────────────────────────────────────────────────────

def serveDashboard() {
    if (!state.dashboardStored) {
        log.warn "Hestia: dashboard not stored — fetching from GitHub"
        fetchDashboardFromGitHub()
        if (!state.dashboardStored) {
            render contentType: "text/html; charset=UTF-8", data: fallbackPage()
            return
        }
    }
    // Read from File Manager via httpGet and serve directly —
    // browser stays on the apps/api URL, hub IP and file path never exposed
    def hubIp   = location.hubs[0].localIP
    def fileUrl = "http://${hubIp}/local/${DASHBOARD_FILENAME}"
    def served  = false
    try {
        httpGet([uri: fileUrl, textParser: true]) { resp ->
            if (resp.status == 200) {
                def html = resp.data.text
                if (html && html.length() > 1000) {
                    render contentType: "text/html; charset=UTF-8", data: html
                    served = true
                }
            }
        }
    } catch(e) {
        log.error "Hestia: could not read dashboard file: ${e.message}"
    }
    if (!served) render contentType: "text/html; charset=UTF-8", data: fallbackPage()
}

def getConfig() {
    render contentType: "application/json", data: (state.config ?: "null")
}

def saveConfig() {
    try {
        def body = request.body
        if (!body) {
            render contentType: "application/json",
                   data: '{"status":"error","message":"empty body"}'
            return
        }
        new groovy.json.JsonSlurper().parseText(body)
        state.config     = body
        state.configSize = body.length()
        try { uploadHubFile(CONFIG_FILENAME, body.getBytes("UTF-8")) } catch(e) {}
        log.info "Hestia: config saved (${body.length()} bytes)"
        render contentType: "application/json", data: '{"status":"ok"}'
    } catch(e) {
        log.error "Hestia: config save error: ${e.message}"
        render contentType: "application/json",
               data: """{"status":"error","message":"${e.message.replace('"','\\"')}"}"""
    }
}

def triggerUpdate() {
    fetchDashboardFromGitHub()
    state.updateAvailable = false
    render contentType: "application/json",
           data: """{"status":"ok","version":"${state.installedVersion}","cachedAt":"${state.dashboardCachedAt}"}"""
}

def getVersion() {
    render contentType: "application/json",
           data: new groovy.json.JsonBuilder([
               appVersion:       APP_VERSION,
               installedVersion: state.installedVersion ?: APP_VERSION,
               latestVersion:    state.latestVersion ?: "unknown",
               updateAvailable:  state.updateAvailable ?: false,
               cachedAt:         state.dashboardCachedAt ?: "never",
               dashboardSize:    state.dashboardSize ?: 0
           ]).toString()
}

def ping() {
    render contentType: "application/json",
           data: new groovy.json.JsonBuilder([
               status:          "ok",
               app:             "Hestia Dashboard",
               version:         APP_VERSION,
               appId:           app.id,
               configStored:    state.config != null,
               dashboardStored: state.dashboardStored ?: false
           ]).toString()
}

// ── Fallback page ─────────────────────────────────────────────────────────

private String fallbackPage() {
    def hubIp  = location.hubs[0].localIP
    def updUrl = "http://${hubIp}/apps/api/${app.id}/update?access_token=${state.accessToken}"
    return """<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Hestia</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0A0A0A;color:#F2F1EE;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}.card{background:#111;border:1px solid #1a1a1a;border-radius:16px;padding:2.5rem;max-width:420px;width:100%;text-align:center}h1{font-size:20px;font-weight:300;letter-spacing:.2em;text-transform:uppercase;margin-bottom:.5rem}p{font-size:13px;color:#555;line-height:1.7;margin-bottom:1.5rem}a{display:inline-block;padding:10px 24px;background:#1A1200;border:1px solid #6B4A08;border-radius:8px;color:#F59E0B;font-size:13px;text-decoration:none}</style>
</head><body><div class="card">
<h1>Hestia™</h1>
<p>Dashboard not yet loaded. Ensure your hub has internet access, then tap below.</p>
<a href="${updUrl}">⬇ Fetch Dashboard Now</a>
</div></body></html>"""
}
