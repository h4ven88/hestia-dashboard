# Hestia for Android: tester install

Draft for review. The intent is that most of this becomes a page on
hestari.com, with the APK itself hosted on GitHub Releases. Nothing here is
live yet.

---

## Build being distributed

| | |
|---|---|
| Version | **2.2.3** |
| Built | 2026-10-24 |
| Size | 29,019,547 bytes (27.7 MiB) |
| SHA-256 | `b44ebb71df6856c97295d2ea78ce4b0c944bd0baa399945b664ddbfe863f3a59` |
| Minimum Android | **8.0** (API 26) |
| Signing | Release key, v2/v3 scheme |

Verified by reading the APK's own archive directory rather than trusting the
build: release-signed (`CN=Hestia, O=Hestari`), no v1 certificate (correct at
this minimum), all eleven wake-word models, the ONNX runtime and all nine fonts
bundled, and no CDN script of any kind. It works with no network except to your
own hub.

**This exact build was run on a wiped Galaxy A16 (Android 16).** First run from
nothing: hub found by name over mDNS, fingerprint shown, trusted, household
dashboard live with real device state, nothing typed. It then polled the hub
continuously for five minutes with no failures, and camera snapshots rendered
and stayed online through repeated refreshes.

A test notification sent from another device reached this phone, so FCM
registration works under the release signing key.

⚠ Two push paths are NOT covered by that. **Send Test Notification calls the
backend directly from the browser and never touches the hub or the companion
app**, so a real arm/disarm relay is still unexercised on this build -- the
only way to confirm it is a genuine arm or disarm, checking Hubitat's Logs for
`Hestia Push: relay sent`. And delivery to a **force-stopped** app is dropped
by Android's own stopped-state rule, which no code here can change. Ordinary
backgrounding is fine: a data-only push has been measured starting the process
from a cold kill after eight hours of deep doze.

---

## ⛔ Read this first if you already have Hestia installed

**You must uninstall the existing app before installing this one.**

Any build you have now was signed with Android's generic debug key. This one is
signed with the real release key, and Android treats a different signing key as
a different application entirely. Installing over the top fails with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

**Uninstalling wipes the app's data**, which means the trusted hub, the saved
settings and the household key all go. You will go through first-run again.
That is expected, and setup is "tap Get started, it finds your hub, confirm the
name" with nothing typed.

If your household uses a household key, have it to hand before you start, in
case the hub is not reachable on the first attempt.

---

## Installing

1. **Download the APK** from the link on hestari.com. Your browser will warn
   that "this type of file may harm your phone" before it will even download
   it. That warning is about the file type, not this file; it appears for
   every APK.
2. Open it. Android will then say installs from that source are not allowed,
   and offer **Settings** to change it. Two things about that:
   - The permission is **per-app**, not global, so allowing it does not open
     the device up generally.
   - ⚠ It attaches to whichever app **opens** the APK, which is not always the
     one that downloaded it. On a Samsung device going through My Files, it is
     *My Files* that needs the permission, not Samsung Browser. Grant it to
     whichever app the dialog actually names.
3. **Let Play Protect scan it.** Google offers to check the app before it
   installs. Say yes: it has scanned clean on the phones this has been
   installed on, and having a sideloaded build checked rather than waved
   through is worth the few seconds.

   Wording varies by device, and on some you get *"unsafe app blocked"* or
   *"app from an unknown developer"* instead. That is Android noting the app
   did not come from the Play Store, not a report of anything found wrong with
   it. Choose **More details → Install anyway**. You can also check the SHA-256
   above against your download.
4. Open Hestia. First run will:
   - explain what it is about to do,
   - ask for permission to find devices on your network,
   - search for your hub,
   - show you the hub's name and its certificate fingerprint,
   - and let you confirm it.

**If the permission dialog is denied, discovery cannot work**, and the app will
say so specifically rather than claiming no hub was found. A denial is sticky,
so if you tap it away you may need to re-enable it in Android's app settings.

---

## What is worth testing, and what is known to be untested

### Please try
- **First run from nothing.** Does it find the hub by name? Does the fingerprint
  screen make sense?
- **Cameras.** Sit on the Cameras view for a couple of minutes, not just the
  Security summary. A camera that renders once and then goes Offline a refresh
  interval later is a specific bug worth reporting.
- **Push notifications.** Turn them on, then use Settings → Diagnostics → Send
  Test Notification. Then try a real arm or disarm.
- **Notifications with the app closed.** Swipe it away and trigger something.
- **The dashboard generally.** Arm and disarm, lights, locks, anything you use.

### Known limits, so you do not spend time on them
- **Fire tablets cannot run this.** Fire OS has no Google Play Services, so
  push notifications cannot work there at all, and the app may not install. The
  browser version at hestari.com remains the right thing on a Fire tablet.
- **Camera snapshots that live on the camera itself** (rather than being served
  through the hub) are not yet supported in the app. Hub-served snapshots work.
  If your cameras are UniFi or similar with their own IP address, expect them
  not to appear.
- **A force-stopped app will not receive notifications** until you open it
  again. This is Android's own rule for apps the user has explicitly stopped
  and is not something the app can work around. Normal backgrounding is fine:
  notifications wake the app even after Android has killed it.
- **No diagnostics.** This build has the developer console compiled out, so if
  something breaks there is no log to read. Please describe what you saw and
  what you were doing; that is more useful here than usual.

### If you are outside the US
Google began enforcing developer verification for apps installed outside the
Play Store on **2026-09-30 in Brazil, Indonesia, Singapore and Thailand**, with
a wider rollout stated for 2027. If you are in one of those four countries this
APK may be blocked from installing regardless of the steps above. That is a
platform policy, not a fault in the file.

---

## Reporting something

Useful: what you did, what you expected, what happened, your Android version
and phone model, and whether the browser version at hestari.com behaves the
same way. The last one is the single most useful detail, because it separates
an app problem from a dashboard problem.

---

## Hosting: settled

**The APK goes on GitHub Releases. hestari.com links to it. It cannot live in
the repo or on the site.**

Reasons, in order of how binding they are:
- **Cloudflare Pages caps a single asset at 25 MiB.** Verified against
  Cloudflare's own limits page 2026-10-22: *"The maximum file size for a single
  Cloudflare Pages site asset is 25 MiB."* This APK is **27.7 MiB**, so it
  exceeds the cap by about 2.7 MiB. Serving it from hestari.com is not a
  preference, it is unavailable.
- A 29 MB binary committed to the repo sits in git history permanently, and
  every future build adds another 29 MB that can never be removed without
  rewriting history. Release attachments live outside git history entirely.
- Each release gets a stable, versioned URL, GitHub serves the bandwidth, and
  the 2 GB per-asset limit is not a constraint here.

**Wiring.** `_redirects` already 302s `/sandbox.html`, so the same mechanism can
point `/download` or `/app` at the current release asset. One line, and it moves
with each release.

**Open questions for you:**
1. A dedicated install page, or a section on the existing landing page? A
   separate page is easier to link from the forum and easier to keep blunt
   about the Play Protect warning without unsettling ordinary visitors.
2. Should the download be obvious on the landing page, or only reachable by
   direct link while it is tester-only? Right now the audience is a handful of
   people from one forum thread.
3. Do you want the checksum published? It lets a tester verify the file, and it
   costs a line. I would.
4. Should the page state that the app is unreleased and unverified by Google?
   I think yes, since it sets expectations before the Play Protect dialog does it
   less kindly.
