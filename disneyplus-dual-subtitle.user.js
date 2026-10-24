// ==UserScript==
// @name         Disney+ 增強（音量＋雙字幕＋字幕放大）
// @namespace    https://github.com/charles0506/disneyplus-dual-subtitle
// @version      1.3.1
// @description  Disney+ 音量放大（壓縮器防爆音）、字幕放大、中英雙字幕（中文上排、英文下排）、顯示目前畫質
// @homepageURL  https://github.com/charles0506/disneyplus-dual-subtitle
// @supportURL   https://github.com/charles0506/disneyplus-dual-subtitle/issues
// @updateURL    https://raw.githubusercontent.com/charles0506/disneyplus-dual-subtitle/main/disneyplus-dual-subtitle.user.js
// @downloadURL  https://raw.githubusercontent.com/charles0506/disneyplus-dual-subtitle/main/disneyplus-dual-subtitle.user.js
// @match        https://www.disneyplus.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// 兩個獨立區塊：上半音量增強、下半雙字幕＋字幕放大（各自一個閉包，互不共用變數）

(function () {
  'use strict';

  // 做法：<video> → GainNode（放大）→ DynamicsCompressor（壓住大聲處，避免破音）→ 喇叭。
  // Disney+ 的 <video> 可能藏在 shadow DOM 裡，所以除了掃 DOM 也攔 play() 抓元素。
  //
  // 保險：createMediaElementSource 一接上就拔不掉。若瀏覽器對 DRM 影片的 Web Audio
  // 只輸出靜音，影片會變無聲。偵測到「正在播放卻連續全零」就記下停用並重新整理。

  const KEY_GAIN = 'dpvb-gain';
  const KEY_OFF = 'dpvb-disabled';
  const STEP = 0.25, MIN = 1, MAX = 6, DEF = 2.5;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  let gainVal = parseFloat(store.get(KEY_GAIN));
  if (!(gainVal >= MIN && gainVal <= MAX)) gainVal = DEF;
  let enabled = true;
  const disabled = store.get(KEY_OFF) === '1';

  let ctx = null;
  const chains = new WeakMap(); // video -> {gain, comp, analyser}
  const all = new Set();

  function applyAll() {
    for (const c of all) {
      const g = enabled ? gainVal : 1;
      c.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.05);
      c.comp.ratio.setTargetAtTime(enabled ? 12 : 1, ctx.currentTime, 0.05);
    }
  }

  function hook(video) {
    if (disabled || chains.has(video)) return;
    try {
      ctx = ctx || new AudioContext();
      const src = ctx.createMediaElementSource(video);
      const gain = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 10;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(gain).connect(comp).connect(ctx.destination);
      src.connect(analyser);
      const c = { gain, comp, analyser };
      chains.set(video, c);
      all.add(c);
      applyAll();
      watchSilence(video, c);
      video.addEventListener('play', () => ctx.state === 'suspended' && ctx.resume());
      if (!video.paused) ctx.resume();
    } catch (e) {
      console.warn('[Disney+ 音量增強] 接不上', e);
    }
  }

  function watchSilence(video, c) {
    const buf = new Float32Array(c.analyser.fftSize);
    let silentSince = 0, lastT = -1;
    const timer = setInterval(() => {
      const playing = !video.paused && !video.muted && video.volume > 0 &&
        video.currentTime !== lastT && ctx.state === 'running';
      lastT = video.currentTime;
      if (!playing) { silentSince = 0; return; }
      c.analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      if (peak > 0) { clearInterval(timer); return; } // 有聲音，確認可用
      silentSince = silentSince || Date.now();
      if (Date.now() - silentSince > 8000) {
        clearInterval(timer);
        store.set(KEY_OFF, '1');
        toast('此瀏覽器對 Disney+ 影片輸出靜音，音量增強已停用，重新整理中…', 3000);
        setTimeout(() => location.reload(), 3000);
      }
    }, 500);
  }

  // 攔 play()：shadow DOM 裡的 video 也抓得到
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (this instanceof HTMLVideoElement) hook(this);
    return origPlay.apply(this, arguments);
  };
  new MutationObserver(() => document.querySelectorAll('video').forEach(hook))
    .observe(document, { childList: true, subtree: true });

  // ---- 介面：右上角小膠囊，滑鼠動才出現；點一下開關、滾輪調整 ----
  let pill, hideTimer, toastTimer;
  function ensurePill() {
    if (!document.body) return null;
    if (pill) {
      const parent = document.fullscreenElement || document.body; // 全螢幕時要掛進全螢幕元素才看得到
      if (pill.parentNode !== parent) parent.appendChild(pill);
      return pill;
    }
    pill = document.createElement('div');
    pill.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;' +
      'padding:6px 12px;border-radius:16px;background:rgba(0,0,0,.65);color:#fff;' +
      'font:14px/1.2 system-ui,sans-serif;cursor:pointer;user-select:none;opacity:0;' +
      'transition:opacity .2s;max-width:60vw';
    pill.title = '點一下：開/關　滾輪：調整　Alt+↑↓：調整　Alt+0：開/關';
    pill.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    pill.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      adjust(e.deltaY < 0 ? STEP : -STEP);
    }, { passive: false });
    pill.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    pill.addEventListener('mouseleave', () => show());
    (document.fullscreenElement || document.body).appendChild(pill);
    return pill;
  }

  function label() {
    if (disabled) return '🔈 音量增強已停用（此瀏覽器不支援）— 點此重新啟用';
    return enabled ? `🔊 ${Math.round(gainVal * 100)}%` : '🔈 原音量';
  }

  function show(ms = 2000) {
    if (toastTimer || (!all.size && !disabled) || !ensurePill()) return; // 沒在播影片就不打擾
    pill.textContent = label();
    pill.style.opacity = '1';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { pill.style.opacity = '0'; }, ms);
  }

  function toast(msg, ms) {
    if (!ensurePill()) return;
    pill.textContent = msg;
    pill.style.opacity = '1';
    clearTimeout(hideTimer);
    toastTimer = setTimeout(() => { toastTimer = null; pill.style.opacity = '0'; }, ms);
  }

  function toggle() {
    if (disabled) { store.del(KEY_OFF); location.reload(); return; }
    enabled = !enabled;
    if (ctx) applyAll();
    show();
  }

  function adjust(d) {
    if (disabled) return;
    enabled = true;
    gainVal = Math.min(MAX, Math.max(MIN, Math.round((gainVal + d) / STEP) * STEP));
    store.set(KEY_GAIN, String(gainVal));
    if (ctx) applyAll();
    show();
  }

  document.addEventListener('mousemove', () => show(), { passive: true });
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowUp') adjust(STEP);
    else if (e.key === 'ArrowDown') adjust(-STEP);
    else if (e.key === '0') toggle();
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
})();


