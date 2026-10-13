// Firebase Cloud Messaging, for devices that cannot do Web Push.
//
// WHY THIS EXISTS AT ALL: an Android WebView has no Push API and no service
// worker push, so the native app can never hold a Web Push subscription. FCM
// is the only transport to an app whose screen is off. Browsers keep using
// VAPID/Web Push exactly as before; this is additive and nothing in the
// existing path changed to accommodate it.
//
// FCM's HTTP v1 API needs an OAuth2 access token, which means signing a JWT
// with the service account key and exchanging it. The legacy server-key API
// that needed none of this is retired, so there is no simpler route.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/* The access token lives an hour. Cached in module scope rather than KV on
   purpose: a Worker isolate is reused across many requests, so this costs
   nothing and avoids a KV write per hour per isolate. KV write volume is not
   hypothetical here -- it took the backend down for every household once
   already, and the fix for that was to stop writing things that had not
   changed. A cold isolate simply mints a new one. */
let _cachedToken = null;      // { token, expiresAt }

/* Refreshed a minute early. A token that expires mid-flight fails the send
   with a 401, and the notification it was carrying is the one the user most
   wanted at that moment. */
const EXPIRY_MARGIN_MS = 60 * 1000;

function b64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlText(str) {
  return b64url(new TextEncoder().encode(str));
}

/** The service account's PEM private key as a CryptoKey for RS256 signing. */
async function importKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    raw,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * Reads the service account out of the environment.
 *
 * Throws rather than returning null, because every caller's only sensible
 * response to a missing or malformed credential is to stop. A silent null
 * would surface later as "nothing was sent" with no reason attached, which on
 * this backend is the failure shape that costs days.
 */
function serviceAccount(env) {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FCM_SERVICE_ACCOUNT is not set');
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch (e) {
    throw new Error('FCM_SERVICE_ACCOUNT is not valid JSON');
  }
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new Error('FCM_SERVICE_ACCOUNT is missing client_email, private_key or project_id');
  }
  return sa;
}

async function accessToken(env) {
  if (_cachedToken && _cachedToken.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return _cachedToken.token;
  }
  const sa = serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlText(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));

  const key = await importKey(sa.private_key);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const assertion = `${header}.${claims}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`FCM token exchange failed ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  _cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
  return _cachedToken.token;
}

/**
 * Sends one notification to one FCM registration token.
 *
 * Returns the same `{ ok, status }` shape the Web Push path returns, so
 * dispatchPush can treat both transports identically and the pruning rules
 * stay in one place.
 *
 * DATA-ONLY, DELIBERATELY. A message carrying a `notification` block is
 * rendered by Android itself whenever the app is backgrounded, which means the
 * app's own messaging service never runs and cannot choose the channel, the
 * importance or the tap target -- a door chime and a smoke alarm would arrive
 * identically. Sending data-only keeps that decision in the app, where the two
 * channels live.
 */
export async function sendFcmNotification(env, registrationToken, { title, body, category, tag }) {
  const sa = serviceAccount(env);
  const token = await accessToken(env);

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: registrationToken,
          // Every value must be a string; FCM rejects the message outright
          // otherwise, and a rejected smoke alert is worse than a late one.
          data: {
            title: String(title ?? ''),
            body: String(body ?? ''),
            category: String(category ?? ''),
            ...(tag ? { tag: String(tag) } : {}),
          },
          android: {
            // 'high' wakes a dozing device. The alternative, 'normal', lets
            // Android hold the message until the next maintenance window,
            // which can be many minutes -- acceptable for a newsletter and
            // not for an intrusion alert.
            priority: 'high',
          },
        },
      }),
    }
  );

  return { ok: res.ok, status: res.status };
}

/**
 * Is this registration token dead?
 *
 * 404 UNREGISTERED only. The app was uninstalled or the token was rotated, and
 * that value will never deliver again.
 *
 * ⛔ 400 IS DELIBERATELY NOT HERE, and an earlier version of this function had
 * it. Google returns INVALID_ARGUMENT for a bad token AND for a payload
 * problem: message too big, an invalid data key, a bad TTL. Their own guidance
 * is to remove a registration on 400 only "provided you have confirmed the
 * payload is valid", and this function cannot confirm that, because
 * sendFcmNotification discards the response body.
 *
 * The failure that makes it matter: webhook.js builds a notification body from
 * a device's display name with no length cap. One oversized event returns 400
 * for EVERY device in the household in the same dispatch, and pruning on it
 * would delete all of them at once. The phones would go permanently silent
 * while the browsers kept working, with nothing on any screen to say so.
 *
 * Erring the other way is cheap: a genuinely dead token that returns 400
 * instead of 404 simply stays in the list and fails again later.
 */
export function fcmTokenIsDead(status) {
  return status === 404;
}
