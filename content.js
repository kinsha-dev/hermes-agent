// XTK v6 - X.com TikTok-style video feed
// Fix: page helper stores stream without tracks check
// Fix: activate() plays source videos to prime captureStream
// Fix: tweet-ID dedup prevents repeats
// All double-quoted strings, no unicode, no template literals
(function () {
  "use strict";
  var HARVEST_MS = 200;
  var PREWARM_MS = 500;
  var LOAD_MORE_DELAY = 1000;

  if (!window.__xtkSeenIds) window.__xtkSeenIds = new Set();
  if (!window.__xtkQueue)   window.__xtkQueue   = [];
  if (!window.__xtkIdx)     window.__xtkIdx     = 0;
  if (!window.__xtkActive)  window.__xtkActive  = false;

  var seenIds = window.__xtkSeenIds;
  var queue   = window.__xtkQueue;
  var idx     = window.__xtkIdx;
  var active  = window.__xtkActive;

  function syncState() {
    window.__xtkIdx = idx;
    window.__xtkActive = active;
  }

  // Injected into PAGE context so captureStream() bypasses isolated-world restrictions.
  // Stores MediaStream on vid.__xtkStream (expando props cross isolated-world boundary).
  // NO getTracks() check - store stream immediately, even if inactive (0 tracks).
  function injectPageHelper() {
    if (document.getElementById("__xtkPageHelper")) return;
    var s = document.createElement("script");
    s.id = "__xtkPageHelper";
    s.textContent = [
      "(function(){",
      "  if(window.__xtkPH) return; window.__xtkPH=true;",
      "  function tryCapture(v){",
      "    if(v.__xtkStream||v.__xtkNoCapture) return;",
      "    if(!v.currentSrc&&!v.srcObject) return;",
      "    try{ v.__xtkStream=v.captureStream(); }",
      "    catch(e){ v.__xtkNoCapture=true; }",
      "  }",
      "  setInterval(function(){ document.querySelectorAll('video').forEach(tryCapture); },100);",
      "  document.addEventListener('play',function(e){ if(e.target&&e.target.tagName==='VIDEO') tryCapture(e.target); },true);",
      "  document.addEventListener('loadedmetadata',function(e){ if(e.target&&e.target.tagName==='VIDEO') tryCapture(e.target); },true);",
      "})();"
    ].join("\n");
    (document.head||document.documentElement).appendChild(s);
  }

  function buildOverlay() {
    if (document.getElementById("xtk-overlay")) return;
    var ov = document.createElement("div");
    ov.id = "xtk-overlay";
    ov.style.display = "none"; ov.style.position = "fixed";
    ov.style.top = "0"; ov.style.left = "0";
    ov.style.right = "0"; ov.style.bottom = "0";
    ov.style.background = "#000"; ov.style.zIndex = "999999";
    ov.style.fontFamily = "system-ui,sans-serif"; ov.style.color = "#fff";

    var top = document.createElement("div"); top.id = "xtk-top";
    top.style.cssText = "position:absolute;top:0;left:0;right:0;height:44px;display:flex;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.7);z-index:1;padding:0 16px;";
    var lbl = document.createElement("span"); lbl.textContent = "Videos"; lbl.style.cssText = "font-size:15px;font-weight:600;"; top.appendChild(lbl);
    var ctr = document.createElement("span"); ctr.id = "xtk-counter"; ctr.style.cssText = "font-size:13px;opacity:.6;"; top.appendChild(ctr);
    var sp = document.createElement("span"); sp.style.flex="1"; top.appendChild(sp);
    var esc = document.createElement("span"); esc.textContent = "Esc to exit"; esc.style.cssText = "font-size:12px;opacity:.4;"; top.appendChild(esc);
    ov.appendChild(top);

    var vc = document.createElement("div"); vc.id = "xtk-vc";
    vc.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;";
    ov.appendChild(vc);

    var ld = document.createElement("div"); ld.id = "xtk-loading"; ld.textContent = "Loading...";
    ld.style.cssText = "display:none;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:14px;opacity:.6;";
    ov.appendChild(ld);

    var nav = document.createElement("div"); nav.id = "xtk-nav";
    nav.style.cssText = "position:absolute;right:16px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:10px;";
    var pb = document.createElement("button"); pb.id = "xtk-prev"; pb.textContent = "PREV";
    pb.style.cssText = "width:52px;height:52px;border-radius:50%;border:none;background:rgba(255,255,255,.18);color:#fff;font-size:11px;font-weight:600;cursor:pointer;";
    pb.onclick = function(){ navigate(-1); }; nav.appendChild(pb);
    var nb = document.createElement("button"); nb.id = "xtk-next"; nb.textContent = "NEXT";
    nb.style.cssText = "width:52px;height:52px;border-radius:50%;border:none;background:rgba(255,255,255,.18);color:#fff;font-size:11px;font-weight:600;cursor:pointer;";
    nb.onclick = function(){ navigate(+1); }; nav.appendChild(nb);
    ov.appendChild(nav);

    var bot = document.createElement("div"); bot.id = "xtk-bot";
    bot.style.cssText = "position:absolute;bottom:0;left:0;right:0;padding:16px 16px 24px;background:linear-gradient(transparent,rgba(0,0,0,.75));";
    var ae = document.createElement("div"); ae.id = "xtk-author"; ae.style.cssText = "font-weight:700;font-size:15px;margin-bottom:4px;"; bot.appendChild(ae);
    var ce = document.createElement("div"); ce.id = "xtk-caption"; ce.style.cssText = "font-size:14px;opacity:.85;max-height:56px;overflow:hidden;line-height:1.4;"; bot.appendChild(ce);
    ov.appendChild(bot);

    document.body.appendChild(ov);
  }

  function getTweetId(article) {
    var t = article ? article.querySelector("time") : null;
    var a = t ? t.closest("a") : null;
    var m = a && a.href ? a.href.match(/status\/(\d+)/) : null;
    return m ? m[1] : null;
  }

  // Primes a source video: mutes it, plays it, waits for stream to become active.
  // Returns a Promise<MediaStream|null>.
  function primeVideo(vid) {
    return new Promise(function(resolve) {
      if (!vid) return resolve(null);
      // Already has active stream? Use it.
      if (vid.__xtkStream && vid.__xtkStream.getTracks().length > 0) {
        return resolve(vid.__xtkStream);
      }
      var wasMuted = vid.muted;
      vid.muted = true;
      var timeout = setTimeout(function() {
        vid.muted = wasMuted;
        // Return whatever stream we have even if 0 tracks
        resolve(vid.__xtkStream || null);
      }, 1200);
      vid.play().then(function() {
        // Wait for page helper to capture (up to 300ms)
        var checks = 0;
        var interval = setInterval(function() {
          checks++;
          if ((vid.__xtkStream && vid.__xtkStream.getTracks().length > 0) || checks > 15) {
            clearInterval(interval);
            clearTimeout(timeout);
            vid.muted = wasMuted;
            resolve(vid.__xtkStream || null);
          }
        }, 20);
      }).catch(function() {
        clearTimeout(timeout);
        vid.muted = wasMuted;
        resolve(vid.__xtkStream || null);
      });
    });
  }

  function harvest() {
    var arts = document.querySelectorAll("article");
    var added = 0;
    for (var i = 0; i < arts.length; i++) {
      var art = arts[i];
      var tid = getTweetId(art);
      if (!tid || seenIds.has(tid)) continue;
      var vp = art.querySelector("[data-testid=\"videoPlayer\"]");
      var vid = vp ? vp.querySelector("video") : art.querySelector("video");
      if (!vid) continue;
      // Accept stream even with 0 tracks - will prime on showVideo
      if (!vid.__xtkStream && !vid.currentSrc) continue;
      seenIds.add(tid);
      queue.push({ tweetId: tid, vid: vid, article: art });
      added++;
    }
    if (added > 0) { log("harvest +"+added+" total="+queue.length); updateCounter(); }
  }

  var mirrorVid = null;
  function getMirror() {
    if (mirrorVid && mirrorVid.parentNode) return mirrorVid;
    var vc = document.getElementById("xtk-vc"); if (!vc) return null;
    mirrorVid = document.createElement("video");
    mirrorVid.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;background:#000;";
    mirrorVid.muted = false; mirrorVid.playsInline = true; mirrorVid.autoplay = false;
    vc.appendChild(mirrorVid); return mirrorVid;
  }

  var progScroll = false;

  function showVideo(i) {
    if (i < 0 || i >= queue.length) return;
    var entry = queue[i];
    log("showVideo #"+i+" tweetId="+entry.tweetId);
    var ld = document.getElementById("xtk-loading");
    if (ld) ld.style.display = "block";
    var m = getMirror(); if (!m) return;
    m.pause(); m.srcObject = null;

    // Prime the source video to get a live stream, then mirror it
    primeVideo(entry.vid).then(function(stream) {
      if (!stream) {
        log("showVideo #"+i+" no stream after prime");
        if (ld) ld.style.display = "none";
        return;
      }
      m.srcObject = stream; m.muted = false;
      var done = false; var timer = null;
      function onReady() {
        if (done) return; done = true; clearTimeout(timer);
        if (ld) ld.style.display = "none";
        m.play().catch(function(e){ log("play err: "+e.message); });
        var ae = document.getElementById("xtk-author");
        var ce = document.getElementById("xtk-caption");
        if (ae) { var ne = entry.article ? entry.article.querySelector("[data-testid=\"User-Name\"] span") : null; ae.textContent = ne ? ne.textContent : ""; }
        if (ce) { var te = entry.article ? entry.article.querySelector("[data-testid=\"tweetText\"]") : null; ce.textContent = te ? te.textContent.slice(0,140) : ""; }
        updateCounter();
        if (i >= queue.length - 3) loadMore();
      }
      m.addEventListener("canplay", onReady, {once:true});
      m.addEventListener("loadeddata", onReady, {once:true});
      timer = setTimeout(onReady, PREWARM_MS);
      m.load();
    });
  }

  function navigate(d) {
    var n = idx + d;
    if (n < 0 || n >= queue.length) return;
    idx = n; syncState(); showVideo(idx);
  }

  function loadMore() {
    var btns = document.querySelectorAll("[role=\"button\"]");
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent && btns[i].textContent.trim() === "Show more") {
        progScroll = true;
        btns[i].scrollIntoView({behavior:"instant",block:"center"});
        btns[i].click(); log("loadMore clicked");
        setTimeout(function(){ progScroll=false; harvest(); }, LOAD_MORE_DELAY);
        return;
      }
    }
    log("loadMore: no Show more button");
  }

  function activate() {
    if (active) return; active=true; syncState();
    buildOverlay(); injectPageHelper();
    var ov = document.getElementById("xtk-overlay");
    if (ov) ov.style.display = "block";
    // Harvest existing, then show first
    setTimeout(function() {
      harvest();
      if (queue.length > 0) { idx=0; syncState(); showVideo(0); }
      else { log("no videos on activate - waiting for harvest interval"); }
    }, 250);
    if (window.__xtkHarvestTimer) clearInterval(window.__xtkHarvestTimer);
    window.__xtkHarvestTimer = setInterval(function() {
      harvest();
      // Auto-show first video once queue has items and nothing is playing yet
      if (active && queue.length > 0 && idx === 0) {
        var m = getMirror();
        if (m && !m.srcObject) { showVideo(0); }
      }
    }, HARVEST_MS);
    log("activated");
  }

  function deactivate() {
    if (!active) return; active=false; syncState();
    if (window.__xtkHarvestTimer) { clearInterval(window.__xtkHarvestTimer); window.__xtkHarvestTimer=null; }
    var ov = document.getElementById("xtk-overlay"); if (ov) ov.style.display="none";
    if (mirrorVid) { mirrorVid.pause(); mirrorVid.srcObject=null; }
    log("deactivated");
  }

  document.addEventListener("keydown", function(e) {
    if (e.target && e.target.matches("input,textarea,[contenteditable]")) return;
    if (e.key==="v"||e.key==="V") { e.preventDefault(); active ? deactivate() : activate(); return; }
    if (!active) return;
    if (e.key==="ArrowDown"||e.key==="j") { e.preventDefault(); navigate(+1); }
    if (e.key==="ArrowUp"||e.key==="k")   { e.preventDefault(); navigate(-1); }
    if (e.key==="Escape") { e.preventDefault(); deactivate(); }
    if (e.key==="m"||e.key==="M") { var mv=getMirror(); if(mv){ mv.muted=!mv.muted; log("muted="+mv.muted); } }
  });

  window.addEventListener("scroll", function(){ if(!progScroll&&active) harvest(); }, {passive:true});

  function updateCounter() {
    var el = document.getElementById("xtk-counter");
    if (el) el.textContent = queue.length ? " "+( idx+1)+" / "+queue.length : "";
  }
  function log() {
    var a = Array.prototype.slice.call(arguments);
    a.unshift("[XTK v6]"); console.log.apply(console,a);
  }

  log("init seenIds="+seenIds.size+" queue="+queue.length);
  injectPageHelper();
})();