(function () {
  'use strict';

  // Disney+ 字幕是 HLS 裡未加密的 WebVTT 分段（*.vtt，CORS 允許 disneyplus.com）。
  // 1. PerformanceObserver 側錄頁面載入的 .m3u8 / .vtt 網址
  // 2. 自己重抓 m3u8，含 #EXT-X-MEDIA:TYPE=SUBTITLES 的就是主清單，列出各語言字幕
  // 3. 頁面正在載的 .vtt 屬於哪一軌 = 目前顯示的語言；另一語言整軌抓下來
  // 4. 依 video.currentTime（加上用原字幕文字比對算出的時間差）找出第二語言當下那句
  // 原字幕畫在 .hive-subtitle-renderer-cue-window：藏起來但照讀文字，和第二語言一起自己畫成兩行。

  const KEY_SCALE = 'dpds-scale2', KEY_ON = 'dpds-on', KEY_LANG = 'dpds-lang';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  let scale = parseFloat(store.get(KEY_SCALE));
  if (!(scale >= 0.5 && scale <= 3)) scale = 1; // 1.2.0 起改成自畫字幕的倍率，換 key 重設
  let dualOn = store.get(KEY_ON) !== '0';
  let prefLang = store.get(KEY_LANG) || '';

  const ours = new Set();          // 自己抓的網址，側錄時略過
  const seenM3u8 = new Set();
  const pageVtt = new Set();       // 頁面自己載的 vtt（用 key 比對）
  let tracks = [];                 // {lang, name, url, segKeys:Set, segUrls:[]}
  let primary = null, secondary = null;
  let primaryCues = [], secondaryCues = [];
  let offset = 0;
  const offsetSamples = [];
  let variants = [];               // 主清單的畫質檔位 {w, h, bw}

  const segKey = (u) => {
    try { return new URL(u).pathname.split('/').slice(-2).join('/'); } catch (e) { return u; }
  };

  async function getText(url) {
    ours.add(url);
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error(r.status + ' ' + url);
    return r.text();
  }

  // ---- HLS ----
  const attrs = (s) => {
    const o = {};
    s.replace(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g, (_, k, v, q) => { o[k] = q !== undefined ? q : v; });
    return o;
  };

  async function onM3u8(url, text) {
    if (seenM3u8.has(url)) return;
    seenM3u8.add(url);
    if (text === undefined) {
      try { text = await getText(url); } catch (e) { return; }
    }
    if (!/#EXT-X-MEDIA:.*TYPE=SUBTITLES/.test(text)) return;
    const list = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('#EXT-X-MEDIA:')) continue;
      const a = attrs(line.slice(13));
      if (a.TYPE !== 'SUBTITLES' || !a.URI || a.FORCED === 'YES') continue;
      if (list.some((t) => t.lang === a.LANGUAGE)) continue;
      list.push({ lang: a.LANGUAGE || '', name: a.NAME || a.LANGUAGE, url: new URL(a.URI, url).href });
    }
    // 畫質檔位（#EXT-X-STREAM-INF）：只拿來顯示，不改播放行為
    const lines = text.split(/\r?\n/);
    const vs = [];
    lines.forEach((line, i) => {
      if (!line.startsWith('#EXT-X-STREAM-INF:')) return;
      const a = attrs(line.slice(18));
      const m = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
      if (m) vs.push({ w: +m[1], h: +m[2], bw: +(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0 });
    });
    if (vs.length) variants = vs;
    if (!list.length) return;
    tracks = list;
    primary = secondary = null;
    primaryCues = secondaryCues = [];
    offset = 0; offsetSamples.length = 0;
    await Promise.all(tracks.map(async (t) => {
      try {
        const pl = await getText(t.url);
        t.segUrls = pl.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => new URL(l, t.url).href);
        t.segKeys = new Set(t.segUrls.map(segKey));
      } catch (e) { t.segUrls = []; t.segKeys = new Set(); }
    }));
    detectPrimary();
  }

  function detectPrimary() {
    if (!tracks.length || !pageVtt.size) return;
    const p = tracks.find((t) => t.segKeys && [...pageVtt].some((k) => t.segKeys.has(k)));
    if (!p || p === primary) return;
    primary = p;
    offset = 0; offsetSamples.length = 0;
    loadCues(p).then((c) => { if (primary === p) primaryCues = c; });
    pickSecondary();
  }

  function pickSecondary() {
    if (!primary) return;
    const others = tracks.filter((t) => t !== primary);
    const auto = /^zh/i.test(primary.lang) ? 'en' : 'zh-Hant';
    let want = prefLang || auto;
    let base = want.split('-')[0].toLowerCase();
    if (base === primary.lang.split('-')[0].toLowerCase()) { want = auto; base = want.split('-')[0].toLowerCase(); }
    const s = others.find((t) => t.lang.toLowerCase() === want.toLowerCase()) ||
      others.find((t) => t.lang.toLowerCase().split('-')[0] === base) || others[0];
    if (!s || s === secondary) return;
    secondary = s;
    secondaryCues = [];
    loadCues(s).then((c) => { if (secondary === s) secondaryCues = c; });
  }

  // ---- WebVTT ----
  const toSec = (s) => {
    const p = s.trim().split(':').map(parseFloat);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };

  function parseVtt(text) {
    const cues = [];
    for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const [a, b] = lines[i].split('-->');
      const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (body) cues.push({ start: toSec(a), end: toSec(b.trim().split(/\s+/)[0]), text: body });
    }
    return cues;
  }

  async function loadCues(t) {
    const out = [];
    const urls = t.segUrls.slice();
    const worker = async () => {
      while (urls.length) {
        const u = urls.shift();
        try { out.push(...parseVtt(await getText(u))); } catch (e) {}
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    out.sort((x, y) => x.start - y.start);
    return out;
  }

  // ---- 側錄網址 ----
  function onEntry(name) {
    if (ours.has(name)) return;
    if (/\.m3u8(\?|$)/.test(name)) onM3u8(name);
    else if (/\.vtt(\?|$)/.test(name)) {
      const k = segKey(name);
      if (!pageVtt.has(k)) { pageVtt.add(k); detectPrimary(); }
    }
  }
  try {
    new PerformanceObserver((list) => list.getEntries().forEach((e) => onEntry(e.name)))
      .observe({ type: 'resource', buffered: true });
  } catch (e) {}

  // 清單網址不一定以 .m3u8 結尾，也可能沒進 resource timing：再看 fetch / XHR 回應內容
  const isMaster = (t) => typeof t === 'string' && t.startsWith('#EXTM3U') && t.includes('TYPE=SUBTITLES');
  const origFetch = window.fetch;
  window.fetch = function (input) {
    const p = origFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input && input.url;
    if (url && !ours.has(url)) {
      p.then((r) => {
        const ct = r.headers.get('content-type') || '';
        if (/mpegurl|m3u8/i.test(ct + url)) r.clone().text().then((t) => isMaster(t) && onM3u8(r.url || url, t)).catch(() => {});
      }).catch(() => {});
    }
    return p;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.addEventListener('load', () => {
      try {
        if ((this.responseType === '' || this.responseType === 'text') && isMaster(this.responseText)) {
          onM3u8(this.responseURL || String(url), this.responseText);
        }
      } catch (e) {}
    });
    return origOpen.apply(this, arguments);
  };

  // ---- 找原字幕／影片（可能在 shadow DOM 裡） ----
  // 排版照自製 Netflix 雙字幕插件：原生字幕藏起來（仍讀它的文字），自己畫兩行，
  // 中文在上（粗、大）、英文在下（細、小），透明底黑描邊，貼近影片底部；暫停時隱藏。
  let cueRoot = null; // 含字幕的 document 或 shadowRoot

  function findRoot(root) {
    if (root.querySelector('.hive-subtitle-renderer-wrapper')) return root;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const r = findRoot(el.shadowRoot); if (r) return r; }
    }
    return null;
  }

  function mainVideo() {
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (v.readyState > 0 && r.width * r.height > area) { best = v; area = r.width * r.height; }
    }
    return best;
  }

  // ---- 疊加層 ----
  const LINE = 'display:block;margin:0.05em auto;padding:0 0.3em;white-space:pre-line;line-height:1.25;' +
    'text-shadow:-1.5px -1.5px 0 #000,1.5px -1.5px 0 #000,-1.5px 1.5px 0 #000,1.5px 1.5px 0 #000,0 0 6px rgba(0,0,0,.6)';
  let box = null, topEl, botEl;
  function ensureBox() {
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;text-align:center;' +
        'transform:translateX(-50%);color:#fff;' +
        "font-family:'Microsoft JhengHei','PingFang TC',Arial,sans-serif;display:none";
      topEl = document.createElement('div');
      botEl = document.createElement('div');
      topEl.style.cssText = LINE + ';font-weight:700';
      botEl.style.cssText = LINE + ';font-weight:400';
      box.append(topEl, botEl);
    }
    const parent = document.fullscreenElement || document.body;
    if (parent && box.parentNode !== parent) parent.appendChild(box);
    return box;
  }

  const norm = (s) => s.replace(/\s+/g, '');
  let lastPrimaryText = '', lastScan = 0;

  function tick() {
    if ((!cueRoot || !cueRoot.querySelector('.hive-subtitle-renderer-wrapper')) && Date.now() - lastScan > 2000) {
      lastScan = Date.now(); // 整頁掃 shadow DOM 很貴，找不到時 2 秒才再掃
      cueRoot = findRoot(document);
    }

    const v = mainVideo();
    const b = ensureBox();
    if (!v || !b || !cueRoot) { if (b) b.style.display = 'none'; return; }

    // 藏原生字幕：用 visibility 讓文字還在 DOM 裡可讀
    cueRoot.querySelectorAll('.hive-subtitle-renderer-wrapper').forEach((w) => {
      if (w.style.visibility !== 'hidden') w.style.visibility = 'hidden';
    });

    const cueEls = [...cueRoot.querySelectorAll('.hive-subtitle-renderer-cue-window')];
    const ptext = cueEls.map((e) => e.innerText || e.textContent).join('\n').trim();

    // 用原字幕剛出現的那一刻校正時間差（只用整軌唯一、夠長的句子）
    if (ptext && ptext !== lastPrimaryText && primaryCues.length) {
      const n = norm(ptext);
      if (n.length >= 4) {
        const hits = primaryCues.filter((c) => norm(c.text) === n);
        if (hits.length === 1) {
          offsetSamples.push(hits[0].start - v.currentTime);
          if (offsetSamples.length > 7) offsetSamples.shift();
          const s = offsetSamples.slice().sort((x, y) => x - y);
          offset = s[s.length >> 1];
        }
      }
    }
    lastPrimaryText = ptext;

    const t = v.currentTime + offset;
    const stext = dualOn ? secondaryCues.filter((c) => c.start <= t && t < c.end).map((c) => c.text).join('\n') : '';

    // 中文永遠在上排：原字幕是中文 → 上原下副；原字幕是英文 → 上副下原
    const primaryZh = !primary || /^zh/i.test(primary.lang);
    const zhText = primaryZh ? ptext : stext;
    const otherText = primaryZh ? stext : ptext;

    if (v.paused || (!zhText && !otherText)) { b.style.display = 'none'; return; }

    const vr = v.getBoundingClientRect();
    const zhPx = Math.max(20, vr.height * 0.05) * scale;
    topEl.textContent = zhText;
    botEl.textContent = otherText;
    topEl.style.display = zhText ? 'block' : 'none';
    botEl.style.display = otherText ? 'block' : 'none';
    topEl.style.fontSize = Math.round(zhPx) + 'px';
    botEl.style.fontSize = Math.round(zhPx * 0.72) + 'px';
    b.style.width = Math.round(vr.width * 0.92) + 'px';
    b.style.left = Math.round(vr.left + vr.width / 2) + 'px';
    b.style.bottom = Math.round(window.innerHeight - vr.bottom + vr.height * 0.08) + 'px';
    b.style.display = 'block';
  }
  setInterval(tick, 100);

  // ---- 畫質顯示：右上角音量膠囊正下方，滑鼠動時出現 2 秒；Alt+Q 釘選常駐 ----
  const KEY_QPIN = 'dpds-qpin';
  let qPinned = store.get(KEY_QPIN) === '1';
  let qBadge, qUntil = 0;

  const mbps = (bw) => (bw / 1e6).toFixed(1) + ' Mbps';

  function qualityText() {
    const v = mainVideo();
    if (!v || !v.videoWidth) return '';
    const parts = [`畫質 ${v.videoWidth}×${v.videoHeight}`];
    const same = variants.filter((x) => x.h === v.videoHeight).map((x) => x.bw).filter(Boolean);
    if (same.length) {
      const lo = Math.min(...same), hi = Math.max(...same);
      parts.push('約 ' + (lo === hi ? mbps(lo) : `${mbps(lo).split(' ')[0]}~${mbps(hi)}`));
    }
    if (variants.length) {
      const top = variants.reduce((a, b) => (b.h > a.h || (b.h === a.h && b.bw > a.bw) ? b : a));
      parts.push(`清單最高 ${top.w}×${top.h}`);
    }
    const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
    if (q) parts.push(`掉格 ${q.droppedVideoFrames}/${q.totalVideoFrames}`);
    return parts.join('｜');
  }

  function updateBadge() {
    if (!document.body) return;
    if (!qBadge) {
      qBadge = document.createElement('div');
      qBadge.style.cssText = 'position:fixed;top:52px;right:16px;z-index:2147483647;padding:6px 12px;' +
        'border-radius:16px;background:rgba(0,0,0,.65);color:#fff;font:14px/1.2 system-ui,sans-serif;' +
        'pointer-events:none;font-variant-numeric:tabular-nums;white-space:nowrap;display:none';
    }
    const parent = document.fullscreenElement || document.body;
    if (qBadge.parentNode !== parent) parent.appendChild(qBadge);
    const text = (qPinned || Date.now() < qUntil) ? qualityText() : '';
    qBadge.textContent = text;
    qBadge.style.display = text ? 'block' : 'none';
  }
  setInterval(updateBadge, 500);
  document.addEventListener('mousemove', () => { qUntil = Date.now() + 2000; }, { passive: true });

  // ---- 提示 ＆ 快捷鍵 ----
  let tip, tipTimer;
  function toast(msg) {
    if (!tip) {
      tip = document.createElement('div');
      tip.style.cssText = 'position:fixed;top:92px;right:16px;z-index:2147483647;padding:6px 12px;' +
        'border-radius:16px;background:rgba(0,0,0,.7);color:#fff;font:14px/1.3 system-ui,sans-serif;' +
        'pointer-events:none;white-space:pre-line';
    }
    const parent = document.fullscreenElement || document.body;
    if (tip.parentNode !== parent) parent.appendChild(tip);
    tip.textContent = msg;
    tip.style.display = 'block';
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { tip.style.display = 'none'; }, 2500);
  }

  function status() {
    const p = primary ? primary.name : '（尚未偵測到）';
    const s = secondary ? `${secondary.name}${secondaryCues.length ? '' : '（載入中）'}` : '無';
    return `字幕 ${Math.round(scale * 100)}%\n原字幕：${p}\n第二字幕：${dualOn ? s : '關閉'}`;
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === '=' || k === '+') scale = Math.min(3, +(scale + 0.1).toFixed(1));
    else if (k === '-') scale = Math.max(0.5, +(scale - 0.1).toFixed(1));
    else if (k === 's') { dualOn = !dualOn; store.set(KEY_ON, dualOn ? '1' : '0'); }
    else if (k === 'l') {
      const others = tracks.filter((t) => t !== primary);
      if (others.length) {
        const i = others.indexOf(secondary);
        const next = others[(i + 1) % others.length];
        prefLang = next.lang;
        store.set(KEY_LANG, prefLang);
        secondary = null;
        pickSecondary();
      }
    } else if (k === 'q') {
      qPinned = !qPinned;
      store.set(KEY_QPIN, qPinned ? '1' : '0');
      updateBadge();
      e.preventDefault(); e.stopPropagation();
      toast(qPinned ? '畫質資訊：常駐顯示' : '畫質資訊：滑鼠移動時才顯示');
      return;
    } else if (k === 'd') { /* 只顯示狀態 */ }
    else return;
    store.set(KEY_SCALE, String(scale));
    e.preventDefault(); e.stopPropagation();
    toast(status() + (k === 'd' ? `\n時間差：${offset.toFixed(2)} 秒（${offsetSamples.length} 筆校正）` +
      (qualityText() ? '\n' + qualityText() : '') : ''));
  }, true);
})();
