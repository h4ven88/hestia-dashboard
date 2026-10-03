/* The JS half of the native bridge. See android/BRIDGE.md for the contract.
 *
 * Injected by the native layer at document start, BEFORE the dashboard's own
 * scripts run. dashboard.html never ships this file and never references it:
 * the page only ever READS window.hestiaNative, so the browser build carries
 * nothing dead and there is one web layer, not two.
 *
 * WHY A SHIM AT ALL. The raw Android interface is synchronous, returns only
 * primitives and strings, and -- per Android's own documentation -- "runs in
 * another thread and not in the thread in which it is constructed". So it
 * cannot return a Promise and must not block. The raw object therefore takes a
 * JSON request and returns immediately; native completes the work and calls
 * back into the dispatcher below, which settles the Promise the page is
 * holding. The page never sees any of that.
 *
 * PHASE 1 DELIBERATELY EXPOSES NO METHODS. capabilities is empty, and the page
 * must behave exactly as the browser build does. That is the gate: not only
 * "unchanged when the bridge is absent" but "unchanged when it is present and
 * empty", because present-and-empty is what Phase 1 actually ships and is
 * therefore the state that can regress.
 */
(function () {
  'use strict';

  // Installing twice would orphan the first set of pending calls, and a
  // reinjection on a client-side navigation is an easy way to do that.
  if (window.hestiaNative) return;

  var raw = window.__hestiaNativeRaw;
  if (!raw || typeof raw.handshake !== 'function' || typeof raw.call !== 'function') {
    // No bridge, or one too old to understand this contract. Leave the page
    // exactly as a browser would see it rather than installing a stub: a
    // half-present bridge is worse than none, because the page would branch
    // on its existence and then find nothing behind it.
    return;
  }

  var info;
  try {
    info = JSON.parse(raw.handshake());
  } catch (e) {
    return;   // same reasoning: an unreadable handshake is not a bridge
  }

  var seq = 0;
  var pending = Object.create(null);
  var listeners = Object.create(null);

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = 'r' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      var ack;
      try {
        ack = raw.call(JSON.stringify({ id: id, method: method, params: params === undefined ? null : params }));
      } catch (e) {
        delete pending[id];
        reject(new Error('native bridge call failed: ' + (e && e.message ? e.message : e)));
        return;
      }
      /* A synchronous refusal -- unknown method, missing permission, bad
         shape -- comes back from the call itself, so it settles here and the
         page is not left holding a Promise that nothing will ever resolve. */
      if (ack) {
        var parsed = null;
        try { parsed = JSON.parse(ack); } catch (e) { parsed = null; }
        if (parsed && parsed.error) {
          delete pending[id];
          reject(new Error(parsed.error));
        }
      }
    });
  }

  /* Native settles a call by calling this, and ONLY this. Reaching into the
     page to call its internal functions would couple the native layer to
     dashboard.html's private names and break silently on any refactor of a
     1 MB file nobody is diffing against Kotlin. */
  function settle(payload) {
    var msg;
    try { msg = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) { return; }
    if (!msg || !msg.id) return;
    var p = pending[msg.id];
    if (!p) return;                 // already settled, or a reply to a dead call
    delete pending[msg.id];
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result === undefined ? null : msg.result);
  }

  /* The single native-to-page channel. Same reasoning as settle(). */
  function emit(payload) {
    var msg;
    try { msg = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) { return; }
    if (!msg || !msg.event) return;
    var subs = listeners[msg.event];
    if (!subs) return;
    // Copied before iterating so a handler that unsubscribes during dispatch
    // cannot make the loop skip the next one.
    subs.slice().forEach(function (fn) {
      try { fn(msg.data === undefined ? null : msg.data); }
      catch (e) { console.warn('[Bridge] listener for "' + msg.event + '" threw:', e); }
    });
  }

  function on(event, fn) {
    if (typeof event !== 'string' || typeof fn !== 'function') return function () {};
    (listeners[event] || (listeners[event] = [])).push(fn);
    return function off() {
      var subs = listeners[event];
      if (!subs) return;
      var i = subs.indexOf(fn);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  var api = {
    /* The contract version, not the app version. The page branches on
       capabilities, never on this or on platform. */
    version: info.version | 0,
    /* Diagnostics and bug reports ONLY. Branching on platform is what forces
       a fork of the web layer every time a target is added, and avoiding that
       fork is the entire design. */
    platform: String(info.platform || 'unknown'),
    appVersion: String(info.appVersion || ''),
    /* The only thing the page is allowed to branch on. Frozen so a later
       script cannot widen what the page believes is available. */
    capabilities: Object.freeze((info.capabilities || []).map(String)),
    on: on,
    call: call,
  };

  Object.defineProperty(window, 'hestiaNative', {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
    enumerable: true,
  });

  // Native reaches these two and nothing else.
  window.__hestiaNativeSettle = settle;
  window.__hestiaNativeEmit = emit;

  /* Says so, in the page's own console, following this codebase's
     "[Module] message" convention. Without it the bridge is invisible from
     outside the WebView: "present and empty" and "never installed" look
     identical, and those are exactly the two states Phase 1 has to tell
     apart. */
  if (window.console && console.log) {
    console.log('[Bridge] installed — contract v' + api.version + ', ' + api.platform +
                ' app ' + api.appVersion + ', capabilities: ' +
                (api.capabilities.length ? api.capabilities.join(', ') : '(none)'));
  }
})();
