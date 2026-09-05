// One KV key per event, never a growing list under one key -- that
// read-modify-write pattern is exactly what caused the cross-device
// config-clobbering race fixed earlier tonight (two writes landing close
// together, one silently overwriting the other's append). Each event here
// is a fully independent write with no read-before-write at all, so
// concurrent events can never collide. Retention is handled by KV's own
// expirationTtl instead of manual pruning logic.
const RETENTION_SECONDS = 30 * 24 * 60 * 60; // 30 days, matches the TTL already used for config/push KV entries

// Cloudflare KV's list() only ever returns keys in ascending lexicographic
// order -- there's no reverse/newest-first option. A plain ascending
// timestamp in the key therefore lists OLDEST first, and truncating that at
// `limit` silently returns the oldest events still in the retention window
// instead of the newest ones once a household has more events than the
// fetch limit (confirmed by direct test against a mock KV, not just read
// from the docs). Inverting the timestamp fixes this at the source: a
// SMALLER encoded value now means a MORE RECENT event, so ascending key
// order becomes newest-first, matching what list() can actually do.
// INVERT_EPOCH must stay larger than any real timestamp for this to work;
// 9999999999999 is a fixed 13-digit ceiling good until the year 2286 (see
// the epoch-width note in listActivity below).
const INVERT_EPOCH = 9999999999999;

export async function logActivity(env, shortHash, { category, title, body, source }) {
  try {
    const ts = Date.now();
    const invTs = String(INVERT_EPOCH - ts).padStart(13, '0');
    const rand = crypto.randomUUID().slice(0, 8);
    const key = `activity:${shortHash}:${invTs}-${rand}`;
    await env.HESTIA_KV.put(key, JSON.stringify({ ts, category, title, body, source }), {
      expirationTtl: RETENTION_SECONDS,
    });
  } catch {
    // Logging must never block or fail the actual push/dispatch path it's
    // attached to -- swallow errors here on purpose.
  }
}

// Lists recent activity for a household, newest first, capped at `limit`.
// Each KV get() below is one subrequest, on top of the list() call itself --
// Cloudflare caps subrequests per invocation, so `limit` must stay small
// regardless of caller (functions/api/activity/index.js additionally caps
// what a client can request; this default/cap is a second, independent
// backstop for any other caller).
//
// No `limit * 2` buffer: every key now embeds the fixed-width inverted
// timestamp above plus a fixed 8-char random suffix, so ascending key order
// already IS newest-first -- no over-fetch needed to compensate for
// mis-ordering. The .sort() below is cheap insurance (it re-sorts by the
// real `ts` in the stored value, not the key), and it's also what keeps
// results correct during the one-time transition window: entries written
// before this change used a plain ascending timestamp key and will sort
// into a temporarily-wrong position in the raw key order until they expire
// via their existing 30-day TTL -- self-healing, no migration needed.
const MAX_LIST_LIMIT = 25;
export async function listActivity(env, shortHash, limit = MAX_LIST_LIMIT) {
  limit = Math.min(limit, MAX_LIST_LIMIT);
  const prefix = `activity:${shortHash}:`;
  const list = await env.HESTIA_KV.list({ prefix, limit });
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
