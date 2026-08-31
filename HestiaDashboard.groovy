/**
 * Hestia™ Home Dashboard v1.6.2
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
 *   5. Push notifications       — polls Maker API for door/window/lock/
 *      motion/smoke/water changes and subscribes to HSM directly, so it
 *      keeps working even when nobody has the dashboard open. Deliberately
 *      reuses the device categorization already synced in the config blob
 *      (state.config) rather than asking for a second, separate set of
 *      device selections here — the dashboard's own Settings UI is the
 *      only place a user should ever need to pick devices.
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
@Field static final String APP_VERSION        = "1.6.2"
@Field static final String TOKEN_FILENAME      = "hestia-token.json"
@Field static final String CONFIG_FILENAME     = "hestia-config.json"
@Field static final String DASHBOARD_FILENAME  = "index.html"
@Field static final String DASHBOARD_URL       = "https://raw.githubusercontent.com/h4ven88/hestia-dashboard/main/index.html"
@Field static final String BUILD_INFO_URL      = "https://raw.githubusercontent.com/h4ven88/hestia-dashboard/main/build-info.json"

// ── Push notifications ───────────────────────────────────────────────────
@Field static final String  PUSH_SEND_URL     = "https://hestari.com/api/push/send"
@Field static final Integer PUSH_POLL_SECONDS = 25

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
                "Push notifications: ${push?.pushEnabled == true ? '✓ active (polling every ' + PUSH_POLL_SECONDS + 's)' : '— disabled'}\n" +
                "App ID: ${app.id}\n" +
                "Hub IP: ${hubIp}"
        }

        section("Actions") {
            input "updateDashboard", "button", title: "⬇ Update Dashboard File"
            input "resetConfig", "button", title: "🗑 Clear Stored Config"
        }

        section("Debugging") {
            input "pushDebugLogging", "bool", title: "Push notification debug logging",
                description: "Logs what each poll cycle sees -- device counts, sensor categorization, state changes. Turn off once things are working.",
                defaultValue: false, submitOnChange: true
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
    runIn(PUSH_POLL_SECONDS, "pushPollDevices")
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
// Deliberately polls Maker API (the same HTTP interface the dashboard itself
// uses) instead of native subscribe() — subscribe() needs device object
// references from this app's own capability inputs, which would mean asking
// users to re-select every door/window/lock/motion sensor a second time
// here, duplicating what they've already set up in Hestia's web Settings.
// Polling against state.config (the same JSON blob the dashboard syncs)
// needs zero extra setup and stays in sync automatically.

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

// Maker API base URL. Reuses push.hub's scheme and port -- the exact hub
// URL already synced from Hestia's own Settings -- but always targets
// 127.0.0.1 rather than the hub's own LAN IP. This app runs ON the hub, and
// a hub connecting to its own LAN-facing IP is a different, sometimes-
// blocked network path than a browser elsewhere on the LAN reaching that
// same address -- confirmed by logs: pushPollDevices() got a flat
// connection-refused on the hub's own IP even though the dashboard itself
// reaches that exact address successfully from every other device. 127.0.0.1
// avoids the self-connection entirely since the target IS this hub.
def pushHubBase(push) {
    def raw = (push?.hub ?: "http://${location.hubs[0].localIP}").replaceAll(/\/+$/, '')
    try {
        def u = new URI(raw)
        def port = u.port > 0 ? ":${u.port}" : ''
        return "${u.scheme}://127.0.0.1${port}"
    } catch (e) {
        return raw
    }
}

// HSM status → armed/disarmed, mirrors the dashboard's own artemisHsmSync()
// classification (armedAway/armedHome/armedNight count as armed; anything
// mid-transition or disarmed does not, so "armed only" devices don't fire
// during the entry/exit delay countdown).
def pushHsmStatusHandler(evt) {
    def v = (evt.value ?: "").toLowerCase()
    state.pushArmed = (v.contains("armed") && !v.contains("disarmed") && !v.contains("arming"))
}

def pushSeedArmedStatus() {
    def push = getPushSettings()
    if (!push) { state.pushArmed = false; return }
    try {
        def uri = "${pushHubBase(push)}/apps/api/${push.appId}/hsm?access_token=${push.token}"
        httpGet([uri: uri, timeout: 10, ignoreSSLIssues: true]) { resp ->
            def v = (resp?.data?.hsm ?: resp?.data?.hsmStatus ?: "").toString().toLowerCase()
            state.pushArmed = (v.contains("armed") && !v.contains("disarmed") && !v.contains("arming"))
        }
    } catch (e) {
        state.pushArmed = false
    }
}

// hsmAlert fires on intrusion (the actual burglar-alarm trip). Smoke/CO and
// water are handled by direct device polling below instead of HSM, since
// not everyone has HSM Monitor watching those sensors at all.
def pushHsmAlertHandler(evt) {
    def push = getPushSettings()
    if (!push || push.pushEnabled != true || push.pushAlarming == false) return
    def v = (evt.value ?: "").toLowerCase()
    if (!v.startsWith("intrusion")) return
    def scope = v.contains("home") ? "Home" : "Away"
    pushSendNotification("alarming", "Security Alarm", "${scope} intrusion alarm triggered!", push.token)
}

// Polls Maker API's bulk /devices/all endpoint every PUSH_POLL_SECONDS,
// diffs against the last-seen attribute values, and sends a push for any
// transition that matches an enabled category + event type. Keeps
// rescheduling itself indefinitely — when push is disabled this is just a
// cheap early-return every cycle, which is simpler and more robust than
// trying to precisely start/stop the loop from every place config changes.
def pushPollDevices() {
    def dbg = settings.pushDebugLogging == true
    try {
        def push = getPushSettings()
        if (push?.pushEnabled != true) {
            if (dbg) log.info "Hestia Push: poll skipped -- pushEnabled is ${push?.pushEnabled} (push settings ${push ? 'found' : 'NOT found -- state.config missing appId/token'})"
            return
        }

        def uri = "${pushHubBase(push)}/apps/api/${push.appId}/devices/all?access_token=${push.token}"
        if (dbg) log.info "Hestia Push: polling ${pushHubBase(push)}/apps/api/${push.appId}/devices/all"
        def devices = null
        httpGet([uri: uri, timeout: 15, ignoreSSLIssues: true]) { resp ->
            if (resp.status == 200) devices = resp.data
        }
        if (devices == null) {
            if (dbg) log.info "Hestia Push: poll got no devices back from Maker API (request may have failed)"
            return
        }
        if (dbg) log.info "Hestia Push: poll fetched ${devices.size()} devices from Maker API"

        def sensors = push.artemisSensors ?: [:]
        def catFor = [:] // deviceId -> [cat, subtype, name]
        (sensors.contacts ?: []).each { catFor[it.id?.toString()] = [cat: "contacts", subtype: it.subtype, name: it.name ?: "Sensor"] }
        (sensors.motions  ?: []).each { catFor[it.id?.toString()] = [cat: "motions",  name: it.name ?: "Sensor"] }
        (sensors.smokes   ?: []).each { catFor[it.id?.toString()] = [cat: "smokes",   name: it.name ?: "Sensor"] }
        (sensors.waters   ?: []).each { catFor[it.id?.toString()] = [cat: "waters",   name: it.name ?: "Sensor"] }
        def lockLabel = [:]
        (push.locks ?: []).each { if (it.id) lockLabel[it.id.toString()] = it.label ?: "Lock" }
        def motionAllowed = (push.pushMotionDevices ?: []).collect { it.toString() } as Set

        if (dbg) log.info "Hestia Push: categorized sensors -- contacts:${(sensors.contacts ?: []).size()} motions:${(sensors.motions ?: []).size()} smokes:${(sensors.smokes ?: []).size()} waters:${(sensors.waters ?: []).size()} locks:${(push.locks ?: []).size()} -- doors:${push.pushDoors != false} windows:${push.pushWindows != false} open:${push.pushOpen != false} close:${push.pushClose != false}"

        def doorsOn    = push.pushDoors    != false
        def windowsOn  = push.pushWindows  != false
        def locksOn    = push.pushLocks    != false
        def motionOn   = push.pushMotion   == true
        def smokeOn    = push.pushSmoke    != false
        def waterOn    = push.pushWater    != false
        def openOn     = push.pushOpen     != false
        def closeOn    = push.pushClose    != false

        def lastStates = state.pushDeviceStates ?: [:]
        def newStates  = [:]

        devices.each { device ->
            def id = device.id?.toString()
            if (!id) return
            def attrs = [:]
            (device.attributes ?: []).each { a -> if (a?.name) attrs[a.name] = a.currentValue }

            def info = catFor[id]
            def lock = lockLabel[id]

            if (info?.cat == "contacts" && attrs.contact in ["open", "closed"]) {
                def key = "contact:${id}"
                newStates[key] = attrs.contact
                if (dbg) log.info "Hestia Push: contact device ${id} (${info.name}) = ${attrs.contact}, last seen = ${lastStates[key]}"
                if (lastStates[key] != null && lastStates[key] != attrs.contact) {
                    def isWindow = info.subtype == "window"
                    def gateOpen = (isWindow ? windowsOn : doorsOn) && (attrs.contact == "open" ? openOn : closeOn)
                    if (dbg) log.info "Hestia Push: ${id} transitioned ${lastStates[key]} -> ${attrs.contact}, isWindow=${isWindow}, gate open=${gateOpen}"
                    if (gateOpen) {
                        def kind = isWindow ? "Window" : "Door"
                        pushSendNotification(isWindow ? "windows" : "doors", "${kind} ${attrs.contact == 'open' ? 'Opened' : 'Closed'}",
                            "${info.name} is now ${attrs.contact}.", push.token)
                    }
                }
            } else if (dbg && attrs.contact != null) {
                log.info "Hestia Push: device ${id} has a contact attribute (${attrs.contact}) but isn't categorized as a contact sensor -- info=${info}"
            }

            if (lock && attrs.lock in ["locked", "unlocked"]) {
                def key = "lock:${id}"
                newStates[key] = attrs.lock
                if (lastStates[key] != null && lastStates[key] != attrs.lock && locksOn && (attrs.lock == "unlocked" ? openOn : closeOn)) {
                    pushSendNotification("locks", "Door ${attrs.lock == 'locked' ? 'Locked' : 'Unlocked'}",
                        "${lock} was ${attrs.lock}.", push.token)
                }
            }

            if (info?.cat == "motions" && attrs.motion in ["active", "inactive"]) {
                def key = "motion:${id}"
                newStates[key] = attrs.motion
                if (lastStates[key] != null && lastStates[key] != attrs.motion && attrs.motion == "active"
                        && motionOn && motionAllowed.contains(id)) {
                    pushSendNotification("motion", "Motion Detected", "Motion detected: ${info.name}.", push.token)
                }
            }

            if (info?.cat == "smokes") {
                ["smoke", "carbonMonoxide"].each { attrName ->
                    def val = attrs[attrName]
                    if (val in ["detected", "clear"]) {
                        def key = "${attrName}:${id}"
                        newStates[key] = val
                        if (lastStates[key] != null && lastStates[key] != val && val == "detected" && smokeOn) {
                            pushSendNotification("smoke", "Smoke / CO Alert", "${info.name} detected ${attrName == 'smoke' ? 'smoke' : 'carbon monoxide'}!", push.token)
                        }
                    }
                }
            }

            if (info?.cat == "waters" && attrs.water in ["wet", "dry"]) {
                def key = "water:${id}"
                newStates[key] = attrs.water
                if (lastStates[key] != null && lastStates[key] != attrs.water && attrs.water == "wet" && waterOn) {
                    pushSendNotification("water", "Water / Freeze Alert", "${info.name} detected water!", push.token)
                }
            }
        }

        state.pushDeviceStates = newStates
    } catch (e) {
        log.warn "Hestia Push: poll error: ${e.message}"
    } finally {
        runIn(PUSH_POLL_SECONDS, "pushPollDevices")
    }
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
