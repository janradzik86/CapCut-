/* ClipForge — original browser-based video editor (vanilla JS, no build step). */
'use strict';
(() => {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = t => { t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60; return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0'); };
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

function toast(msg, ms = 2200) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------------- IndexedDB storage ---------------- */
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open('clipforge', 1); } catch (e) { return rej(e); }
      req.onupgradeneeded = () => { const d = req.result; d.createObjectStore('projects', { keyPath: 'id' }); d.createObjectStore('blobs'); };
      req.onsuccess = () => { this.db = req.result; res(this.db); };
      req.onerror = () => rej(req.error);
    });
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store); let out;
      const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
    });
  },
  put(store, val, key) { return this.tx(store, 'readwrite', s => s.put(val, key)); },
  get(store, key) { return this.tx(store, 'readonly', s => s.get(key)); },
  del(store, key) { return this.tx(store, 'readwrite', s => s.delete(key)); },
  all(store) { return this.tx(store, 'readonly', s => s.getAll()); },
};

/* ---------------- Constants ---------------- */
const FILTERS = [
  ['Oryginał', ''], ['Żywy', 'saturate(1.5) contrast(1.1)'], ['Mono', 'grayscale(1)'],
  ['Sepia', 'sepia(0.8)'], ['Chłodny', 'hue-rotate(-18deg) saturate(1.2) brightness(1.03)'],
  ['Ciepły', 'sepia(0.3) saturate(1.35) hue-rotate(-8deg)'], ['Retro', 'sepia(0.45) contrast(0.9) brightness(1.08) saturate(0.9)'],
  ['Noir', 'grayscale(1) contrast(1.5) brightness(0.9)'], ['Sen', 'brightness(1.12) saturate(1.3) contrast(0.92)'],
  ['Mat', 'contrast(0.8) brightness(1.1) saturate(0.85)'], ['Neon', 'saturate(2) hue-rotate(25deg) contrast(1.15)'],
  ['Inwersja', 'invert(1)'],
];
const FONTS = ['system-ui', 'Georgia', 'Impact', 'Courier New', 'Trebuchet MS', 'Arial Black', 'Comic Sans MS'];
const COLORS = ['#ffffff', '#000000', '#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#7c5cff', '#ff8c42'];
const ASPECTS = { '9:16': [9, 16], '16:9': [16, 9], '1:1': [1, 1], '4:5': [4, 5], '4:3': [4, 3], '21:9': [21, 9] };
const TRANSITIONS = [['none', 'Brak'], ['fade', 'Przenikanie'], ['slideL', 'Wjazd ←'], ['slideU', 'Wjazd ↑'], ['zoom', 'Zoom'], ['blur', 'Rozmycie'], ['spin', 'Obrót']];
const TEXT_ANIMS = [['none', 'Brak'], ['fade', 'Pojawienie'], ['pop', 'Pop'], ['slide', 'Wjazd'], ['type', 'Maszyna'], ['bounce', 'Odbicie']];

/* ---------------- State ---------------- */
let P = null;            // current project
const media = new Map(); // mediaId -> {url, img?, blob}
const els = new Map();   // clipId -> HTMLMediaElement
let sel = null;          // selected clip id
let t = 0, playing = false, playStart = 0, playT0 = 0;
let pps = 60;            // timeline pixels per second
let undoStack = [], redoStack = [];
let audioCtx = null, mixDest = null;
const srcNodes = new WeakMap();
let exporting = null;

const canvas = $('#stage'); const ctx = canvas.getContext('2d');

function newProject(aspect = '9:16') {
  return { id: uid(), name: 'Projekt ' + new Date().toLocaleDateString(), aspect, bg: '#000000', bgBlur: false, media: [], clips: [], updated: Date.now(), thumb: '' };
}

/* ---------------- Undo ---------------- */
const snap = () => JSON.stringify({ clips: P.clips, aspect: P.aspect, bg: P.bg, bgBlur: P.bgBlur });
function commit() { undoStack.push(snap()); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
function restore(s) { const o = JSON.parse(s); Object.assign(P, o); syncEls(); layoutMain(); refresh(); }
function undo() { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); }

/* ---------------- Media ---------------- */
function mediaKind(file) {
  if (file.type.startsWith('video')) return 'video';
  if (file.type.startsWith('image')) return 'image';
  if (file.type.startsWith('audio')) return 'audio';
  const n = file.name.toLowerCase();
  if (/\.(mp4|mov|webm|mkv|m4v|3gp)$/.test(n)) return 'video';
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(n)) return 'image';
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(n)) return 'audio';
  return null;
}

function probe(kind, url) {
  return new Promise(res => {
    if (kind === 'image') {
      const img = new Image();
      img.onload = () => res({ duration: 5, w: img.naturalWidth, h: img.naturalHeight, img });
      img.onerror = () => res(null); img.src = url; return;
    }
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.preload = 'auto'; el.muted = true; el.playsInline = true;
    el.onloadedmetadata = () => {
      const r = { duration: isFinite(el.duration) ? el.duration : 10, w: el.videoWidth || 0, h: el.videoHeight || 0 };
      if (kind !== 'video') return res(r);
      el.currentTime = Math.min(0.5, r.duration / 3);
      el.onseeked = () => {
        try {
          const c = document.createElement('canvas'); const th = 60; c.height = th; c.width = Math.max(1, Math.round(th * r.w / r.h));
          c.getContext('2d').drawImage(el, 0, 0, c.width, c.height); r.thumb = c.toDataURL('image/jpeg', 0.6);
        } catch (e) {}
        res(r);
      };
    };
    el.onerror = () => res(null); el.src = url;
  });
}

async function importFiles(files, target) {
  if (!files.length) return;
  commit(); let added = 0;
  for (const f of files) {
    const kind = mediaKind(f); if (!kind) { toast('Nieobsługiwany plik: ' + f.name); continue; }
    const url = URL.createObjectURL(f);
    const info = await probe(kind, url);
    if (!info) { toast('Nie można odczytać: ' + f.name); continue; }
    const m = { id: uid(), type: kind, name: f.name, duration: info.duration, w: info.w, h: info.h, thumb: info.thumb || '' };
    if (kind === 'image') { try { const c = document.createElement('canvas'); c.height = 60; c.width = Math.max(1, Math.round(60 * info.w / info.h)); c.getContext('2d').drawImage(info.img, 0, 0, c.width, c.height); m.thumb = c.toDataURL('image/jpeg', .6); } catch (e) {} }
    P.media.push(m);
    media.set(m.id, { url, img: info.img, blob: f });
    DB.put('blobs', f, m.id).catch(() => {});
    let track = target || (kind === 'audio' ? 'audio' : 'main');
    if (kind === 'audio') track = 'audio';
    const clip = baseClip(m, track);
    if (track !== 'main') clip.start = t;
    P.clips.push(clip); added++;
    if (track === 'overlay') { clip.scale = 0.45; clip.x = 0.22; clip.y = -0.25; }
  }
  if (added) { syncEls(); layoutMain(); refresh(); save(); toast('Dodano: ' + added); }
}

