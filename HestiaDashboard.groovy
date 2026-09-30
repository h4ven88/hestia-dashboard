/**
 * Hestia™ Home Dashboard v2.1.4
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
 *   5. HSM alert reporting      — records the latest hsmAlert (including the
 *      entry-delay "pending" alert) so the dashboard can show the countdown.
 *      HSM alerts are location events, invisible to Maker API's device poll.
 *   6. Push notifications (arm-state) — subscribes to HSM directly and
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
 * GET     /security  Latest HSM alert and whether it is still active
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
@Field static final String APP_VERSION        = "2.1.4"
@Field static final String TOKEN_FILENAME      = "hestia-token.json"
@Field static final String CONFIG_FILENAME     = "hestia-config.json"
@Field static final String DASHBOARD_FILENAME  = "index.html"
@Field static final String DASHBOARD_URL       = "https://raw.githubusercontent.com/h4ven88/hestia-dashboard/main/index.html"
@Field static final String BUILD_INFO_URL      = "https://raw.githubusercontent.com/h4ven88/hestia-dashboard/main/build-info.json"

// ── Push notifications ───────────────────────────────────────────────────
@Field static final String PUSH_SEND_URL  = "https://hestari.com/api/push/send"
@Field static final String PUSH_ARMED_URL = "https://hestari.com/api/push/armed"
// A transient WAN blip at the exact moment of a real alarm previously meant
// that relay just never left the hub -- one bounded, delayed retry rides out
// a momentary failure without retrying forever. Delay is shorter than the
// connect timeout below on purpose: long enough for a brief blip to clear,
// short enough that a life-safety alert doesn't sit queued for long.
@Field static final Integer PUSH_RETRY_MAX       = 1
@Field static final Integer PUSH_RETRY_DELAY_SEC = 8

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
    path("/security") {
        action: [ GET: "getSecurity", OPTIONS: "preflight" ]
    }
    path("/reminders") {
        action: [ GET: "getReminders", POST: "ackReminder", OPTIONS: "preflight" ]
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
    // Baseline for recordHsmEvent(), so the first hsmStatus event after an
    // install or upgrade only counts as a change if the status really changed.
    if (state.hsmStatusValue == null) state.hsmStatusValue = location.hsmStatus?.toString()
    pushSeedArmedStatus()
    // Without this, /local/index.html only ever refreshed when the app itself
    // was installed or upgraded. If HPM went quiet for any reason (as it did in
    // Sept 2026, when packageManifest.json sat at 1.6.4 after v1.6.5 shipped),
    // initialize() never re-ran, the dashboard file was never re-fetched, and
    // every hub-served install silently stayed on old code indefinitely with no
    // way to self-correct. downloadDashboard(false) already compares versions
    // and returns early when there's nothing new, so this is a cheap poll.
    runEvery3Hours("dashboardUpdateCheck")
    /* Reminders. ONE scanning job, never one job per reminder: the platform
       caps an app at 75 scheduled jobs, so a household with enough reminders
       would otherwise hit a wall it could not see coming. The tick is cheap
       when nothing is due -- it reads state, finds nothing, writes nothing. */
    runEvery1Minute("reminderTick")
    /* Only for the downtime window. Recurring schedules survive a reboot on
       their own, but any fire time that elapsed while the hub was down is
       dropped by the platform and never caught up, so something has to look. */
    subscribe(location, "systemStart", "systemStartHandler")
    /* Marks the tick as freshly registered. reminderHealTick() needs this:
       state.remTickAt stays empty until the tick first runs, up to a minute
       from now, and without a grace window every poll in between would warn
       that a job registered seconds ago was not running. */
    state.remInitAt = now()
    state.remHealTries = 0
    state.remHealGaveUp = false
    log.info "Hestia: initialized v${APP_VERSION} — app ID: ${app.id}"
}

