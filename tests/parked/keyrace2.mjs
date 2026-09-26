/* Household key, revised rules. Epoch ordering, tri-state reads, key-only
 * hub writes, silent adoption only when the local key is absent or still
 * provisional, confirmation on a real key change, no cloud deletes.
 *
 * Run: node keyrace2.mjs
 */

let NOW = 0, Q = [], SEQ = 0;
const at = (t, fn) => { Q.push({ t, fn, seq: SEQ++ }); };
function run(until) {
  while (Q.length) {
    Q.sort((a, b) => a.t - b.t || a.seq - b.seq);
    const e = Q.shift();
    // Put it back. Dropping it silently kills whatever chain scheduled it,
    // which cost one device its entire poll loop across a sequential run().
    if (e.t > until) { Q.push(e); break; }
    NOW = e.t; e.fn();
  }
  NOW = until;
}
const reset = () => { NOW = 0; Q = []; SEQ = 0; };

/* ── hub ─────────────────────────────────────────────────────── */
class Hub {
  constructor({ latency = 80, jitter = 40, down = [], degraded = [] } = {}) {
    this.key = null; this.epoch = 0;
    this.config = { rooms: 'original' };     // everything that is NOT the key
    this.latency = latency; this.jitter = jitter;
    this.down = down; this.degraded = degraded;
    this.keyWrites = []; this.rejected = 0;
  }
  _win(list, t) { return list.some(([a, b]) => t >= a && t < b); }
  _lat() { return this.latency + Math.random() * this.jitter; }

  read(cb) {
    const lat = this._lat(), arrive = NOW + lat / 2, done = NOW + lat;
    at(arrive, () => {
      // Order matters: a degraded store must never look like an empty one.
      const state = this._win(this.down, NOW) ? 'unreachable'
        : this._win(this.degraded, NOW) ? 'unreachable'      // §3: degraded maps here
        : this.key ? 'ok' : 'empty';
      const snap = { state, key: this.key, epoch: this.epoch, config: this.config };
      at(done, () => cb(snap));
    });
  }
  // §5: merges key+epoch only. Never touches the rest of the config.
  writeKey(key, epoch, cb) {
    const lat = this._lat(), arrive = NOW + lat / 2, done = NOW + lat;
    at(arrive, () => {
      let ok = false;
      if (!this.key || epoch > this.epoch) { this.key = key; this.epoch = epoch; ok = true; this.keyWrites.push({ t: NOW, key, epoch }); }
      else this.rejected++;
      at(done, () => cb && cb(ok));
    });
  }
  // An ordinary settings save. The key does NOT ride along any more.
  writeConfig(config, cb) {
    const lat = this._lat(), arrive = NOW + lat / 2, done = NOW + lat;
    at(arrive, () => { this.config = config; at(done, () => cb && cb(true)); });
  }
}

/* ── device ──────────────────────────────────────────────────── */
let KEYSEQ = 0;
const mint = () => `k${String(++KEYSEQ).padStart(3, '0')}`;
const POLL = 30000;

class Device {
  constructor(name, hub, opts = {}) {
    this.name = name; this.hub = hub;
    this.key = opts.key || null;
    this.epoch = opts.epoch || 0;
    this.provisional = false;      // minted here, not yet seen on the hub
    this.config = opts.config || { rooms: 'original' };
    this.pending = null;           // awaiting human confirmation
    this.prompts = 0; this.adopts = 0; this.minted = null;
    this.log = [];
  }
  say(m) { this.log.push(`${String(Math.round(NOW)).padStart(7)}ms ${this.name}: ${m}`); }

  boot(t) { at(t, () => this._read(true)); }
  startPoll() { at(NOW + POLL, () => { this._read(false); this.startPoll(); }); }

  _read(isBoot) {
    this.hub.read(r => {
      if (r.state === 'unreachable') {                       // §4.1 / §6
        this.say('hub unreachable, no mint no adopt');
        if (isBoot) at(NOW + 5000, () => this._read(true));
        return;
      }
      if (r.state === 'empty') {
        if (this.key) { this.say(`hub empty, republishing ${this.key}@${this.epoch}`);
          this.hub.writeKey(this.key, this.epoch); }
        else this._mint();
        if (isBoot) this.startPoll();
        return;
      }
      this._reconcile(r);
      if (isBoot) this.startPoll();
    });
  }