function baseClip(m, track) {
  return { id: uid(), mediaId: m.id, track, start: 0, dur: m.duration, in: 0, speed: 1, volume: 1, filter: '', adj: { b: 1, c: 1, s: 1, h: 0, blur: 0, vig: 0 },
    fadeIn: 0, fadeOut: 0, transition: 'none', x: 0, y: 0, scale: 1, rot: 0, opacity: 1, fit: 'contain', flipH: false, reverse: false };
}

function mediaOf(c) { return P.media.find(m => m.id === c.mediaId); }

/* One media element per clip so the same source can be used twice. */
function syncEls() {
  const ids = new Set(P.clips.map(c => c.id));
  for (const [id, el] of els) if (!ids.has(id)) { el.pause(); el.removeAttribute('src'); els.delete(id); }
  for (const c of P.clips) {
    if (c.track === 'text' || els.has(c.id)) continue;
    const m = mediaOf(c); const mm = m && media.get(m.id);
    if (!m || !mm || m.type === 'image') continue;
    const el = document.createElement(m.type === 'video' ? 'video' : 'audio');
    el.src = mm.url; el.preload = 'auto'; el.playsInline = true; el.crossOrigin = 'anonymous';
    el.setAttribute('playsinline', ''); el.setAttribute('webkit-playsinline', '');
    els.set(c.id, el); hookAudio(el);
  }
}

function ensureAudio() {
  if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    mixDest = audioCtx.createMediaStreamDestination();
    for (const el of els.values()) hookAudio(el);
  } catch (e) { audioCtx = null; }
}
function hookAudio(el) {
  if (!audioCtx || srcNodes.has(el)) return;
  try {
    const src = audioCtx.createMediaElementSource(el); const g = audioCtx.createGain();
    src.connect(g); g.connect(audioCtx.destination); g.connect(mixDest); srcNodes.set(el, g);
  } catch (e) {}
}

/* ---------------- Timeline model ---------------- */
function layoutMain() {
  let s = 0;
  for (const c of P.clips.filter(c => c.track === 'main')) { c.start = s; s += c.dur; }
}
const mainClips = () => P.clips.filter(c => c.track === 'main');
function totalDur() { let d = 0; for (const c of P.clips) d = Math.max(d, c.start + c.dur); return d; }
const active = (c, at) => at >= c.start && at < c.start + c.dur;
function srcTime(c, at) {
  const m = mediaOf(c); const span = c.dur * c.speed; const local = (at - c.start) * c.speed;
  const st = c.reverse ? c.in + span - local : c.in + local;
  return clamp(st, 0, m ? m.duration - 0.03 : st);
}