def dashboardUpdateCheck() {
    /* The reminder heal belongs here as well as on the endpoint, and for the
       affected population this is the copy that matters.
       runEvery3Hours("dashboardUpdateCheck") was registered by the PREVIOUS
       initialize(), so it is already running on exactly the hubs whose tick was
       never scheduled, and a scheduled job resolves to the newly pasted code.
       The endpoint copy only fires while a dashboard is open with reminders
       configured -- but a household relying on pushed reminders and keeping no
       screen open is the natural end state of this feature, and that is
       precisely who would never have healed. Three hours is slow, and slow
       beats never. */
    reminderHealTick("periodic check")
    downloadDashboard(false)
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
            // GitHub raw serves .json as text/plain with nosniff, so without an
            // explicit Accept content-type this parses as text and resp.data.version
            // throws MissingPropertyException -- swallowed below, making the whole
            // update check a silent no-op. Same pattern already used elsewhere here.
            httpGet([uri: BUILD_INFO_URL, contentType: "application/json", timeout: 15]) { resp ->
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
                // The downloaded file is the MINIFIED index.html, where terser emits
                // double quotes -- a single-quote-only pattern never matched, so this
                // silently fell through to APP_VERSION and the version comparison
                // above was really "build-info vs APP_VERSION", not "vs the dashboard
                // actually on disk". Whenever those two legitimately diverge that
                // meant re-downloading 600+ KB on every single check.
                def version = (content =~ /HESTIA_VERSION\s*=\s*['"]([^'"]+)['"]/)
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
    recordHsmEvent(evt)
    def v = (evt.value ?: "").toLowerCase()
    def armed = (v.contains("armed") && !v.contains("disarmed") && !v.contains("arming"))
    state.pushArmed = armed
    pushRelayArmedState(armed)
    pushSendArmStatusNotification(v)
}

// Push equivalent of the dashboard's announceHsmEvent() -- mirrors every
// transition Announcements already narrates via TTS (arming/armed/disarmed,
// home/away), not just the final settled state. Deliberately its own toggle
// (pushArmStatus) separate from "Alarming" (pushAlarming), which stays
// intrusion-trip-only -- see the Push/Announce scope mismatch finding this
// closes. An unrecognized status string is left alone rather than guessed
// at, same principle as the dashboard's own HSM-sync fix.
def pushSendArmStatusNotification(String v) {
    def push = getPushSettings()
    if (!push || push.pushEnabled != true || push.pushArmStatus == false) return
    def isHome = v.contains("home") || v.contains("night")
    def scope = isHome ? "Home" : "Away"
    def title, body
    if (v.contains("arming")) {
        title = "Arming ${scope}"
        body  = "Exit delay started"
    } else if (v.contains("armed") && !v.contains("disarmed")) {
        title = "Armed ${scope}"
        body  = "Security system armed"
    } else if (v.contains("disarm")) {
        title = "Disarmed"
        body  = "Security system disarmed"
    } else {
        return
    }
    pushSendNotification("armStatus", title, body, push.token)
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
    pushPostWithRetry(PUSH_ARMED_URL, [armed: armed, token: push.token])
}

// hsmAlert fires on intrusion (the actual burglar-alarm trip). Smoke/CO and
// water go through the Maker API device-event webhook instead of HSM,
// since not everyone has HSM Monitor watching those sensors at all.
// During HSM's own configured entry delay it first sends a "-delay" value
// ("intrusion-delay", "intrusion-home-delay", "intrusion-night-delay", per
// Hubitat's Rule Machine documentation of HSM alert values), then the plain
// value ("intrusion-home") once the delay runs out. Both start with
// "intrusion", so without this check every entry delay is reported as a
// break-in the instant it starts. v1.6.5 checked for "pending" instead --
// that word only appears in HSM's log text, never in the event value, so the
// check never matched. "pending" is still accepted in case a firmware
// version ever uses it. artemisEntryDelay is the same number the dashboard's
// countdown uses, so the message doesn't quote a made-up delay.
def pushHsmAlertHandler(evt) {
    recordHsmEvent(evt)
    def push = getPushSettings()
    if (!push || push.pushEnabled != true || push.pushAlarming == false) return
    def v = (evt.value ?: "").toLowerCase()
    if (!v.startsWith("intrusion")) return
    def scope = v.contains("home") ? "Home" : v.contains("night") ? "Night" : "Away"
    if (v.contains("delay") || v.contains("pending")) {
        def delay = push.artemisEntryDelay ?: 60
        pushSendNotification("alarming", "Security", "${scope} alarming in ${delay} seconds -- disarm to cancel", push.token)
        return
    }
    pushSendNotification("alarming", "Security Alarm", "${scope} intrusion alarm triggered!", push.token)
}

// ── HSM alert reporting (dashboard entry-delay countdown) ───────────────
// Called first from both HSM handlers, before any push gating, so it runs
// whether or not push notifications are enabled.
//
// An alert counts as active until HSM's arm status actually CHANGES after it
// (a disarm or re-arm), or HSM sends "cancel". Only a changed value moves
// hsmStatusAt: if HSM re-sent the same "armedAway" mid-delay, a plain
// timestamp would wrongly end a countdown that is still running.
//
// The raw value is logged at info on purpose. The entry-delay value
// ("intrusion-...-delay") comes from Hubitat's documentation rather than a
// captured event, so this line is how a real test confirms it.
//
// A repeat of the same alert with no status change in between (e.g. a
// second door opening during the same delay) keeps the original time, so
// the dashboard's countdown doesn't restart from full.
//
// A disarm fires hsmStatus "disarmed" and hsmAlert "cancel" almost together,
// in separate executions, and plain state is saved at the end of each, so one
// of the two writes can be lost. That's deliberately tolerated rather than
// solved with singleThreaded (which would queue the dashboard's /config
// requests behind a slow dashboard download) or atomicState (unsafe to mix
// with state): whichever write survives, getSecurity() reports not active.
def recordHsmEvent(evt) {
    def v = (evt.value ?: "").toString()
    if (evt.name == "hsmAlert") {
        def prev = state.hsmAlert
        def prevAt = (prev?.at ?: 0L) as Long
        def sameAlert = prev?.value == v && prevAt > ((state.hsmStatusAt ?: 0L) as Long)
        state.hsmAlert = [value: v, at: sameAlert ? prevAt : now()]
        log.info "Hestia: hsmAlert value=\"${v}\"" + (evt.descriptionText ? " (${evt.descriptionText})" : "")
    } else if (evt.name == "hsmStatus" && v != state.hsmStatusValue) {
        state.hsmStatusValue = v
        state.hsmStatusAt    = now()
    }
}

def getSecurity() {
    def alert    = state.hsmAlert
    def alertAt  = (alert?.at ?: 0L) as Long
    def statusAt = (state.hsmStatusAt ?: 0L) as Long
    def active   = alertAt > 0L && alertAt > statusAt && alert?.value?.toLowerCase() != "cancel"
    render contentType: "application/json", headers: CORS_HEADERS,
           data: new groovy.json.JsonBuilder([
               hsmStatus:   location.hsmStatus,
               alert:       alert?.value,
               alertAt:     alertAt ?: null,
               // Computed here so the dashboard never compares against a
               // device clock that may disagree with the hub's.
               alertAgeMs:  alertAt ? (now() - alertAt) : null,
               alertActive: active
           ]).toString()
}

// ── Reminders ─────────────────────────────────────────────────────────────
//
// The hub fires reminders so they still arrive when no dashboard is open.
//
// It does NO date arithmetic. The dashboard precomputes absolute epoch-ms
// instants into each reminder's fireQueue and the hub only compares numbers.
// Everything about weekday sets, month lengths, end dates and daylight saving
// stays in the one implementation that has been tested across both
// hemispheres; Hubitat's own DST behaviour in schedule() is undocumented, and
// a second implementation would be a second chance to get it wrong.
//
// Accepted race, stated rather than left implicit: reminderTick() (scheduled)
// and ackReminder() (HTTP) both read-modify-write state.remRuntime, and the
// app is not singleThreaded. If they interleave in the same instant, the later
// write wins and the other change is lost -- in practice a lost ack, which
// shows as unacknowledged again and is re-pressed. The window is very narrow
// (the tick does no blocking work; asynchttpPost returns immediately), and
// atomicState is deliberately not used here because this file already
// documents that mixing it with state is unsafe. Same tradeoff recordHsmEvent()
// makes, and worth the same honesty.
//
// Runtime lives in state.remRuntime, its OWN key, never inside state.config.
// Marking reminders inside the config blob would mean parsing, mutating and
// re-uploading the entire household config every minute, forever, against the
// same store whose silent truncation getConfig() already has to defend
// against. This map is small and is only written when something changed.

@Field static final Long REMINDER_MISSED_AFTER_MS = 15L * 60L * 1000L
// Entries older than this are dropped so the map stays bounded. Comfortably
// past the dashboard's own 7-day window for one-time reminders.
@Field static final Long REMINDER_RUNTIME_KEEP_MS = 8L * 24L * 60L * 60L * 1000L
/* How often reminderTick() refreshes its heartbeat. NOT every pass: the tick
   is deliberately write-free when nothing is due, and a state write every
   minute forever would undo that. Five minutes is frequent enough to tell
   "running" from "never started" and cheap enough to be uninteresting. */
@Field static final Long REMINDER_TICK_BEAT_MS = 5L * 60L * 1000L
// Past this with no heartbeat, the tick is presumed not running.
@Field static final Long REMINDER_TICK_STALE_MS = 11L * 60L * 1000L
/* Minimum gap between two heal attempts, and it is load-bearing.
   runEvery1Minute schedules "with a randomized position in the interval", and
   overwrite (the default) cancels the previous schedule and creates a new one.
   The dashboard polls /reminders roughly every five seconds, so an unthrottled
   heal would cancel and recreate the job about twelve times a minute -- and if
   that random position is re-drawn each time, the tick would almost never
   survive long enough to fire. The heal would be starving the job it is trying
   to register. Whether the position is re-drawn is NOT documented and could not
   be confirmed, so this window exists to make the question stop mattering:
   three minutes is far longer than the one-minute period, so the tick always
   gets a clear run regardless of which reading is correct. */
@Field static final Long REMINDER_HEAL_GAP_MS = 3L * 60L * 1000L
/* Grace after initialize(), to stop a guaranteed false positive. The tick is
   registered by initialize() but state.remTickAt stays empty until it first
   runs, up to a minute later -- so without this every install and every Done
   produced a burst of "not running" warnings about a job that had just been
   registered and was perfectly healthy. */
@Field static final Long REMINDER_HEAL_GRACE_MS = 2L * 60L * 1000L
/* After this many heals that changed nothing, stop and say so once. A hub
   whose job store is genuinely broken (the "stuck schedules" reports trace to
   database corruption, not to anything a re-register fixes) would otherwise
   churn the scheduler and the log forever, on a hub that is already sick. */
@Field static final Integer REMINDER_HEAL_MAX_TRIES = 3

/* Re-register the reminder tick if it looks like it is not running.
 *
 * Why this is needed at all: runEvery1Minute("reminderTick") is registered in
 * initialize(), which runs ONLY from installed()/updated() -- and updated()
 * fires only when someone opens the app and clicks Done. Pasting new code and
 * clicking "Update Dashboard File" never reaches it, which is exactly what this
 * project's own v2.1.0 update instructions told everyone to do. The result was
 * a hub that reported the right version, served its endpoints, held a valid
 * queue, and never fired anything, with nothing anywhere saying so.
 *
 * Deliberately NOT claimed: that this fixes a "stuck" schedule. The community
 * reports of that trace to database corruption and were resolved by a soft
 * reset and restore, not by re-registering; the documented workaround was a
 * full app re-save, which is initialize(), not this. If a bare re-register does
 * not take, the attempt ceiling below turns that into one honest error rather
 * than permanent churn.
 *
 * Returns true when it actually rescheduled. */
private boolean reminderHealTick(String why) {
    try {
        Long nowMs = now()
        Long beat  = (state.remTickAt ?: 0L) as Long
        if (nowMs - beat <= REMINDER_TICK_STALE_MS) {
            // Healthy. Clear the failure count so a later real problem starts
            // from a full allowance rather than an exhausted one.
            if (state.remHealTries) { state.remHealTries = 0 }
            return false
        }
        Long initAt = (state.remInitAt ?: 0L) as Long
        if (initAt && nowMs - initAt < REMINDER_HEAL_GRACE_MS) return false
        Long lastHeal = (state.remHealAt ?: 0L) as Long
        if (lastHeal && nowMs - lastHeal < REMINDER_HEAL_GAP_MS) return false

        Integer tries = (state.remHealTries ?: 0) as Integer
        if (tries >= REMINDER_HEAL_MAX_TRIES) {
            if (!state.remHealGaveUp) {
                state.remHealGaveUp = true
                log.error "Hestia: the reminder tick is still not running after " +
                          "${REMINDER_HEAL_MAX_TRIES} attempts to reschedule it. " +
                          "Open the Hestia app and click Done. If that does not help, " +
                          "the hub's scheduler may need attention."
            }
            return false
        }

        state.remHealAt = nowMs
        state.remHealTries = tries + 1
        state.remHealGaveUp = false
        runEvery1Minute("reminderTick")
        // States what was OBSERVED, not what is wrong with the job. This checks
        // heartbeat age; it cannot see whether a job exists, and saying so
        // outright would send anyone debugging this down the wrong path.
        log.warn "Hestia: no reminder heartbeat in over " +
                 "${(long)(REMINDER_TICK_STALE_MS / 60000L)} minutes (${why}) — rescheduling the tick. " +
                 "Clicking Done in the app is what normally registers it."
        return true
    } catch (e) {
        log.warn "Hestia: could not verify the reminder schedule: ${e.message}"
        return false
    }
}

def getReminders() {
    reminderHealTick("dashboard poll")
    render contentType: "application/json", headers: CORS_HEADERS,
           data: new groovy.json.JsonBuilder([
               runtime: (state.remRuntime ?: [:]),
               /* Lets the dashboard tell "the hub is firing these" from "the
                  hub is reachable and the right version but nothing is
                  running". Without it, capability was inferred from a version
                  string alone and a silent hub meant silent reminders, because
                  the dashboard had stood down on the strength of that string. */
               tickAt:  (state.remTickAt ?: 0L),
               // The hub's own clock, so the dashboard can tell whether a
               // device clock disagrees rather than silently trusting its own.
               now:     now()
           ]).toString()
}

def ackReminder() {
    try {
        def body = request.body
        def parsed = body ? new groovy.json.JsonSlurper().parseText(body) : null
        def id = (parsed instanceof Map) ? parsed.id : null
        if (!id) {
            render contentType: "application/json", headers: CORS_HEADERS,
                   data: '{"status":"error","message":"missing id"}'
            return
        }
        def rt = (state.remRuntime ?: [:])
        def entry = rt[id as String]
        if (!entry) {
            // Acking something the hub never fired is not an error worth
            // failing on -- the dashboard may have fired it locally.
            render contentType: "application/json", headers: CORS_HEADERS,
                   data: '{"status":"ok","note":"no runtime entry"}'
            return
        }
        entry.ackedAt = now()
        rt[id as String] = entry
        state.remRuntime = rt
        log.info "Hestia: reminder ${id} acknowledged"
        render contentType: "application/json", headers: CORS_HEADERS,
               data: '{"status":"ok"}'
    } catch (e) {
        log.error "Hestia: reminder ack error: ${e.message}"
        render contentType: "application/json", headers: CORS_HEADERS,
               data: '{"status":"error","message":"ack failed"}'
    }
}

/* Runs every minute, and again on systemStart.
 *
 * Cheap on the common path: when nothing is due it reads state, finds nothing,
 * and writes nothing. state.remRuntime is only assigned when something
 * actually changed, so this is not a once-a-minute write.
 *
 * Reminders are re-read from the config on every pass, so a reminder deleted
 * or disabled on any device simply stops being considered -- there is no stale
 * queue on the hub that could outlive it. */
def reminderTick() {
    try {
        def nowMs = now()
        /* Heartbeat, throttled, and FIRST -- ahead of every early return below.
           It answers "is this job running", not "did it have work to do". A
           household with no reminders yet still has a working tick, and
           reporting otherwise would make the dashboard fire locally the moment
           one was created, racing the hub that was about to fire it too. */
        Long beat = (state.remTickAt ?: 0L) as Long
        if (nowMs - beat > REMINDER_TICK_BEAT_MS) state.remTickAt = nowMs

        def cfg = getPushSettings()
        if (!cfg) return
        def reminders = cfg.reminders
        if (!(reminders instanceof List) || reminders.isEmpty()) return

        def rt = (state.remRuntime ?: [:])
        def changed = false

        reminders.each { rem ->
            if (!(rem instanceof Map)) return
            def id = rem.id as String
            /* Only an explicit true counts as enabled, matching the dashboard's
               own `if (!rem.enabled) return`. Treating a MISSING enabled flag as
               enabled here would have meant a reminder the dashboard considers
               off still firing from the hub -- silent on screen, loud on your
               phone, with nothing to explain the disagreement. */
            if (!id || rem.enabled != true) return
            def queue = rem.fireQueue
            if (!(queue instanceof List) || queue.isEmpty()) return

            def entry   = rt[id]
            def lastOcc = (entry?.occAt ?: 0L) as Long

            // The most recent instant that is due and newer than whatever we
            // last recorded. Only the latest matters: one entry per reminder,
            // by design, because a history of missed firings is explicitly not
            // wanted -- three days closed should say "missed", not list three.
            Long occAt = null
            queue.each { t ->
                Long ts = (t ?: 0L) as Long
                if (ts <= nowMs && ts > lastOcc && (occAt == null || ts > occAt)) occAt = ts
            }
            if (occAt == null) return

            rt[id] = [occAt: occAt, firedAt: nowMs, ackedAt: null]
            changed = true

            /* Record it either way, but only NOTIFY if it is still timely. A
               hub that was off for three days coming back and firing every
               reminder it missed would be worse than silence -- and for
               something like a medication reminder, actively unsafe. The
               dashboard shows it as missed regardless. */
            if (nowMs - occAt <= REMINDER_MISSED_AFTER_MS) {
                def label = (rem.label ?: "Reminder") as String
                /* Respect the household's master push switch, the same way
                   every other push path in this file does. "Reminders are
                   pushed" means push is the channel they use, not that they
                   override someone who turned notifications off. The
                   occurrence is still recorded above either way, so the
                   dashboard shows it whether or not anything was sent. */
                if (cfg.pushEnabled == true) {
                    pushSendNotification("reminder", "Reminder", label, cfg.token as String)
                    log.info "Hestia: reminder fired -- ${label}"
                } else {
                    log.info "Hestia: reminder due, push disabled -- ${label}"
                }
            } else {
                log.info "Hestia: reminder missed while hub was unavailable -- ${rem.label}"
            }
        }

        // Bounded storage: drop anything long settled. Only on a pass that was
        // already writing, so this never adds a write of its own.
        if (changed) {
            def pruned = [:]
            rt.each { k, v ->
                Long occ = (v?.occAt ?: 0L) as Long
                if (occ > 0L && (nowMs - occ) < REMINDER_RUNTIME_KEEP_MS) pruned[k] = v
            }
            state.remRuntime = pruned
        }
    } catch (e) {
        log.error "Hestia: reminder tick error: ${e.message}"
    }
}

/* A scheduled fire time that elapses while the hub is down is silently
   dropped by the platform -- it is never fired late and never caught up
   (confirmed: the scheduler does not reach back in time). Recurring schedules
   themselves survive a reboot fine, so this exists ONLY to reconcile the
   downtime window, not to re-register anything. */
def systemStartHandler(evt) {
    log.info "Hestia: hub restarted, reconciling reminders"
    reminderTick()
}

def pushSendNotification(String category, String title, String body, String token) {
    pushPostWithRetry(PUSH_SEND_URL, [
        category: category,
        title:    title,
        body:     body,
        armed:    state.pushArmed == true,
        token:    token
    ])
}

// Shared by pushRelayArmedState() and pushSendNotification() -- both relay
// to the same Cloudflare push backend and previously fired a bare
// asynchttpPost with no retry on failure. asynchttpPost's own callback has
// no way to delay inline, so a real retry has to go through the scheduler
// (runIn), not a loop in the same call.
def pushPostWithRetry(String uri, Map bodyMap, Integer attempt = 0) {
    try {
        asynchttpPost("pushPostCallback", [
            uri: uri,
            contentType: "application/json",
            requestContentType: "application/json",
            timeout: 10,
            body: new groovy.json.JsonBuilder(bodyMap).toString()
        ], [uri: uri, bodyMap: bodyMap, attempt: attempt])
    } catch (e) {
        log.warn "Hestia Push: relay error (attempt ${attempt}): ${e.message}"
        pushScheduleRetryIfEligible(uri, bodyMap, attempt, e.message)
    }
}

def pushPostCallback(response, data) {
    if (response?.status == 200) {
        // Logged at info even on a plain first-attempt success -- these
        // relays fire infrequently (arm/disarm changes, real HSM alerts),
        // so this is cheap, and it's the only way to confirm this code path
        // actually ran at all without waiting for a failure to happen.
        log.info "Hestia Push: relay sent" + ((data?.attempt ?: 0) > 0 ? " (succeeded on retry, attempt ${data.attempt})" : "")
        return
    }
    log.warn "Hestia Push: relay failed — HTTP ${response?.status} (attempt ${data?.attempt ?: 0})"
    pushScheduleRetryIfEligible(data?.uri, data?.bodyMap, (data?.attempt ?: 0) as Integer, "HTTP ${response?.status}")
}

def pushScheduleRetryIfEligible(String uri, Map bodyMap, Integer attempt, String reason) {
    if (!uri || !bodyMap) return
    if (attempt >= PUSH_RETRY_MAX) {
        log.warn "Hestia Push: giving up after ${attempt + 1} attempt(s) — ${reason}"
        return
    }
    log.info "Hestia Push: retrying in ${PUSH_RETRY_DELAY_SEC}s (attempt ${attempt + 1}) — ${reason}"
    runIn(PUSH_RETRY_DELAY_SEC, "pushRetryFire", [data: [uri: uri, bodyMap: bodyMap, attempt: attempt + 1]])
}

def pushRetryFire(data) {
    pushPostWithRetry(data.uri as String, data.bodyMap as Map, data.attempt as Integer)
}

// ── Config endpoints ──────────────────────────────────────────────────────
def getConfig() {
    def cfg = state.config
    // Hubitat's own state-size limit doesn't throw or fail on write -- it
    // silently persists a shorter value than what saveConfig() actually
    // wrote. That can't be caught synchronously inside saveConfig() itself
    // (state only actually persists once that execution ends, after any
    // check there would already have run); comparing against the length
    // saveConfig() recorded last time, here on a later read, is the
    // earliest point truncation actually becomes observable.
    if (cfg && cfg != "null" && state.configSize && cfg.length() != state.configSize) {
        log.warn "Hestia: state.config truncated (expected ${state.configSize} bytes, found ${cfg.length()}) — falling back to hub file"
        cfg = null // force the hub-file fallback below
    }
    if (!cfg || cfg == "null") {
        try {
            def bytes = downloadHubFile(CONFIG_FILENAME)
            if (bytes) {
                cfg = new String(bytes, "UTF-8")
                state.config = cfg
                state.configSize = cfg.length()
                log.info "Hestia: config restored from hub file (${cfg.length()} bytes)"
            }
        } catch(e) {
            log.warn "Hestia: hub file read failed: ${e.message}"
        }
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
        // Carry the household cloud secret forward when an incoming save omits
        // it. This store is the household's distribution point for it: every
        // device on the LAN reads it back with the config. A dashboard older
        // than v2.0.0 has no such field in its payload, so a stale tab or a
        // hub-served build still on the previous version would replace the
        // whole config and erase it -- after which devices holding the old
        // secret and devices that mint a new one write records neither can
        // read, silently and permanently.
        //
        // Deliberately ALL best-effort, parse included: preserving the secret
        // is a convenience, and must never be able to stop a save. Before this
        // existed, saveConfig() stored whatever string it was handed without
        // looking at it, so anything JsonSlurper dislikes has to fall through
        // to that same behaviour rather than reject the user's config.
        if (state.config) {
            try {
                def parsed = new groovy.json.JsonSlurper().parseText(body)
                def incoming = (parsed instanceof Map) ? parsed.config : null
                if (incoming instanceof Map && incoming.cloudSecret == null) {
                    def prev = new groovy.json.JsonSlurper().parseText(state.config)
                    def prevCfg = (prev instanceof Map) ? prev.config : null
                    def keep = (prevCfg instanceof Map) ? prevCfg.cloudSecret : null
                    if (keep) {
                        incoming.cloudSecret = keep
                        body = new groovy.json.JsonBuilder(parsed).toString()
                        log.info "Hestia: preserved household cloud secret across an older client's save"
                    }
                }
            } catch(e) {
                log.warn "Hestia: could not preserve cloud secret: ${e.message}"
            }
        }

        try { uploadHubFile(CONFIG_FILENAME, body.getBytes("UTF-8")) } catch(e) {
            log.warn "Hestia: hub file write failed: ${e.message}"
        }
        state.config     = body
        state.configSize = body.length()
        // Real truncation can't be detected here -- see getConfig()'s check,
        // which compares against state.configSize on a later read, once
        // Hubitat has actually had a chance to persist (or truncate) it.
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
               // Version of the index.html actually sitting on this hub, which is
               // what wall panels load from /local/. Distinct from APP_VERSION: the
               // app can be current while the copy it last downloaded is stale, and
               // without this the dashboard can't tell those two cases apart.
               dashboardVersion: state.dashboardVersion ?: null,
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
