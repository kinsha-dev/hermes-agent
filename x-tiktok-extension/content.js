// XTK v8 - X.com TikTok-style video feed
// Fix: re-capture stream at show-time (stale captureStream tracks fixed)
// Fix: readyState >= 2 threshold for harvest (was >= 4, too strict)
// Fix: mirror starts muted, unmutes after play (autoplay policy fix)
// Fix: robust onReady with timeupdate + playing fallback listeners
// Fix: showBusy always released on timeout path
// No template literals, no unicode, all double-quoted strings

(function () {
  "use strict";

  var HARVEST_MS       = 300;
  var PREWARM_MS       = 800;
  var LOAD_MORE_DELAY  = 1200;
  var READY_TIMEOUT_MS = 2000;

  if (!window.__xtkSeenIds) window.__xtkSeenIds = new Set();
  if (!window.__xtkQueue)   window.__xtkQueue   = [];
  if (!window.__xtkIdx)     window.__xtkIdx     = 0;
  if (!window.__xtkActive)  window.__xtkActive  = false;

  var seenIds = window.__xtkSeenIds;
  var queue   = window.__xtkQueue;
  var idx     = window.__xtkIdx;
  var active  = window.__xtkActive;

  function syncState() {
    window.__xtkIdx    = idx;
    window.__xtkActive = active;
  }

  // Injected into PAGE context so captureStream() bypasses isolated-world restriction.
  // Uses readyState >= 2 (HAVE_CURRENT_DATA) — sufficient for a live stream.
  // Stores the SOURCE video element itself (__xtkSourceVid) so we can re-capture fresh.
  function injectPageHelper() {
    if (document.getElementById("__xtkPageHelper")) return;
    var s = document.createElement("script");
    s.id = "__xtkPageHelper";
    s.textContent = [
      "(function(){",
      "  if(window.__xtkPH) return; window.__xtkPH=true;",
      "  function tryCapture(v){",
      "    if(v.__xtkNoCapture) return;",
      "    if(v.readyState<2) return;",
      "    try{",
      "      v.__xtkStream=v.captureStream();",
      "      v.__xtkSourceVid=v;",
      "    } catch(e){ v.__xtkNoCapture=true; }",
      "  }",
      "  function scanAll(){",
      "    document.querySelectorAll('video').forEach(tryCapture);",
      "  }",
      "  setInterval(scanAll,100);",
      "  ['canplay','canplaythrough','playing','loadeddata'].forEach(function(ev){",
      "    document.addEventListener(ev,function(e){",
      "      if(e.target&&e.target.tagName==='VIDEO') tryCapture(e.target);",
      "    },true);",
      "  });",
      "})();"
    ].join("\n");
    (document.head || document.documentElement).appendChild(s);
  }

  function buildOverlay() {
    if (document.getElementById("xtk-overlay")) return;

    var ov = document.createElement("div");
    ov.id = "xtk-overlay";
    ov.style.cssText = "display:none;position:fixed;top:0;left:0;right:0;bottom:0;" +
      "background:#000;z-index:999999;font-family:system-ui,sans-serif;color:#fff;";

    var top = document.createElement("div");
    top.id = "xtk-top";
    top.style.cssText = "position:absolute;top:0;left:0;right:0;height:44px;" +
      "display:flex;align-items:center;padding:0 16px;gap:12px;" +
      "background:rgba(0,0,0,.7);z-index:1;";

    var lbl = document.createElement("span");
    lbl.textContent = "Videos";
    lbl.style.cssText = "font-size:15px;font-weight:600;";

    var ctr = document.createElement("span");
    ctr.id = "xtk-counter";
    ctr.style.cssText = "font-size:13px;opacity:.55;";

    var sp = document.createElement("span");
    sp.style.flex = "1";

    var esc = document.createElement("span");
    esc.textContent = "Esc=exit  J/K=nav  M=mute";
    esc.style.cssText = "font-size:11px;opacity:.4;";

    top.appendChild(lbl);
    top.appendChild(ctr);
    top.appendChild(sp);
    top.appendChild(esc);
    ov.appendChild(top);

    var vc = document.createElement("div");
    vc.id = "xtk-vc";
    vc.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;";
    ov.appendChild(vc);

    var ld = document.createElement("div");
    ld.id = "xtk-loading";
    ld.textContent = "Loading...";
    ld.style.cssText = "display:none;position:absolute;top:50%;left:50%;" +
      "transform:translate(-50%,-50%);font-size:14px;opacity:.6;z-index:2;";
    ov.appendChild(ld);

    var nav = document.createElement("div");
    nav.style.cssText = "position:absolute;right:16px;top:50%;transform:translateY(-50%);" +
      "display:flex;flex-direction:column;gap:10px;z-index:2;";

    var pb = document.createElement("button");
    pb.textContent = "PREV";
    pb.style.cssText = "width:52px;height:52px;border-radius:50%;border:none;" +
      "background:rgba(255,255,255,.18);color:#fff;font-size:11px;font-weight:600;cursor:pointer;";
    pb.onclick = function () { navigate(-1); };

    var nb = document.createElement("button");
    nb.textContent = "NEXT";
    nb.style.cssText = "width:52px;height:52px;border-radius:50%;border:none;" +
      "background:rgba(255,255,255,.18);color:#fff;font-size:11px;font-weight:600;cursor:pointer;";
    nb.onclick = function () { navigate(+1); };

    nav.appendChild(pb);
    nav.appendChild(nb);
    ov.appendChild(nav);

    var bot = document.createElement("div");
    bot.style.cssText = "position:absolute;bottom:0;left:0;right:0;" +
      "padding:16px 16px 24px;background:linear-gradient(transparent,rgba(0,0,0,.8));z-index:2;";

    var ae = document.createElement("div");
    ae.id = "xtk-author";
    ae.style.cssText = "font-weight:700;font-size:15px;margin-bottom:4px;";

    var ce = document.createElement("div");
    ce.id = "xtk-caption";
    ce.style.cssText = "font-size:13px;opacity:.85;max-height:52px;overflow:hidden;line-height:1.4;";

    bot.appendChild(ae);
    bot.appendChild(ce);
    ov.appendChild(bot);

    document.body.appendChild(ov);
  }

  function getTweetId(article) {
    var t = article ? article.querySelector("time") : null;
    var a = t ? t.closest("a[href]") : null;
    var m = a ? a.href.match(/\/status\/(\d+)/) : null;
    return m ? m[1] : null;
  }

  // Prime DOM videos during a user-gesture window so play() is allowed.
  // Only attempts play if readyState < 2 to avoid fighting X's own player.
  function primeAllVideos(callback) {
    var vids = [].slice.call(document.querySelectorAll("video"));
    if (vids.length === 0) { setTimeout(callback, 0); return; }

    var remaining = vids.length;
    var done = false;

    function finish() {
      remaining--;
      if (!done && remaining <= 0) { done = true; callback(); }
    }

    setTimeout(function () {
      if (!done) { done = true; callback(); }
    }, 1000);

    vids.forEach(function (v) {
      if (v.readyState >= 2) { finish(); return; }
      var wasMuted = v.muted;
      v.muted = true;
      var p = v.play();
      if (p && typeof p.then === "function") {
        p.then(function () {
          // Pause immediately — we only needed the gesture-unlock
          v.pause();
          v.muted = wasMuted;
          finish();
        }).catch(function () {
          v.muted = wasMuted;
          finish();
        });
      } else {
        v.muted = wasMuted;
        finish();
      }
    });
  }

  // Re-capture a fresh stream from the source video at show-time.
  // This prevents stale/ended track issues when X recycles video elements.
  function getFreshStream(entry) {
    var srcVid = entry.vid;
    if (!srcVid || srcVid.__xtkNoCapture) return entry.stream;
    // If source video has been recycled / src changed, readyState may have dropped
    if (srcVid.readyState < 2) {
      log("getFreshStream: srcVid readyState=" + srcVid.readyState + ", using cached stream");
      return entry.stream;
    }
    try {
      var fresh = srcVid.captureStream();
      entry.stream = fresh;
      log("getFreshStream: re-captured ok tracks=" + fresh.getTracks().length);
      return fresh;
    } catch (e) {
      log("getFreshStream: captureStream failed, using cached");
      return entry.stream;
    }
  }

  function harvest() {
    var arts = document.querySelectorAll("article");
    var added = 0;
    for (var i = 0; i < arts.length; i++) {
      var art = arts[i];
      var tid = getTweetId(art);
      if (!tid || seenIds.has(tid)) continue;

      var vp  = art.querySelector("[data-testid=\"videoPlayer\"]");
      var vid = vp ? vp.querySelector("video") : art.querySelector("video");
      // readyState >= 2 is sufficient (page helper already lowered the bar)
      if (!vid || !vid.__xtkStream) continue;
      if (vid.readyState < 2) continue;

      var tracks = vid.__xtkStream.getTracks();
      if (tracks.length === 0) continue;

      seenIds.add(tid);
      queue.push({ tweetId: tid, stream: vid.__xtkStream, vid: vid, article: art });
      added++;
    }
    if (added > 0) {
      log("harvest +" + added + " total=" + queue.length);
      updateCounter();
    }
  }

  var mirrorVid = null;

  function getMirror() {
    if (mirrorVid && mirrorVid.parentNode) return mirrorVid;
    var vc = document.getElementById("xtk-vc");
    if (!vc) return null;
    mirrorVid = document.createElement("video");
    mirrorVid.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;" +
      "object-fit:contain;background:#000;";
    mirrorVid.muted      = true;   // must start muted for autoplay policy
    mirrorVid.playsInline = true;
    mirrorVid.autoplay   = false;
    vc.appendChild(mirrorVid);
    return mirrorVid;
  }

  var progScroll = false;
  var showBusy   = false;

  function showVideo(i) {
    if (showBusy) { log("showVideo busy, skipping #" + i); return; }
    if (i < 0 || i >= queue.length) return;

    showBusy = true;
    var entry = queue[i];
    log("showVideo #" + i + " tweetId=" + entry.tweetId);

    var ld = document.getElementById("xtk-loading");
    if (ld) ld.style.display = "block";

    var m = getMirror();
    if (!m) { showBusy = false; return; }

    // Fully reset mirror
    m.pause();
    m.removeAttribute("src");
    m.srcObject = null;

    // Get a fresh stream to avoid stale tracks
    var stream = getFreshStream(entry);
    m.srcObject = stream;
    m.muted = true; // keep muted until play() resolves (autoplay policy)

    var done  = false;
    var timer = null;

    // Clean up all the one-time listeners and fire callback once
    function onReady() {
      if (done) return;
      done = true;
      clearTimeout(timer);

      m.removeEventListener("canplay",    onReady);
      m.removeEventListener("loadeddata", onReady);
      m.removeEventListener("timeupdate", onReady);
      m.removeEventListener("playing",    onReady);

      showBusy = false;
      if (ld) ld.style.display = "none";

      m.play().then(function () {
        m.muted = false; // unmute after play succeeds
        log("playing, unmuted");
      }).catch(function (e) {
        log("play err:" + e.message);
        // If autoplay blocked, at least leave it muted/paused visible
      });

      // Update metadata
      var ae = document.getElementById("xtk-author");
      var ce = document.getElementById("xtk-caption");
      if (ae) {
        var ne = entry.article
          ? entry.article.querySelector("[data-testid=\"User-Name\"] span")
          : null;
        ae.textContent = ne ? ne.textContent : "";
      }
      if (ce) {
        var te = entry.article
          ? entry.article.querySelector("[data-testid=\"tweetText\"]")
          : null;
        ce.textContent = te ? te.textContent.slice(0, 140) : "";
      }

      updateCounter();
      if (i >= queue.length - 3) loadMore();
    }

    m.addEventListener("canplay",    onReady, { once: true });
    m.addEventListener("loadeddata", onReady, { once: true });
    m.addEventListener("timeupdate", onReady, { once: true });
    m.addEventListener("playing",    onReady, { once: true });

    // Fallback: if no event fires in READY_TIMEOUT_MS, release the busy lock
    // and try to play anyway — stream may still work even without an event
    timer = setTimeout(function () {
      if (!done) {
        log("showVideo timeout for #" + i + ", forcing onReady");
        onReady();
      }
    }, READY_TIMEOUT_MS);

    m.load();
  }

  function navigate(d) {
    if (showBusy) return;
    var n = idx + d;
    if (n < 0 || n >= queue.length) {
      log("navigate: reached end (" + queue.length + " total)");
      return;
    }
    idx = n;
    syncState();
    showVideo(idx);
  }

  function loadMore() {
    var btns = document.querySelectorAll("[role=\"button\"]");
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent && btns[i].textContent.trim() === "Show more") {
        progScroll = true;
        btns[i].scrollIntoView({ behavior: "instant", block: "center" });
        btns[i].click();
        log("loadMore: clicked Show more");
        setTimeout(function () {
          progScroll = false;
          primeAndHarvest();
        }, LOAD_MORE_DELAY);
        return;
      }
    }
    log("loadMore: no Show more button found");
  }

  function primeAndHarvest() {
    primeAllVideos(function () {
      setTimeout(harvest, 150);
    });
  }

  function activate() {
    if (active) return;
    active = true;
    syncState();
    buildOverlay();
    injectPageHelper();

    var ov = document.getElementById("xtk-overlay");
    if (ov) ov.style.display = "block";

    log("activated - priming videos...");

    primeAllVideos(function () {
      setTimeout(function () {
        harvest();
        if (queue.length > 0) {
          idx = 0;
          syncState();
          showVideo(0);
        } else {
          log("no streams ready yet - harvest interval will pick them up");
        }
      }, 200);
    });

    if (window.__xtkHarvestTimer) clearInterval(window.__xtkHarvestTimer);
    window.__xtkHarvestTimer = setInterval(harvest, HARVEST_MS);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    syncState();

    if (window.__xtkHarvestTimer) {
      clearInterval(window.__xtkHarvestTimer);
      window.__xtkHarvestTimer = null;
    }

    var ov = document.getElementById("xtk-overlay");
    if (ov) ov.style.display = "none";

    if (mirrorVid) {
      mirrorVid.pause();
      mirrorVid.srcObject = null;
    }

    showBusy = false;
    log("deactivated");
  }

  document.addEventListener("keydown", function (e) {
    if (e.target && e.target.matches("input,textarea,[contenteditable]")) return;

    if (e.key === "v" || e.key === "V") {
      e.preventDefault();
      active ? deactivate() : activate();
      return;
    }

    if (!active) return;

    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); navigate(+1); }
    if (e.key === "ArrowUp"   || e.key === "k") { e.preventDefault(); navigate(-1); }
    if (e.key === "Escape")                      { e.preventDefault(); deactivate(); }

    if (e.key === "m" || e.key === "M") {
      var mv = getMirror();
      if (mv) { mv.muted = !mv.muted; log("muted=" + mv.muted); }
    }
  });

  window.addEventListener("scroll", function () {
    if (!progScroll && active) primeAndHarvest();
  }, { passive: true });

  function updateCounter() {
    var el = document.getElementById("xtk-counter");
    if (el) el.textContent = queue.length ? " " + (idx + 1) + " / " + queue.length : "";
  }

  function log() {
    var a = Array.prototype.slice.call(arguments);
    a.unshift("[XTK v8]");
    console.log.apply(console, a);
  }

  log("init seenIds=" + seenIds.size + " queue=" + queue.length);
  injectPageHelper();

})();