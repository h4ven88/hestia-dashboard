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

export async function mutatePushDevices(env, key, mutator) {
  let devices;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const raw = await env.HESTIA_KV.get(key);
    devices = raw ? JSON.parse(raw) : {};
    mutator(devices);
    const newRaw = JSON.stringify(devices);

    const recheck = await env.HESTIA_KV.get(key);
    if (recheck !== raw) continue; // someone else wrote since our read -- retry against their value

    await env.HESTIA_KV.put(key, newRaw, { expirationTtl: PUSH_DEVICES_TTL_SECONDS });
    return devices;
  }
  // Ran out of retries under sustained concurrent writes to this household's
  // key -- apply and return the best-effort result rather than retrying
  // forever; losing one write under this much contention is preferable to
  // this request hanging.
  await env.HESTIA_KV.put(key, JSON.stringify(devices), { expirationTtl: PUSH_DEVICES_TTL_SECONDS });
  return devices;
}
