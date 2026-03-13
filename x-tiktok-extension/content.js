// XTikTok Feed — content.js  (XTK v5 — fully fixed rewrite)
// Fixes applied:
//   [F1] Reparent original <video> instead of cloneNode (MSE blob exclusivity)
//   [F2] CSS layout: position:absolute 100%x100%, display:block container
//   [F3] Pre-warm timeout 2000ms → 300ms + canplay event fast-path
//   [F4] Harvest scan interval 500ms → 100ms + immediate scan on activation
//   [F5] Scroll-back replay properly debounced (was firing 0ms = AbortError)
//   [F6] Observer disconnect threshold 5 → 20 videos
'use strict';
(() => {
  // ─── Constants ────────────────────────────────────────────────────────────
  const HARVEST_INTERVAL_MS = 100;      // [F4] was 500
  const PREWARM_TIMEOUT_MS  = 300;      // [F3] was 2000
  const SCROLL_REPLAY_MS    = 250;      // [F5] debounce for scroll-back replay
  const OBSERVER_QUEUE_MAX  = 20;       // [F6] was 5
  const TRIGGER_SCROLL_PX   = 3000;    // how far to scroll to trigger load-more

  // ─── State ────────────────────────────────────────────────────────────────
  let queue        = [];   // { el: VideoElement, originalParent, originalNextSibling }
  let currentIndex = -1;
  let isActive     = false;
  let harvestTimer = null;
  let primaryObserver = null;

  // ─── DOM refs (created once) ──────────────────────────────────────────────
  let overlay, topBar, counterEl, loadingEl, container, navPrev, navNext, bottomBar;

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function log(...args) {
    console.log('[XTK]', ...args);
  }

  // ─── Build overlay DOM ────────────────────────────────────────────────────
  function buildOverlay() {
    if (document.getElementById('xtk-overlay')) return;
    overlay = document.createElement('div');
    overlay.id = 'xtk-overlay';
    Object.assign(overlay.style, {
      position:   'fixed',
      top:        '0', left: '0',
      width:      '100vw', height: '100vh',
      background: '#000',
      zIndex:     '2147483647',
      display:    'none',
    });

    // Top bar
    topBar = document.createElement('div');
    topBar.id = 'xtk-top-bar';
    Object.assign(topBar.style, {
      position:   'absolute',
      top:        '0', left: '0', right: '0',
      height:     '44px',
      display:    'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding:    '0 16px',
      zIndex:     '10',
      color:      '#fff',
    });
    const logoSpan = document.createElement('span');
    logoSpan.style.cssText = 'font-weight:700;font-size:18px;';
    logoSpan.textContent = '𝕏';
    topBar.appendChild(logoSpan);
    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'Videos';
    titleSpan.style.cssText = 'font-size:16px;font-weight:600;';
    topBar.appendChild(titleSpan);
    counterEl = document.createElement('span');
    counterEl.style.cssText = 'font-size:14px;opacity:.8;';
    topBar.appendChild(counterEl);
    const escBtn = document.createElement('button');
    escBtn.textContent = 'Esc to exit';
    escBtn.style.cssText = 'background:rgba(255,255,255,.15);border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:13px;';
    escBtn.addEventListener('click', deactivate);
    topBar.appendChild(escBtn);

    // Loading indicator
    loadingEl = document.createElement('div');
    loadingEl.id = 'xtk-loading';
    loadingEl.style.cssText = 'display:none;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:16px;z-index:20;';
    loadingEl.textContent = 'Loading…';

    // [F2] Video container — display:block, not flex
    container = document.createElement('div');
    container.id = 'xtk-video-container';
    Object.assign(container.style, {
      position:   'absolute',
      top:        '0', left: '0',
      width:      '100%', height: '100%',
      display:    'block',          // [F2] was flex → causes collapse
      overflow:   'hidden',
    });

    // Nav buttons
    const nav = document.createElement('div');
    nav.id = 'xtk-nav';
    nav.style.cssText = 'position:absolute;right:16px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:8px;z-index:10;';
    navPrev = document.createElement('button');
    navPrev.style.cssText = 'width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.2);border:none;color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
    navPrev.innerHTML = '↑';
    const prevLabel = document.createElement('span');
    prevLabel.style.cssText = 'display:block;font-size:10px;text-align:center;color:#fff;margin-top:2px;';
    prevLabel.textContent = 'PREV';
    navNext = document.createElement('button');
    navNext.style.cssText = navPrev.style.cssText;
    navNext.innerHTML = '↓';
    const nextLabel = document.createElement('span');
    nextLabel.style.cssText = prevLabel.style.cssText;
    nextLabel.textContent = 'NEXT';
    const prevWrap = document.createElement('div');
    prevWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;';
    prevWrap.append(navPrev, prevLabel);
    const nextWrap = document.createElement('div');
    nextWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;';
    nextWrap.append(navNext, nextLabel);
    nav.append(prevWrap, nextWrap);
    navPrev.addEventListener('click', () => navigate(-1));
    navNext.addEventListener('click', () => navigate(1));

    // Bottom bar (author / caption)
    bottomBar = document.createElement('div');
    bottomBar.id = 'xtk-bottom';
    bottomBar.style.cssText = 'position:absolute;bottom:0;left:0;right:0;padding:12px 16px 16px;background:linear-gradient(transparent,rgba(0,0,0,.7));color:#fff;z-index:10;pointer-events:none;';

    overlay.append(topBar, loadingEl, container, nav, bottomBar);
    document.body.appendChild(overlay);
  }

  // ─── [F2] Apply fullscreen CSS to a video ─────────────────────────────────
  function applyVideoStyle(video) {
    video.style.cssText = `
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      height: 100% !important;
      object-fit: contain;
      background: #000;
      z-index: 1;
    `;
  }

  // ─── [F1] Harvest: reparent original, don't clone ─────────────────────────
  //
  //  X.com uses MediaSource Extensions (MSE). blob:https://x.com/{uuid} URLs
  //  are bound exclusively to the <video> element they were created on.
  //  Cloning the element and setting the same src on a new <video> results in
  //  networkState=0 forever — the browser never loads it.
  //  Fix: physically move the original element into our container.
  //
  function harvestVideo(tweetVideo) {
    // Avoid double-harvesting
    if (tweetVideo._xtkHarvested) return;
    tweetVideo._xtkHarvested = true;

    // Save original DOM location so we can restore on deactivate
    tweetVideo._xtkOriginalParent      = tweetVideo.parentElement;
    tweetVideo._xtkOriginalNextSibling = tweetVideo.nextSibling;

    // Pause the tweet's own playback
    tweetVideo.pause();

    // Reparent into XTK container  ← [F1] THE KEY FIX
    container.appendChild(tweetVideo);

    // Reset display (XTK may have hidden it in a previous session)
    tweetVideo.style.display = 'block';

    queue.push({
      el:                   tweetVideo,
      originalParent:       tweetVideo._xtkOriginalParent,
      originalNextSibling:  tweetVideo._xtkOriginalNextSibling,
    });
  }

  // Restore a video to its original tweet position
  function releaseVideo(entry) {
    const v = entry.el;
    v._xtkHarvested = false;
    if (entry.originalParent && document.contains(entry.originalParent)) {
      entry.originalParent.insertBefore(v, entry.originalNextSibling || null);
    } else {
      // Original parent removed (tweet scrolled away) — just detach
      if (v.parentElement) v.parentElement.removeChild(v);
    }
    // Reset styles we added
    v.style.cssText = '';
    v.pause();
  }

  // ─── Harvest scan ─────────────────────────────────────────────────────────
  // [F4] Called immediately on activate + every HARVEST_INTERVAL_MS (100ms)
  function harvestScan() {
    // Find all tweet videos NOT yet harvested
    const tweetVideos = Array.from(
      document.querySelectorAll('div[data-testid="videoPlayer"] video, div[data-testid="tweetPhoto"] video, article video')
    ).filter(v => !v._xtkHarvested && v.readyState >= 1 && (v.src || v.currentSrc));

    let added = 0;
    for (const v of tweetVideos) {
      harvestVideo(v);
      added++;
    }

    if (added > 0 || queue.length > 0) {
      console.log('[XTK] harvest scan:', { found: tweetVideos.length, added, total: queue.length });
    }
    if (queue.length > 0) {
      console.log('[XTK] queue:', queue.length, 'videos');
    }

    // Stop observer once we have enough queued
    if (queue.length >= OBSERVER_QUEUE_MAX) { // [F6] was 5
      stopPrimaryObserver();
      console.log('[XTK] observer disconnected (' + OBSERVER_QUEUE_MAX + '+ queued)');
    }

    // Update counter
    updateCounter();
  }

  // ─── Primary column observer ──────────────────────────────────────────────
  function startPrimaryObserver() {
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]') ||
                          document.querySelector('main') ||
                          document.body;
    if (!primaryColumn) return;
    primaryObserver = new MutationObserver(() => harvestScan());
    primaryObserver.observe(primaryColumn, { childList: true, subtree: true });
    console.log('[XTK] observer started on primaryColumn');
  }

  function stopPrimaryObserver() {
    if (primaryObserver) {
      primaryObserver.disconnect();
      primaryObserver = null;
    }
  }

  // ─── Trigger load-more ────────────────────────────────────────────────────
  // Briefly scrolls down to trigger X.com's infinite scroll, then returns
  function triggerLoadMore() {
    const scrollable = document.querySelector('[data-testid="primaryColumn"]') ||
                       document.scrollingElement;
    if (!scrollable) return;
    const currentScroll = scrollable.scrollTop;
    const targetScroll  = currentScroll + TRIGGER_SCROLL_PX;
    console.log(`[XTK] triggerLoadMore: briefly at ${targetScroll}, returning to ${currentScroll} in 150ms`);
    scrollable.scrollTop = targetScroll;
    setTimeout(() => { scrollable.scrollTop = currentScroll; }, 150);
    // Restart observer after scroll (new tweets may appear)
    if (!primaryObserver) startPrimaryObserver();
  }

  // ─── [F3] Pre-warm a video ────────────────────────────────────────────────
  // With [F1] applied, most videos are already rs=4 (original elements).
  // This is now a near-instant fast-path. Timeout reduced to 300ms.
  function preWarm(video, index) {
    return new Promise(resolve => {
      // Fast path: already loaded
      if (video.readyState >= 3) {
        console.log(`[XTK] pre-warm done #${index}: loaded=true readyState=${video.readyState}`);
        return resolve({ loaded: true });
      }

      // [F3] Event-driven fast path — fires as soon as data arrives
      const onCanPlay = () => {
        clearTimeout(timer);
        video.removeEventListener('canplaythrough', onCanPlay);
        video.removeEventListener('canplay', onCanPlay);
        console.log(`[XTK] pre-warm done #${index}: loaded=true readyState=${video.readyState}`);
        resolve({ loaded: true });
      };
      video.addEventListener('canplaythrough', onCanPlay, { once: true });
      video.addEventListener('canplay',        onCanPlay, { once: true });

      // Ensure the browser is actually trying to load
      if (video.preload === 'none') video.preload = 'auto';

      // [F3] Fallback timeout: 300ms (was 2000ms)
      const timer = setTimeout(() => {
        video.removeEventListener('canplaythrough', onCanPlay);
        video.removeEventListener('canplay',        onCanPlay);
        const loaded = video.readyState >= 3;
        console.log(`[XTK] pre-warm done #${index}: loaded=${loaded} readyState=${video.readyState}`);
        resolve({ loaded });
      }, PREWARM_TIMEOUT_MS);
    });
  }

  // ─── Play a video ─────────────────────────────────────────────────────────
  function playVideo(video) {
    console.log(`[XTK] play() attempt readyState=${video.readyState} muted=${video.muted} hidden=${document.hidden}`);
    return video.play().then(() => {
      console.log('[XTK] play() started ✓');
    }).catch(err => {
      console.warn('[XTK] play() failed:', err.message);
    });
  }

  // ─── Show a video by index ────────────────────────────────────────────────
  async function showVideo(index) {
    if (index < 0 || index >= queue.length) return;
    const entry = queue[index];
    const video = entry.el;
    console.log(`[XTK] showVideo #${index} readyState=${video.readyState} preload=${video.preload}`);

    // Hide all other videos in container
    Array.from(container.querySelectorAll('video')).forEach(v => {
      if (v !== video) {
        v.pause();
        v.style.display = 'none';
      }
    });

    // [F2] Apply fullscreen layout to the active video
    video.style.display = 'block';
    applyVideoStyle(video);

    // [F3] Pre-warm (fast with original elements)
    const { loaded } = await preWarm(video, index);
    if (!loaded) {
      // Video not ready — try to trigger more loading and skip forward
      loadingEl.style.display = 'block';
      triggerLoadMore();
      // Try next video
      if (index + 1 < queue.length) {
        loadingEl.style.display = 'none';
        return showVideo(index + 1);
      }
      return;
    }

    loadingEl.style.display = 'none';

    // Unmute if this is not the first interaction
    video.muted = false;

    // Play
    await playVideo(video);

    // Update counter and bottom bar
    updateCounter();
    updateBottomBar(index);

    // Trigger load-more when approaching end of queue
    if (index >= queue.length - 3) {
      triggerLoadMore();
    }
  }

  // ─── Navigate prev/next ───────────────────────────────────────────────────
  async function navigate(direction) {
    const next = currentIndex + direction;
    if (next < 0 || next >= queue.length) {
      if (direction > 0 && queue.length > 0) {
        // At end — trigger load-more and wait
        triggerLoadMore();
        await new Promise(r => setTimeout(r, 400));
        if (next < queue.length) {
          currentIndex = next;
          await showVideo(currentIndex);
        }
      }
      return;
    }
    currentIndex = next;
    await showVideo(currentIndex);
  }

  // ─── Update HUD ───────────────────────────────────────────────────────────
  function updateCounter() {
    if (!counterEl) return;
    counterEl.textContent = queue.length > 0
      ? `${currentIndex + 1} / ${queue.length}`
      : '…';
  }

  function updateBottomBar(index) {
    if (!bottomBar) return;
    const entry = queue[index];
    if (!entry) return;
    const video   = entry.el;
    const article = entry.originalParent?.closest?.('article[data-testid="tweet"]');
    if (!article) { bottomBar.innerHTML = ''; return; }
    const handleEl  = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
    const displayEl = article.querySelector('[data-testid="User-Name"] span');
    const tweetText = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || '';
    const handle  = handleEl?.getAttribute('href')?.replace('/', '') || '';
    const display = displayEl?.textContent?.trim() || '';
    bottomBar.innerHTML = `
      <div style="font-weight:700;font-size:15px;margin-bottom:2px;">
        ${display ? `<span>${display}</span> ` : ''}
        <span style="opacity:.7;font-weight:400;">@${handle}</span>
      </div>
      <div style="font-size:14px;opacity:.9;max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${tweetText}
      </div>
    `;
  }

  // ─── Scroll-back replay ───────────────────────────────────────────────────
  // [F5] After triggerLoadMore scrolls back, the current video may have paused.
  //      Re-play it, but debounce properly to avoid AbortError race with play().
  function scheduleScrollBackReplay() {
    if (currentIndex < 0 || currentIndex >= queue.length) return;
    const video = queue[currentIndex].el;
    clearTimeout(video._xtkScrollReplayTimer);
    video._xtkScrollReplayTimer = setTimeout(() => {
      if (video.paused && !video.ended) {
        console.log('[XTK] re-playing video after scroll-back (debounced 250ms)');
        video.play().catch(() => {});
      }
    }, SCROLL_REPLAY_MS);
  }

  // ─── Keyboard handler ─────────────────────────────────────────────────────
  function onKeyDown(e) {
    if (!isActive) {
      if (e.key === 'v' || e.key === 'V') {
        const tag = document.activeElement?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !document.activeElement?.isContentEditable) {
          activate();
        }
      }
      return;
    }
    switch (e.key) {
      case 'Escape':              deactivate(); break;
      case 'ArrowDown': case 'j': e.preventDefault(); navigate(1);  break;
      case 'ArrowUp':   case 'k': e.preventDefault(); navigate(-1); break;
      case ' ':
        e.preventDefault();
        if (currentIndex >= 0 && queue[currentIndex]) {
          const v = queue[currentIndex].el;
          v.paused ? v.play().catch(() => {}) : v.pause();
        }
        break;
      case 'm': case 'M':
        if (currentIndex >= 0 && queue[currentIndex]) {
          const v = queue[currentIndex].el;
          v.muted = !v.muted;
        }
        break;
    }
  }

  // ─── Activate ─────────────────────────────────────────────────────────────
  async function activate() {
    if (isActive) return;
    isActive = true;
    log('activating overlay');
    buildOverlay();
    overlay.style.display = 'block';

    // Reset state
    queue        = [];
    currentIndex = 0;

    // [F4] Immediate harvest scan + start observer
    startPrimaryObserver();
    harvestScan(); // immediate — [F4]

    // [F4] Polling interval at 100ms (was 500ms)
    harvestTimer = setInterval(() => {
      harvestScan();
    }, HARVEST_INTERVAL_MS);

    // Wait briefly for initial harvest
    await new Promise(r => setTimeout(r, 80));

    // Trigger load-more to get more videos into the timeline
    triggerLoadMore();

    // Wait for scroll-back
    await new Promise(r => setTimeout(r, 250));

    // Start playing first video
    if (queue.length > 0) {
      await showVideo(0);
    } else {
      // Nothing harvested yet — show loading and wait
      loadingEl.style.display = 'block';
      await new Promise(r => setTimeout(r, 600));
      harvestScan();
      if (queue.length > 0) {
        loadingEl.style.display = 'none';
        await showVideo(0);
      }
    }

    // Listen for scroll events to re-play paused video
    document.addEventListener('scroll', scheduleScrollBackReplay, { passive: true });
  }

  // ─── Deactivate ───────────────────────────────────────────────────────────
  function deactivate() {
    if (!isActive) return;
    isActive = false;
    log('deactivating overlay');

    // Stop timers
    if (harvestTimer) { clearInterval(harvestTimer); harvestTimer = null; }
    stopPrimaryObserver();

    // Pause current video
    if (currentIndex >= 0 && queue[currentIndex]) {
      queue[currentIndex].el.pause();
    }

    // [F1] Restore ALL harvested videos back to their original tweet positions
    for (const entry of queue) {
      releaseVideo(entry);
    }
    queue        = [];
    currentIndex = -1;

    // Hide overlay
    if (overlay) {
      overlay.style.display = 'none';
      // Clear container
      while (container.firstChild) container.removeChild(container.firstChild);
    }

    // Remove scroll listener
    document.removeEventListener('scroll', scheduleScrollBackReplay);
  }

  // ─── Bootstrap ────────────────────────────────────────────────────────────
  function init() {
    console.log('[XTK v5 init]', {
      version:  'v5',
      shortcut: 'V key',
      fixes:    ['F1-no-clone', 'F2-css-layout', 'F3-prewarm', 'F4-harvest-interval', 'F5-scroll-debounce', 'F6-observer-threshold'],
    });
    document.addEventListener('keydown', onKeyDown);
    buildOverlay(); // build DOM early so it's ready
    overlay.style.display = 'none'; // hidden until V pressed
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
