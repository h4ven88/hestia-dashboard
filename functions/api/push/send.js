import { dispatchPush } from '../../_lib/pushDispatch.js';
import { getHouseholdConfig } from '../../_lib/householdConfig.js';
import { logActivity } from '../../_lib/activityLog.js';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Manual/testing entry point -- token-authenticated so it can be called
// directly (e.g. from a terminal) without a real device event. The
// automatic path is webhook.js, triggered by Maker API's device-event POST
// URL feature; both funnel into the same dispatchPush() so gating rules
// can't drift between the two.
//
// Body: { category, title, body, armed, token }
// "token" must match this household's Maker API access token, already
// stored via the existing config-sync PUT under the same ip-hash key. A
// lightweight way to verify the caller actually holds this household's
// credentials before fanning out real notifications, without inventing a
// separate secret-management scheme -- reuses data that's already synced.
export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
  }

  const { category, title, body: message, armed, token } = body;
  if (!title || !message) {
    return Response.json({ status: 'error', message: 'missing title or body' }, { status: 400 });
  }

  const hash = await sha256(ip);
  const shortHash = hash.substring(0, 16);

  const household = await getHouseholdConfig(env, ip, shortHash);
  if (!household) return Response.json({ status: 'error', message: 'unknown household' }, { status: 404 });

  const storedToken = household.config && household.config.token;
  if (!storedToken || !token || token !== storedToken) {
    return Response.json({ status: 'error', message: 'unauthorized' }, { status: 401 });
  }

  // This endpoint is the only path for hsmAlert intrusion trips (Groovy's
  // pushHsmAlertHandler calls it directly, bypassing webhook.js entirely),
  // so it's also the only place those can be captured for the Activity Log.
  if (category) {
    await logActivity(env, shortHash, { category, title, body: message, source: category === 'alarming' ? 'hsm' : 'manual' });
  }

  const result = await dispatchPush(env, shortHash, { category, title, body: message, armed });
  return Response.json({ status: 'ok', logged: !!category, ...result });
}
