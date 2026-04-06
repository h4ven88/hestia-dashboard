# Hestia™ Home Dashboard

> **Your safe haven, at a glance.**

A fast, elegant smart home dashboard for [Hubitat Elevation](https://hubitat.com). Built for wall tablets, desktops, laptops, and phones. All your rooms, all your devices, at a glance — no cloud, no subscriptions, no compromises.

---

## Features

- **Unified layout** — single HTML file, responsive across desktop, tablet, and mobile
- **Live device control** — lights, dimmers, fans, blinds, thermostats, locks, color bulbs
- **Real-time updates** — WebSocket connection to Hubitat for instant state changes
- **Five themes** — Dark, Light, Slate, Warm, Cream
- **Color bulb support** — full RGB and color temperature control with inline popups
- **Weather** — National Weather Service integration, no API key required
- **Hub config sync** — settings stored on-hub, shared across all devices on your network
- **PWA ready** — installable as a home screen app on any device
- **Display mode** — Auto, Desktop, Tablet, or Mobile — per-device override stored locally
- **Settings lock** — optional 6-digit PIN to protect configuration
- **Artemis™ security module** — full HSM integration, Ring sensor support, zone awareness, armed status indicators

---

## Requirements

- Hubitat Elevation hub (C-7, C-8, or C-8 Pro)
- [Maker API](https://docs.hubitat.com/index.php?title=Maker_API) app installed and enabled on your hub
- A browser on any device on your local network
- [Hubitat Safety Monitor](https://docs.hubitat.com/index.php?title=Hubitat_Safety_Monitor) (optional — required only for Artemis arm/disarm)

---

## Quick Start

### 1. Install the Hestia app on your Hubitat hub

1. In Hubitat, go to **Apps Code** → **New App**
2. Paste the contents of `HestiaDashboard.groovy` and click **Save**
3. Go to **Apps** → **Add User App** → **Hestia Dashboard**
4. Click **Done** — the app fetches the dashboard and writes its discovery file automatically

### 2. Open the dashboard

The Hestia app status page shows your dashboard URL:

```
http://192.168.x.x/local/hestia-dashboard.html
```

Bookmark this URL — no token required. Works on any device on your local network.

On first load, a four-step setup wizard guides you through connecting to your hub and assigning your devices.

### 3. (Optional) Install as a wall panel

On iPad or Android tablet, open the dashboard in Safari or Chrome and use **Add to Home Screen** to install it as a PWA. Enable guided access or screen pinning for a dedicated wall panel experience.

---

## Setup Wizard

The four-step onboarding wizard runs automatically on first install:

| Step | What it does |
|------|-------------|
| **Connect** | Enter your Hubitat hub URL and Maker API credentials |
| **Inventory** | Discovers all your devices and auto-classifies them by type |
| **Rooms** | Create the rooms in your home |
| **Assign** | Assign each device to a room |

On any subsequent device (tablet, phone), the wizard is skipped entirely — credentials and config are loaded automatically from the hub.

---

## Device Support

| Type | Capabilities |
|------|-------------|
| Switches | On / Off |
| Dimmers | On / Off, brightness slider |
| Color bulbs | On / Off, brightness, color temperature (2700K–6500K), RGB |
| Fans | Off / Low / Medium / High |
| Window blinds / shades | Open / Close, position slider |
| Thermostats | Heat / Cool / Off, setpoint adjustment |
| Locks | Status display, lock / unlock |

---

## Artemis™ Security Module

Artemis integrates with Hubitat Safety Monitor to bring full security panel functionality to Hestia.

- **HSM integration** — arm Home, arm Away, disarm with PIN, bidirectional sync
- **Ring and Z-Wave sensors** — doors, windows, motion detectors, smoke/CO, water/freeze, glass break
- **Zone awareness** — sensors assigned to rooms; sidebar shows security state per room
- **Armed status** — topbar pill and home tab banner when armed
- **HSM detection** — if HSM is not installed, Artemis shows sensors and monitoring but disables arm/disarm controls with a clear setup prompt

HSM is a prerequisite for arming. Sensor monitoring works independently of HSM.

---

## Settings

Open settings via the ⚙ gear icon in the topbar.

| Section | Options |
|---------|---------|
| **Settings Lock** | 6-digit PIN to protect configuration |
| **Hub Connection** | URL, Maker API App ID, access token, poll interval |
| **Panel Behavior** | Display mode, default room, inactivity timeout |
| **Weather** | ZIP code lookup or manual coordinates |
| **Thermostats** | Add and configure thermostat devices |
| **Rooms** | Create, rename, and reorder rooms |
| **Devices** | View all synced devices, reclassify types, assign to rooms |
| **Artemis Security** | Sensor assignments, room mapping, device types, disarm PIN |

---

## Display Modes

Hestia automatically detects your screen size and applies the appropriate layout:

| Width | Mode | Layout |
|-------|------|--------|
| ≤768px | Mobile | Bottom tab bar, full-width cards |
| 769–900px | Small tablet | Sidebar 130px, 2-column cards |
| 901–1200px | Tablet | Sidebar 148px, 3-column home grid, touch-optimised |
| ≥1201px | Desktop | Sidebar 176px, 3-column cards, full topbar |

Override auto-detection in **Settings → Panel Behavior → Display Mode**. The override is stored on that device only and does not sync to other devices.

---

## Licence

**Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**

Personal, non-commercial use only. Commercial use requires explicit written permission.

See [LICENSE](https://github.com/h4ven88/hestia-dashboard/blob/main/LICENSE) for full terms.

---

## Copyright

Copyright © 2026 Haven. All rights reserved.

Hestia™ and Artemis™ are trademarks of Haven.

---

## Roadmap

| Phase | Feature | Status |
|-------|---------|--------|
| 1–3 | Core dashboard, themes, onboarding, device support | ✅ Complete |
| 4 | Artemis security module, zone awareness, HSM integration | ✅ Complete |
| 5 | HPM packaging | 🔵 In progress |
| 6 | Athena — AI agent | ⬜ Planned |

---

## Support

- [Hubitat Community Forum](https://community.hubitat.com)
- [Open an issue](https://github.com/h4ven88/hestia-dashboard/issues)

---

*Built with care for the Hubitat community.*
