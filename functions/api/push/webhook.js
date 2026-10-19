import { dispatchPush } from '../../_lib/pushDispatch.js';
import { getHouseholdConfig } from '../../_lib/householdConfig.js';
import { logActivity } from '../../_lib/activityLog.js';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Maps a device event to what CONFIG.artemisSensors/CONFIG.locks category it
// belongs to, if any -- the same categorization dashboard.html itself uses
// for Announcements, just read from the synced config instead of live CONFIG.
function categorize(config, deviceId) {
  const sensors = config.artemisSensors || {};
  const findIn = (arr) => (arr || []).find(d => String(d.id) === String(deviceId));
  let hit = findIn(sensors.contacts);
  if (hit) return { cat: 'contacts', subtype: hit.subtype, name: hit.name || 'Sensor' };
  hit = findIn(sensors.motions);
  if (hit) return { cat: 'motions', name: hit.name || 'Sensor' };
  hit = findIn(sensors.smokes);
  if (hit) return { cat: 'smokes', name: hit.name || 'Sensor' };
  hit = findIn(sensors.waters);
  if (hit) return { cat: 'waters', name: hit.name || 'Sensor' };
  const lock = (config.locks || []).find(l => String(l.id) === String(deviceId));
  if (lock) return { cat: 'locks', name: lock.label || 'Lock' };
  return null;
}

// Same event shapes the push dispatch switch below recognizes, but with none
// of its on/off category toggles, open/close gates, or per-device motion
// picker applied -- the Activity Log records what happened, not what the
// user chose to be notified about.
function describeEvent(info, evt) {
  if (info.cat === 'contacts' && evt.name === 'contact' && (evt.value === 'open' || evt.value === 'closed')) {
    const isWindow = info.subtype === 'window';
    return {
      category: isWindow ? 'windows' : 'doors',
      title: `${isWindow ? 'Window' : 'Door'} ${evt.value === 'open' ? 'Opened' : 'Closed'}`,
      body: `${evt.displayName || info.name} is now ${evt.value}.`,
    };
  }
  if (info.cat === 'locks' && evt.name === 'lock' && (evt.value === 'locked' || evt.value === 'unlocked')) {
    return {
      category: 'locks',
      title: `Door ${evt.value === 'locked' ? 'Locked' : 'Unlocked'}`,
      body: `${evt.displayName || info.name} was ${evt.value}.`,
    };
  }
  if (info.cat === 'motions' && evt.name === 'motion' && evt.value === 'active') {
    return { category: 'motion', title: 'Motion Detected', body: `Motion detected: ${evt.displayName || info.name}.` };
  }
  if (info.cat === 'smokes' && (evt.name === 'smoke' || evt.name === 'carbonMonoxide') && evt.value === 'detected') {
    return {
      category: 'smoke',
      title: 'Smoke / CO Alert',
      body: `${evt.displayName || info.name} detected ${evt.name === 'smoke' ? 'smoke' : 'carbon monoxide'}!`,
    };
  }
  if (info.cat === 'waters' && evt.name === 'water' && evt.value === 'wet') {
    return { category: 'water', title: 'Water / Freeze Alert', body: `${evt.displayName || info.name} detected water!` };
  }
  return null;
}

// While disarmed, a lingering person can retrigger the same motion sensor
// dozens of times in a few minutes -- each one a separate KV write with no
// real added information. Cooldown is scoped per-sensor (not house-wide),
// so movement between rooms during a real event still logs each sensor's
// first trigger; it only suppresses the *same* sensor re-firing on top of
// itself. While armed, skip the cooldown entirely -- that's exactly when
// full-resolution tracking (e.g. where an intruder has been) matters most,
// and it's also when motion should be rare in the first place.
const MOTION_LOG_COOLDOWN_SECONDS = 600; // 10 minutes, disarmed only

