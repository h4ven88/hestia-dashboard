// One KV key per event, never a growing list under one key -- that
// read-modify-write pattern is exactly what caused the cross-device
// config-clobbering race fixed earlier tonight (two writes landing close
// together, one silently overwriting the other's append). Each event here
// is a fully independent write with no read-before-write at all, so
// concurrent events can never collide. Retention is handled by KV's own
// expirationTtl instead of manual pruning logic.
const RETENTION_SECONDS = 30 * 24 * 60 * 60; // 30 days, matches the TTL already used for config/push KV entries

export async function logActivity(env, shortHash, { category, title, body, source }) {
  try {
    const ts = Date.now();
    const rand = crypto.randomUUID().slice(0, 8);
    const key = `activity:${shortHash}:${ts}-${rand}`;
    await env.HESTIA_KV.put(key, JSON.stringify({ ts, category, title, body, source }), {
      expirationTtl: RETENTION_SECONDS,
    });
  } catch {
    // Logging must never block or fail the actual push/dispatch path it's
    // attached to -- swallow errors here on purpose.
  }
}

// Lists recent activity for a household, newest first, capped at `limit`.
// KV's list() only guarantees lexicographic key order, not numeric, but
// since every key embeds a millisecond timestamp zero-padded... actually
// Date.now() isn't zero-padded, so lexicographic and chronological order
// can diverge at digit-count boundaries. Sort the fetched results by their
// parsed `ts` field instead of trusting key order.
export async function listActivity(env, shortHash, limit = 100) {
  const prefix = `activity:${shortHash}:`;
  const list = await env.HESTIA_KV.list({ prefix, limit: Math.min(limit * 2, 1000) });
  const entries = await Promise.all(
    list.keys.map(async (k) => {
      const raw = await env.HESTIA_KV.get(k.name);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    })
  );
  return entries
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}
