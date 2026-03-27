/**
 *  Hestia™ Home Dashboard  v1.0.1
 *  ════════════════════════════════════════════════════════════════
 *  Single Hubitat app — serves the dashboard and stores config.
 *
 *  Copyright © 2025 Haven. All rights reserved.
 *  Licence: CC BY-NC 4.0 — personal use only.
 *  https://github.com/h4ven88/hestia-dashboard
 *
 *  ── ENDPOINTS ───────────────────────────────────────────────────
 *  GET  /dashboard          Serves the dashboard HTML
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

@Field static final String APP_VERSION = "1.0.1"

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
    // Ensure token exists
    if (!state.accessToken) {
        try { createAccessToken() } catch(e) {
            log.error "Hestia: could not create access token — enable OAuth in Apps Code: ${e.message}"
        }
    }

    dynamicPage(name: "mainPage", title: "Hestia™ Dashboard",
                install: true, uninstall: true, refreshInterval: 0) {

        section("") {
            paragraph "<h2>Hestia™ Home Dashboard</h2><em>Your safe haven, at a glance.</em>"
        }

        section("Dashboard URL") {
            if (state.accessToken) {
                // Build local URL using hub IP directly — avoids cloud relay issues
                def hubIp   = location.hubs[0].localIP
                def dashUrl = "http://${hubIp}/apps/api/${app.id}/dashboard?access_token=${state.accessToken}"
                paragraph "Open this URL in any browser on your local network:\n\n" +
                          "<b>${dashUrl}</b>\n\n" +
                          "Bookmark it or save it as a PWA on your tablet."
            } else {
                paragraph "⚠ OAuth token not yet created. Save the app first, then reopen this page."
            }
        }

        section("Status") {
            def cacheSize  = state.dashboardHtml ? state.dashboardHtml.length() : 0
            def configSize = state.config ? state.config.length() : 0
            paragraph "Dashboard cache: ${cacheSize > 0 ? (cacheSize/1024).toInteger() + ' KB (cached ' + (state.dashboardCachedAt ?: '?') + ')' : '⚠ Not yet fetched'}\n" +
                      "Installed version: ${state.installedVersion ?: 'not fetched'}\n" +
                      "Latest on GitHub: ${state.latestVersion ?: 'unknown'}\n" +
                      "Config stored: ${configSize > 0 ? configSize + ' bytes' : 'none'}\n" +
                      "App ID: ${app.id}"
        }

        section("Actions") {
            input "fetchDashboard", "button", title: "⬇ Fetch Latest Dashboard from GitHub"
            input "checkVersion",   "button", title: "🔍 Check for Updates"
            input "clearCache",     "button", title: "🗑 Clear Dashboard Cache"
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
        case "clearCache":
            state.dashboardHtml     = null
            state.dashboardCachedAt = null
            state.installedVersion  = null
            log.info "Hestia: dashboard cache cleared"
            break
        case "resetConfig":
            state.config = null
            try { uploadHubFile("hestia-config.json", "null".getBytes("UTF-8")) } catch(e) {}
            log.info "Hestia: config cleared"
            break
    }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

def installed() {
    initialize()
}

def updated() {
    initialize()
}

def initialize() {
    if (!state.accessToken) {
        try { createAccessToken() } catch(e) {
            log.error "Hestia: OAuth not enabled — go to Apps Code, open Hestia Dashboard, enable OAuth, save"
        }
    }
    writeDiscovery()
    if (!state.dashboardHtml) fetchDashboardFromGitHub()
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
        uploadHubFile("hestia-token.json", json.getBytes("UTF-8"))
        log.info "Hestia: discovery file written → /local/hestia-token.json"
    } catch(e) {
        log.warn "Hestia: could not write discovery file (non-fatal): ${e.message}"
    }
}

// ── Dashboard fetch ───────────────────────────────────────────────────────

def fetchDashboardFromGitHub() {
    log.info "Hestia: fetching dashboard from GitHub"
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
                    state.dashboardHtml     = html
                    state.dashboardCachedAt = new Date().format("yyyy-MM-dd HH:mm")
                    def vMatch = (html =~ /HESTIA_VERSION\s*=\s*['"]([^'"]+)['"]/)
                    state.installedVersion  = vMatch ? vMatch[0][1] : APP_VERSION
                    log.info "Hestia: cached ${html.length()} bytes, v${state.installedVersion}"
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
            headers: ["User-Agent": "HestiaDashboard/${APP_VERSION}", "Accept": "application/vnd.github.v3+json"]
        ]) { resp ->
            if (resp.status == 200) {
                def latest = resp.data?.tag_name?.replace("v","") ?: APP_VERSION
                state.latestVersion  = latest
                state.updateAvailable = isNewerVersion(latest, state.installedVersion ?: APP_VERSION)
                log.info "Hestia: latest GitHub version: ${latest}"
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
    if (state.dashboardHtml) {
        def html = state.dashboardHtml
        // Ensure DOCTYPE is first — build output may have copyright comment before it
        // Find DOCTYPE position and move it to the very front
        def dtIdx = html.toLowerCase().indexOf("<!doctype html>")
        if (dtIdx < 0) {
            html = "<!DOCTYPE html>\n" + html
        } else if (dtIdx > 0) {
            // DOCTYPE exists but isn't first — move it to front
            html = "<!DOCTYPE html>\n" + html.substring(dtIdx + 15)
        }
        if (state.updateAvailable) {
            def hubIp   = location.hubs[0].localIP
            def updUrl  = "http://${hubIp}/apps/api/${app.id}/update?access_token=${state.accessToken}"
            def banner  = """<div id="hestia-update-banner" style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#1A1200;border-bottom:1px solid #6B4A08;padding:8px 16px;display:flex;align-items:center;gap:12px;font-family:system-ui,sans-serif;font-size:12px;color:#F59E0B"><span>&#8679; Hestia v${state.latestVersion} is available.</span><a href="${updUrl}" style="color:#F59E0B;font-weight:600;text-decoration:underline">Update now</a><span style="margin-left:auto;cursor:pointer;opacity:.6" onclick="this.parentElement.remove()">&#10005;</span></div>"""
            html = html.replace("<body>", "<body>" + banner)
        }
        render contentType: "text/html; charset=UTF-8", data: html
        return
    }
    // No cache — try live fetch
    log.warn "Hestia: no cache — attempting live fetch"
    fetchDashboardFromGitHub()
    if (state.dashboardHtml) {
        render contentType: "text/html; charset=UTF-8", data: state.dashboardHtml
        return
    }
    render contentType: "text/html; charset=UTF-8", data: fallbackPage()
}

def getConfig() {
    render contentType: "application/json", data: (state.config ?: "null")
}

def saveConfig() {
    try {
        def body = request.body
        if (!body) { render contentType: "application/json", data: '{"status":"error","message":"empty body"}'; return }
        new groovy.json.JsonSlurper().parseText(body)
        state.config = body
        try { uploadHubFile("hestia-config.json", body.getBytes("UTF-8")) } catch(e) {}
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
               cacheSize:        state.dashboardHtml ? state.dashboardHtml.length() : 0
           ]).toString()
}

def ping() {
    render contentType: "application/json",
           data: new groovy.json.JsonBuilder([
               status:       "ok",
               app:          "Hestia Dashboard",
               version:      APP_VERSION,
               appId:        app.id,
               configStored: state.config != null,
               dashCached:   state.dashboardHtml != null
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
<p>Dashboard not yet loaded. Ensure your hub has internet access.</p>
<a href="${updUrl}">⬇ Fetch Dashboard Now</a>
</div></body></html>"""
}
