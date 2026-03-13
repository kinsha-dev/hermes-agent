# Manual Launch Hotkey Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove auto-activation on page load; let the user press `V` to toggle the TikTok-style video player on/off.

**Architecture:** Three small edits to `content.js` only — no new files, no manifest changes. (1) Add `V` key guard in the keydown listener. (2) Strip auto-activation from the init block. (3) Strip auto-activation from SPA navigation handler.

**Tech Stack:** Plain JS Chrome extension (MV3), no build step.

---

## Chunk 1: All changes (single file, three edits)

**Files:**
- Modify: `content.js` (keydown listener, `onUrlChange`, init block)

---

### Task 1: Add `V` toggle to the keydown listener

The existing listener bails early with `if (!state.active) return`, so `V` (which must work when inactive to *start* the player) needs to be handled before that guard.

- [ ] **Step 1: Edit the keydown listener in `content.js`**

Replace the current listener block:

```js
document.addEventListener('keydown', e => {
    if (!state.active) return
    const keys = ['ArrowDown','ArrowUp',' ','m','M','Escape']
    if (!keys.includes(e.key)) return
    e.preventDefault(); e.stopPropagation()
    handleKey(e.key)
  }, { capture: true })
```

With:

```js
document.addEventListener('keydown', e => {
    // V toggles the player — works whether active or not,
    // but is suppressed when focus is inside a text field.
    if (e.key === 'v' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = document.activeElement?.tagName
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !document.activeElement?.isContentEditable) {
        e.preventDefault(); e.stopPropagation()
        state.active ? deactivate() : activate()
        return
      }
    }

    if (!state.active) return
    const keys = ['ArrowDown','ArrowUp',' ','m','M','Escape']
    if (!keys.includes(e.key)) return
    e.preventDefault(); e.stopPropagation()
    handleKey(e.key)
  }, { capture: true })
```

- [ ] **Step 2: Verify syntax**

```bash
node --check content.js && echo "✓ OK"
```

Expected: `✓ OK`

---

### Task 2: Remove auto-activation from `onUrlChange`

- [ ] **Step 3: Edit `onUrlChange` in `content.js`**

Replace:

```js
  function onUrlChange() {
    const wasActive = state.active
    if (onVideosPage()) {
      if (!wasActive) activate()
    } else {
      if (wasActive) deactivate()
    }
  }
```

With:

```js
  function onUrlChange() {
    // Deactivate if user navigates away; do NOT auto-activate on arrival.
    // User must press V to launch the player.
    if (!onVideosPage() && state.active) deactivate()
  }
```

- [ ] **Step 4: Verify syntax**

```bash
node --check content.js && echo "✓ OK"
```

Expected: `✓ OK`

---

### Task 3: Remove auto-activation from the init block

- [ ] **Step 5: Edit the init block at the bottom of `content.js`**

Replace the entire `if (IS_MAIN_FRAME) { ... } else { ... }` block:

```js
  if (IS_MAIN_FRAME) {
    // x.com/home: main frame has everything. Wait for React to render.
    setTimeout(() => {
      const hasContent = document.querySelectorAll('article, video').length > 0
      console.log('[XTK main] hasContent:', hasContent,
        'articles:', document.querySelectorAll('article').length,
        'videos:', document.querySelectorAll('video').length)
      if (hasContent) {
        activate()
      } else {
        // Empty shell with iframe player (shouldn't happen for x.com/home)
        console.log('[XTK main] no content found, waiting...')
        // Keep polling in case React renders later
        const poll = setInterval(() => {
          if (document.querySelectorAll('article, video').length > 0) {
            clearInterval(poll)
            activate()
          }
        }, 500)
        setTimeout(() => clearInterval(poll), 15000)
      }
    }, 1200)   // 1.2s — give React a bit more time to render the home feed
  } else {
    // Sub-frame: only activate if this frame actually has video content.
    // Avoids running overlay in ad iframes and other sub-frames on x.com/home.
    setTimeout(() => {
      const hasVideos = document.querySelectorAll('video').length > 0
      if (hasVideos) {
        console.log('[XTK iframe] has videos, activating')
        activate()
      }
      // else: sub-frame with no videos (ads, etc.) — skip silently
    }, 800)
  }
```

With:

```js
  if (IS_MAIN_FRAME) {
    console.log('[XTK] ready — press V to launch the video player')
  }
  // Sub-frames: no action. Only the main frame handles the V hotkey.
```

- [ ] **Step 6: Final syntax check**

```bash
node --check content.js && echo "✓ OK"
```

Expected: `✓ OK`

- [ ] **Step 7: Commit**

```bash
cd /Users/kinsha/clawdbott/x-tiktok-extension
git add content.js
git commit -m "feat: manual V hotkey to launch player; remove auto-activation"
```
