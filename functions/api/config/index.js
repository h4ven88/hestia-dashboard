async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPut({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
  }

  const raw = JSON.stringify(body);
  if (raw.length > 65536) {
    return Response.json({ status: 'error', message: 'payload too large' }, { status: 413 });
  }

  const hash = await sha256(ip);
  const ipKey = `ip:${hash.substring(0, 16)}`;

  await env.HESTIA_KV.put(ipKey, raw, { expirationTtl: 2592000 });

  if (body.homeId) {
    await env.HESTIA_KV.put(`home:${body.homeId}`, raw, { expirationTtl: 2592000 });
  }

  return Response.json({ status: 'ok' });
}
