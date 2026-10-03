# The native bridge contract

Phase 1 of the Android app. This file is the contract; the Kotlin implements it
and never extends it informally.

**The one rule: the web layer is never forked.** `dashboard.html` stays one
file serving the browser app, the hub-served app, and every native app. The
native layer is thin and multiplies; the web layer does not. Everything below
exists to keep that true under pressure.

---

## Phase 1 scope

The contract exists and is **empty**. `window.hestiaNative` is injected and
reports `capabilities: []`. No capability is implemented until its own phase.

This is deliberately a weaker-looking goal than it is, because it pins down the
part that is easy to get wrong later and impossible to retrofit.

---

## Shape

Native injects `window.hestiaNative` at document start. **`dashboard.html` only
ever reads it.** The page contains no injection code, no shim, and no fallback
implementation, so the browser build carries nothing dead.

### Transport

Verified against the Android documentation, 2026-10-01
(`developer.android.com/develop/ui/views/layout/webapps/webview`):

- `@JavascriptInterface` is required for `targetSdkVersion` 17 and later, and
  the method must be public.
- **"The object that is bound to your JavaScript runs in another thread and not
  in the thread in which it is constructed."** So no bridge method may assume
  the UI thread, and anything touching the WebView marshals back to it.

Because of that threading, the raw interface is **one synchronous method** that
accepts a JSON request and returns immediately. Native completes the work and
resolves the call by dispatching a reply. The promise API the page sees is
built by the shim on top of that, keyed by request id.

The page therefore sees `async` methods. The raw interface is not the contract
and is not called directly by `dashboard.html`.

### Events, native to page

Native does **not** reach into the page and call internal functions. It
dispatches to one well-known entry point the shim owns, and the page subscribes:

```js
hestiaNative.on('push', handler)       // a notification arrived while open
hestiaNative.on('micState', handler)   // the microphone service started/stopped
hestiaNative.on('presence', handler)   // home/away changed
hestiaNative.on('hubTrust', handler)   // the pinned certificate changed
```

An `evaluateJavascript` that calls anything other than that dispatcher is a
contract violation, because it couples the native layer to the page's private
names and silently breaks on any refactor of `dashboard.html`.

---

## Four invariants

**1. Branch on capability, never on platform.** The page asks
`hestiaNative.capabilities.includes('push')`, never
`hestiaNative.platform === 'android'`. iOS and the three desktop targets
implement different subsets, and Linux ships as a kiosk browser with no bridge
at all. Branching on platform means editing `dashboard.html` for every new
target, which is the fork this whole design exists to prevent.

This is the same rule the garage door tile already follows: act on declared
capability, not on an inference about what the thing probably is.

**2. The page never names a host.** `hub.request()` takes a **path**. Native
supplies the origin from its own stored configuration and applies its own
certificate pin. A method that accepted a URL would let any script in the
WebView use the pinned native client as a general-purpose fetcher, which is a
request-forgery hole with extra privileges attached. Removing the parameter
removes the class.

**3. Absent and empty must both behave exactly as the browser does.** Two
states, not one. "Bridge absent" is the browser build. "Bridge present,
capabilities empty" is what Phase 1 actually ships, and it is the state that
can regress, so it is the one that gets tested hardest.

**4. Everything on the bridge is reachable by any script the WebView runs.**
There is no per-script origin check available at this boundary. The
documentation is explicit: **"don't use `addJavascriptInterface()` unless you
wrote all of the HTML and JavaScript that appears in your WebView. Don't let
the user navigate within your WebView to web pages that aren't your own."**

So: navigation locked to the bundled origin, external links handed to the
system browser, and a CSP on the bundled page. And see the prerequisite below,
which is not currently satisfied.

---

## The surface, by phase

Always present, from Phase 1:

| Member | Type | Notes |
|---|---|---|
| `version` | integer | Contract version, not the app version |
| `platform` | string | Diagnostics and bug reports only, never a branch |
| `appVersion` | string | Must equal `HESTIA_VERSION`; `build.js` asserts it |
| `capabilities` | string[] | The only thing the page is allowed to branch on |
| `on(event, fn)` | function | The sole native-to-page channel |

Added by their own phases:

| Capability | Members | Phase |
|---|---|---|
| `hub` | `hub.discover()`, `hub.request(path, opts)`, `hub.trustState()` | 2 |
| `mic` | `mic.hold()`, `mic.release()`, `mic.state()` | 3 |
| `notify` | `notify.show(n)`, `notify.permissionState()`, `notify.requestPermission()` | 4 |
| `localPush` | `net.localEndpoint()` | 4 |
| `push` | `push.register()`, `push.token()`, `push.presence(state)` | 5 |

`mic` holds the foreground service and the permission. **Inference stays in
JavaScript**, so no audio crosses the bridge.

---

## Prerequisite found 2026-10-01, not yet satisfied

**The bundled page must stop loading third-party JavaScript before the bridge
ships.** Today [dashboard.html:1457](../dashboard.html) loads ONNX Runtime from
`cdnjs.cloudflare.com` and [:6097](../dashboard.html) points its WASM path at
the same CDN. Fonts come from Google at :25-31.

By invariant 4 and the documentation quoted there, a WebView that executes
JavaScript we did not write cannot safely expose a bridge at all. The CDN is
also a silent single point of failure for the wake word on a tablet with no
internet, which is the opposite of what an installed app should do.

The project plan listed bundling the runtime and models as "running alongside,
not sequenced". **That ranking is wrong.** It is a Phase 1 prerequisite, and
two independent reasons now point at it: offline capability and the bridge
boundary. Fonts bundle with it.

---

## Open question, do not implement on assumption

**The native storage row may be unnecessary.** The plan justifies it as "not
clearable by a browser data wipe", and that is true but may already hold: a
WebView's `localStorage` is app-private, and there is no browser for a user to
clear. If so, `_LS` needs no native backing and the row should be struck rather
than implemented.

What would change the answer: whether Android's own "clear cache" or "clear
storage" for the app wipes WebView `localStorage`, and whether auto-backup
would carry a household key off the device, which is a separate reason to take
control of it. Settle it with a real device before writing a line of it.

---

## How Phase 1 is proven

The gate is: **the browser build is unchanged with the bridge absent, and
unchanged with the bridge present but empty.**

A test that greps `dashboard.html` for `hestiaNative` and asserts every
occurrence sits behind a guard **does not establish this**, and this project
has shipped three false greens of exactly that shape in one release series: an
assertion satisfied by the comment above the call it was checking, one
satisfied by a constant inside the block it was meant to prove was live, and
one satisfied by a string in a branch hard-wired off.

So the test runs the real extracted functions in three environments, no
`window.hestiaNative`, an empty one, and a fully populated stub, and asserts
the first two produce **identical** observable behaviour. The mutation gate
then deletes each capability guard in turn and requires red.
