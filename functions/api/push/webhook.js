import { dispatchPush } from '../../_lib/pushDispatch.js';

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

// Registered automatically by dashboard.html as Maker API's device-event
// POST URL (see pushRegisterMakerApiWebhook() in dashboard.html) -- this is
// the actual trigger for push notifications. Hubitat only emits an event
// when an attribute's value actually changes, so unlike the Groovy polling
// this replaced, there's no "diff against last-seen state" step needed here;
// every event that arrives already represents a real transition.
//
// Body (Maker API's own shape): { content: { name, value, displayName,
// deviceId, descriptionText, unit, data } }
export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
  }

  const evt = body && body.content;
  if (!evt || !evt.deviceId) return Response.json({ status: 'ok', skipped: 'no device event' });

  const hash = await sha256(ip);
  const shortHash = hash.substring(0, 16);

  const configRaw = await env.HESTIA_KV.get(`ip:${shortHash}`);
  if (!configRaw) return Response.json({ status: 'ok', skipped: 'unknown household' });

  const config = (JSON.parse(configRaw).config) || {};
  if (config.pushEnabled !== true) return Response.json({ status: 'ok', skipped: 'push disabled' });

  const info = categorize(config, evt.deviceId);
  if (!info) return Response.json({ status: 'ok', skipped: 'device not categorized for push' });

  const doorsOn   = config.pushDoors   !== false;
  const windowsOn = config.pushWindows !== false;
  const locksOn   = config.pushLocks   !== false;
  const motionOn  = config.pushMotion  === true;
  const smokeOn   = config.pushSmoke   !== false;
  const waterOn   = config.pushWater   !== false;
  const openOn    = config.pushOpen    !== false;
  const closeOn   = config.pushClose   !== false;
  const motionAllowed = new Set((config.pushMotionDevices || []).map(String));

  let category = null, title = null, message = null;

  if (info.cat === 'contacts' && evt.name === 'contact' && (evt.value === 'open' || evt.value === 'closed')) {
    const isWindow = info.subtype === 'window';
    if ((isWindow ? windowsOn : doorsOn) && (evt.value === 'open' ? openOn : closeOn)) {
      category = isWindow ? 'windows' : 'doors';
      title = `${isWindow ? 'Window' : 'Door'} ${evt.value === 'open' ? 'Opened' : 'Closed'}`;
      message = `${evt.displayName || info.name} is now ${evt.value}.`;
    }
  } else if (info.cat === 'locks' && evt.name === 'lock' && (evt.value === 'locked' || evt.value === 'unlocked')) {
    if (locksOn && (evt.value === 'unlocked' ? openOn : closeOn)) {
      category = 'locks';
      title = `Door ${evt.value === 'locked' ? 'Locked' : 'Unlocked'}`;
      message = `${evt.displayName || info.name} was ${evt.value}.`;
    }
  } else if (info.cat === 'motions' && evt.name === 'motion' && evt.value === 'active') {
    if (motionOn && motionAllowed.has(String(evt.deviceId))) {
      category = 'motion';
      title = 'Motion Detected';
      message = `Motion detected: ${evt.displayName || info.name}.`;
    }
  } else if (info.cat === 'smokes' && (evt.name === 'smoke' || evt.name === 'carbonMonoxide') && evt.value === 'detected') {
    if (smokeOn) {
      category = 'smoke';
      title = 'Smoke / CO Alert';
      message = `${evt.displayName || info.name} detected ${evt.name === 'smoke' ? 'smoke' : 'carbon monoxide'}!`;
    }
  } else if (info.cat === 'waters' && evt.name === 'water' && evt.value === 'wet') {
    if (waterOn) {
      category = 'water';
      title = 'Water / Freeze Alert';
      message = `${evt.displayName || info.name} detected water!`;
    }
  }

  if (!category) return Response.json({ status: 'ok', skipped: 'no matching category/gate' });

  const armedRaw = await env.HESTIA_KV.get(`armed:${shortHash}`);
  const armed = armedRaw === '1';

  const result = await dispatchPush(env, shortHash, { category, title, body: message, armed });
  return Response.json({ status: 'ok', ...result });
}
