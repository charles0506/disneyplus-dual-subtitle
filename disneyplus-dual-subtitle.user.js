// ==UserScript==
// @name         Disney+ 雙字幕＋字幕放大
// @namespace    https://github.com/charles0506/disneyplus-dual-subtitle
// @version      1.0.0
// @description  Disney+ 字幕放大，並在原字幕上方加第二語言（中文字幕配英文，英文字幕配中文）
// @homepageURL  https://github.com/charles0506/disneyplus-dual-subtitle
// @supportURL   https://github.com/charles0506/disneyplus-dual-subtitle/issues
// @updateURL    https://raw.githubusercontent.com/charles0506/disneyplus-dual-subtitle/main/disneyplus-dual-subtitle.user.js
// @downloadURL  https://raw.githubusercontent.com/charles0506/disneyplus-dual-subtitle/main/disneyplus-dual-subtitle.user.js
// @match        https://www.disneyplus.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Disney+ 字幕是 HLS 裡未加密的 WebVTT 分段（*.vtt，CORS 允許 disneyplus.com）。
  // 1. PerformanceObserver 側錄頁面載入的 .m3u8 / .vtt 網址
  // 2. 自己重抓 m3u8，含 #EXT-X-MEDIA:TYPE=SUBTITLES 的就是主清單，列出各語言字幕
  // 3. 頁面正在載的 .vtt 屬於哪一軌 = 目前顯示的語言；另一語言整軌抓下來
  // 4. 依 video.currentTime（加上用原字幕文字比對算出的時間差）把第二語言疊在原字幕上方
  // 原字幕畫在 .hive-subtitle-renderer-cue-window，放大用 CSS zoom。

  const KEY_SCALE = 'dpds-scale', KEY_ON = 'dpds-on', KEY_LANG = 'dpds-lang';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  let scale = parseFloat(store.get(KEY_SCALE));
  if (!(scale >= 0.8 && scale <= 3)) scale = 1.4;
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
  let cueRoot = null; // 含字幕的 document 或 shadowRoot
  const styledRoots = new WeakSet();
  const CSS = '.hive-subtitle-renderer-cue-window{zoom:var(--dpds-scale,1.4)!important}';

  function findRoot(root) {
    if (root.querySelector('.hive-subtitle-renderer-wrapper')) return root;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const r = findRoot(el.shadowRoot); if (r) return r; }
    }
    return null;
  }

  function injectStyle(root) {
    if (styledRoots.has(root)) return;
    styledRoots.add(root);
    const st = document.createElement('style');
    st.textContent = CSS;
    (root === document ? document.head || document.documentElement : root).appendChild(st);
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
  let box = null;
  function ensureBox() {
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;text-align:center;' +
        'transform:translateX(-50%);white-space:pre-line;color:#fff;font-family:Arial,sans-serif;' +
        'line-height:1.25;text-shadow:0 0 4px #000,0 0 2px #000;display:none';
    }
    const parent = document.fullscreenElement || document.body;
    if (parent && box.parentNode !== parent) parent.appendChild(box);
    return box;
  }

  const norm = (s) => s.replace(/\s+/g, '');
  let lastPrimaryText = '', lastScan = 0;

  function tick() {
    document.documentElement.style.setProperty('--dpds-scale', String(scale));
    if ((!cueRoot || !cueRoot.querySelector('.hive-subtitle-renderer-wrapper')) && Date.now() - lastScan > 2000) {
      lastScan = Date.now(); // 整頁掃 shadow DOM 很貴，找不到時 2 秒才再掃
      cueRoot = findRoot(document);
    }
    if (cueRoot) injectStyle(cueRoot);

    const v = mainVideo();
    const b = ensureBox();
    if (!v || !b) return;

    const cueEls = cueRoot ? [...cueRoot.querySelectorAll('.hive-subtitle-renderer-cue-window')] : [];
    const ptext = cueEls.map((e) => e.textContent).join('\n').trim();

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
    const text = dualOn ? secondaryCues.filter((c) => c.start <= t && t < c.end).map((c) => c.text).join('\n') : '';
    if (!text) { b.style.display = 'none'; return; }

    const vr = v.getBoundingClientRect();
    b.textContent = text;
    b.style.fontSize = Math.round(vr.height * 0.036 * scale) + 'px';
    b.style.maxWidth = Math.round(vr.width * 0.9) + 'px';
    b.style.left = Math.round(vr.left + vr.width / 2) + 'px';
    let bottomY = vr.bottom - vr.height * 0.12;
    const rects = cueEls.map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
    if (rects.length) bottomY = Math.min(...rects.map((r) => r.top)) - 4;
    b.style.top = '';
    b.style.bottom = Math.round(window.innerHeight - bottomY) + 'px';
    b.style.display = 'block';
  }
  setInterval(tick, 100);

  // ---- 提示 ＆ 快捷鍵 ----
  let tip, tipTimer;
  function toast(msg) {
    if (!tip) {
      tip = document.createElement('div');
      tip.style.cssText = 'position:fixed;top:56px;right:16px;z-index:2147483647;padding:6px 12px;' +
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
    else if (k === '-') scale = Math.max(0.8, +(scale - 0.1).toFixed(1));
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
    } else if (k === 'd') { /* 只顯示狀態 */ }
    else return;
    store.set(KEY_SCALE, String(scale));
    e.preventDefault(); e.stopPropagation();
    toast(status() + (k === 'd' ? `\n時間差：${offset.toFixed(2)} 秒（${offsetSamples.length} 筆校正）` : ''));
  }, true);
})();