// The on/off category toggles, open/close gates, and per-device motion
// picker from Settings > Push Notifications -- applied only to push
// dispatch, never to the Activity Log above.
function pushAllowed(config, described, evt) {
  const openOn  = config.pushOpen  !== false;
  const closeOn = config.pushClose !== false;
  switch (described.category) {
    case 'doors':   return config.pushDoors   !== false && (evt.value === 'open' ? openOn : closeOn);
    case 'windows': return config.pushWindows !== false && (evt.value === 'open' ? openOn : closeOn);
    case 'locks':   return config.pushLocks   !== false && (evt.value === 'unlocked' ? openOn : closeOn);
    case 'motion':  return config.pushMotion  === true && new Set((config.pushMotionDevices || []).map(String)).has(String(evt.deviceId));
    case 'smoke':   return config.pushSmoke   !== false;
    case 'water':   return config.pushWater   !== false;
    default:        return false;
  }
}

// Registered automatically by dashboard.html as Maker API's device-event
// POST URL (see pushRegisterMakerApiWebhook() in dashboard.html) -- this is
// the actual trigger for push notifications. Hubitat only emits an event
// when an attribute's value actually changes, so unlike the Groovy polling
// this replaced, there's no "diff against last-seen state" step needed here;
// every event that arrives already represents a real transition.
//
// Body (Maker API's own shape): { content: { name, value, displayName,
// deviceId, descriptionText, unit, data } }
/* The capability verifier, at its own KV key.
 *
 * NOT in the record's service half, because discover.js hands that to anyone
 * at this address -- which is the mistake the wcap comment in config/index.js
 * already warns about. Written only by an authorised config write, so the
 * stored side of the comparison is never attacker-chosen. */
export const webhookCapKey = (shortHash) => `hcap:${shortHash}`;

/* ⛔ THE CUTOFF THAT WAS DOCUMENTED AND NEVER EXISTED.
 *
 * CLAUDE.md states, as shipped behaviour, that uncapped posts are "accepted
 * until 2026-11-30, and refused the moment that household registers a
 * capability". The second half was real. The FIRST HALF WAS NOT IN THE CODE AT
 * ALL -- a grep of functions/ for this date, for any date comparison, for
 * `cutoff` and for `graceUntil` returned nothing. So the window never closed,
 * and the population it stays open for is precisely the one it was written to
 * serve: a household that never registers a capability. It waited for an event
 * that, for its target population, does not occur.
 *
 * That is worse than a plain gap, because anyone reading the notes believed a
 * backstop existed. A documented guard that is absent from the code is the
 * failure mode this project has paid for repeatedly.
 *
 * WHO IS ACTUALLY LEFT IN THE WINDOW, which is what makes the date safe:
 * registering happens in the dashboard, and enabling push at all requires
 * opening the dashboard. So any household that has opened one since v2.2.0
 * already has a capability and never reaches the grace. What remains is a
 * household that enabled push BEFORE v2.2.0 and has not opened a dashboard
 * since -- and their `ip:` record has a 30-day TTL, so most have lapsed anyway.
 * Opening the dashboard once fixes it, and the refusal below says so in the log
 * rather than failing silently. */
const UNCAPPED_GRACE_UNTIL = Date.parse('2026-11-30T23:59:59Z');

export async function onRequestPost({ request, env }) {
  return processDeviceEvent({ request, env, cap: null });
}

