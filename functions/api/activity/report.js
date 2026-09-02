import { logActivity } from '../../_lib/activityLog.js';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Fire-and-forget target for dashboard.html's announceEvent() -- Announcements
// are entirely client-side/TTS and never otherwise touch the backend, so this
// is the only way they can show up in the same unified Activity Log as push
// events. Same IP-hash trust boundary as the rest of config sync: a caller
// can only ever write into their own household's log, never another's.
//
// Body: { category, title, body }
export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return Response.json({ status: 'error', message: 'no IP' }, { status: 400 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON' }, { status: 400 });
  }

  const { category, title, body: message } = body;
  if (!title || !message) {
    return Response.json({ status: 'error', message: 'missing title or body' }, { status: 400 });
  }

  const hash = await sha256(ip);
  const shortHash = hash.substring(0, 16);

  await logActivity(env, shortHash, { category: category || 'announcement', title, body: message, source: 'announcement' });
  return Response.json({ status: 'ok' });
}
