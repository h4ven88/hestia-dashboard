// Shared by subscribe.js (PUT/DELETE) and pushDispatch.js (self-pruning dead
// subscriptions) -- all three read-modify-write the same push:<hash> KV blob,
// so a subscribe/unsubscribe landing mid-dispatch (or two devices
// subscribing at once) can lose a write. Cloudflare KV has no
// compare-and-swap, so this can't make the update atomic. A post-write
// verify (read back what we just wrote) sounds like it'd catch conflicts,
// but it doesn't: if writer A reads, then writer B reads the same stale
// value before A ever writes, A's put-then-verify can both succeed cleanly
// -- A never sees B's write because it hasn't happened yet -- and B's
// subsequent put then silently clobbers A's change with both writers
// believing they'd succeeded. Rechecking the value immediately before the
// put instead of after narrows the window: the recheck is the last thing
// that happens before we commit, so it catches the other writer's put
// whenever their full read-mutate-put cycle finishes first. It still isn't
// airtight -- both writers' rechecks can still land before either's put --
// but that requires four round trips to interleave instead of two, and the
// retry loop re-reads and re-applies the mutator fresh each time it detects
// a conflict rather than blindly overwriting.
const PUSH_DEVICES_TTL_SECONDS = 2592000;
const MAX_RETRIES = 3;

/* ⛔ WHY A NO-OP WRITE CANNOT SIMPLY BE SKIPPED FOREVER. The record expires
   after PUSH_DEVICES_TTL_SECONDS and a put is the only thing that refreshes
   that clock -- KV has no "touch". Skip unconditionally and a household whose
   registration never changes would have its whole device list vanish 30 days
   later, taking every notification with it. So a write is forced once the
   record is older than this, well inside the TTL.
   Same shape as the guard the config fingerprint needs, and written down here
   because the obvious optimisation is actively dangerous without it. */
const REFRESH_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;

export async function mutatePushDevices(env, key, mutator) {
  let devices;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    /* Metadata rather than a field inside the value: the record is a map of
       device id to device and every consumer iterates it, so a `_writtenAt`
       entry would read as a device with no subscription. */
    const got = await env.HESTIA_KV.getWithMetadata(key);
    const raw = got.value;
    const writtenAt = (got.metadata && got.metadata.at) || 0;
    devices = raw ? JSON.parse(raw) : {};
    mutator(devices);
    const newRaw = JSON.stringify(devices);

    /* The app re-registers on EVERY launch, and an Android process is killed
       and relaunched far more often than a tab reloads -- so this is the most
       frequent write in the system and almost always changes nothing. KV write
       volume is not hypothetical: it took the backend down for every household
       once already. */
    if (raw !== null && newRaw === raw && Date.now() - writtenAt < REFRESH_FLOOR_MS) {
      return devices;
    }

    const recheck = await env.HESTIA_KV.get(key);
    if (recheck !== raw) continue; // someone else wrote since our read -- retry against their value

    await env.HESTIA_KV.put(key, newRaw, {
      expirationTtl: PUSH_DEVICES_TTL_SECONDS,
      metadata: { at: Date.now() },
    });
    return devices;
  }
  // Ran out of retries under sustained concurrent writes to this household's
  // key -- apply and return the best-effort result rather than retrying
  // forever; losing one write under this much contention is preferable to
  // this request hanging.
  await env.HESTIA_KV.put(key, JSON.stringify(devices), {
    expirationTtl: PUSH_DEVICES_TTL_SECONDS,
    metadata: { at: Date.now() },
  });
  return devices;
}
