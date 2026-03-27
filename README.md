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

---

## Requirements

- Hubitat Elevation hub (C-7, C-8, or C-8 Pro)
- [Maker API](https://docs.hubitat.com/index.php?title=Maker_API) app installed and enabled on your hub
- A browser on any device on your local network

---

## Quick Start

### 1. Enable Maker API on your Hubitat hub

1. In Hubitat, go to **Apps** → **Add Built-In App** → **Maker API**
2. Select all devices you want to control
3. Note your **App ID** and **Access Token**

### 2. Install the dashboard

Download `dashboard.min.html` from the [latest release](../../releases/latest) and open it in any browser on your local network.

On first load, the setup wizard will guide you through:
1. Connecting to your hub
2. Discovering your devices
3. Creating your rooms
4. Assigning devices to rooms

### 3. (Optional) Install as a wall panel

On iPad or Android tablet, open the dashboard in Safari or Chrome and use **Add to Home Screen** to install it as a PWA. Set your browser to open on launch and enable guided access or screen pinning for a dedicated wall panel experience.

---

## Setup Wizard

The four-step onboarding wizard runs automatically on first install:

| Step | What it does |
|------|-------------|
| **Connect** | Enter your Hubitat hub URL and Maker API credentials |
| **Inventory** | Discovers all your devices and auto-classifies them by type |
| **Rooms** | Create the rooms in your home |
| **Assign** | Assign each device to a room |

You can re-run the wizard any time from **Settings → Re-run Setup**.

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
| Locks | Status display |

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
| **Appearance** | Five themes — Dark, Light, Slate, Warm, Cream |

---

## Display Modes

Hestia automatically detects your screen size and applies the appropriate layout:

| Width | Mode | Layout |
|-------|------|--------|
| ≤768px | Mobile | Bottom tab bar, full-width cards |
| 769–900px | Small tablet | Sidebar 130px, 2-column cards |
| 901–1200px | Tablet | Sidebar 148px, 2-column cards, touch-optimised |
| ≥1201px | Desktop | Sidebar 176px, 3-column cards, full topbar |

Override auto-detection in **Settings → Panel Behavior → Display Mode**. The override is stored on that device only and does not sync to other devices.

---

## Licence

**Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**

Personal, non-commercial use only. Commercial use requires explicit written permission.

See [LICENSE](LICENSE) for full terms.

---

## Copyright

Copyright © 2025 Haven. All rights reserved.

Hestia™ is a trademark of Haven.

---

## Roadmap

| Phase | Feature | Status |
|-------|---------|--------|
| 1–3 | Core dashboard, themes, onboarding, device support | ✅ Complete |
| 4 | Single Hubitat app + HPM packaging | 🔵 In progress |
| 5 | Athena — AI agent | ⬜ Planned |
| 6 | Artemis — Security integration | ⬜ Planned |

---

## Support

- [Hubitat Community Forum](https://community.hubitat.com)
- [Open an issue](../../issues)

---

*Built with care for the Hubitat community.*
