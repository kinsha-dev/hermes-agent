# X TikTok Video Extension — Design Spec

**Date:** 2026-03-12
**Status:** Approved

## Overview

A Chrome extension that transforms x.com/i/videos into a full-screen, TikTok-style video feed. Auto-activates on the videos URL. Up/down arrow keys and trackpad scroll navigate between videos. Esc exits.

## Problem

X.com's video feed is cluttered and mouse-driven. There's no keyboard-native way to scroll through videos one at a time in a focused, full-screen view.

## Solution

A Manifest V3 Chrome extension with a single content script. When the user navigates to `x.com/i/videos`, the extension injects a full-screen black overlay over the page. It uses a `MutationObserver` to harvest video elements and metadata from X.com's live DOM — no API key, no login separate from the user's existing X session. Navigation is entirely keyboard/scroll-driven.

---

## Architecture

### Files

```
x-tiktok-extension/
├── manifest.json       # MV3 config — targets x.com/*
├── content.js          # All logic: observer, overlay, navigation
├── overlay.css         # Full-screen overlay styles
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

No background service worker needed. No popup. No external API calls.

### Components

**1. URL Watcher (content.js)**
Listens for `pushstate`/`popstate` navigation events (X.com is a SPA). When the URL matches `x.com/i/videos` (or `/home` with video posts), activates the overlay.

**2. MutationObserver (content.js)**
Observes `document.body` for new `<video>` elements. For each discovered video:
- Extracts `<video>` src (direct mp4) or `<source>` children (HLS m3u8)
- Walks up the DOM to find the parent tweet article
- Extracts: author handle, display name, like count, retweet count, reply count, view count, tweet text

Deduplicates by video src. Appends to video queue.

**3. Overlay Renderer (content.js + overlay.css)**
Fixed-position `div` at z-index 999999 covering the full viewport. Contains:
- Single `<video>` element (autoplay, object-fit: contain)
- Top bar: logo + counter (`4 / 18`) + Esc hint
- Bottom gradient: avatar, handle, tweet text, engagement stats, Follow button
- Right side: ↑↓ nav hint buttons

**4. Navigation Controller (content.js)**
- `currentIndex` tracks position in the video queue array
- `ArrowDown` / scroll down → `currentIndex++`, load next video
- `ArrowUp` / scroll up → `currentIndex--`, load prev video
- `Space` → play/pause current `<video>` element
- `M` → toggle mute
- `Esc` → hide overlay, restore X.com scroll
- Scroll debounce: 600ms to prevent over-scrolling on trackpad

**5. Infinite Load Trigger (content.js)**
When `currentIndex >= queue.length - 2`, programmatically scrolls `document.documentElement` by 1000px to trigger X.com's virtual scroll and load the next batch of posts. Resets after new videos are observed.

---

## UI Design

```
┌─────────────────────────────────────────┐
│ [𝕏 X Videos]              4 / 18  [Esc]│  ← top bar
├─────────────────────────────────────────┤
│                                    [↑]  │
│          ┌──────────┐             prev  │
│          │          │                  │
│          │   VIDEO  │            [↓]  │
│          │          │             next  │
│          └──────────┘                  │
│          ▓▓▓▓▓░░░░░░  (progress bar)   │
├─────────────────────────────────────────┤
│ [avatar] @handle · Display Name [Follow]│  ← bottom gradient
│ Tweet text here (truncated 2 lines)     │
│ ♥ 42.1K  ↻ 8.3K  💬 1.2K  👁 2.1M    │
└─────────────────────────────────────────┘
```

---

## Controls

| Input | Action |
|---|---|
| `↓` / scroll down | Next video |
| `↑` / scroll up | Previous video |
| `Space` | Play / pause |
| `M` | Mute / unmute |
| `Esc` | Exit overlay |
| Click video | Play / pause |

---

## Key Technical Decisions

- **Manifest V3** (not V2): Required for new Chrome installs; `content_scripts` with `"run_at": "document_idle"`
- **No service worker**: All logic lives in `content.js` — simpler, no message passing needed
- **DOM-based video extraction**: Reads `<video>` elements already rendered by X.com's React app; no API reverse-engineering
- **SPA navigation detection**: X.com uses History API — content script hooks `pushState` and `popstate` to detect URL changes without a page reload
- **Scroll debounce**: Trackpad scroll fires rapidly; 600ms debounce prevents skipping multiple videos per gesture
- **Overlay over live X.com**: X.com keeps running behind the overlay; programmatic scroll triggers natural infinite-load behavior

---

## Installation (Dev)

1. `chrome://extensions` → Enable Developer Mode
2. "Load unpacked" → select `x-tiktok-extension/` folder
3. Navigate to `x.com/i/videos`

---

## Out of Scope (v1)

- Liking/retweeting from the overlay (read-only)
- Following from the overlay
- Audio waveform / video timeline scrubbing
- Safari / Firefox support
- Published Chrome Web Store listing
