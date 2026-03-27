/**
 *  Hestia™ Home Dashboard  v1.0.0
 *  ════════════════════════════════════════════════════════════════
 *  Single Hubitat app — serves the dashboard and stores config.
 *
 *  Copyright © 2025 Haven. All rights reserved.
 *  Licence: CC BY-NC 4.0 — personal use only.
 *  https://github.com/h4ven88/hestia-dashboard
 *
 *  ── WHAT THIS APP DOES ──────────────────────────────────────────
 *  1. Serves the Hestia dashboard HTML at /dashboard
 *  2. Stores and syncs dashboard config across all devices
 *  3. Fetches the latest dashboard from GitHub on first run
 *     and caches it in hub state — works offline after first load
 *  4. Checks for updates in the background and notifies the dashboard
 *
 *  ── INSTALL INSTRUCTIONS ────────────────────────────────────────
 *  1. Hubitat → Apps Code → + New App → paste → Save
 *  2. Apps → Add User App → "Hestia Dashboard" → Done
 *  3. Open a browser on your network and go to:
 *     http://[your-hub-ip]/apps/api/[app-id]/dashboard
 *     (The app page shows the exact URL after install)
 *
 *  ── ENDPOINTS ───────────────────────────────────────────────────
 *  GET  /dashboard          Serves the dashboard HTML
 *  GET  /config             Returns stored config JSON
 *  POST /config             Saves config JSON
 *  GET  /update             Fetches latest dashboard from GitHub
 *  GET  /version            Returns version info JSON
 *  GET  /ping               Health check
 */

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

// ── GitHub release URL ────────────────────────────────────────────────────
@Field static final String GITHUB_RELEASE_URL =
    "https://github.com/h4ven88/hestia-dashboard/releases/download/v1.0.0/dashboard.min.html"

@Field static final String GITHUB_VERSION_URL =
    "https://api.github.com/repos/h4ven88/hestia-dashboard/releases/latest"

@Field static final String APP_VERSION = "1.0.0"

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

// ── UI Pages ──────────────────────────────────────────────────────────────

