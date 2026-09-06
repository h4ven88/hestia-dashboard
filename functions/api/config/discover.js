async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ request, env }) {
  try {
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return Response.json({ found: false });

    const hash = await sha256(ip);
    const key = `ip:${hash.substring(0, 16)}`;
    const value = await env.HESTIA_KV.get(key);

    if (!value) return Response.json({ found: false });

    return new Response(JSON.stringify({ found: true, ...JSON.parse(value) }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  } catch (err) {
    console.error('[config/discover] onRequestGet error:', err);
    return Response.json({ found: false }, { status: 500 });
  }
}