/* ---------------- Rendering ---------------- */
function setCanvasSize(base = null) {
  const [aw, ah] = ASPECTS[P.aspect] || [9, 16];
  const short = base || (exporting ? exporting.res : 720);
  let w, h;
  if (aw <= ah) { w = short; h = Math.round(short * ah / aw); } else { h = short; w = Math.round(short * aw / ah); }
  w -= w % 2; h -= h % 2;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function filterStr(c) {
  const a = c.adj || {}; let f = c.filter || '';
  if (a.b !== 1) f += ` brightness(${a.b})`; if (a.c !== 1) f += ` contrast(${a.c})`;
  if (a.s !== 1) f += ` saturate(${a.s})`; if (a.h) f += ` hue-rotate(${a.h}deg)`;
  if (a.blur) f += ` blur(${a.blur * canvas.width / 720}px)`;
  return f.trim() || 'none';
}

function sourceOf(c) {
  const m = mediaOf(c); if (!m) return null;
  if (m.type === 'image') { const mm = media.get(m.id); return mm && mm.img ? { el: mm.img, w: m.w, h: m.h } : null; }
  const el = els.get(c.id); if (!el || el.readyState < 2) return null;
  return { el, w: el.videoWidth || m.w, h: el.videoHeight || m.h };
}

function transIn(c, at) {
  const d = 0.5; const p = clamp((at - c.start) / d, 0, 1);
  const r = { alpha: 1, dx: 0, dy: 0, sc: 1, blur: 0, rot: 0 };
  if (c.transition === 'none' || p >= 1) return r;
  const e = 1 - Math.pow(1 - p, 3);
  switch (c.transition) {
    case 'fade': r.alpha = e; break;
    case 'slideL': r.dx = (1 - e); break;
    case 'slideU': r.dy = (1 - e); break;
    case 'zoom': r.sc = 1.6 - 0.6 * e; r.alpha = e; break;
    case 'blur': r.blur = (1 - e) * 20; break;
    case 'spin': r.rot = (1 - e) * Math.PI; r.sc = 0.3 + 0.7 * e; break;
  }
  return r;
}

function drawVisual(c, at) {
  const s = sourceOf(c); if (!s || !s.w) return;
  const W = canvas.width, H = canvas.height;
  let alpha = c.opacity;
  const local = at - c.start;
  if (c.fadeIn > 0) alpha *= clamp(local / c.fadeIn, 0, 1);
  if (c.fadeOut > 0) alpha *= clamp((c.dur - local) / c.fadeOut, 0, 1);
  const tr = transIn(c, at); alpha *= tr.alpha;
  if (alpha <= 0) return;
  const fit = c.fit === 'cover' ? Math.max(W / s.w, H / s.h) : Math.min(W / s.w, H / s.h);
  const dw = s.w * fit * c.scale * tr.sc, dh = s.h * fit * c.scale * tr.sc;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(W / 2 + (c.x + tr.dx) * W, H / 2 + (c.y + tr.dy) * H);
  ctx.rotate(c.rot * Math.PI / 180 + tr.rot);
  if (c.flipH) ctx.scale(-1, 1);
  let f = filterStr(c); if (tr.blur) f = (f === 'none' ? '' : f) + ` blur(${tr.blur}px)`;
  ctx.filter = f;
  ctx.drawImage(s.el, -dw / 2, -dh / 2, dw, dh);
  ctx.filter = 'none';
  if (c.adj && c.adj.vig > 0) {
    const g = ctx.createRadialGradient(0, 0, Math.min(dw, dh) * 0.3, 0, 0, Math.max(dw, dh) * 0.7);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${c.adj.vig})`);
    ctx.fillStyle = g; ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
  }
  ctx.restore();
}

function drawBlurBg(c) {
  const s = sourceOf(c); if (!s || !s.w) return;
  const W = canvas.width, H = canvas.height; const f = Math.max(W / s.w, H / s.h) * 1.1;
  ctx.save(); ctx.filter = `blur(${Math.round(W / 30)}px) brightness(0.7)`;
  ctx.drawImage(s.el, (W - s.w * f) / 2, (H - s.h * f) / 2, s.w * f, s.h * f); ctx.restore();
}

function drawText(c, at) {
  const T = c.text; if (!T) return;
  const W = canvas.width, H = canvas.height; const local = at - c.start;
  let alpha = c.opacity, sc = 1, dy = 0, str = T.content;
  const p = clamp(local / 0.5, 0, 1), e = 1 - Math.pow(1 - p, 3);
  switch (T.anim) {
    case 'fade': alpha *= e; break;
    case 'pop': sc = p < 1 ? 0.3 + 0.7 * e + Math.sin(p * Math.PI) * 0.15 : 1; break;
    case 'slide': dy = (1 - e) * 0.15; alpha *= e; break;
    case 'type': str = T.content.slice(0, Math.floor(clamp(local / Math.max(0.6, T.content.length * 0.06), 0, 1) * T.content.length)); break;
    case 'bounce': dy = -Math.abs(Math.sin(local * 4)) * 0.02 * Math.max(0, 1 - local / 3); break;
  }
  if (c.fadeOut > 0) alpha *= clamp((c.dur - local) / c.fadeOut, 0, 1);
  if (c.fadeIn > 0) alpha *= clamp(local / c.fadeIn, 0, 1);
  const size = T.size * W / 720 * c.scale;
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.translate(W / 2 + c.x * W, H / 2 + (c.y + dy) * H); ctx.rotate(c.rot * Math.PI / 180); ctx.scale(sc, sc);
  ctx.font = `${T.bold ? '700' : '400'} ${size}px ${T.font}`; ctx.textAlign = T.align || 'center'; ctx.textBaseline = 'middle';
  const lines = str.split('\n'); const lh = size * 1.2; const y0 = -(lines.length - 1) * lh / 2;
  const fullLines = T.content.split('\n');
  if (T.bg) {
    const wMax = Math.max(...fullLines.map(l => ctx.measureText(l).width)); const pad = size * 0.3;
    ctx.fillStyle = T.bg; const bw = wMax + pad * 2, bh = fullLines.length * lh + pad;
    const bx = T.align === 'left' ? -pad : T.align === 'right' ? -wMax - pad : -bw / 2;
    roundRect(bx, -bh / 2, bw, bh, size * 0.25); ctx.fill();
  }
  lines.forEach((l, i) => {
    if (T.stroke) { ctx.lineWidth = size * 0.12; ctx.strokeStyle = T.stroke; ctx.lineJoin = 'round'; ctx.strokeText(l, 0, y0 + i * lh); }
    if (T.shadow) { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = size * 0.2; ctx.shadowOffsetY = size * 0.05; }
    ctx.fillStyle = T.color; ctx.fillText(l, 0, y0 + i * lh); ctx.shadowColor = 'transparent';
  });
  ctx.restore();
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

function render(at) {
  setCanvasSize();
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = P.bg; ctx.fillRect(0, 0, W, H);
  const mains = mainClips().filter(c => active(c, at));
  if (P.bgBlur && mains[0]) drawBlurBg(mains[0]);
  for (const c of mains) drawVisual(c, at);
  for (const c of P.clips) if (c.track === 'overlay' && active(c, at)) drawVisual(c, at);
  for (const c of P.clips) if (c.track === 'text' && active(c, at)) drawText(c, at);
  if (!exporting && sel) {
    const c = P.clips.find(c => c.id === sel);
    if (c && c.track !== 'main' && c.track !== 'audio' && active(c, at)) {
      ctx.save(); ctx.strokeStyle = '#ffd166'; ctx.lineWidth = Math.max(2, W / 360); ctx.setLineDash([8, 6]);
      const b = boundsOf(c); if (b) ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.restore();
    }
  }
}

function boundsOf(c) {
  const W = canvas.width, H = canvas.height;
  if (c.track === 'text') {
    const T = c.text; const size = T.size * W / 720 * c.scale;
    ctx.save(); ctx.font = `${T.bold ? '700' : '400'} ${size}px ${T.font}`;
    const lines = T.content.split('\n'); const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + size * 0.6; ctx.restore();
    const h = lines.length * size * 1.2 + size * 0.3;
    return { x: W / 2 + c.x * W - w / 2, y: H / 2 + c.y * H - h / 2, w, h };
  }
  const m = mediaOf(c); if (!m || !m.w) return null;
  const fit = Math.min(W / m.w, H / m.h); const w = m.w * fit * c.scale, h = m.h * fit * c.scale;
  return { x: W / 2 + c.x * W - w / 2, y: H / 2 + c.y * H - h / 2, w, h };
}

/* Sync HTML media elements with the timeline position */
function syncMedia(at, force) {
  for (const c of P.clips) {
    const el = els.get(c.id); if (!el) continue;
    if (active(c, at)) {
      const want = srcTime(c, at);
      const vol = clamp(c.volume * fadeGain(c, at), 0, 1);
      const g = srcNodes.get(el);
      if (g) { g.gain.value = c.volume * fadeGain(c, at); el.volume = 1; } else el.volume = vol;
      el.muted = c.volume === 0;
      if (playing && !c.reverse) {
        el.playbackRate = clamp(c.speed, 0.0625, 16);
        if (el.paused) { el.currentTime = want; const pr = el.play(); if (pr) pr.catch(() => {}); }
        else if (Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
      } else {
        if (!el.paused) el.pause();
        if (force || Math.abs(el.currentTime - want) > (playing ? 0.08 : 0.02)) { try { el.currentTime = want; } catch (e) {} }
      }
    } else if (!el.paused) el.pause();
  }
}
function fadeGain(c, at) {
  const l = at - c.start; let g = 1;
  if (c.track === 'audio') { if (c.fadeIn > 0) g *= clamp(l / c.fadeIn, 0, 1); if (c.fadeOut > 0) g *= clamp((c.dur - l) / c.fadeOut, 0, 1); }
  return g;
}

function tick() {
  if (playing) {
    t = playT0 + (performance.now() - playStart) / 1000;
    const end = totalDur();
    if (t >= end) {
      t = end;
      if (exporting) { finishExport(); } else { setPlaying(false); }
    }
    syncMedia(t);
    updatePlayhead();
    if (exporting) { $('#expBar').style.width = (100 * t / Math.max(0.01, end)) + '%'; }
  }
  if (P && $('#editor').classList.contains('active')) render(t);
  requestAnimationFrame(tick);
}

function setPlaying(v) {
  if (v && t >= totalDur() - 0.05) t = 0;
  playing = v; playT0 = t; playStart = performance.now();
  if (v) ensureAudio();
  $('#btnPlay').innerHTML = v ? '&#x23F8;' : '&#x25B6;';
  syncMedia(t, true);
}
function seek(nt) { t = clamp(nt, 0, Math.max(0, totalDur())); playT0 = t; playStart = performance.now(); syncMedia(t, true); updatePlayhead(); }

/* ---------------- Timeline UI ---------------- */
const tlInner = $('#tlInner'), timeline = $('#timeline');
const PAD = 40;
function refreshTimeline() {
  const dur = Math.max(totalDur(), 10) + 5;
  tlInner.style.width = (dur * pps + PAD + 200) + 'px';
  const ruler = $('#ruler'); ruler.innerHTML = '';
  const step = pps > 120 ? 0.5 : pps > 40 ? 1 : pps > 15 ? 5 : 10;
  for (let s = 0; s <= dur; s += step) {
    const d = document.createElement('div'); d.className = 'tick'; d.style.left = (s * pps) + 'px';
    if (Math.abs(s % (step * 2)) < 1e-6 || step >= 5) d.textContent = fmt(s).replace(/\.0$/, ''); ruler.appendChild(d);
  }
  $$('.clip', tlInner).forEach(e => e.remove());
  for (const c of P.clips) {
    const tr = $(`.track[data-track="${c.track}"]`, tlInner); if (!tr) continue;
    const d = document.createElement('div'); d.className = `clip ${c.track}` + (c.id === sel ? ' sel' : ''); d.dataset.id = c.id;
    d.style.left = (c.start * pps + PAD) + 'px'; d.style.width = Math.max(8, c.dur * pps) + 'px';
    const m = mediaOf(c);
    if (m && m.thumb) d.style.backgroundImage = `url(${m.thumb})`;
    let label = c.track === 'text' ? '“' + c.text.content.split('\n')[0] + '”' : (m ? m.name : '?');
    if (c.speed !== 1) label += ` · ${c.speed}x`;
    d.innerHTML = `<div class="h l"></div><span></span><div class="h r"></div>`; $('span', d).textContent = label;
    if (c.track === 'audio') d.prepend(waveFor(c));
    tr.appendChild(d);
  }
  $('#tDur').textContent = fmt(totalDur());
  updatePlayhead();
}
function waveFor(c) {
  const cv = document.createElement('canvas'); cv.className = 'wave'; cv.width = 200; cv.height = 40;
  const g = cv.getContext('2d'); g.fillStyle = '#9ff5d6'; let seed = c.mediaId.charCodeAt(0);
  for (let i = 0; i < 100; i++) { seed = (seed * 9301 + 49297) % 233280; const h = 6 + (seed / 233280) * 28; g.fillRect(i * 2, 20 - h / 2, 1.2, h); }
  return cv;
}
function updatePlayhead() {
  $('#playhead').style.left = (t * pps + PAD) + 'px'; $('#tCur').textContent = fmt(t);
  if (playing) {
    const x = t * pps + PAD; const vw = timeline.clientWidth;
    if (x > timeline.scrollLeft + vw - 60 || x < timeline.scrollLeft) timeline.scrollLeft = x - 80;
  }
}

/* Pointer interactions: seek, select, drag, trim */
let drag = null;
tlInner.addEventListener('pointerdown', e => {
  const clipEl = e.target.closest('.clip');
  const rect = tlInner.getBoundingClientRect();
  const xToT = x => (x - rect.left - PAD) / pps;
  if (!clipEl) {
    if (e.target.closest('.track-label')) return;
    select(null); seek(xToT(e.clientX));
    drag = { type: 'scrub', xToT }; tlInner.setPointerCapture(e.pointerId); return;
  }
  const c = P.clips.find(c => c.id === clipEl.dataset.id); if (!c) return;
  select(c.id);
  const handle = e.target.classList.contains('h') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
  drag = { type: handle ? 'trim' + handle : 'move', c, x0: e.clientX, orig: JSON.parse(JSON.stringify(c)), moved: false, xToT };
  tlInner.setPointerCapture(e.pointerId);
});
tlInner.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.type === 'scrub') { seek(drag.xToT(e.clientX)); return; }
  const dt = (e.clientX - drag.x0) / pps; if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
  if (!drag.moved) { commit(); drag.moved = true; }
  const c = drag.c, o = drag.orig; const m = mediaOf(c);
  const maxSrc = m && m.type !== 'image' && c.track !== 'text' ? m.duration : Infinity;
  if (drag.type === 'move') {
    if (c.track === 'main') {
      // reorder main track clips by dragging past neighbours' midpoints
      const tt = drag.xToT(e.clientX); const list = mainClips(); const idx = list.indexOf(c);
      let target = list.findIndex(o2 => tt < o2.start + o2.dur / 2); if (target < 0) target = list.length - 1;
      if (target !== idx) { const all = P.clips; all.splice(all.indexOf(c), 1); const ref = list[target]; let pos = all.indexOf(ref); if (target > idx) pos++; all.splice(pos, 0, c); layoutMain(); refreshTimeline(); }
    } else { c.start = Math.max(0, snapT(o.start + dt, c)); refreshTimeline(); }
  } else if (drag.type === 'trimr') {
    let nd = Math.max(0.1, o.dur + dt); if (maxSrc !== Infinity) nd = Math.min(nd, (maxSrc - o.in) / o.speed);
    c.dur = nd; if (c.track === 'main') layoutMain(); refreshTimeline();
  } else if (drag.type === 'triml') {
    let d = dt; d = Math.min(d, o.dur - 0.1); if (maxSrc !== Infinity) d = Math.max(d, -o.in / o.speed);
    if (c.track !== 'main') d = Math.max(d, -o.start);
    c.dur = o.dur - d; if (maxSrc !== Infinity) c.in = o.in + d * o.speed;
    if (c.track !== 'main') c.start = o.start + d; else layoutMain();
    refreshTimeline();
  }
  syncMedia(t, true);
});
const endDrag = () => { if (drag && drag.moved) save(); drag = null; };
tlInner.addEventListener('pointerup', endDrag); tlInner.addEventListener('pointercancel', endDrag);
function snapT(v, self) {
  const pts = [0, t]; for (const c of P.clips) if (c !== self) pts.push(c.start, c.start + c.dur);
  for (const p of pts) if (Math.abs(p - v) * pps < 8) return p; return v;
}

/* Canvas drag for overlay/text positioning, wheel/pinch to scale */
let cdrag = null;
canvas.addEventListener('pointerdown', e => {
  const r = canvas.getBoundingClientRect(); const k = canvas.width / r.width;
  const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
  const hits = P.clips.filter(c => (c.track === 'text' || c.track === 'overlay') && active(c, t)).reverse();
  const hit = hits.find(c => { const b = boundsOf(c); return b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h; });
  if (!hit) { const mc = mainClips().find(c => active(c, t)); select(mc ? mc.id : null); return; }
  select(hit.id); commit();
  cdrag = { c: hit, x0: e.clientX, y0: e.clientY, ox: hit.x, oy: hit.y, k: 1 / r.width, kh: 1 / r.height };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!cdrag) return;
  cdrag.c.x = clamp(cdrag.ox + (e.clientX - cdrag.x0) * cdrag.k, -0.7, 0.7);
  cdrag.c.y = clamp(cdrag.oy + (e.clientY - cdrag.y0) * cdrag.kh, -0.7, 0.7);
});
canvas.addEventListener('pointerup', () => { if (cdrag) { save(); cdrag = null; } });
canvas.addEventListener('wheel', e => {
  const c = selClip(); if (!c || c.track === 'audio') return; e.preventDefault();
  c.scale = clamp(c.scale * (e.deltaY < 0 ? 1.05 : 0.95), 0.05, 5); save();
}, { passive: false });

/* ---------------- Selection & toolbar ---------------- */
const selClip = () => P && P.clips.find(c => c.id === sel);
function select(id) { sel = id; closeSheet(); refreshTimeline(); buildToolbar(); }

function tool(icon, label, fn, cls = '') {
  const b = document.createElement('button'); b.className = 'tool ' + cls; b.innerHTML = `<i>${icon}</i>${label}`; b.onclick = fn; return b;
}
function buildToolbar() {
  const tb = $('#toolbar'); tb.innerHTML = ''; const c = selClip();
  if (!c) {
    tb.append(
      tool('&#x2795;', 'Dodaj', () => $('#fileMedia').click()),
      tool('&#x266B;', 'Audio', () => $('#fileAudio').click()),
      tool('T', 'Tekst', addText),
      tool('&#x29C9;', 'Nakładka', () => $('#fileOverlay').click()),
      tool('&#x25AD;', 'Format', sheetAspect),
      tool('&#x25D1;', 'Tło', sheetBg),
      tool('&#x2702;', 'Podziel', splitAtPlayhead),
    );
    return;
  }
  const isMedia = c.track !== 'text'; const m = mediaOf(c); const isVis = c.track !== 'audio';
  tb.append(tool('&#x2702;', 'Podziel', splitAtPlayhead));
  if (c.track === 'text') tb.append(tool('&#x270E;', 'Edytuj', sheetText));
  if (isMedia && m && m.type !== 'image') tb.append(tool('&#x23E9;', 'Prędkość', sheetSpeed));
  if (isMedia && m && m.type !== 'image') tb.append(tool('&#x1F50A;', 'Głośność', sheetVolume));
  if (isVis && isMedia) tb.append(tool('&#x2728;', 'Filtry', sheetFilters), tool('&#x2600;', 'Korekta', sheetAdjust));
  if (isVis) tb.append(tool('&#x2725;', 'Transform', sheetTransform));
  if (c.track === 'main' || c.track === 'overlay') tb.append(tool('&#x29D6;', 'Przejście', sheetTransition));
  tb.append(tool('&#x25D0;', 'Zanikanie', sheetFade));
  if (isMedia && m && m.type === 'video') tb.append(tool('&#x21C4;', 'Wstecz', () => { commit(); c.reverse = !c.reverse; toast(c.reverse ? 'Odtwarzanie wstecz (bez dźwięku)' : 'Normalny kierunek'); save(); refresh(); }));
  if (m && m.type === 'video' && c.track === 'main') tb.append(tool('&#x266A;', 'Wyodrębnij<br>audio', () => extractAudio(c)));
  tb.append(
    tool('&#x2398;', 'Duplikuj', () => duplicate(c)),
    tool('&#x2190;', 'W lewo', () => moveClip(c, -1)), tool('&#x2192;', 'W prawo', () => moveClip(c, 1)),
    tool('&#x1F5D1;', 'Usuń', () => removeClip(c), 'danger'),
  );
}

function splitAtPlayhead() {
  let c = selClip();
  if (!c || !active(c, t)) c = mainClips().find(x => active(x, t)) || P.clips.find(x => active(x, t));
  if (!c) return toast('Brak klipu pod wskaźnikiem');
  const local = t - c.start; if (local < 0.05 || c.dur - local < 0.05) return toast('Za blisko krawędzi klipu');
  commit();
  const b = JSON.parse(JSON.stringify(c)); b.id = uid();
  if (c.reverse) { b.in = c.in; c.in = c.in + (c.dur - local) * c.speed; }
  else b.in = c.in + local * c.speed;
  b.start = c.start + local; b.dur = c.dur - local; c.dur = local; b.transition = 'none';
  P.clips.splice(P.clips.indexOf(c) + 1, 0, b);
  syncEls(); layoutMain(); sel = b.id; refresh(); save(); toast('Podzielono');
}
function duplicate(c) {
  commit(); const b = JSON.parse(JSON.stringify(c)); b.id = uid();
  if (c.track !== 'main') b.start = c.start + c.dur;
  P.clips.splice(P.clips.indexOf(c) + 1, 0, b); syncEls(); layoutMain(); sel = b.id; refresh(); save();
}
function removeClip(c) { commit(); P.clips.splice(P.clips.indexOf(c), 1); sel = null; syncEls(); layoutMain(); refresh(); save(); }
function moveClip(c, dir) {
  commit();
  if (c.track === 'main') {
    const list = mainClips(); const i = list.indexOf(c), j = i + dir; if (j < 0 || j >= list.length) return;
    const a = P.clips.indexOf(list[i]), b = P.clips.indexOf(list[j]); [P.clips[a], P.clips[b]] = [P.clips[b], P.clips[a]]; layoutMain();
  } else c.start = Math.max(0, c.start + dir * 0.5);
  refresh(); save();
}
function extractAudio(c) {
  commit(); const a = JSON.parse(JSON.stringify(c)); a.id = uid(); a.track = 'audio'; a.transition = 'none';
  c.volume = 0; P.clips.push(a); syncEls(); refresh(); save(); toast('Audio wyodrębnione na ścieżkę audio');
}
function addText() {
  commit();
  const c = { id: uid(), track: 'text', start: t, dur: 3, in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, x: 0, y: 0, scale: 1, rot: 0, opacity: 1,
    text: { content: 'Twój tekst', size: 64, color: '#ffffff', font: 'system-ui', bold: true, stroke: '#000000', bg: '', shadow: true, anim: 'pop', align: 'center' } };
  P.clips.push(c); sel = c.id; refresh(); save(); sheetText();
}

/* ---------------- Sheets (property panels) ---------------- */
const sheet = $('#sheet'), sheetBody = $('#sheetBody');
let sheetCommitted = false;
function openSheet(title, build) {
  $('#sheetTitle').textContent = title; sheetBody.innerHTML = ''; sheetCommitted = false; build(sheetBody); sheet.classList.add('open');
}
function closeSheet() { sheet.classList.remove('open'); }
$('#sheetClose').onclick = () => { closeSheet(); save(); };
function once() { if (!sheetCommitted) { commit(); sheetCommitted = true; } }

function range(parent, label, val, min, max, step, onInput, fmtv = v => v) {
  const f = document.createElement('div'); f.className = 'field';
  f.innerHTML = `<label></label><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
  $('label', f).textContent = label; const r = $('input', f), o = $('output', f); r.value = val; o.textContent = fmtv(+val);
  r.oninput = () => { once(); o.textContent = fmtv(+r.value); onInput(+r.value); };
  parent.appendChild(f); return r;
}
function chips(parent, items, cur, onPick) {
  const w = document.createElement('div'); w.className = 'chips';
  for (const [v, l] of items) { const b = document.createElement('button'); b.className = 'chip' + (v === cur ? ' on' : ''); b.textContent = l;
    b.onclick = () => { once(); $$('.chip', w).forEach(x => x.classList.remove('on')); b.classList.add('on'); onPick(v); }; w.appendChild(b); }
  parent.appendChild(w); return w;
}
function heading(p, txt) { const h = document.createElement('p'); h.className = 'muted small'; h.textContent = txt; p.appendChild(h); }

function sheetSpeed() {
  const c = selClip();
  openSheet('Prędkość', b => {
    const apply = v => {
      const m = mediaOf(c); const span = c.dur * c.speed; c.speed = v; c.dur = span / v;
      if (m && c.in + c.dur * c.speed > m.duration) c.dur = (m.duration - c.in) / v;
      if (c.track === 'main') layoutMain(); refreshTimeline();
    };
    const r = range(b, 'Prędkość', c.speed, 0.1, 10, 0.1, apply, v => v.toFixed(1) + 'x');
    chips(b, [[0.25, '0.25x'], [0.5, '0.5x'], [1, '1x'], [1.5, '1.5x'], [2, '2x'], [4, '4x'], [8, '8x']], c.speed, v => { r.value = v; r.nextSibling.textContent = v.toFixed(1) + 'x'; apply(v); });
  });
}
function sheetVolume() {
  const c = selClip();
  openSheet('Głośność', b => {
    range(b, 'Głośność', c.volume, 0, 2, 0.01, v => c.volume = v, v => Math.round(v * 100) + '%');
    chips(b, [[0, 'Wycisz'], [1, '100%'], [2, '200%']], c.volume, v => { c.volume = v; sheetVolume(); });
  });
}
function filterThumb(c, f) {
  const cv = document.createElement('canvas'); cv.width = 90; cv.height = 90; const g = cv.getContext('2d');
  const s = sourceOf(c); g.filter = f || 'none';
  if (s && s.w) { const k = Math.max(90 / s.w, 90 / s.h); g.drawImage(s.el, (90 - s.w * k) / 2, (90 - s.h * k) / 2, s.w * k, s.h * k); }
  else { const gr = g.createLinearGradient(0, 0, 90, 90); gr.addColorStop(0, '#ff8c42'); gr.addColorStop(1, '#4cc9f0'); g.fillStyle = gr; g.fillRect(0, 0, 90, 90); }
  return cv;
}
function sheetFilters() {
  const c = selClip();
  openSheet('Filtry', b => {
    const grid = document.createElement('div'); grid.className = 'filters';
    for (const [name, f] of FILTERS) {
      const card = document.createElement('button'); card.className = 'fcard' + (c.filter === f ? ' on' : '');
      card.append(filterThumb(c, f), document.createTextNode(name));
      card.onclick = () => { once(); c.filter = f; $$('.fcard', grid).forEach(x => x.classList.remove('on')); card.classList.add('on'); };
      grid.appendChild(card);
    }
    b.appendChild(grid);
    const all = document.createElement('button'); all.className = 'chip'; all.style.marginTop = '12px'; all.textContent = 'Zastosuj do wszystkich klipów';
    all.onclick = () => { once(); for (const x of P.clips) if (x.track === 'main') x.filter = c.filter; toast('Zastosowano'); };
    b.appendChild(all);
  });
}
function sheetAdjust() {
  const c = selClip(); const a = c.adj;
  openSheet('Korekta', b => {
    range(b, 'Jasność', a.b, 0.2, 2, 0.01, v => a.b = v, v => Math.round((v - 1) * 100));
    range(b, 'Kontrast', a.c, 0.2, 2, 0.01, v => a.c = v, v => Math.round((v - 1) * 100));
    range(b, 'Nasycenie', a.s, 0, 3, 0.01, v => a.s = v, v => Math.round((v - 1) * 100));
    range(b, 'Odcień', a.h, -180, 180, 1, v => a.h = v, v => v + '°');
    range(b, 'Rozmycie', a.blur, 0, 20, 0.5, v => a.blur = v);
    range(b, 'Winieta', a.vig, 0, 1, 0.01, v => a.vig = v, v => Math.round(v * 100));
    const r = document.createElement('button'); r.className = 'chip'; r.textContent = 'Resetuj';
    r.onclick = () => { once(); Object.assign(a, { b: 1, c: 1, s: 1, h: 0, blur: 0, vig: 0 }); sheetAdjust(); }; b.appendChild(r);
  });
}
function sheetTransform() {
  const c = selClip();
  openSheet('Transformacja', b => {
    range(b, 'Skala', c.scale, 0.05, 4, 0.01, v => c.scale = v, v => Math.round(v * 100) + '%');
    range(b, 'Obrót', c.rot, -180, 180, 1, v => c.rot = v, v => v + '°');
    range(b, 'Pozycja X', c.x, -0.7, 0.7, 0.005, v => c.x = v, v => Math.round(v * 100));
    range(b, 'Pozycja Y', c.y, -0.7, 0.7, 0.005, v => c.y = v, v => Math.round(v * 100));
    range(b, 'Krycie', c.opacity, 0, 1, 0.01, v => c.opacity = v, v => Math.round(v * 100) + '%');
    if (c.track !== 'text') {
      heading(b, 'Dopasowanie');
      chips(b, [['contain', 'Zmieść'], ['cover', 'Wypełnij']], c.fit, v => c.fit = v);
      const fl = document.createElement('button'); fl.className = 'chip'; fl.style.marginTop = '8px'; fl.textContent = 'Odbij poziomo';
      fl.onclick = () => { once(); c.flipH = !c.flipH; }; b.appendChild(fl);
    }
    heading(b, 'Wskazówka: przeciągnij element na podglądzie, kółkiem myszy zmień rozmiar.');
  });
}
function sheetTransition() {
  const c = selClip();
  openSheet('Przejście (wejście klipu)', b => chips(b, TRANSITIONS, c.transition, v => c.transition = v));
}
function sheetFade() {
  const c = selClip();
  openSheet('Zanikanie', b => {
    range(b, 'Pojawianie', c.fadeIn, 0, Math.min(5, c.dur / 2), 0.1, v => c.fadeIn = v, v => v.toFixed(1) + 's');
    range(b, 'Zanikanie', c.fadeOut, 0, Math.min(5, c.dur / 2), 0.1, v => c.fadeOut = v, v => v.toFixed(1) + 's');
  });
}
function sheetText() {
  const c = selClip(); const T = c.text;
  openSheet('Tekst', b => {
    const ta = document.createElement('textarea'); ta.value = T.content;
    ta.oninput = () => { once(); T.content = ta.value || ' '; refreshTimeline(); }; b.appendChild(ta);
    range(b, 'Rozmiar', T.size, 12, 220, 1, v => T.size = v);
    heading(b, 'Kolor');
    const sw = document.createElement('div'); sw.className = 'chips';
    for (const col of COLORS) { const s = document.createElement('button'); s.className = 'swatch' + (T.color === col ? ' on' : ''); s.style.background = col;
      s.onclick = () => { once(); T.color = col; $$('.swatch', sw).forEach(x => x.classList.remove('on')); s.classList.add('on'); }; sw.appendChild(s); }
    const cp = document.createElement('input'); cp.type = 'color'; cp.value = T.color; cp.oninput = () => { once(); T.color = cp.value; }; sw.appendChild(cp);
    b.appendChild(sw);
    heading(b, 'Czcionka'); chips(b, FONTS.map(f => [f, f.split(' ')[0]]), T.font, v => T.font = v);
    heading(b, 'Styl');
    chips(b, [['plain', 'Zwykły'], ['outline', 'Obrys'], ['box', 'Etykieta'], ['shadow', 'Cień']],
      T.bg ? 'box' : T.stroke ? 'outline' : T.shadow ? 'shadow' : 'plain',
      v => { T.stroke = v === 'outline' ? '#000000' : ''; T.bg = v === 'box' ? 'rgba(0,0,0,0.65)' : ''; T.shadow = v === 'shadow' || v === 'outline'; });
    chips(b, [[true, 'Pogrubiony'], [false, 'Normalny']], T.bold, v => T.bold = v);
    chips(b, [['left', 'Do lewej'], ['center', 'Środek'], ['right', 'Do prawej']], T.align, v => T.align = v);
    heading(b, 'Animacja'); chips(b, TEXT_ANIMS, T.anim, v => T.anim = v);
    range(b, 'Czas trwania', c.dur, 0.5, 30, 0.1, v => { c.dur = v; refreshTimeline(); }, v => v.toFixed(1) + 's');
  });
  setTimeout(() => { const ta = $('textarea', sheetBody); if (ta && !matchMedia('(pointer:coarse)').matches) ta.select(); }, 50);
}
function sheetAspect() {
  openSheet('Format', b => {
    chips(b, Object.keys(ASPECTS).map(k => [k, k]), P.aspect, v => { P.aspect = v; });
  });
}
function sheetBg() {
  openSheet('Tło', b => {
    chips(b, [[false, 'Kolor'], [true, 'Rozmyte wideo']], P.bgBlur, v => P.bgBlur = v);
    const sw = document.createElement('div'); sw.className = 'chips'; sw.style.marginTop = '10px';
    for (const col of COLORS) { const s = document.createElement('button'); s.className = 'swatch' + (P.bg === col ? ' on' : ''); s.style.background = col;
      s.onclick = () => { once(); P.bg = col; $$('.swatch', sw).forEach(x => x.classList.remove('on')); s.classList.add('on'); }; sw.appendChild(s); }
    b.appendChild(sw);
  });
}

/* ---------------- Export ---------------- */
function pickMime() {
  const c = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
$('#btnExport').onclick = () => {
  if (!totalDur()) return toast('Dodaj najpierw klipy');
  if (!window.MediaRecorder || !canvas.captureStream) return toast('Eksport nie jest obsługiwany w tej przeglądarce');
  $('#exportSetup').hidden = false; $('#exportRun').hidden = true; $('#exportModal').classList.add('open');
};
$('#expCancel').onclick = () => $('#exportModal').classList.remove('open');
$('#expGo').onclick = startExport;
$('#expAbort').onclick = () => { if (exporting) { exporting.aborted = true; finishExport(); } };

function startExport() {
  ensureAudio(); setPlaying(false); select(null);
  const res = +$('#expRes').value, fps = +$('#expFps').value, mbps = +$('#expBitrate').value;
  exporting = { res, fps, chunks: [], aborted: false };
  setCanvasSize(res);
  const stream = canvas.captureStream(fps);
  if (mixDest) mixDest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
  const mime = pickMime();
  let rec;
  try { rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: mbps * 1e6 * (res / 720), audioBitsPerSecond: 192000 }); }
  catch (e) { exporting = null; return toast('Błąd nagrywania: ' + e.message); }
  exporting.rec = rec; exporting.mime = rec.mimeType || mime || 'video/webm';
  rec.ondataavailable = e => { if (e.data && e.data.size) exporting.chunks.push(e.data); };
  rec.onstop = onRecorded;
  $('#exportSetup').hidden = true; $('#exportRun').hidden = false; $('#expBar').style.width = '0';
  $('#expMsg').textContent = 'Renderowanie w czasie rzeczywistym…';
  t = 0; syncMedia(0, true);
  // give decoders a moment to seek to the first frame
  setTimeout(() => { if (!exporting) return; rec.start(250); setPlaying(true); }, 600);
}
function finishExport() {
  if (!exporting || exporting.stopping) return; exporting.stopping = true;
  setPlaying(false);
  setTimeout(() => { try { exporting.rec.state !== 'inactive' ? exporting.rec.stop() : onRecorded(); } catch (e) { onRecorded(); } }, 200);
}
async function onRecorded() {
  const ex = exporting; if (!ex) return; exporting = null; setCanvasSize();
  if (ex.aborted) { $('#exportModal').classList.remove('open'); return toast('Przerwano eksport'); }
  const blob = new Blob(ex.chunks, { type: ex.mime });
  const ext = ex.mime.includes('mp4') ? 'mp4' : 'webm';
  const name = (P.name || 'ClipForge').replace(/[^\w\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ ]+/g, '_') + '_' + ex.res + 'p.' + ext;
  $('#expMsg').textContent = 'Zapisywanie…';
  try { await saveFile(blob, name); } catch (e) { toast('Błąd zapisu: ' + e.message, 4000); }
  $('#exportModal').classList.remove('open');
}
async function saveFile(blob, name) {
  const plugins = window.Capacitor && window.Capacitor.Plugins;
  if (isNative && plugins && plugins.Filesystem) {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
    try {
      const out = await plugins.Filesystem.writeFile({ path: 'ClipForge/' + name, data: b64, directory: 'DOCUMENTS', recursive: true });
      toast('Zapisano w Dokumenty/ClipForge/' + name, 4000);
      if (plugins.Share) plugins.Share.share({ title: name, url: out.uri }).catch(() => {});
    } catch (e) {
      const out = await plugins.Filesystem.writeFile({ path: name, data: b64, directory: 'CACHE' });
      if (plugins.Share) await plugins.Share.share({ title: name, url: out.uri }); else throw e;
    }
    return;
  }
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name });
      const w = await h.createWritable(); await w.write(blob); await w.close(); toast('Zapisano: ' + name); return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); toast('Pobrano: ' + name, 3000);
}