/* Shared by this route (uncapped, legacy) and webhook/[cap].js (capped).
 *
 * WHY A CAPABILITY AT ALL: this endpoint had no credential of any kind, and it
 * composes with discover.js into a remotely triggerable fire alarm. A
 * neighbour sharing the public IP reads the household's smoke sensor ids from
 * discover.js, POSTs {deviceId, name:'smoke', value:'detected'} here, and
 * because 'smoke' is in pushDispatch's ALWAYS_CATEGORIES it bypasses the
 * armed-only gate and every phone in the house gets "Smoke / CO Alert", at any
 * hour, repeatably. The same trick blinds the Activity Log: one fake motion
 * event per sensor every ten minutes holds the mcool: cooldown open so real
 * motion is never recorded.
 *
 * WHY THE CAPABILITY IS A PATH SEGMENT, not a query string: Hubitat's docs
 * specify /postURL/[URL] with the target "URL encoded" and say nothing about
 * whether a query string survives being encoded, stored and replayed. That is
 * unconfirmed platform behaviour, and this project has nearly shipped on three
 * of those already. A path segment cannot be dropped without breaking postURL
 * for every user of it, so it needs no assumption.
 *
 * WHY UNCAPPED IS STILL ACCEPTED: only the browser can re-register the URL --
 * a Groovy app cannot reliably call its own hub's Maker API (established by
 * direct testing in Sprint 13). Refusing uncapped POSTs on the release that
 * introduces the cap would silently kill device-event push and Activity Log
 * capture for every household that does not open a dashboard, who are exactly
 * the push-only households the feature is for. So uncapped is accepted for a
 * stated grace window.
 *
 * THE WINDOW CLOSES PER HOUSEHOLD, NOT ON A DATE ALONE: once a household has
 * registered a capped URL it has an hcap: verifier, and from that moment an
 * uncapped POST for that household is refused. So a household is protected the
 * first time it opens a dashboard, and only households that have never
 * migrated stay exposed. */
