async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// getHouseholdConfig() (functions/_lib/householdConfig.js) requires the
// stored value to decrypt as { encrypted: true, payload: { iv, data } } --
// anything else silently decrypts to null downstream instead of erroring.
// This only checks that outer wrapper shape/types match what the read side
// actually requires; it never decrypts or inspects the encrypted payload.
function isValidConfigPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.encrypted !== true) return false;
  const payload = body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (typeof payload.iv !== 'string' || !payload.iv) return false;
  if (typeof payload.data !== 'string' || !payload.data) return false;
  return true;
}

export async function onRequestPut({ request, env }) {
  try {
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
    }

    if (!isValidConfigPayload(body)) {
      return Response.json({ status: 'error', message: 'invalid config payload shape' }, { status: 400 });
    }

    const raw = JSON.stringify(body);
    if (raw.length > 65536) {
      return Response.json({ status: 'error', message: 'payload too large' }, { status: 413 });
    }

    const hash = await sha256(ip);
    const ipKey = `ip:${hash.substring(0, 16)}`;

    await env.HESTIA_KV.put(ipKey, raw, { expirationTtl: 2592000 });

    return Response.json({ status: 'ok' });
  } catch (err) {
    console.error('[config/index] onRequestPut error:', err);
    return Response.json({ status: 'error', message: 'internal error' }, { status: 500 });
  }
}