/* ---------------- Persistence ---------------- */
let saveT = null;
function save() {
  if (!P) return; clearTimeout(saveT);
  saveT = setTimeout(() => {
    P.updated = Date.now(); P.name = $('#projName').value || P.name;
    try { const c = document.createElement('canvas'); c.width = 160; c.height = 160; const g = c.getContext('2d'); const k = Math.max(160 / canvas.width, 160 / canvas.height);
      g.drawImage(canvas, (160 - canvas.width * k) / 2, (160 - canvas.height * k) / 2, canvas.width * k, canvas.height * k); P.thumb = c.toDataURL('image/jpeg', 0.6); } catch (e) {}
    DB.put('projects', JSON.parse(JSON.stringify(P))).catch(() => {});
  }, 600);
}
async function openProject(p) {
  for (const el of els.values()) { el.pause(); el.removeAttribute('src'); } els.clear();
  for (const mm of media.values()) URL.revokeObjectURL(mm.url); media.clear();
  P = p; sel = null; t = 0; undoStack = []; redoStack = [];
  for (const m of P.media) {
    const blob = await DB.get('blobs', m.id).catch(() => null);
    if (!blob) continue;
    const url = URL.createObjectURL(blob); const entry = { url, blob };
    if (m.type === 'image') { entry.img = new Image(); entry.img.src = url; }
    media.set(m.id, entry);
  }
  const missing = P.media.filter(m => !media.has(m.id)).length;
  if (missing) toast(`Brakuje ${missing} plików multimedialnych`);
  $('#projName').value = P.name;
  showScreen('editor'); syncEls(); layoutMain(); refresh(); seek(0);
}
async function listProjects() {
  let ps = []; try { ps = await DB.all('projects'); } catch (e) {}
  ps.sort((a, b) => b.updated - a.updated);
  const list = $('#projectList'); list.innerHTML = ''; $('#noProjects').hidden = ps.length > 0;
  for (const p of ps) {
    const d = document.createElement('div'); d.className = 'pcard';
    const dur = p.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
    d.innerHTML = `<div class="thumb"></div><div class="meta"><b></b><span class="muted small"></span></div><button class="del" title="Usuń">&#x2715;</button>`;
    if (p.thumb) $('.thumb', d).style.backgroundImage = `url(${p.thumb})`;
    $('b', d).textContent = p.name; $('.meta span', d).textContent = fmt(dur) + ' · ' + new Date(p.updated).toLocaleDateString();
    d.onclick = e => { if (e.target.closest('.del')) return; openProject(p); };
    $('.del', d).onclick = async () => { if (!confirm('Usunąć projekt „' + p.name + '”?')) return;
      for (const m of p.media) await DB.del('blobs', m.id).catch(() => {}); await DB.del('projects', p.id).catch(() => {}); listProjects(); };
    list.appendChild(d);
  }
}