  _mint() {
    const jitter = Math.random() * 5000;                     // §4.2
    at(NOW + jitter, () => {
      this.hub.read(r => {                                   // re-read before writing
        if (r.state !== 'empty') { if (r.state === 'ok') this._reconcile(r); return; }
        const k = mint();
        this.key = k; this.epoch = 1; this.provisional = true; this.minted = k;
        this.say(`mint ${k}@1 (provisional)`);               // §4.3 persisted locally first
        this.hub.writeKey(k, 1);
      });
    });
  }

  _reconcile(r) {
    if (!this.key) { this.key = r.key; this.epoch = r.epoch; this.adopts++;
      this.say(`adopt ${r.key}@${r.epoch} (had none, silent)`); return; }

    if (r.key === this.key) {
      if (this.provisional) { this.provisional = false; this.say(`${this.key} confirmed on hub`); }
      if (r.epoch > this.epoch) this.epoch = r.epoch;
      return;
    }

    // Different key on the hub.
    if (this.provisional) {            // ours was never established: yield silently
      this.say(`yield provisional ${this.key} → ${r.key}@${r.epoch}`);
      this.key = r.key; this.epoch = r.epoch; this.provisional = false; this.adopts++;
      return;
    }
    if (r.epoch < this.epoch) {        // backup restore: hub is behind
      this.say(`hub behind (${r.epoch}<${this.epoch}), republishing ${this.key}`);
      this.hub.writeKey(this.key, this.epoch);
      return;
    }
    // Established key being replaced: a human has to say yes. §6
    if (!this.pending || this.pending.key !== r.key) {
      this.pending = { key: r.key, epoch: r.epoch }; this.prompts++;
      this.say(`PROMPT: hub offers ${r.key}@${r.epoch}, awaiting confirmation`);
    }
  }

  confirm() {
    if (!this.pending) return;
    this.key = this.pending.key; this.epoch = this.pending.epoch;
    this.provisional = false; this.pending = null; this.adopts++;
    this.say(`user confirmed ${this.key}@${this.epoch}`);
  }
  userSave(newCfg) {                    // §5: key never rides along
    this.config = newCfg; this.say(`settings save (${newCfg.rooms})`);
    this.hub.writeConfig(newCfg);
  }
  rotate() {
    this.epoch += 1; this.key = mint(); this.provisional = false;
    this.say(`ROTATE → ${this.key}@${this.epoch}`);
    this.hub.writeKey(this.key, this.epoch);
  }
}

