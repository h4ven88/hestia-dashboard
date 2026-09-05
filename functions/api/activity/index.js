import { listActivity } from '../../_lib/activityLog.js';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Same trust boundary as discover.js and the rest of the config-sync
// endpoints: the caller's own public IP hash IS the household scope, no
// separate token needed to just read back events for that scope.
export async function onRequestGet({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

  const hash = await sha256(ip);
  const shortHash = hash.substring(0, 16);

  // Capped well under Cloudflare's per-invocation subrequest ceiling --
  // listActivity() issues one KV get per entry, so this bound (plus the
  // list() call itself) is what actually keeps this endpoint from 500ing.
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 25, 1), 25);

  const entries = await listActivity(env, shortHash, limit);
  return Response.json({ status: 'ok', entries }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}
