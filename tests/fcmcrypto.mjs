/* Does the FCM JWT path actually work?
 *
 * None of it has ever run: PEM parsing, pkcs8 import, RS256 signing, base64url.
 * A review can read it; only execution proves it. Node 24 has the same
 * WebCrypto and the same btoa/atob a Worker does, so this exercises the real
 * module with a THROWAWAY key rather than the user's service account.
 */
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { sendFcmNotification } from '../functions/_lib/fcm.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const env = {
  FCM_SERVICE_ACCOUNT: JSON.stringify({
    client_email: 'hestia@example.iam.gserviceaccount.com',
    private_key: pem,
    project_id: 'hestia-test',
  }),
};

let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };

const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  if (String(url).includes('oauth2')) {
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.fake', expires_in: 3600 }) };
  }
  return { ok: true, status: 200, text: async () => '{}' };
};

const res = await sendFcmNotification(env, 'device-token-abc',
  { title: 'Smoke / CO Alert', body: 'Kitchen smoke detector', category: 'smoke', tag: 'smoke' });

check('the send reports ok', res.ok === true && res.status === 200);
check('two calls: token exchange then send', calls.length === 2, calls.map(c => c.url).join(' | '));

// ---- the JWT ----
const form = new URLSearchParams(calls[0].opts.body.toString());
const jwt = form.get('assertion');
check('a JWT assertion was sent', typeof jwt === 'string' && jwt.split('.').length === 3);

const [h64, c64, s64] = jwt.split('.');
const un = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const header = JSON.parse(un(h64).toString());
const claims = JSON.parse(un(c64).toString());

check('header is RS256', header.alg === 'RS256' && header.typ === 'JWT', JSON.stringify(header));
check('issuer is the service account', claims.iss === 'hestia@example.iam.gserviceaccount.com');
check('scope is firebase.messaging', claims.scope === 'https://www.googleapis.com/auth/firebase.messaging');
check('audience is the token endpoint', claims.aud === 'https://oauth2.googleapis.com/token');
check('expiry is in the future and within an hour',
  claims.exp > claims.iat && claims.exp - claims.iat <= 3600);

/* THE ONE THAT MATTERS. If the PEM parse or the pkcs8 import were wrong the
   signature would still be bytes and still be base64url; only verifying it
   against the public half proves the key was read correctly. */
const v = createVerify('RSA-SHA256');
v.update(`${h64}.${c64}`);
check('the signature verifies against the public key',
  v.verify(publicKey, un(s64)),
  'proves PEM parse, pkcs8 import and RS256 signing are all correct');

check('base64url, not base64', !/[+/=]/.test(jwt), 'a + or / would make the assertion unparseable');

// ---- the send ----
const sendUrl = calls[1].url;
check('sends to the project from the service account',
  sendUrl === 'https://fcm.googleapis.com/v1/projects/hestia-test/messages:send', sendUrl);
check('bearer token from the exchange',
  calls[1].opts.headers.Authorization === 'Bearer ya29.fake');

const msg = JSON.parse(calls[1].opts.body).message;
check('addressed to the device token', msg.token === 'device-token-abc');
/* Data-only. A notification block would be rendered by Android itself when the
   app is backgrounded, so HestiaMessaging would never run and could not pick
   the channel: a door chime and a smoke alarm would look identical. */
check('data-only, no notification block', msg.notification === undefined && !!msg.data);
check('every data value is a string, which FCM requires',
  Object.values(msg.data).every(v => typeof v === 'string'), JSON.stringify(msg.data));
check('high priority so a dozing device wakes', msg.android.priority === 'high');

// ---- the token is cached ----
calls.length = 0;
await sendFcmNotification(env, 'device-token-abc', { title: 'x', body: 'y', category: 'door' });
check('the second send reuses the access token',
  calls.length === 1 && calls[0].url.includes('fcm.googleapis.com'),
  'a token exchange per notification would be a round trip nobody needs');

// ---- bad credentials fail loudly ----
for (const [label, bad] of [
  ['missing', {}],
  ['not JSON', { FCM_SERVICE_ACCOUNT: 'nonsense' }],
  ['incomplete', { FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'a@b.c' }) }],
]) {
  let threw = null;
  await sendFcmNotification(bad, 't', { title: 'x', body: 'y' }).catch(e => { threw = e; });
  check(`a ${label} service account throws rather than silently not sending`, !!threw, threw && threw.message);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
