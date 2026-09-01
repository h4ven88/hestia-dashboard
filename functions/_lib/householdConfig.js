// Mirrors dashboard.html's _cloudDeriveKey/_cloudEncrypt/_cloudDecrypt exactly.
// cloudSyncPush() in dashboard.html always sends an AES-GCM encrypted blob
// (keyed by the household's own public IP, never a shared secret) -- the
// config PUT endpoint stores that verbatim with zero decryption, so every
// ip:${hash} KV entry is ciphertext, not plain JSON. Any Function reading it
// needs to decrypt it the same way the browser does before it means
// anything. Getting this wrong doesn't error -- JSON.parse() on the
// {encrypted:true, payload:{...}} wrapper succeeds fine, it just means
// .config is silently undefined, so every downstream check (pushEnabled,
// token match, categorization) fails quietly instead of loudly. That's
// exactly what happened here for hours before this was caught.
async function deriveKey(ip) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + ':hestia-cloud-sync'));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

function fromBase64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Returns { config, thermostats, rooms, staging, savedAt, version } with
// `config` being the actual settings object (pushEnabled, token,
// artemisSensors, etc.), or null if the stored value is missing, isn't
// encrypted-shaped, or fails to decrypt (e.g. written before this format,
// or by a different IP).
export async function getHouseholdConfig(env, ip, shortHash) {
  const raw = await env.HESTIA_KV.get(`ip:${shortHash}`);
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed.encrypted || !parsed.payload) return null;

  try {
    const key = await deriveKey(ip);
    const iv = fromBase64(parsed.payload.iv);
    const ct = fromBase64(parsed.payload.data);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const inner = JSON.parse(new TextDecoder().decode(pt));

    // cloudSyncPush(payload) in dashboard.html wraps the ALREADY-shaped
    // buildConfigPayload() result -- itself { config: <real settings>,
    // thermostats, rooms, staging, savedAt } -- under a second "config" key:
    // { config: payload, savedAt, version }. So the real settings are two
    // levels deep (inner.config.config), not one (inner.config). Missing
    // this cost hours: JSON.parse always succeeds either way, so reading
    // only one level deep silently returns undefined for every real field
    // instead of erroring.
    const payload = inner.config || {};
    return {
      config: payload.config || {},
      thermostats: payload.thermostats || [],
      rooms: payload.rooms || [],
      staging: payload.staging || [],
      savedAt: payload.savedAt || inner.savedAt || null,
      version: inner.version || null,
    };
  } catch {
    return null;
  }
}
