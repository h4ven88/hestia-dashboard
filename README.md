# Hestia Home Dashboard

> **Your safe haven, at a glance.**

A fast, elegant smart home dashboard for [Hubitat Elevation](https://hubitat.com). Built for wall tablets, desktops, laptops, and phones. All your rooms, all your devices, at a glance -- no subscriptions, no compromises.

**Version:** v1.5.2 | **Live:** [https://hestari.com](https://hestari.com) | **License:** CC BY-NC 4.0

---

## Features

* **Unified layout** -- single HTML file, responsive across desktop, tablet, and mobile
* **Live device control** -- lights, dimmers, fans, blinds, thermostats, locks, color bulbs
* **Real-time updates** -- WebSocket connection to Hubitat for instant state changes
* **Five themes** -- Dark, Light, Slate, Warm, Cream
* **Color bulb support** -- full RGB and color temperature control with inline popups
* **Weather** -- National Weather Service integration, no API key required
* **Athena voice assistant** -- hands-free voice control with wake word detection (OpenWakeWord/ONNX), Google Cloud Speech-to-Text, Claude AI command understanding, and Google Neural2 TTS responses
* **Artemis security** -- HSM (Hubitat Safety Monitor) integration with arm/disarm control and sensor monitoring (contact, motion, smoke/CO, water, glass break)
* **Companion Groovy app** -- auto-discovery, cross-device config sync, auto-download of dashboard to hub
* **Wall Panel mode** -- dedicated setup for tablets with auto-launch and guided access support
* **Hub config sync** -- settings stored on-hub, shared across all devices on your network
* **PWA ready** -- installable as a home screen app on any device
* **Display mode** -- Auto, Desktop, Tablet, or Mobile -- per-device override stored locally
* **Settings lock** -- optional 6-digit PIN to protect configuration

---

## Requirements

* Hubitat Elevation hub (C-7, C-8, or C-8 Pro)
* [Maker API](https://docs.hubitat.com/index.php?title=Maker_API) app installed and enabled on your hub
* A browser on any device on your local network

**For Athena voice assistant (optional):**

* Anthropic API key (for Claude AI command understanding)
* Google Cloud API key with the following APIs enabled:
  - Cloud Speech-to-Text API (`speech.googleapis.com`)
  - Cloud Text-to-Speech API (`texttospeech.googleapis.com`)

---

## Quick Start

### 1. Enable Maker API on your Hubitat hub

1. In Hubitat, go to **Apps** > **Add Built-In App** > **Maker API**
2. Select all devices you want to control
3. Note your **App ID** and **Access Token**

### 2. Install the dashboard

**Option A -- Hosted (recommended)**

Open [https://hestari.com](https://hestari.com) in any browser. On first load the setup wizard will prompt you for your hub IP and Maker API credentials.

**Option B -- Local**

Download `index.html` from the [latest release](https://github.com/h4ven88/hestia-dashboard/releases/latest) and open it in any browser on your local network, or install it to your hub's File Manager at `/local/index.html`.

On first load, the setup wizard will guide you through:

1. Connecting to your hub
2. Discovering your devices
3. Creating your rooms
4. Assigning devices to rooms

### 3. (Optional) Install as a wall panel

On iPad or Android tablet, open the dashboard in Safari or Chrome and use **Add to Home Screen** to install it as a PWA. Set your browser to open on launch and enable guided access or screen pinning for a dedicated wall panel experience. Wall Panel setup options are available under **Settings > Wall Panel Setup**.

---

## Companion App

The **Hestia Dashboard** companion Groovy app (`HestiaDashboard.groovy`) enhances the dashboard with hub-side features.

### What it does

| Feature | Description |
| --- | --- |
| **Auto-download** | Fetches `index.html` from GitHub and installs it to the hub's File Manager on install and upgrade |
| **Local discovery** | Writes `hestia-token.json` with Maker API credentials so the dashboard can auto-discover the hub on new devices |
| **Config sync** | Stores and serves dashboard configuration, keeping settings in sync across all devices on your network |
| **Health check** | Exposes `/ping` and `/version` endpoints for monitoring |

### Installation

**Option A -- HPM (recommended)**

Install via [Hubitat Package Manager](https://community.hubitat.com/t/hubitat-package-manager/94303). Search for "Hestia Dashboard" in the package list.

**Option B -- Manual**

1. In Hubitat, go to **Apps Code** > **New App**
2. Paste the contents of `HestiaDashboard.groovy`
3. Click **Save**
4. Go to **Apps** > **Add User App** > **Hestia Dashboard**
5. Follow the in-app setup prompts

---

## Athena Voice Assistant

Athena is a fully hands-free voice control module. Say the wake word, speak a command, and get a spoken response -- same interaction model as Alexa or Google Home, but powered by Claude AI for higher-quality reasoning.

### Voice pipeline

```
Wake word detected ("Athena")
  -> chime plays
  -> panel opens, wake word engine stops
  -> microphone opens for recording
  -> user speaks command
  -> silence detected, recording stops
  -> audio sent to Google Cloud Speech-to-Text
  -> transcript sent to Claude AI for understanding
  -> device commands executed via Maker API
  -> spoken response via Google Cloud Neural2 TTS
  -> follow-up listening window (5s)
  -> panel closes, wake word engine restarts
```

### Supported languages

| Code | Voice |
| --- | --- |
| en-US | en-US-Neural2-F |
| en-GB | en-GB-Neural2-C |
| es-ES | es-ES-Neural2-A |
| es-US | es-US-Neural2-A |

### Setup

1. **Anthropic API key** -- Enter in **Settings > Athena > API Key**. Used for Claude AI command understanding (model: `claude-haiku-4-5-20251001`).

2. **Google Cloud API key** -- Enter in **Settings > Athena > Google TTS API Key**. This single key is used for both Speech-to-Text (voice input) and Text-to-Speech (voice output).

   To create the key:
   1. Go to [Google Cloud Console](https://console.cloud.google.com/)
   2. Create or select a project
   3. Enable **Cloud Speech-to-Text API** and **Cloud Text-to-Speech API**
   4. Go to **APIs & Services > Credentials > Create Credentials > API Key**
   5. Restrict the key: under **API restrictions**, select the two APIs above; under **Website restrictions**, add `hestari.com` as an allowed referrer
   6. Free tier includes 1M TTS characters/month and 60 minutes STT/month

3. **Wake word** -- Athena uses OpenWakeWord with ONNX Runtime Web for in-browser wake word detection. The ONNX models are loaded automatically from the hosted URL. No additional setup is needed for wake word functionality.

---

## Artemis Security

Artemis integrates with Hubitat Safety Monitor (HSM) to provide home security features directly from the dashboard.

* **Arm / Disarm** -- arm away, arm home, arm night, or disarm from the dashboard
* **Sensor monitoring** -- contact sensors, motion sensors, smoke/CO detectors, water leak sensors, glass break sensors
* **Status display** -- real-time security state shown in the dashboard

---

## Setup Wizard

The four-step onboarding wizard runs automatically on first install:

| Step | What it does |
| --- | --- |
| **Connect** | Enter your Hubitat hub IP and Maker API credentials |
| **Inventory** | Discovers all your devices and auto-classifies them by type |
| **Rooms** | Create the rooms in your home |
| **Assign** | Assign each device to a room |

You can re-run the wizard any time from **Settings > Re-run Setup**.

---

## Device Support

| Type | Capabilities |
| --- | --- |
| Switches | On / Off |
| Dimmers | On / Off, brightness slider |
| Color bulbs | On / Off, brightness, color temperature (2700K-6500K), RGB |
| Fans | Off / Low / Medium / High |
| Window blinds / shades | Open / Close, position slider |
| Thermostats | Heat / Cool / Off, setpoint adjustment |
| Locks | Lock / Unlock |

---

## Settings

Open settings via the gear icon in the topbar.

| Section | Options |
| --- | --- |
| **Settings Lock** | 6-digit PIN to protect configuration |
| **Hub Connection** | URL, Maker API App ID, access token, poll interval |
| **Panel Behavior** | Display mode, default room, inactivity timeout |
| **Wall Panel Setup** | Tablet-specific configuration for dedicated wall panels |
| **Weather** | ZIP code lookup or manual coordinates |
| **Athena** | Wake word, voice, language, Anthropic API key, Google Cloud API key |
| **Artemis** | HSM integration, sensor assignment, arm/disarm options |
| **Thermostats** | Add and configure thermostat devices |
| **Rooms** | Create, rename, and reorder rooms |
| **Devices** | View all synced devices, reclassify types, assign to rooms |
| **Appearance** | Five themes -- Dark, Light, Slate, Warm, Cream |

---

## Display Modes

Hestia automatically detects your screen size and applies the appropriate layout:

| Width | Mode | Layout |
| --- | --- | --- |
| <=768px | Mobile | Bottom tab bar, full-width cards |
| 769-900px | Small tablet | Sidebar 130px, 2-column cards |
| 901-1200px | Tablet | Sidebar 148px, 2-column cards, touch-optimised |
| >=1201px | Desktop | Sidebar 176px, 3-column cards, full topbar |

Override auto-detection in **Settings > Panel Behavior > Display Mode**. The override is stored on that device only and does not sync to other devices.

---

## Roadmap

| Sprint | Feature | Status |
| --- | --- | --- |
| 1-3 | Core dashboard, themes, onboarding, device support | Complete |
| 4 | Companion Groovy app, HPM packaging | Complete |
| 5 | Athena voice AI -- wake word detection, Google Neural2 TTS | Complete |
| 6 | Cloud Speech-to-Text, config sync, Artemis security | Complete |
| 7 | Wake word pipeline fix, Groovy app v1.4.0 | Complete |
| 8 | Athena v2 -- persistent memory, conversation mode, timers, personality presets, full device control | Complete |
| 9 | Reminders, routines, adaptive silence detection | Complete |
| 10 | Built-in calendar widget, inline reminder creation | Complete |

---

## Licence

**Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**

Personal, non-commercial use only. Commercial use requires explicit written permission.

See [LICENSE](https://github.com/h4ven88/hestia-dashboard/blob/main/LICENSE) for full terms.

---

## Copyright

Copyright 2026 Haven. All rights reserved.

Hestia is a trademark of Haven.

---

## Support

* [Hubitat Community Forum](https://community.hubitat.com)
* [Open an issue](https://github.com/h4ven88/hestia-dashboard/issues)

---

*Built with care for the Hubitat community.*