function showScreen(id) { $$('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }
function refresh() { refreshTimeline(); buildToolbar(); }

/* ---------------- Wiring ---------------- */
function startNew(aspect) { openProject(newProject(aspect)).then(() => { save(); $('#fileMedia').click(); }); }
$('#newProject').onclick = () => startNew('9:16');
$$('.qa').forEach(b => b.onclick = () => startNew(b.dataset.aspect));
$('#btnBack').onclick = () => { setPlaying(false); for (const el of els.values()) el.pause(); save(); setTimeout(listProjects, 700); showScreen('home'); };
$('#projName').onchange = save;
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnPlay').onclick = () => setPlaying(!playing);
$('#btnStart').onclick = () => seek(0); $('#btnEnd').onclick = () => seek(totalDur());
$('#zoomIn').onclick = () => { pps = Math.min(400, pps * 1.4); refreshTimeline(); };
$('#zoomOut').onclick = () => { pps = Math.max(5, pps / 1.4); refreshTimeline(); };
timeline.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); pps = clamp(pps * (e.deltaY < 0 ? 1.15 : 0.87), 5, 400); refreshTimeline(); } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { timeline.scrollLeft += e.deltaY; } }, { passive: false });
$('#fileMedia').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };
$('#fileAudio').onchange = e => { importFiles([...e.target.files], 'audio'); e.target.value = ''; };
$('#fileOverlay').onchange = e => { importFiles([...e.target.files], 'overlay'); e.target.value = ''; };
document.addEventListener('pointerdown', ensureAudio, { once: true });