def mainPage() {
    dynamicPage(name: "mainPage", title: "Hestia™ Dashboard",
                install: true, uninstall: true, refreshInterval: 0) {

        def dashUrl = state.accessToken ?
            "${getFullApiServerUrl()}/dashboard?access_token=${state.accessToken}" : null

        section("") {
            paragraph "<h2>Hestia™ Home Dashboard</h2><em>Your safe haven, at a glance.</em>"
        }

        if (dashUrl) {
            section("Dashboard URL") {
                paragraph "Open this URL in any browser on your network to access the dashboard:\n\n" +
                          "<b><a href='${dashUrl}' target='_blank'>${dashUrl}</a></b>\n\n" +
                          "Bookmark it or add it to your home screen as a PWA."
            }
        }

        section("Status") {
            def cacheSize = state.dashboardHtml ? state.dashboardHtml.length() : 0
            def configSize = state.config ? state.config.length() : 0
            def cacheDate = state.dashboardCachedAt ?: "never"
            def installedVersion = state.installedVersion ?: "not fetched"
            def latestVersion = state.latestVersion ?: "unknown"

            paragraph "Dashboard cache: ${cacheSize > 0 ? (cacheSize/1024).toInteger() + ' KB (cached ' + cacheDate + ')' : '⚠ Not yet fetched'}\n" +
                      "Installed version: ${installedVersion}\n" +
                      "Latest on GitHub: ${latestVersion}\n" +
                      "Config stored: ${configSize > 0 ? configSize + ' bytes' : 'none'}"
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
            state.dashboardHtml = null
            state.dashboardCachedAt = null
            state.installedVersion = null
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
    if (!state.accessToken) createAccessToken()
    writeDiscovery()
    // Fetch dashboard on first install if not cached
    if (!state.dashboardHtml) {
        fetchDashboardFromGitHub()
    }
    // Schedule daily version check at 3am
    schedule("0 0 3 * * ?", "checkLatestVersion")
    log.info "Hestia: initialized — v${APP_VERSION}"
}

// ── Discovery file ────────────────────────────────────────────────────────
// Written to File Manager so dashboard can auto-discover the app

def writeDiscovery() {
    try {
        def discovery = new groovy.json.JsonBuilder([
            appId:   app.id,
            token:   state.accessToken,
            version: APP_VERSION
        ]).toString()
        uploadHubFile("hestia-token.json", discovery.getBytes("UTF-8"))
        log.info "Hestia: discovery file written → /local/hestia-token.json"
    } catch(e) {
        log.error "Hestia: failed to write discovery file: ${e.message}"
    }
}

// ── Dashboard fetch ───────────────────────────────────────────────────────

def fetchDashboardFromGitHub() {
    log.info "Hestia: fetching dashboard from GitHub → ${GITHUB_RELEASE_URL}"
    try {
        httpGet([
            uri:                GITHUB_RELEASE_URL,
            followRedirects:    true,
            textParser:         true,
            requestContentType: "text/html",
            headers:            ["User-Agent": "Hestia-Dashboard/${APP_VERSION} Hubitat"]
        ]) { resp ->
            if (resp.status == 200) {
                def html = resp.data.text
                if (html && html.length() > 1000) {
                    state.dashboardHtml = html
                    state.dashboardCachedAt = new Date().format("yyyy-MM-dd HH:mm")
                    // Extract version from the HTML
                    def vMatch = html =~ /HESTIA_VERSION\s*=\s*['"]([^'"]+)['"]/
                    state.installedVersion = vMatch ? vMatch[0][1] : APP_VERSION
                    log.info "Hestia: dashboard fetched and cached — ${html.length()} bytes, v${state.installedVersion}"
                } else {
                    log.error "Hestia: fetched HTML too short (${html?.length()} bytes) — ignoring"
                }
            } else {
                log.error "Hestia: GitHub returned HTTP ${resp.status}"
            }
        }
    } catch(e) {
        log.error "Hestia: failed to fetch from GitHub: ${e.message}"
    }
}

def checkLatestVersion() {
    log.info "Hestia: checking for latest version on GitHub"
    try {
        httpGet([
            uri:     GITHUB_VERSION_URL,
            headers: [
                "User-Agent": "Hestia-Dashboard/${APP_VERSION} Hubitat",
                "Accept":     "application/vnd.github.v3+json"
            ]
        ]) { resp ->
            if (resp.status == 200) {
                def data = resp.data
                def latest = data?.tag_name?.replace("v","") ?: APP_VERSION
                state.latestVersion = latest
                state.updateAvailable = isNewerVersion(latest, state.installedVersion ?: APP_VERSION)
                log.info "Hestia: latest version on GitHub is ${latest} — update available: ${state.updateAvailable}"
            }
        }
    } catch(e) {
        log.warn "Hestia: version check failed (hub may be offline): ${e.message}"
    }
}

// Simple semver comparison — returns true if candidate is newer than current
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
    // 1. Serve from cache if available
    if (state.dashboardHtml) {
        def html = state.dashboardHtml

        // Inject update notification banner if an update is available
        if (state.updateAvailable) {
            def banner = """<div id="hestia-update-banner" style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#1A1200;border-bottom:1px solid #6B4A08;padding:8px 16px;display:flex;align-items:center;gap:12px;font-family:system-ui,sans-serif;font-size:12px;color:#F59E0B">
<span>⬆ Hestia v${state.latestVersion} is available.</span>
<a href="${getFullApiServerUrl()}/update?access_token=${state.accessToken}" style="color:#F59E0B;font-weight:600;text-decoration:underline">Update now</a>
<span style="margin-left:auto;cursor:pointer;opacity:.6" onclick="document.getElementById('hestia-update-banner').remove()">✕</span>
</div>"""
            html = html.replace("<body>", "<body>" + banner)
        }

        render contentType: "text/html; charset=UTF-8", data: html
        return
    }

    // 2. No cache — try to fetch from GitHub synchronously
    log.warn "Hestia: no cached dashboard — attempting live fetch"
    fetchDashboardFromGitHub()

    if (state.dashboardHtml) {
        render contentType: "text/html; charset=UTF-8", data: state.dashboardHtml
        return
    }

    // 3. Both failed — serve minimal fallback
    render contentType: "text/html; charset=UTF-8", data: fallbackPage()
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
        new groovy.json.JsonSlurper().parseText(body)   // validate JSON
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
    log.info "Hestia: manual update triggered via /update endpoint"
    fetchDashboardFromGitHub()
    if (state.updateAvailable) state.updateAvailable = false
    render contentType: "application/json",
           data: """{"status":"ok","version":"${state.installedVersion}","cachedAt":"${state.dashboardCachedAt}"}"""
}

def getVersion() {
    render contentType: "application/json",
           data: new groovy.json.JsonBuilder([
               appVersion:      APP_VERSION,
               installedVersion: state.installedVersion ?: APP_VERSION,
               latestVersion:   state.latestVersion ?: "unknown",
               updateAvailable: state.updateAvailable ?: false,
               cachedAt:        state.dashboardCachedAt ?: "never",
               cacheSize:       state.dashboardHtml ? state.dashboardHtml.length() : 0
           ]).toString()
}

def ping() {
    render contentType: "application/json",
           data: new groovy.json.JsonBuilder([
               status:       "ok",
               app:          "Hestia Dashboard",
               version:      APP_VERSION,
               configStored: state.config != null,
               dashCached:   state.dashboardHtml != null
           ]).toString()
}

// ── Fallback page ─────────────────────────────────────────────────────────
// Shown if GitHub is unreachable and no cache exists

private String fallbackPage() {
    return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Hestia</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0A0A;color:#F2F1EE;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}
.card{background:#111;border:1px solid #1a1a1a;border-radius:16px;padding:2.5rem;max-width:420px;width:100%;text-align:center}
.icon{font-size:40px;margin-bottom:1rem}
h1{font-size:20px;font-weight:300;letter-spacing:.2em;text-transform:uppercase;color:#F2F1EE;margin-bottom:.5rem}
p{font-size:13px;color:#555;line-height:1.7;margin-bottom:1.5rem}
a{display:inline-block;padding:10px 24px;background:#1A1200;border:1px solid #6B4A08;border-radius:8px;color:#F59E0B;font-size:13px;text-decoration:none;transition:all .2s}
a:hover{background:#2A2000}
.sub{font-size:11px;color:#333;margin-top:1.5rem}
</style>
</head>
<body>
<div class="card">
  <div class="icon">⬡</div>
  <h1>Hestia™</h1>
  <p>Dashboard not yet loaded.<br>The hub could not reach GitHub to download the dashboard, and no local cache exists.</p>
  <a href="${getFullApiServerUrl()}/update?access_token=${state.accessToken}">⬇ Fetch Dashboard Now</a>
  <div class="sub">Ensure your hub has internet access, then try again.<br>The dashboard will be cached locally after first load.</div>
</div>
</body>
</html>"""
}
