/* =========================================================
   X TikTok Feed — Content Script v5
   Auto-activates on x.com/home

   Architecture:
   ─────────────────────────────────────────────────────────
   x.com/home is a standard SPA. The main frame has all
   the tweet articles and video elements.

   We move X.com's div[data-testid="videoComponent"] (not
   just the raw <video>) into our overlay. This preserves
   X.com's HLS.js binding which is attached to the full
   component structure, not just the <video> element.

   Navigation: ↑↓ keys or trackpad scroll
   ========================================================= */

;(function () {
  'use strict'

  const IS_MAIN_FRAME = window === window.top

  // ── Helpers ──────────────────────────────────────────────

  function topUrl() {
    try { return window.top.location.href } catch (e) { return location.href }
  }

  function isVideosUrl(href) {
    href = href || location.href
    return /x\.com\/home/.test(href) || /twitter\.com\/home/.test(href)
  }

  function onVideosPage() {
    return isVideosUrl(location.href) || isVideosUrl(topUrl())
  }

  // ── State ────────────────────────────────────────────────

  const state = {
    queue: [],
    currentIndex: -1,
    active: false,
    loadingMore: false,
    observer: null,
    harvestTimer: null,
    scrollDebounce: null,
    showToken: 0,           // incremented each showVideo() call; cancels stale async ops
  }

  let overlay, videoContainer, counter, handleEl, nameEl, textEl

  // ── Extract metadata ─────────────────────────────────────

  function fmt(t) { return t ? t.trim() : '' }

  function extractMeta(el) {
    const meta = { handle: '', name: '', text: '', likes: '', retweets: '', replies: '', views: '' }
    if (!el) return meta
    try {
      const userLink = el.querySelector('[data-testid="User-Name"] a[href*="/"]')
      if (userLink) {
        const parts = userLink.getAttribute('href').split('/')
        meta.handle = '@' + (parts[parts.length - 1] || '').split('?')[0]
      }
      const nameSpan = el.querySelector('[data-testid="User-Name"] span')
      if (nameSpan) meta.name = nameSpan.textContent.trim()
      const tweetText = el.querySelector('[data-testid="tweetText"]')
      if (tweetText) meta.text = tweetText.textContent.trim()
      const like = el.querySelector('[data-testid="like"] span[data-testid="app-text-transition-container"]')
        || el.querySelector('[data-testid="like"] span')
      if (like) meta.likes = fmt(like.textContent)
      const rt = el.querySelector('[data-testid="retweet"] span[data-testid="app-text-transition-container"]')
        || el.querySelector('[data-testid="retweet"] span')
      if (rt) meta.retweets = fmt(rt.textContent)
      const re = el.querySelector('[data-testid="reply"] span[data-testid="app-text-transition-container"]')
        || el.querySelector('[data-testid="reply"] span')
      if (re) meta.replies = fmt(re.textContent)
      const views = el.querySelector('[data-testid="views"] span')
        || el.querySelector('a[href*="/analytics"] span')
      if (views) meta.views = fmt(views.textContent)
    } catch (e) {}
    return meta
  }

  // ── Harvest videos ───────────────────────────────────────

  function harvestVideos() {
    if (!state.active) return

    // Diagnostic: always log the first scan so we can see what's in the DOM
    if (state.queue.length === 0) {
      console.log('[XTK] harvest scan:', {
        url: location.href,
        articles: document.querySelectorAll('article').length,
        tweetArticles: document.querySelectorAll('article[data-testid="tweet"]').length,
        videoComponents: document.querySelectorAll('[data-testid="videoComponent"]').length,
        videos: document.querySelectorAll('video').length,
      })
    }

    // Layer 1: tweet articles (home feed) — from HTML analysis this is the correct structure:
    //   article[data-testid="tweet"] → tweetPhoto → placementTracking → videoPlayer → videoComponent → video
    document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
      const videoEl = article.querySelector('video')
      if (!videoEl) return
      if (state.queue.some(e => e.videoEl === videoEl)) return
      // Skip profile pictures and tiny clips (< 1.5s confirmed real content)
      if (videoEl.duration > 0 && videoEl.duration < 1.5) return
      state.queue.push({
        articleEl: article,
        videoEl,
        movedEl: null,       // the actual DOM node we'll move (videoComponent or video)
        placeholder: null,
        origParent: null,
        origNext: null,
        meta: extractMeta(article),
      })
    })

    // Layer 2: any article (fallback for non-tweet video posts)
    if (state.queue.length === 0) {
      document.querySelectorAll('article').forEach(article => {
        const videoEl = article.querySelector('video')
        if (!videoEl) return
        if (state.queue.some(e => e.videoEl === videoEl)) return
        if (videoEl.duration > 0 && videoEl.duration < 1.5) return
        state.queue.push({
          articleEl: article, videoEl, movedEl: null,
          placeholder: null, origParent: null, origNext: null,
          meta: extractMeta(article),
        })
      })
    }

    // Layer 3: any video on page not in our overlay
    if (state.queue.length === 0) {
      document.querySelectorAll('video').forEach(videoEl => {
        if (videoEl.closest('#xtk-overlay')) return
        if (state.queue.some(e => e.videoEl === videoEl)) return
        if (videoEl.duration > 0 && videoEl.duration < 1.5) return
        const parent = videoEl.closest('article') || videoEl.parentElement
        state.queue.push({
          articleEl: parent, videoEl, movedEl: null,
          placeholder: null, origParent: null, origNext: null,
          meta: extractMeta(parent || document.body),
        })
      })
    }

    if (state.queue.length > 0) {
      console.log(`[XTK] queue: ${state.queue.length} videos`)
    }

    if (state.active && state.currentIndex === -1 && state.queue.length > 0) {
      overlay.classList.remove('loading')
      showVideo(0)
    }

    updateCounter()

    // Disconnect observer once we have enough queued to avoid infinite churn
    if (state.queue.length >= 5 && state.observer) {
      state.observer.disconnect()
      state.observer = null
      console.log('[XTK] observer disconnected (5+ queued)')
    }
  }

  // ── Move video into overlay ───────────────────────────────
  //
  // DEFINITIVE ARCHITECTURE (from live DOM/MSE debugging):
  //
  //   X.com's IntersectionObserver uses primaryColumn as its ROOT.
  //   Moving videoComponent out of primaryColumn fires IO with
  //   isIntersecting:false → SourceBuffer.appendBuffer() stops →
  //   readyState stays 0 permanently → black screen.
  //
  //   FIX: move ONLY the raw <video> element. videoComponent stays
  //   inside primaryColumn, IO keeps firing, HLS keeps streaming.
  //   HLS.js holds a JS reference to <video> — it doesn't matter
  //   where in the DOM the element lives.

  function moveVideoToOverlay(entry) {
    const v = entry.videoEl

    entry.movedEl    = v
    entry.origParent = v.parentElement
    entry.origNext   = v.nextSibling

    // Placeholder so videoComponent doesn't visually collapse
    const ph = document.createElement('div')
    ph.style.cssText = `display:inline-block;width:${v.offsetWidth || 320}px;height:${v.offsetHeight || 180}px`
    if (entry.origParent) entry.origParent.insertBefore(ph, v)
    entry.placeholder = ph

    videoContainer.appendChild(v)

    // Bug #1 fix: position:absolute so the video fills the container exactly.
    // position:relative inside a flex container caused the flex layout to shrink
    // around the video's natural dimensions (e.g. 300x720) instead of the container
    // filling the viewport → video rendered at top:-76, left:280 (confirmed live).
    v.style.setProperty('position',   'absolute','important')
    v.style.setProperty('top',        '0',       'important')
    v.style.setProperty('left',       '0',       'important')
    v.style.setProperty('width',      '100%',    'important')
    v.style.setProperty('height',     '100%',    'important')
    v.style.setProperty('object-fit', 'contain', 'important')
    v.style.setProperty('display',    'block',   'important')
    v.style.setProperty('cursor',     'pointer', 'important')
    v.style.setProperty('visibility', 'visible', 'important')
    v.style.setProperty('opacity',    '1',       'important')
  }

  function restoreVideoToArticle(entry) {
    const v = entry.videoEl
    if (!v) return

    v.pause()
    ;['position','top','left','width','height','object-fit','display',
      'cursor','visibility','opacity'].forEach(p => v.style.removeProperty(p))

    if (entry.origParent && entry.origParent.isConnected) {
      entry.origParent.insertBefore(v, entry.origNext || null)
    }
    if (entry.placeholder) { entry.placeholder.remove(); entry.placeholder = null }
    entry.origParent = null
    entry.origNext   = null
    entry.movedEl    = null
  }

  // ── Inject overlay HTML ──────────────────────────────────

  function injectOverlay() {
    if (document.getElementById('xtk-overlay')) return
    const div = document.createElement('div')
    div.id = 'xtk-overlay'
    div.innerHTML = `
      <div id="xtk-top-bar">
        <div id="xtk-logo"><div id="xtk-logo-icon">𝕏</div><span>Videos</span></div>
        <span id="xtk-counter">— / —</span>
        <span id="xtk-esc-hint" title="Exit (Esc)">Esc to exit</span>
      </div>
      <div id="xtk-loading"><div id="xtk-spinner"></div><span id="xtk-loading-text">Loading videos…</span></div>
      <div id="xtk-video-container"></div>
      <div id="xtk-nav">
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
          <button class="xtk-nav-btn" id="xtk-prev">↑</button><span class="xtk-nav-label">prev</span>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
          <button class="xtk-nav-btn" id="xtk-next">↓</button><span class="xtk-nav-label">next</span>
        </div>
      </div>
      <div id="xtk-bottom">
        <div id="xtk-author-row"><div id="xtk-author-info"><div id="xtk-handle"></div><div id="xtk-name"></div></div></div>
        <div id="xtk-text"></div>
        <div id="xtk-stats">
          <span class="xtk-stat"><span class="xtk-stat-icon">♥</span><span id="xtk-likes"></span></span>
          <span class="xtk-stat"><span class="xtk-stat-icon">↻</span><span id="xtk-retweets"></span></span>
          <span class="xtk-stat"><span class="xtk-stat-icon">💬</span><span id="xtk-replies"></span></span>
          <span class="xtk-stat"><span class="xtk-stat-icon">👁</span><span id="xtk-views"></span></span>
        </div>
      </div>`
    document.body.appendChild(div)
    overlay        = div
    videoContainer = div.querySelector('#xtk-video-container')
    counter        = div.querySelector('#xtk-counter')
    handleEl       = div.querySelector('#xtk-handle')
    nameEl         = div.querySelector('#xtk-name')
    textEl         = div.querySelector('#xtk-text')
    div.querySelector('#xtk-prev').addEventListener('click', () => showVideo(state.currentIndex - 1))
    div.querySelector('#xtk-next').addEventListener('click', () => showVideo(state.currentIndex + 1))
    div.querySelector('#xtk-esc-hint').addEventListener('click', deactivate)
    videoContainer.addEventListener('click', togglePlayPause)
  }

  // ── Safe play — handles all 3 confirmed autoplay bugs ───
  //
  // Bug #1 (NotAllowedError): play() fires before any user gesture
  //   → always start muted (guaranteed to be allowed), then re-enable audio
  // Bug #2 (AbortError): X.com sets preload="none" so readyState=0 when
  //   play() is called; browser tries to load+play simultaneously → crash
  //   → set preload="auto", force load(), wait for "canplay" event
  // Bug #3 (document.hidden): Tab not yet visible at overlay activation;
  //   Chrome silently suppresses play() when document.hidden=true
  //   → defer until visibilitychange fires

  function safePlay(v) {
    if (!state.active) return

    // Bug #3 — tab not visible yet
    if (document.hidden) {
      console.log('[XTK] tab hidden — deferring play until visible')
      const onVisible = () => {
        if (!document.hidden && state.active && v === currentVideo()) safePlay(v)
      }
      document.addEventListener('visibilitychange', onVisible, { once: true })
      return
    }

    // Bug #2 — preload="none" means zero data buffered; must force load first
    if (v.preload !== 'auto') {
      v.preload = 'auto'
    }

    const attempt = () => {
      if (!state.active || v !== currentVideo()) return // stale call
      console.log(`[XTK] play() attempt readyState=${v.readyState} muted=${v.muted} hidden=${document.hidden}`)
      const p = v.play()
      if (!p) return // very old browser, no Promise
      p.then(() => {
        console.log('[XTK] play() started ✓')
      }).catch(err => {
        console.warn(`[XTK] play() ${err.name}: ${err.message}`)
        if (err.name === 'NotAllowedError') {
          // Bug #1 — no user gesture; muted autoplay is always permitted
          console.log('[XTK] retrying muted (autoplay policy)')
          v.muted = true
          v.play().catch(e2 => {
            // Even muted failed — wait for first overlay interaction
            console.warn('[XTK] even muted blocked — waiting for click')
            overlay.addEventListener('click', () => {
              if (state.active && v === currentVideo()) safePlay(v)
            }, { once: true })
          })
        } else if (err.name === 'AbortError') {
          // Bug #2 — load started simultaneously; wait for canplay then retry
          console.log('[XTK] AbortError — waiting for canplay')
          v.addEventListener('canplay', () => {
            if (state.active && v === currentVideo()) v.play().catch(() => {})
          }, { once: true })
        }
      })
    }

    // If no data loaded yet (readyState 0 = HAVE_NOTHING), trigger load then wait
    if (v.readyState === 0) {
      v.addEventListener('canplay', attempt, { once: true })
      v.load() // kicks off the actual network request (preload was "none")
    } else {
      attempt()
    }
  }

  // ── Wait for video data ──────────────────────────────────
  // Returns true if video got data, false on timeout.
  // Handles preload="none": sets preload="auto" and calls load() first.

  function waitForVideoData(v, timeoutMs) {
    return new Promise(resolve => {
      if (v.readyState >= 2) { resolve(true); return }

      let done = false
      const finish = (ok) => {
        if (done) return; done = true
        v.removeEventListener('canplay',    finish)
        v.removeEventListener('loadeddata', finish)
        clearTimeout(timer)
        resolve(ok)
      }
      v.addEventListener('canplay',    () => finish(true),  { once: true })
      v.addEventListener('loadeddata', () => finish(true),  { once: true })
      const timer = setTimeout(() => finish(false), timeoutMs)

      // Kick off loading if X.com set preload="none"
      if (v.preload !== 'auto') v.preload = 'auto'
      if (v.readyState === 0)   v.load()
    })
  }

  // ── Show video ───────────────────────────────────────────
  //
  // PRE-WARM SEQUENCE (fixes definitive root cause):
  //   1. Make overlay invisible (visibility:hidden) so X.com's IO
  //      still sees articles in the viewport → MSE data flows
  //   2. Scroll the target article into view → IO fires → appendBuffer starts
  //   3. Wait for readyState ≥ 2 (up to 2.5s)
  //   4. Show overlay + move <video> + play
  //
  // Token system: each call gets a unique token. If a newer showVideo
  // fires before this one's pre-warm finishes, the stale callback is discarded.

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)) }

  function showVideo(index) {
    if (!state.queue.length) return
    index = clamp(index, 0, state.queue.length - 1)
    const entry = state.queue[index]
    if (!entry) return

    const prev = state.queue[state.currentIndex]
    if (prev && prev !== entry) restoreVideoToArticle(prev)

    state.currentIndex = index
    const token = ++state.showToken

    const v = entry.videoEl
    console.log(`[XTK] showVideo #${index} readyState=${v.readyState} preload=${v.preload}`)

    // ── Step 1: hide overlay so IO sees articles ──────────
    overlay.classList.add('pre-init', 'loading')

    // ── Step 2: scroll article into viewport for IO ───────
    if (entry.articleEl && entry.articleEl.isConnected) {
      entry.articleEl.scrollIntoView({ block: 'center', behavior: 'instant' })
    }

    // ── Step 3: wait for MSE data ─────────────────────────
    waitForVideoData(v, 300).then(loaded => {  // 300ms: fail fast; safePlay handles readyState=0 via canplay event
      if (!state.active || state.showToken !== token) return // superseded
      console.log(`[XTK] pre-warm done #${index}: loaded=${loaded} readyState=${v.readyState}`)

      // ── Step 4: show overlay with loaded video ─────────
      overlay.classList.remove('pre-init', 'loading')
      moveVideoToOverlay(entry)
      safePlay(v)
    })

    // Update metadata immediately (visible once overlay is shown)

    handleEl.textContent = entry.meta.handle || ''
    nameEl.textContent   = entry.meta.name   || ''
    textEl.textContent   = entry.meta.text   || ''
    overlay.querySelector('#xtk-likes').textContent    = entry.meta.likes    || ''
    overlay.querySelector('#xtk-retweets').textContent = entry.meta.retweets || ''
    overlay.querySelector('#xtk-replies').textContent  = entry.meta.replies  || ''
    overlay.querySelector('#xtk-views').textContent    = entry.meta.views    || ''
    updateCounter()

    if (index >= state.queue.length - 2) triggerLoadMore()
  }

  function updateCounter() {
    if (!counter) return
    counter.textContent = state.queue.length > 0
      ? `${state.currentIndex >= 0 ? state.currentIndex + 1 : '—'} / ${state.queue.length}`
      : '— / —'
  }

  function currentVideo() {
    const e = state.queue[state.currentIndex]; return e ? e.videoEl : null
  }
  function togglePlayPause() {
    const v = currentVideo(); if (!v) return
    v.paused ? safePlay(v) : v.pause()
  }
  function toggleMute() {
    const v = currentVideo(); if (v) v.muted = !v.muted
  }

  // ── Load more ────────────────────────────────────────────

  function triggerLoadMore() {
    if (state.loadingMore) return
    state.loadingMore = true
    if (!state.observer) startObserver()

    // Scroll down to push X.com's sentinel element into viewport, triggering their
    // IntersectionObserver-based "load more" logic. The overlay covers the full screen
    // so the user sees zero flicker. After 150ms (long enough for X.com's observer to
    // fire and queue more tweets) we scroll back so the current video's parent containers
    // remain in the viewport, preventing X.com from pausing the HLS stream.
    const savedY = window.scrollY
    window.scrollBy({ top: 3000, behavior: 'instant' })
    console.log(`[XTK] triggerLoadMore: briefly at ${window.scrollY}, returning to ${savedY} in 150ms`)

    setTimeout(() => {
      window.scrollTo({ top: savedY, behavior: 'instant' })
      // Bug #4 fix: debounce the re-play to avoid racing with the initial play()
      // that already fired. Without debounce, play()→scroll-back→play() sequence
      // causes AbortError: "interrupted by new load" (confirmed 0ms gap in console).
      const cur = state.queue[state.currentIndex]
      if (cur && cur.videoEl.paused) {
        clearTimeout(cur.videoEl._xtkScrollPlayTimer)
        cur.videoEl._xtkScrollPlayTimer = setTimeout(() => {
          if (cur.videoEl.paused) {
            console.log('[XTK] re-playing video after scroll-back (debounced 250ms)')
            safePlay(cur.videoEl)
          }
        }, 250)
      }
    }, 150)

    setTimeout(() => {
      state.loadingMore = false
      harvestVideos()
    }, 2000)
  }

  function startObserver() {
    if (state.observer) return
    state.observer = new MutationObserver(() => {
      clearTimeout(state.harvestTimer)
      state.harvestTimer = setTimeout(harvestVideos, 150)
    })
    const root = document.querySelector('[data-testid="primaryColumn"]')
      || document.querySelector('main')
      || document.body
    state.observer.observe(root, { childList: true, subtree: true })
    console.log('[XTK] observer started on', root.getAttribute('data-testid') || root.tagName)
  }

  // ── Activate / Deactivate ────────────────────────────────

  function activate() {
    if (state.active) return
    console.log('[XTK] activating overlay')
    state.active = true
    injectOverlay()
    overlay.classList.add('active', 'loading')
    // Do NOT set body.overflow = 'hidden' — that would prevent window.scrollBy()
    // from triggering X.com's IntersectionObserver-based infinite feed load.
    // The overlay is position:fixed;inset:0 so it visually covers everything.
    // Wheel events are intercepted via { capture:true, passive:false } below.
    startObserver()
    harvestVideos()

    if (state.queue.length === 0) {
      // Poll every 500ms for up to 20 seconds waiting for X.com to render videos
      const poll = setInterval(() => {
        harvestVideos()
        if (state.queue.length > 0) clearInterval(poll)
      }, 500)
      setTimeout(() => clearInterval(poll), 20000)
    }
  }

  function deactivate() {
    if (!state.active) return
    console.log('[XTK] deactivating overlay')
    state.active = false
    const cur = state.queue[state.currentIndex]
    if (cur) restoreVideoToArticle(cur)
    if (overlay) overlay.classList.remove('active', 'loading')
    if (state.observer) { state.observer.disconnect(); state.observer = null }
    clearTimeout(state.harvestTimer)
    clearTimeout(state.scrollDebounce)
    state.queue = []; state.currentIndex = -1
  }

  // ── Keyboard ─────────────────────────────────────────────

  function handleKey(key) {
    switch (key) {
      case 'ArrowDown': showVideo(state.currentIndex + 1); break
      case 'ArrowUp':   showVideo(state.currentIndex - 1); break
      case ' ':         togglePlayPause(); break
      case 'm': case 'M': toggleMute(); break
      case 'Escape':    deactivate(); break
    }
  }

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

  document.addEventListener('wheel', e => {
    if (!state.active) return
    e.preventDefault(); e.stopPropagation()
    clearTimeout(state.scrollDebounce)
    state.scrollDebounce = setTimeout(() => {
      handleKey(e.deltaY > 0 ? 'ArrowDown' : 'ArrowUp')
    }, 600)
  }, { passive: false, capture: true })

  // ── SPA navigation ───────────────────────────────────────

  function onUrlChange() {
    // Deactivate if user navigates away; do NOT auto-activate on arrival.
    // User must press V to launch the player.
    if (!onVideosPage() && state.active) deactivate()
  }

  const origPush = history.pushState.bind(history)
  history.pushState = (...a) => { origPush(...a); onUrlChange() }
  const origReplace = history.replaceState.bind(history)
  history.replaceState = (...a) => { origReplace(...a); onUrlChange() }
  window.addEventListener('popstate', onUrlChange)

  // ── Init ─────────────────────────────────────────────────

  console.log('[XTK v5 init]', {
    isMainFrame: IS_MAIN_FRAME,
    href: location.href,
    topHref: (() => { try { return window.top.location.href } catch(e) { return 'cross-origin' } })(),
    onVideosPage: onVideosPage(),
  })

  if (!onVideosPage()) return

  if (IS_MAIN_FRAME) {
    console.log('[XTK] ready — press V to launch the video player')
  }
  // Sub-frames: no action. Only the main frame handles the V hotkey.

})()
