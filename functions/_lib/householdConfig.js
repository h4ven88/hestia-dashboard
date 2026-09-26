// Reads the household's SERVICE half: the small set of fields the Workers
// genuinely need to answer "a door opened, should anyone be notified?"
//
// These Workers deliberately hold NO decryption path for the private half.
// The private half carries the Maker API token, both PIN hashes, camera URLs
// and the Anthropic and Google API keys, encrypted under a key derived from a
// secret that lives on the household's hub. If a decryption path remained
// here, the split would be cosmetic and the backend would still be able to
// read everything.
//
// Why the split exists: the record is addressed by a hash of the caller's
// public IP, so everyone behind one NAT shares it. Under CGNAT that is many
// unrelated households, and the old scheme encrypted the whole thing with a
// key derived from that same IP plus a constant in a public repo -- which any
// of them could recompute.

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromBase64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/**
 * @returns { config, legacy } where `config` is the service half, or null when
 *          the record is missing or unreadable. Callers MUST treat null as
 *          "refuse", never as "allow" -- an attacker who can write a malformed
 *          record would otherwise force a fail-open.
 */
export async function getHouseholdConfig(env, ip, shortHash) {
  const raw = await env.HESTIA_KV.get(`ip:${shortHash}`);
  if (!raw) return null;

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }

  // Current shape. No decryption, by design.
  if (parsed.service && typeof parsed.service === 'object' && !Array.isArray(parsed.service)) {
    return { config: parsed.service, legacy: false };
  }

  /* TRANSITIONAL -- delete one release after the split ships.
     A record written before the split holds everything encrypted under the old
     IP-derived key. Reading it here means a household migrates on its first
     device EVENT rather than its first settings save, which is far sooner: the
     alternative leaves every arm relay and every alarm push 401ing from deploy
     until that household happens to reload the dashboard. */
  if (!parsed.encrypted || !parsed.payload) return null;
  try {
    const rawKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + ':hestia-cloud-sync'));
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const iv = fromBase64(parsed.payload.iv);
    const ct = fromBase64(parsed.payload.data);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const inner = JSON.parse(new TextDecoder().decode(pt));

    // cloudSyncPush() wraps the already-shaped payload under a second "config"
    // key, so the real settings sit two levels deep. Reading one level returns
    // undefined for every field without erroring.
    const payload = inner.config || {};
    const cfg = payload.config || {};

    // Present the legacy record in the new shape, including a derived
    // tokenHash, so the handlers have exactly one code path to reason about.
    return {
      config: {
        ...cfg,
        tokenHash: cfg.token ? await sha256Hex(cfg.token) : null,
      },
      legacy: true,
    };
  } catch {
    return null;
  }
}

export { sha256Hex };
