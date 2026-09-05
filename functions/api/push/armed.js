import { getHouseholdConfig } from '../../_lib/householdConfig.js';
import { logActivity } from '../../_lib/activityLog.js';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Lightweight relay from HestiaDashboard.groovy's native HSM subscription.
// Groovy can't poll Maker API from the hub itself (a hub calling its own
// LAN-facing IP is a different, sometimes-blocked network path than any
// other device reaching that same address -- confirmed the hard way
// tonight), but arm-state comes from a location-level event subscription,
// which never made an HTTP call in the first place. This just relays that
// state outward -- an ordinary outbound call, the same kind
// pushSendNotification() in Groovy already makes successfully -- so
// webhook.js knows current arm state when a device event arrives moments
// later and needs to decide "armed only" gating.
//
// Body: { armed: boolean, token }
export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
  }

  const { armed, token } = body;
  if (typeof armed !== 'boolean' || !token) {
    return Response.json({ status: 'error', message: 'missing armed or token' }, { status: 400 });
  }

  const hash = await sha256(ip);
  const shortHash = hash.substring(0, 16);

  const household = await getHouseholdConfig(env, ip, shortHash);
  if (!household) return Response.json({ status: 'error', message: 'unknown household' }, { status: 404 });

  const storedToken = household.config && household.config.token;
  if (!storedToken || token !== storedToken) {
    return Response.json({ status: 'error', message: 'unauthorized' }, { status: 401 });
  }

  // This key is current STATE, not an event record -- unlike config/push
  // KV entries (which SHOULD expire if a household truly goes stale), a
  // household that stays armed continuously for 30+ days with no hsmStatus
  // change or hub reboot (both of which already refresh this write) would
  // otherwise have the key silently expire mid-armed-period: armedRaw
  // becomes null, webhook.js reads that as disarmed, "armed only" push
  // devices go quiet, and the motion cooldown wrongly relaxes during an
  // actually-armed window. A 1-year TTL keeps this effectively persistent
  // for any realistic continuous-armed duration while still eventually
  // cleaning up a genuinely abandoned household.
  const ARMED_TTL_SECONDS = 365 * 24 * 60 * 60;
  const prevRaw = await env.HESTIA_KV.get(`armed:${shortHash}`);
  const prev = prevRaw === '1';
  await env.HESTIA_KV.put(`armed:${shortHash}`, armed ? '1' : '0', { expirationTtl: ARMED_TTL_SECONDS });

  if (prevRaw === null || prev !== armed) {
    await logActivity(env, shortHash, {
      category: 'alarm',
      title: armed ? 'System Armed' : 'System Disarmed',
      body: armed ? 'Security system armed.' : 'Security system disarmed.',
      source: 'hsm',
    });
  }

  return Response.json({ status: 'ok' });
}