const sw = $('#stageWrap');
sw.addEventListener('dragover', e => { e.preventDefault(); sw.classList.add('drag'); });
sw.addEventListener('dragleave', () => sw.classList.remove('drag'));
sw.addEventListener('drop', e => { e.preventDefault(); sw.classList.remove('drag'); importFiles([...e.dataTransfer.files]); });

document.addEventListener('keydown', e => {
  if (!$('#editor').classList.contains('active') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); setPlaying(!playing); }
  else if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); const c = selClip(); if (c) duplicate(c); }
  else if (k === 'delete' || k === 'backspace') { const c = selClip(); if (c) removeClip(c); }
  else if (k === 's' || k === 'b') splitAtPlayhead();
  else if (k === 'arrowleft') seek(t - (e.shiftKey ? 1 : 1 / 30));
  else if (k === 'arrowright') seek(t + (e.shiftKey ? 1 : 1 / 30));
  else if (k === 'home') seek(0); else if (k === 'end') seek(totalDur());
  else if (k === 'escape') select(null);
});

// Android hardware back button
if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  window.Capacitor.Plugins.App.addListener('backButton', () => {
    if (sheet.classList.contains('open')) closeSheet();
    else if ($('#editor').classList.contains('active')) $('#btnBack').click();
    else window.Capacitor.Plugins.App.exitApp();
  });
}
window.addEventListener('beforeunload', () => { if (P) DB.put('projects', JSON.parse(JSON.stringify(P))).catch(() => {}); });

window.ClipForge = { get project() { return P; }, importFiles, seek, setPlaying, splitAtPlayhead, addText, undo, redo, get time() { return t; } };
listProjects();
requestAnimationFrame(tick);
})();
