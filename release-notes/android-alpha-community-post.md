# There is an Android app now

Hestia has been a website for its whole life. That has cost you all something
specific: every device had to be told to trust your hub's certificate, every
browser had its own idea about mixed content, and notifications only arrived if
a tab happened to be open somewhere.

The app fixes those at the root rather than working around them.

**It finds your hub by itself.** You install it, tap Get started, and it asks
your network which Hubitat hubs are on it. Mine answers with its own name, so
the screen shows "Haven's Hubitat, C-8 Pro" and its address. You confirm that is
yours. Nothing is typed in: no IP address, no Maker API token, no app ID. It
reads the rest from your hub the way the dashboard already does.

**The certificate question happens once, and it is a real question.** Instead of
a browser interstitial telling you attackers might be stealing your passwords,
you get the hub's actual fingerprint on screen and a button that says Trust this
hub. The app remembers that exact key. If it ever changes, you hear about it
before anything connects, which is a stronger promise than clicking through a
warning on every device you own.

**Notifications arrive with the app closed.** Not backgrounded, closed. Android
can kill the process entirely and a push still starts it. I left a phone
untouched overnight, eight hours into deep sleep with the process genuinely
dead, and a test alert woke it in 28 seconds.

**Hub camera snapshots work again.** If your snapshots come through the hub,
they are fetched over that same pinned connection, so there is no certificate to
accept and no mixed content to argue with.

## Getting it

**hestari.com/install**, or straight from the GitHub release. It is 27.7 MB and
needs Android 8.0 or later.

SHA-256, if you want to check the file before you open it:

`8eae2c75457d51b0ce1ff7a3e8e540680d6dc3a992b3822f8338fa2f6a85fdd5`

Two warnings will try to stop you, and both are normal for anything not
installed from the Play Store. Your browser will say the file type may harm your
phone. Then Android will say installs from that source are not allowed and offer
Settings. That permission is per app, and it attaches to whichever app opens the
file, which is not always the one that downloaded it. Grant it to whatever the
dialog names.

## What it will not do

I would rather you did not waste an evening on these.

- **Fire tablets cannot run it.** Fire OS has no Google Play Services, so push
  cannot work there at all. The website is still the right answer on a Fire
  tablet, and it is not going away.
- **Cameras with their own IP address are not supported yet.** If your snapshot
  URL points at the camera instead of at the hub, expect it to stay blank. This
  one is on the list.
- **Force stop it and notifications stop** until you open it again. That is
  Android's rule for apps you explicitly stopped, not something I can code
  around. Ordinary backgrounding is fine.
- **There is no console in this build**, so if something breaks there is no log
  to read. Describing what you did and what happened is more useful here than
  usual, and saying whether hestari.com does the same thing on the same phone is
  the single most useful detail, because it separates an app problem from a
  dashboard problem.

## Where this is going

Play Store, eventually. That needs a verified developer account and a review
cycle, and I would rather find the embarrassing problems here first.

Which brings me to the honest part: this has been tested on **one phone, one
household, one Android skin**. Samsung One UI, my hub, my devices. Discovery,
notification wake-up and anything depending on a process surviving in the
background are all exactly the things that vary most between manufacturers. I do
not know what it does on a Pixel or a OnePlus because I have never run it on
one.

So before anything else: **does anyone here actually have an Android phone they
would be willing to put this on?** I genuinely do not know. Several of you I
only know by your hubs.

If the first run goes badly, say so in the thread rather than quietly
uninstalling. That is the part I most need to hear about.