/* ── harness ─────────────────────────────────────────────────── */
let PASS = 0, FAIL = 0;
const check = (l, c, x = '') => { c ? PASS++ : FAIL++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? `  ${x}` : ''}`); };
function world(opts = {}) { reset(); KEYSEQ = 0; return new Hub(opts); }
const converged = (hub, devs) => {
  const ks = new Set(devs.map(d => d.key));
  return ks.size === 1 && !ks.has(null) && [...ks][0] === hub.key;
};

console.log('═══ 1. Simultaneous mint, swept across boot offsets ═══');
{
  let split = 0, prompted = 0, n = 0;
  for (let off = 0; off <= 6000; off += 13) {
    const hub = world();
    const a = new Device('A', hub), b = new Device('B', hub);
    a.boot(0); b.boot(off);
    run(200000);
    n++;
    if (!converged(hub, [a, b])) split++;
    if (a.prompts || b.prompts) prompted++;
  }
  check('converges at every boot offset', split === 0, `${split}/${n} split`);
  check('NEVER prompts a human during ordinary migration', prompted === 0,
    `${prompted}/${n} prompted — this is what the provisional flag is for`);
}

console.log('\n═══ 2. Many devices, slow hub ═══');
for (const [count, opts] of [[5, {}], [8, { latency: 900, jitter: 700 }]]) {
  let split = 0, prompted = 0, n = 0;
  for (let off = 0; off <= 3000; off += 29) {
    const hub = world(opts);
    const devs = Array.from({ length: count }, (_, i) => new Device(`D${i}`, hub));
    devs.forEach((d, i) => d.boot(i * off));
    run(300000);
    n++;
    if (!converged(hub, devs)) split++;
    if (devs.some(d => d.prompts)) prompted++;
  }
  check(`${count} devices converge${opts.latency ? ' on a slow hub' : ''}`, split === 0, `${split}/${n}`);
  check(`${count} devices, no spurious prompts`, prompted === 0, `${prompted}/${n}`);
}

console.log('\n═══ 3. Minting must not revert anyone\'s settings (the A3 fix) ═══');
{
  const hub = world();
  const fresh = new Device('fresh', hub, { config: { rooms: 'updated-last-week' } });
  const stale = new Device('stale', hub, { config: { rooms: 'ancient' } });
  fresh.boot(0); fresh.userSave({ rooms: 'updated-last-week' });
  stale.boot(2000);                       // dark for a week, wakes and mints
  run(200000);
  check('a minting stale device leaves the config alone', hub.config.rooms === 'updated-last-week',
    `hub config = ${hub.config.rooms}`);
  check('and the household still converges on one key', converged(hub, [fresh, stale]));
}

console.log('\n═══ 4. Hub unreachable, and hub degraded (truncated state) ═══');
for (const [label, opts] of [
  ['unreachable', { down: [[0, 15000]] }],
  ['degraded (200 + null body)', { degraded: [[0, 15000]] }],
]) {
  const hub = world(opts);
  const a = new Device('A', hub), b = new Device('B', hub);
  a.boot(0); b.boot(300);
  run(120000);
  const mintedEarly = hub.keyWrites.filter(w => w.t < 15000).length;
  check(`no mint while hub is ${label}`, mintedEarly === 0, `${mintedEarly} early key writes`);
  check(`recovers afterwards (${label})`, converged(hub, [a, b]), `hub=${hub.key}`);
}

console.log('\n═══ 5. Backup restore rolls the hub back ═══');
{
  const hub = world();
  const a = new Device('A', hub), b = new Device('B', hub);
  a.boot(0); b.boot(200);
  run(90000);
  const established = hub.key, epoch = hub.epoch;
  at(90000, () => { hub.key = null; hub.epoch = 0; hub.config = { rooms: 'week-old' }; });
  run(300000);
  check('devices restore the key to a rolled-back hub', hub.key === established && hub.epoch === epoch,
    `hub=${hub.key}@${hub.epoch} expected ${established}@${epoch}`);
  check('no human was prompted for a restore', a.prompts === 0 && b.prompts === 0);
}

console.log('\n═══ 6. LAN attacker writes a key to the hub ═══');
{
  const hub = world();
  const a = new Device('A', hub), b = new Device('B', hub);
  a.boot(0); b.boot(200);
  run(90000);
  const real = hub.key;
  at(90000, () => { hub.writeKey('kATTACKER', hub.epoch + 5); });
  run(400000);
  check('devices do NOT silently adopt the attacker key',
    a.key === real && b.key === real, `A=${a.key} B=${b.key} real=${real}`);
  check('a human is prompted instead', a.prompts > 0 && b.prompts > 0,
    `prompts A=${a.prompts} B=${b.prompts}`);
  check('the prompt is raised once, not once per poll', a.prompts === 1 && b.prompts === 1,
    `A=${a.prompts} B=${b.prompts}`);
}

console.log('\n═══ 7. Deliberate rotation still propagates ═══');
{
  const hub = world();
  const a = new Device('A', hub), b = new Device('B', hub);
  a.boot(0); b.boot(200);
  run(90000);
  at(90000, () => a.rotate());
  run(200000);
  check('the other device is prompted, not silently switched', b.prompts === 1, `prompts=${b.prompts}`);
  at(200000, () => b.confirm());
  run(400000);
  check('after confirming, the household converges on the new key', converged(hub, [a, b]),
    `hub=${hub.key} A=${a.key} B=${b.key}`);
}

console.log('\n═══ 8. Blind settings saves cannot touch the key any more ═══');
{
  let bad = 0, n = 0;
  for (let st = 200; st <= 60000; st += 311) {
    const hub = world();
    const a = new Device('A', hub), b = new Device('B', hub, { key: 'kOLD', epoch: 1 });
    a.boot(0); b.boot(40);
    at(st, () => b.userSave({ rooms: `save-${st}` }));
    run(300000);
    n++;
    if (!converged(hub, [a, b]) && b.prompts === 0) bad++;   // unresolved without a prompt
    KEYSEQ = KEYSEQ;
  }
  check('no settings-save timing silently splits the household', bad === 0, `${bad}/${n}`);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