export async function processDeviceEvent({ request, env, cap }) {
  try {
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
    }

    // Hubitat's own docs describe this payload wrapped in a "content" object,
    // but real hub logs show it arrives flat (no wrapper at all) -- accept
    // either shape rather than trust the docs over an actual captured payload.
    const evt = (body && body.content) || body;
    if (!evt || !evt.deviceId) return Response.json({ status: 'ok', skipped: 'no device event' });

    const hash = await sha256(ip);
    const shortHash = hash.substring(0, 16);

    /* The gate. Verifier is stored hashed; the caller presents the raw value,
       so neither side of this comparison is attacker-chosen. */
    const storedCap = await env.HESTIA_KV.get(webhookCapKey(shortHash));
    if (storedCap) {
      /* This arm is REDUNDANT for safety and exists for the log line. With it
         removed, a `cap` of null still falls to the comparison below, where
         sha256(null) hashes the string "null" and can never equal a stored
         verifier, so the request is refused either way -- confirmed by
         mutating this block out and watching the suite stay green while the
         401 still happened. Kept because "refused an uncapped POST" and
         "refused a bad capability" are different operational facts, and a
         household debugging its own notifications needs to tell them apart. */
      if (!cap) {
        console.warn('[push/webhook] refused an uncapped POST for a household that has registered a capability', shortHash);
        return Response.json({ status: 'error', message: 'unauthorized' }, { status: 401 });
      }
      if (await sha256(cap) !== storedCap) {
        console.warn('[push/webhook] refused a POST presenting a bad capability', shortHash);
        return Response.json({ status: 'error', message: 'unauthorized' }, { status: 401 });
      }
    } else if (cap) {
      /* Presented a capability for a household that has none stored. Not an
         attack -- most likely a re-registration whose config write has not
         landed yet. Nothing to verify against, so it is treated exactly like
         an uncapped call rather than refused. */
      console.warn('[push/webhook] capability presented but none stored yet', shortHash);
    } else {
      /* ⛔ THE GRACE WINDOW IS REACHABLE BY CSRF, NOT ONLY BY THE IP NEIGHBOUR.
       *
       * There are no CORS headers anywhere in functions/, no _middleware.js and
       * no Origin check. A POST with Content-Type: text/plain and a JSON string
       * body is a CORS *simple* request -- no preflight -- and request.json()
       * parses it regardless of content type. So ANY website a member of the
       * household visits could fire a fabricated smoke alert into that house,
       * blind, with no need to share the public IP at all. That is outside the
       * settled threat model's boundary, which is the CGNAT neighbour.
       *
       * Every other endpoint is accidentally protected here, because PUT/DELETE
       * and application/json all force a preflight that then fails.
       *
       * A browser ALWAYS attaches Origin to a cross-origin POST. The hub does
       * not -- it is not a browser. So presence of Origin on this path means a
       * browser sent it, and nothing legitimate does.
       *
       * ⚠ DELIBERATELY SCOPED TO THE GRACE PATH ONLY. A household that has
       * registered a capability is authorised above and never reaches here, so
       * this guard cannot break push for them even if some hub somewhere does
       * send an Origin header. The only path it tightens is the one that
       * currently accepts anonymous posts. */
      const origin = request.headers.get('Origin');
      if (origin) {
        console.warn('[push/webhook] refused a browser-originated uncapped POST', shortHash, origin);
        return Response.json({ status: 'error', message: 'unauthorized' }, { status: 401 });
      }
      /* The date half of the grace -- see UNCAPPED_GRACE_UNTIL. Note the clock
         is the Worker's, never anything a caller supplies, so this is not a
         value an attacker can choose. */
      if (Date.now() > UNCAPPED_GRACE_UNTIL) {
        console.warn('[push/webhook] refused an uncapped POST after the grace window closed',
          shortHash, '-- this household must open a dashboard once to register its webhook');
        return Response.json({
          status: 'error',
          message: 'this household has not registered a webhook capability; open the Hestia dashboard once to register it',
        }, { status: 401 });
      }
      // Grace: this household has never registered a capability.
      console.warn('[push/webhook] accepted an uncapped POST (grace window)', shortHash);
    }

    const household = await getHouseholdConfig(env, ip, shortHash);
    if (!household) {
      // Returned a bare 200 with no server-side log, so a household whose
      // record was missing or unreadable had push and the Activity Log die in
      // complete silence -- Maker API sees success and never retries.
      console.error('[push/webhook] no readable record for household', shortHash);
      return Response.json({ status: 'ok', skipped: 'unknown household' });
    }
    const config = household.config || {};

    const info = categorize(config, evt.deviceId);
    if (!info) return Response.json({ status: 'ok', skipped: 'device not categorized' });

    const described = describeEvent(info, evt);
    if (!described) return Response.json({ status: 'ok', skipped: 'not a tracked transition' });

    // Needed for both the motion cooldown decision below and push dispatch's
    // armed-only gate -- fetched once and reused rather than twice.
    let armed = false;
    if (described.category === 'motion' || config.pushEnabled === true) {
      const armedRaw = await env.HESTIA_KV.get(`armed:${shortHash}`);
      armed = armedRaw === '1';
    }

    // Logged independent of the push toggle and its category gates below --
    // Maker API keeps streaming events to this URL even after Push
    // Notifications is turned off in Settings (there's no matching
    // "unregister" call), and the Activity Log is meant to show what actually
    // happened in the home regardless of notification preferences. Motion
    // while disarmed is the one exception, gated by a per-sensor cooldown --
    // see MOTION_LOG_COOLDOWN_SECONDS above.
    let logged = true;
    if (described.category === 'motion' && !armed) {
      const cooldownKey = `mcool:${shortHash}:${evt.deviceId}`;
      const cooling = await env.HESTIA_KV.get(cooldownKey);
      if (cooling) {
        logged = false;
      } else {
        await env.HESTIA_KV.put(cooldownKey, '1', { expirationTtl: MOTION_LOG_COOLDOWN_SECONDS });
      }
    }
    if (logged) await logActivity(env, shortHash, { ...described, source: 'device' });

    if (config.pushEnabled !== true) return Response.json({ status: 'ok', skipped: 'push disabled', logged });
    if (!pushAllowed(config, described, evt)) return Response.json({ status: 'ok', skipped: 'no matching category/gate', logged });

    /* The sensor that fired, so a flapping contact collapses onto itself while
       two different doors stay two notifications. Without it the back door
       opening silently replaced the front door opening. */
    const result = await dispatchPush(env, shortHash, { category: described.category, title: described.title, body: described.body, armed, deviceKey: evt.deviceId });
    return Response.json({ status: 'ok', logged, ...result });
  } catch (err) {
    console.error('[push/webhook] onRequestPost error:', err);
    return Response.json({ status: 'error', message: 'internal error' }, { status: 500 });
  }
}
