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
let exporting = null, renderRes = 0;

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

async function importFiles(files, target, noClip) {
  const created = []; if (!files.length) return created;
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
    if (noClip) { created.push(m); continue; }
    let track = target || (kind === 'audio' ? 'audio' : 'main');
    if (kind === 'audio') track = 'audio';
    const clip = baseClip(m, track);
    if (track !== 'main') clip.start = (track === 'audio' && !musicLength()) ? 0 : t;
    P.clips.push(clip); added++; created.push(clip);
    if (track === 'overlay') { clip.scale = 0.45; clip.x = 0.22; clip.y = -0.25; }
  }
  if (added) { syncEls(); layoutMain(); refresh(); save(); toast('Dodano: ' + added); }
  return created;
}

function baseClip(m, track) {
  return { id: uid(), mediaId: m.id, track, start: 0, dur: m.duration, in: 0, speed: 1, volume: 1, filter: '', adj: { b: 1, c: 1, s: 1, h: 0, blur: 0, vig: 0, temp: 0 }, ai: { bg: 'none', style: 'none', retouch: { smooth: 0, bright: 0, eyes: 0 } },
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
/* ---- Fit-to-audio: images share the time left by videos so the main track ends exactly with the music;
 *      with no (auto) images, videos are repeated (cyclically) until the music ends. Videos keep their length. */
const MIN_IMG = 0.5;
const isImageClip = c => { const m = mediaOf(c); return !!m && m.type === 'image'; };
function musicLength() { let e = 0; for (const c of P.clips) if (c.track === 'audio' && !c.fromVideo && !c.voice) e = Math.max(e, c.start + c.dur); return e; }
function fitToAudio() {
  if (!P.fit) P.fit = { on: true, mode: 'auto' };
  const F = P.fit; const before = P.clips.length;
  P.clips = P.clips.filter(c => !c.autoDup);
  const A = musicLength(); const main = mainClips();
  if (!F.on || A <= 0 || !main.length) return before !== P.clips.length;
  const flex = F.mode === 'duplicate' ? [] : main.filter(c => isImageClip(c) && !c.manualDur);
  const fixedSum = main.filter(c => !flex.includes(c)).reduce((s, c) => s + c.dur, 0);
  if (flex.length) { const each = Math.max(MIN_IMG, (A - fixedSum) / flex.length); for (const c of flex) c.dur = each; return before !== P.clips.length; }
  const src = F.mode === 'duplicate' ? main : main.filter(c => !isImageClip(c));
  if (!src.length) return before !== P.clips.length;
  let total = main.reduce((s, c) => s + c.dur, 0), k = 0, ins = P.clips.indexOf(main[main.length - 1]) + 1;
  while (A - total > 0.1 && k < 2000) {
    const o = src[k % src.length]; const d = JSON.parse(JSON.stringify(o));
    d.id = 'dup-' + o.id + '-' + Math.floor(k / src.length); d.autoDup = true; d.dupOf = o.id; d.dur = Math.min(o.dur, A - total);
    if (o.reverse) d.in = o.in + (o.dur - d.dur) * o.speed;
    P.clips.splice(ins++, 0, d); total += d.dur; k++;
  }
  return true;
}
function layoutMain() {
  const changed = fitToAudio();
  let s = 0;
  for (const c of P.clips.filter(c => c.track === 'main')) { c.start = s; s += c.dur; }
  if (changed) syncEls();
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
  const [aw, ah] = P.aspect === 'orig' && P.customAspect ? P.customAspect : (ASPECTS[P.aspect] || [9, 16]);
  const short = base || (exporting ? exporting.res : renderRes || 720);
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
  const fo = frameOverride.get(c.id); if (fo) return fo;
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
  let src = s.el;
  if (window.CFAI && c.ai) { try { const out = window.CFAI.process(c, s.el, s.w, s.h, srcTime(c, at)); if (out) src = out; } catch (e) { console.warn(e); } }
  let rx = 0, ry = 0;
  if (c.reframe && c.reframe.length) {
    const st = srcTime(c, at); const R = c.reframe; let i = R.findIndex(r => r[0] > st); if (i < 0) i = R.length; const a = R[Math.max(0, i - 1)], b = R[Math.min(R.length - 1, i)];
    const k = b[0] === a[0] ? 0 : clamp((st - a[0]) / (b[0] - a[0]), 0, 1); const cx = a[1] + (b[1] - a[1]) * k, cy = a[2] + (b[2] - a[2]) * k;
    rx = clamp((0.5 - cx) * dw, -(dw - W) / 2, (dw - W) / 2) || 0; ry = clamp((0.5 - cy) * dh, -Math.max(0, dh - H) / 2, Math.max(0, dh - H) / 2) || 0;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(W / 2 + (c.x + tr.dx) * W + rx, H / 2 + (c.y + tr.dy) * H + ry);
  ctx.rotate(c.rot * Math.PI / 180 + tr.rot);
  if (c.flipH) ctx.scale(-1, 1);
  let f = filterStr(c); if (tr.blur) f = (f === 'none' ? '' : f) + ` blur(${tr.blur}px)`;
  ctx.filter = f;
  ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
  ctx.filter = 'none';
  if (c.adj && c.adj.temp) { ctx.save(); ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = alpha * Math.min(1, Math.abs(c.adj.temp)) * 0.7;
    ctx.fillStyle = c.adj.temp > 0 ? '#ff9a3c' : '#3c8cff'; ctx.fillRect(-dw / 2, -dh / 2, dw, dh); ctx.restore(); }
  if (c.ai && c.ai.light && c.ai.light.amt > 0) { const L = c.ai.light; ctx.save(); ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = alpha * L.amt;
    const lx = L.x * dw, ly = L.y * dh, lr = L.r * Math.max(dw, dh); const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
    g.addColorStop(0, '#fff6e8'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fillRect(-dw / 2, -dh / 2, dw, dh); ctx.restore(); }
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
  if (P.bg === 'transparent') ctx.clearRect(0, 0, W, H); else { ctx.fillStyle = P.bg; ctx.fillRect(0, 0, W, H); }
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
      const gain = c.volume * groupGain(c) * fadeGain(c, at);
      const g = srcNodes.get(el);
      if (g) { g.gain.value = gain; el.volume = 1; } else el.volume = clamp(gain, 0, 1);
      el.muted = gain <= 0;
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
  if (c.fadeIn > 0) g *= clamp(l / c.fadeIn, 0, 1); if (c.fadeOut > 0) g *= clamp((c.dur - l) / c.fadeOut, 0, 1);
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
    if (c.autoDup) label = '↻ ' + label;
    if (m && m.type !== 'image' && c.track !== 'text' && (c.volume === 0 || groupGain(c) === 0)) label = '🔇 ' + label;
    if (c.track === 'main' && isImageClip(c) && P.fit && P.fit.on && !c.manualDur && musicLength()) label = '♫ ' + label;
    d.innerHTML = `<div class="h l"></div><span></span><div class="h r"></div>`; $('span', d).textContent = label;
    if (c.track === 'audio') d.prepend(waveFor(c));
    tr.appendChild(d);
  }
  $('#tDur').textContent = fmt(totalDur());
  const ml = $('.track.main .track-label', tlInner); if (ml) { const muted = P.mix && P.mix.orig === 0; ml.innerHTML = muted ? '&#x1F507;&#xFE0E;' : '&#x1F50A;&#xFE0E;'; ml.title = muted ? 'Włącz dźwięk wideo' : 'Wycisz dźwięk wideo'; }
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
tlInner.addEventListener('click', e => {
  if (!e.target.closest('.track.main .track-label')) return;
  commit(); if (!P.mix) P.mix = { orig: 1, music: 1 }; P.mix.orig = P.mix.orig === 0 ? (P.mix.prevOrig || 1) : (P.mix.prevOrig = P.mix.orig, 0);
  refreshTimeline(); save(); toast(P.mix.orig === 0 ? 'Dźwięk wideo wyciszony' : 'Dźwięk wideo włączony');
});
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
    c.dur = nd; if (c.track === 'main' && isImageClip(c)) c.manualDur = true; if (c.autoDup) c.autoDup = false; if (c.track === 'main') layoutMain(); refreshTimeline();
  } else if (drag.type === 'triml') {
    let d = dt; d = Math.min(d, o.dur - 0.1); if (maxSrc !== Infinity) d = Math.max(d, -o.in / o.speed);
    if (c.track !== 'main') d = Math.max(d, -o.start);
    c.dur = o.dur - d; if (maxSrc !== Infinity) c.in = o.in + d * o.speed; if (c.track === 'main' && isImageClip(c)) c.manualDur = true; if (c.autoDup) c.autoDup = false;
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
      tool('&#x2726;', 'Napisy AI', () => aiCaptions(null)),
      tool('&#x29D7;', 'Dopasuj<br>do audio', sheetFit),
      tool('&#x1F50A;&#xFE0E;', 'Głośność', sheetMix),
      tool('&#x1F399;&#xFE0E;', 'Nagraj głos', voiceOver),
      tool('&#x1F4F7;&#xFE0E;', 'Kamera', () => openCamera(false)),
      tool('&#x25A3;', 'Klatka /<br>okładka', sheetCover),
    );
    return;
  }
  const isMedia = c.track !== 'text'; const m = mediaOf(c); const isVis = c.track !== 'audio';
  if (c.autoDup) tb.append(tool('&#x21BB;', 'Zamień na<br>zwykły klip', () => { commit(); c.autoDup = false; c.id = uid(); delete c.dupOf; syncEls(); layoutMain(); sel = c.id; refresh(); save(); toast('Klip jest teraz zwykłym klipem'); }));
  if (c.track === 'main' && isImageClip(c)) tb.append(tool('&#x23F1;', 'Długość', sheetImageDur));
  tb.append(tool('&#x2702;', 'Podziel', splitAtPlayhead));
  if (isMedia && isVis) tb.append(tool('&#x2726;', 'AI', sheetAI, 'ai'));
  else if (isMedia && m && m.type !== 'image') tb.append(tool('&#x2726;', 'AI', sheetAI, 'ai'));
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
  commit(); const a = JSON.parse(JSON.stringify(c)); a.id = uid(); a.track = 'audio'; a.transition = 'none'; a.fromVideo = true; delete a.autoDup;
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
function sheetFit() {
  if (!P.fit) P.fit = { on: true, mode: 'auto' };
  openSheet('Dopasowanie do długości audio', b => {
    const info = document.createElement('p'); info.className = 'small'; b.appendChild(info);
    const upd = () => {
      layoutMain(); refreshTimeline();
      const A = musicLength(), main = mainClips(); const vids = main.filter(c => !isImageClip(c) && !c.autoDup), imgs = main.filter(isImageClip), dups = main.filter(c => c.autoDup);
      const tot = main.reduce((s, c) => s + c.dur, 0);
      info.textContent = !A ? 'Dodaj plik muzyki/audio na ścieżkę audio, aby włączyć dopasowanie.' :
        `Audio: ${fmt(A)} · Wideo: ${vids.length} (${fmt(vids.reduce((s, c) => s + c.dur, 0))})` + (imgs.length ? ` · Zdjęcia: ${imgs.length} × ${fmt(imgs[0].dur)}` : '') + (dups.length ? ` · Powtórzenia: ${dups.length}` : '') +
        ` · Razem: ${fmt(tot)}` + (tot > A + 0.05 ? ` — dłużej niż audio o ${(tot - A).toFixed(1)} s` : '');
    };
    chips(b, [[true, 'Włączone'], [false, 'Wyłączone']], P.fit.on, v => { P.fit.on = v; upd(); });
    heading(b, 'Tryb');
    chips(b, [['auto', 'Zdjęcia wypełniają brakujący czas, wideo bez zmian (powielane gdy brak zdjęć)'], ['duplicate', 'Powielaj wszystkie klipy do końca audio']], P.fit.mode, v => { P.fit.mode = v; upd(); });
    const rs = document.createElement('button'); rs.className = 'chip'; rs.style.marginTop = '10px'; rs.textContent = 'Przywróć automatyczną długość wszystkich zdjęć';
    rs.onclick = () => { once(); mainClips().forEach(c => delete c.manualDur); upd(); }; b.appendChild(rs);
    const tr = document.createElement('button'); tr.className = 'chip'; tr.style.marginTop = '8px'; tr.textContent = 'Przytnij oś do końca audio';
    tr.onclick = () => { const A = musicLength(); if (!A) return; once(); for (const c of mainClips()) { if (c.start >= A - 0.01) { P.clips.splice(P.clips.indexOf(c), 1); continue; } if (c.start + c.dur > A) { c.dur = A - c.start; if (isImageClip(c)) c.manualDur = true; } } syncEls(); upd(); toast('Przycięto do ' + fmt(A)); };
    b.appendChild(tr);
    heading(b, 'Każde dodane zdjęcie skraca pozostałe tak, aby wszystkie razem trwały dokładnie tyle, ile brakuje do końca audio. Zdjęcie przycięte ręcznie zachowuje swoją długość.');
    upd();
  });
}
function sheetImageDur() {
  const c = selClip();
  openSheet('Długość zdjęcia', b => {
    chips(b, [[false, 'Automatyczna (do audio)'], [true, 'Ręczna']], !!c.manualDur, v => { if (v) c.manualDur = true; else delete c.manualDur; layoutMain(); refreshTimeline(); sheetImageDur(); });
    if (c.manualDur) range(b, 'Czas trwania', c.dur, 0.2, 60, 0.1, v => { c.dur = v; layoutMain(); refreshTimeline(); }, v => v.toFixed(1) + ' s');
  });
}
function sheetMix() {
  if (!P.mix) P.mix = { orig: 1, music: 1 };
  openSheet('Głośność', b => {
    range(b, 'Dźwięk z wideo', P.mix.orig, 0, 2, 0.01, v => { P.mix.orig = v; refreshTimeline(); }, v => Math.round(v * 100) + '%');
    range(b, 'Muzyka / audio', P.mix.music, 0, 2, 0.01, v => { P.mix.music = v; refreshTimeline(); }, v => Math.round(v * 100) + '%');
    chips(b, [['mute', 'Wycisz dźwięk wideo'], ['duck', 'Muzyka w tle (wideo 100%, muzyka 30%)'], ['music', 'Tylko muzyka'], ['reset', '100% / 100%']], null, v => {
      if (v === 'mute') P.mix.orig = 0; if (v === 'duck') { P.mix.orig = 1; P.mix.music = 0.3; } if (v === 'music') { P.mix.orig = 0; P.mix.music = 1; } if (v === 'reset') { P.mix.orig = 1; P.mix.music = 1; }
      refreshTimeline(); sheetMix(); });
    heading(b, 'Głośność pojedynczego klipu ustawisz po jego zaznaczeniu → „Głośność”. Ustawienia dotyczą podglądu i eksportu.');
  });
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

/* ---------------- Export (frame-exact offline renderer) ----------------
 * Each output frame is rendered at an exact timestamp: video frames are decoded with WebCodecs
 * (Mediabunny CanvasSink, falls back to precise <video> seeking), audio is mixed offline
 * (volumes, fades, pitch-preserving speed change, reverse) and both are encoded to
 * MP4 (H.264 + AAC, or Opus where AAC is unavailable) or WebM (VP9 + Opus) as a last resort.
 * The file has a constant frame rate and correct duration metadata ("fast start").
 */
const frameOverride = new Map();   // clipId -> {el, w, h} used by sourceOf() during export
let MB = null;
async function mediabunny() { if (!MB) MB = await import(new URL('ai/lib/mediabunny.min.mjs', document.baseURI).href); return MB; }

function exportDims(res) {
  const [aw, ah] = P.aspect === 'orig' && P.customAspect ? P.customAspect : (ASPECTS[P.aspect] || [9, 16]);
  let w, h; if (aw <= ah) { w = res; h = Math.round(res * ah / aw); } else { h = res; w = Math.round(res * aw / ah); }
  return [w - w % 2, h - h % 2];
}
const BITRATE = { 4: 0.07, 8: 0.11, 16: 0.18 }; // bits per pixel per frame
function exportBitrate(res, fps, q) { const [w, h] = exportDims(res); return Math.round(w * h * fps * (BITRATE[q] || 0.11)); }
function updateExportInfo() {
  const res = +$('#expRes').value, fps = +$('#expFps').value, q = +$('#expBitrate').value; const d = totalDur();
  const br = exportBitrate(res, fps, q) + 192000; const [w, h] = exportDims(res);
  $('#expInfo').textContent = `${w}×${h} · ${fps} kl/s · ${fmt(d)} · ok. ${Math.max(0.1, br * d / 8 / 1048576).toFixed(1)} MB`;
}
['#expRes', '#expFps', '#expBitrate'].forEach(s => $(s).addEventListener('change', updateExportInfo));

$('#btnExport').onclick = () => {
  if (!totalDur()) return toast('Dodaj najpierw klipy');
  if (P.photo) return exportPNG(P.name + '.png', 2048);
  setPlaying(false); select(null);
  $('#exportSetup').hidden = false; $('#exportRun').hidden = true; updateExportInfo(); $('#exportModal').classList.add('open');
};
$('#expCancel').onclick = () => $('#exportModal').classList.remove('open');
$('#expGo').onclick = () => startExport().catch(e => { console.error(e); exportFailed(e); });
$('#expAbort').onclick = () => { if (exporting) exporting.aborted = true; };

function exportFailed(e) {
  exporting = null; frameOverride.clear(); renderRes = 0; setCanvasSize();
  $('#exportModal').classList.remove('open');
  modal('Eksport nie powiódł się', b => { b.innerHTML = '<p></p><p class="muted small">Spróbuj niższej rozdzielczości lub innej liczby klatek. Projekt nie został zmieniony.</p>'; $('p', b).textContent = String(e && e.message || e); });
}

async function pickCodecs(M, w, h, fps, bitrate) {
  const v = [];
  for (const [fmtName, vc, acs] of [['mp4', 'avc', ['aac', 'opus']], ['mp4', 'hevc', ['aac', 'opus']], ['webm', 'vp9', ['opus']], ['webm', 'vp8', ['opus']]]) {
    let ok = false; try { ok = await M.canEncodeVideo(vc, { width: w, height: h, bitrate, frameRate: fps }); } catch (e) {}
    if (!ok) continue;
    for (const ac of acs) { let a = false; try { a = await M.canEncodeAudio(ac, { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 }); } catch (e) {} if (a) { v.push({ fmt: fmtName, vc, ac }); break; } }
    if (v.length) break;
  }
  return v[0] || null;
}

async function startExport() {
  const res = +$('#expRes').value, fps = +$('#expFps').value, q = +$('#expBitrate').value;
  const dur = totalDur(); const frames = Math.max(1, Math.round(dur * fps));
  if (!window.VideoEncoder) return startRealtimeExport(res, fps, q);
  const M = await mediabunny();
  const [w, h] = exportDims(res); const bitrate = exportBitrate(res, fps, q);
  const codecs = await pickCodecs(M, w, h, fps, bitrate);
  if (!codecs) { if (res > 720) throw new Error(`To urządzenie nie potrafi zakodować wideo ${w}×${h}. Wybierz niższą rozdzielczość.`); return startRealtimeExport(res, fps, q); }

  exporting = { res, fps, aborted: false, offline: true };
  renderRes = res; setCanvasSize();
  $('#exportSetup').hidden = true; $('#exportRun').hidden = false; $('#expBar').style.width = '0';
  const msg = $('#expMsg'); msg.textContent = 'Miksowanie dźwięku…';
  for (const el of els.values()) el.pause();

  // ----- audio mix
  const audio = await mixAudio(dur, 48000, p => { msg.textContent = `Miksowanie dźwięku… ${Math.round(p * 100)}%`; });
  if (exporting.aborted) return abortExport();

  // ----- output
  const format = codecs.fmt === 'mp4' ? new M.Mp4OutputFormat({ fastStart: 'in-memory' }) : new M.WebMOutputFormat();
  const output = new M.Output({ format, target: new M.BufferTarget() });
  const vsrc = new M.CanvasSource(canvas, { codec: codecs.vc, bitrate, keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(vsrc, { frameRate: fps });
  let asrc = null; if (audio) { asrc = new M.AudioBufferSource({ codec: codecs.ac, bitrate: 192000 }); output.addAudioTrack(asrc); }
  output.setMetadataTags && output.setMetadataTags({ title: P.name, comment: 'ClipForge' });
  await output.start();

  // ----- video frames
  const prov = new FrameProviders(M, fps);
  const t0 = performance.now();
  try {
    for (let i = 0; i < frames; i++) {
      if (exporting.aborted) { await output.cancel(); prov.dispose(); return abortExport(); }
      const tt = i / fps;
      await prov.prepare(tt, i);
      render(tt);
      await vsrc.add(tt, 1 / fps);
      if (i % 3 === 0 || i === frames - 1) {
        const el = (performance.now() - t0) / 1000, p = (i + 1) / frames; const eta = el / p - el;
        $('#expBar').style.width = (p * 100).toFixed(1) + '%';
        msg.textContent = `Renderowanie klatki ${i + 1}/${frames} · ${codecs.vc.toUpperCase()}/${codecs.ac.toUpperCase()} · pozostało ok. ${Math.ceil(eta)} s`;
        await new Promise(r => setTimeout(r, 0)); // keep UI responsive
      }
    }
    vsrc.close && vsrc.close();
    if (asrc) {
      msg.textContent = 'Kodowanie dźwięku…';
      const CH = 48000 * 10; const ctxA = new OfflineAudioContext(2, 1, 48000);
      for (let s = 0; s < audio.L.length; s += CH) {
        const n = Math.min(CH, audio.L.length - s); const buf = ctxA.createBuffer(2, n, 48000);
        buf.copyToChannel(audio.L.subarray(s, s + n), 0); buf.copyToChannel(audio.R.subarray(s, s + n), 1); await asrc.add(buf);
      }
      asrc.close && asrc.close();
    }
    msg.textContent = 'Zapisywanie pliku MP4…';
    await output.finalize();
  } finally { prov.dispose(); frameOverride.clear(); }
  const ext = codecs.fmt; const mime = ext === 'mp4' ? 'video/mp4' : 'video/webm';
  const blob = new Blob([output.target.buffer], { type: mime });
  exporting = null; renderRes = 0; setCanvasSize(); render(t);
  const name = safeName(P.name || 'ClipForge') + '_' + res + 'p.' + ext;
  await deliver(blob, name, `${(blob.size / 1048576).toFixed(1)} MB · ${Math.round((performance.now() - t0) / 1000)} s`);
}
function abortExport() { exporting = null; frameOverride.clear(); renderRes = 0; setCanvasSize(); $('#exportModal').classList.remove('open'); toast('Przerwano eksport'); }
const safeName = s => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'ClipForge';

async function deliver(blob, name, info) {
  $('#expMsg').textContent = 'Zapisywanie…'; $('#expBar').style.width = '100%';
  try {
    const where = await saveFile(blob, name);
    $('#exportModal').classList.remove('open');
    if (where) modal('Gotowe ✓', b => { b.innerHTML = '<p></p><p class="muted small"></p>'; $('p', b).textContent = 'Zapisano: ' + where.label; $('.muted', b).textContent = info; },
      where.actions || [['OK', null, 'export-btn']]);
  } catch (e) {
    console.error(e); $('#exportModal').classList.remove('open');
    // never lose a finished render: offer alternative ways to keep it
    lastRender = { blob, name };
    modal('Nie udało się zapisać', b => { b.innerHTML = '<p></p><p class="muted small">Plik jest gotowy w pamięci — wybierz inną metodę zapisu.</p>'; $('p', b).textContent = String(e && e.message || e); },
      [['Udostępnij…', () => shareBlob(blob, name).then(() => false)], ['Pobierz', () => { downloadBlob(blob, name); }, 'export-btn']]);
  }
}
let lastRender = null;

/* Video frame providers: exact frame for each timestamp */
class FrameProviders {
  constructor(M, fps) { this.M = M; this.fps = fps; this.map = new Map(); }
  async prepare(at, frame) {
    frameOverride.clear();
    for (const c of P.clips) {
      if ((c.track !== 'main' && c.track !== 'overlay') || !active(c, at)) continue;
      const m = mediaOf(c); if (!m || m.type !== 'video') continue;
      let p = this.map.get(c.id); if (!p) { p = await this.create(c, m); this.map.set(c.id, p); }
      const f = await p.get(srcTime(c, at), frame); if (f) frameOverride.set(c.id, f);
    }
  }
  async create(c, m) {
    const mm = media.get(m.id);
    try {
      const input = new this.M.Input({ source: new this.M.BlobSource(mm.blob), formats: this.M.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) throw new Error('decode');
      const dw = track.displayWidth, dh = track.displayHeight; const k = Math.min(1, 1920 / Math.max(dw, dh));
      const sink = new this.M.CanvasSink(track, { width: Math.round(dw * k), height: Math.round(dh * k), fit: 'fill', poolSize: 4 });
      const first = await track.getFirstTimestamp().catch(() => 0);
      const own = document.createElement('canvas'); own.width = Math.round(dw * k); own.height = Math.round(dh * k); const g = own.getContext('2d');
      // timestamps of every output frame of this clip (in order) → one sequential decode pass
      const frameIdx = [], ts = [];
      for (let i = Math.max(0, Math.floor(c.start * this.fps) - 1); i / this.fps < c.start + c.dur + 1 / this.fps; i++) if (active(c, i / this.fps)) { frameIdx.push(i); ts.push(Math.max(first, srcTime(c, i / this.fps))); }
      const pos = new Map(frameIdx.map((f, k) => [f, k]));
      const it = sink.canvasesAtTimestamps(ts); let idx = 0, have = false;
      return {
        get: async (st, frame) => {
          const want = pos.has(frame) ? pos.get(frame) : -1;
          if (want >= 0) while (idx <= want) { const r = await it.next(); idx++; if (r.done) break; if (r.value) { g.drawImage(r.value.canvas, 0, 0, own.width, own.height); have = true; } }
          else { const wc = await sink.getCanvas(Math.max(first, st)); if (wc) { g.drawImage(wc.canvas, 0, 0, own.width, own.height); have = true; } }
          if (!have) { const wc = await sink.getCanvas(first); if (wc) { g.drawImage(wc.canvas, 0, 0, own.width, own.height); have = true; } }
          return have ? { el: own, w: own.width, h: own.height } : null;
        },
        dispose: () => { try { it.return(); } catch (e) {} try { input.dispose(); } catch (e) {} },
      };
    } catch (e) {
      // fallback: precise seeking on a dedicated <video>
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = mm.url;
      await new Promise(r => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 5000); });
      return {
        get: async st => {
          if (Math.abs(v.currentTime - st) > 1e-3 || v.readyState < 2) {
            await new Promise(r => { const done = () => { v.removeEventListener('seeked', done); r(); }; v.addEventListener('seeked', done); v.currentTime = st; setTimeout(done, 3000); });
            if (v.requestVideoFrameCallback) await new Promise(r => { v.requestVideoFrameCallback(() => r()); setTimeout(r, 120); });
          }
          return v.readyState >= 2 ? { el: v, w: v.videoWidth, h: v.videoHeight } : null;
        },
        dispose: () => { v.removeAttribute('src'); v.load(); },
      };
    }
  }
  dispose() { for (const p of this.map.values()) p.dispose(); this.map.clear(); }
}

/* ----- offline audio mix ----- */
const decodedAudio = new Map(); // mediaId -> AudioBuffer | null (48 kHz)
async function decodeMediaAudio(m, rate) {
  const key = m.id + '@' + rate; if (decodedAudio.has(key)) return decodedAudio.get(key);
  let buf = null;
  try { const ab = await media.get(m.id).blob.arrayBuffer(); buf = await new OfflineAudioContext(2, 1, rate).decodeAudioData(ab); } catch (e) { buf = null; } // video without an audio track
  decodedAudio.set(key, buf); return buf;
}
/** WSOLA time-stretch: changes speed while preserving pitch. */
function stretch(x, speed, sr) {
  if (Math.abs(speed - 1) < 1e-3) return x;
  const N = Math.round(sr * 0.04), H = N >> 1, tol = Math.round(sr * 0.012);
  const outLen = Math.floor(x.length / speed); const out = new Float32Array(outLen + N);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  let prev = 0;
  for (let op = 0, k = 0; op < outLen; op += H, k++) {
    const nominal = Math.round(op * speed); let best = nominal;
    if (k > 0) {
      const target = prev + H; let bc = -Infinity;
      for (let d = -tol; d <= tol; d += 3) { const s = nominal + d; if (s < 0 || s + N >= x.length || target + N >= x.length) continue;
        let c = 0; for (let i = 0; i < N; i += 6) c += x[s + i] * x[target + i]; if (c > bc) { bc = c; best = s; } }
    }
    best = clamp(best, 0, Math.max(0, x.length - 1));
    for (let i = 0; i < N; i++) { const j = best + i; if (j >= x.length) break; out[op + i] += x[j] * win[i]; }
    prev = best;
  }
  return out.subarray(0, outLen);
}
function groupGain(c) {
  const mix = P.mix || { orig: 1, music: 1 };
  if (c.track === 'audio') return c.fromVideo ? mix.orig : mix.music;
  return mix.orig;
}
async function mixAudio(dur, sr, onProgress) {
  const len = Math.ceil(dur * sr); const L = new Float32Array(len), R = new Float32Array(len); let any = false;
  const list = P.clips.filter(c => (c.track === 'main' || c.track === 'overlay' || c.track === 'audio') && c.volume > 0 && mediaOf(c) && mediaOf(c).type !== 'image');
  for (let n = 0; n < list.length; n++) {
    const c = list[n]; const m = mediaOf(c); onProgress && onProgress(n / list.length);
    const buf = await decodeMediaAudio(m, sr); if (!buf) continue;
    const a0 = Math.floor(c.in * sr), a1 = Math.min(buf.length, Math.floor((c.in + c.dur * c.speed) * sr)); if (a1 <= a0) continue;
    const chans = [buf.getChannelData(0).subarray(a0, a1), buf.getChannelData(Math.min(1, buf.numberOfChannels - 1)).subarray(a0, a1)];
    const seg = chans.map(ch => { let s = stretch(ch, c.speed, sr); if (c.reverse) s = Float32Array.from(s).reverse(); return s; });
    const vol = c.volume * groupGain(c); const start = Math.round(c.start * sr); const cl = Math.min(seg[0].length, Math.round(c.dur * sr));
    const fi = (c.fadeIn || 0) * sr, fo = (c.fadeOut || 0) * sr;
    for (let i = 0; i < cl; i++) {
      const o = start + i; if (o >= len) break; let g = vol;
      if (fi > 0 && i < fi) g *= i / fi; if (fo > 0 && cl - i < fo) g *= (cl - i) / fo;
      L[o] += seg[0][i] * g; R[o] += seg[1][i] * g;
    }
    any = true; await new Promise(r => setTimeout(r, 0));
  }
  if (!any) return null;
  for (let i = 0; i < len; i++) { const l = L[i], r = R[i]; if (l > 0.95 || l < -0.95) L[i] = Math.tanh(l); if (r > 0.95 || r < -0.95) R[i] = Math.tanh(r); } // soft limiter
  onProgress && onProgress(1);
  return { L, R };
}

/* ----- legacy realtime path (browsers without WebCodecs) ----- */
function pickMime() {
  const c = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function startRealtimeExport(res, fps, q) {
  if (!window.MediaRecorder || !canvas.captureStream) throw new Error('Ta przeglądarka nie obsługuje eksportu wideo.');
  ensureAudio(); setPlaying(false);
  exporting = { res, fps, chunks: [], aborted: false };
  renderRes = res; setCanvasSize();
  const stream = canvas.captureStream(fps);
  if (mixDest) mixDest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
  const mime = pickMime();
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: exportBitrate(res, fps, q), audioBitsPerSecond: 192000 });
  exporting.rec = rec; exporting.mime = rec.mimeType || mime || 'video/webm';
  rec.ondataavailable = e => { if (e.data && e.data.size) exporting.chunks.push(e.data); };
  rec.onstop = onRecorded;
  $('#exportSetup').hidden = true; $('#exportRun').hidden = false; $('#expBar').style.width = '0';
  $('#expMsg').textContent = 'Nagrywanie w czasie rzeczywistym (tryb zgodności)…';
  t = 0; syncMedia(0, true);
  setTimeout(() => { if (!exporting) return; rec.start(250); setPlaying(true); }, 600);
}
function finishExport() {
  if (!exporting || exporting.stopping || exporting.offline) return; exporting.stopping = true;
  setPlaying(false);
  setTimeout(() => { try { exporting.rec.state !== 'inactive' ? exporting.rec.stop() : onRecorded(); } catch (e) { onRecorded(); } }, 200);
}
async function onRecorded() {
  const ex = exporting; if (!ex) return; exporting = null; renderRes = 0; setCanvasSize();
  if (ex.aborted) { $('#exportModal').classList.remove('open'); return toast('Przerwano eksport'); }
  const blob = new Blob(ex.chunks, { type: ex.mime });
  await deliver(blob, safeName(P.name || 'ClipForge') + '_' + ex.res + 'p.' + (ex.mime.includes('mp4') ? 'mp4' : 'webm'), `${(blob.size / 1048576).toFixed(1)} MB`);
}

/* ---------------- Saving files (Android gallery / Windows folders / browser) ---------------- */
const isWinHost = location.protocol === 'http:' && location.hostname === '127.0.0.1';
function mimeOf(name, blob) { return blob.type || (/\.mp4$/i.test(name) ? 'video/mp4' : /\.webm$/i.test(name) ? 'video/webm' : /\.png$/i.test(name) ? 'image/png' : 'text/plain'); }
async function blobToBase64Chunks(blob, chunk, onChunk) {
  for (let o = 0; o < blob.size; o += chunk) {
    const part = blob.slice(o, Math.min(blob.size, o + chunk));
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(part); });
    await onChunk(b64, o === 0, Math.min(1, (o + chunk) / blob.size));
  }
}
/** Returns {label, actions} describing where the file went. Throws on failure. */
async function saveFile(blob, name) {
  const plugins = window.Capacitor && window.Capacitor.Plugins;
  const mime = mimeOf(name, blob);
  if (isNative && plugins && plugins.Filesystem) {
    // 1) stream into the app cache in 3 MB pieces (no giant strings over the JS bridge)
    const path = 'export/' + name; let uri = null;
    await blobToBase64Chunks(blob, 3 * 1024 * 1024, async (b64, first, p) => {
      if (first) { const r = await plugins.Filesystem.writeFile({ path, data: b64, directory: 'CACHE', recursive: true }); uri = r.uri; }
      else await plugins.Filesystem.appendFile({ path, data: b64, directory: 'CACHE' });
      const m = $('#expMsg'); if (m) m.textContent = `Zapisywanie… ${Math.round(p * 100)}%`;
    });
    if (!uri) uri = (await plugins.Filesystem.getUri({ path, directory: 'CACHE' })).uri;
    // 2) publish to the shared gallery / Downloads through MediaStore (native plugin)
    if (plugins.MediaSaver) {
      const r = await plugins.MediaSaver.save({ path: uri, name, mime });
      plugins.Filesystem.deleteFile({ path, directory: 'CACHE' }).catch(() => {});
      return { label: r.displayPath || name, actions: [['Udostępnij', () => plugins.Share && plugins.Share.share({ title: name, url: r.uri || uri }).catch(() => {}).then(() => false)], ['OK', null, 'export-btn']] };
    }
    if (plugins.Share) { await plugins.Share.share({ title: name, url: uri }); return { label: name }; }
    throw new Error('Brak modułu zapisu w tej wersji aplikacji');
  }
  if (isWinHost) {
    const r = await fetch('/api/save?name=' + encodeURIComponent(name) + '&mime=' + encodeURIComponent(mime), { method: 'POST', headers: { 'X-ClipForge': '1', 'Content-Type': 'application/octet-stream' }, body: blob });
    if (!r.ok) throw new Error('Zapis na dysku nie powiódł się (' + r.status + ')');
    const j = await r.json();
    return { label: j.path, actions: [['Pokaż w folderze', () => fetch('/api/reveal?path=' + encodeURIComponent(j.path), { headers: { 'X-ClipForge': '1' } }).then(() => false)], ['OK', null, 'export-btn']] };
  }
  if (window.showSaveFilePicker) {
    try {
      const ext = name.split('.').pop();
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.toUpperCase(), accept: { [mime]: ['.' + ext] } }] });
      const w = await h.createWritable(); await w.write(blob); await w.close(); return { label: h.name };
    } catch (e) { if (e.name === 'AbortError') return null; }
  }
  downloadBlob(blob, name); return { label: name + ' (folder Pobrane)' };
}
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
}
async function shareBlob(blob, name) {
  const plugins = window.Capacitor && window.Capacitor.Plugins;
  if (isNative && plugins && plugins.Share && plugins.Filesystem) {
    const path = 'share/' + name; let uri = null;
    await blobToBase64Chunks(blob, 3 * 1024 * 1024, async (b64, first) => { if (first) uri = (await plugins.Filesystem.writeFile({ path, data: b64, directory: 'CACHE', recursive: true })).uri; else await plugins.Filesystem.appendFile({ path, data: b64, directory: 'CACHE' }); });
    return plugins.Share.share({ title: name, url: uri });
  }
  const f = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [f] })) return navigator.share({ files: [f], title: name });
  downloadBlob(blob, name);
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
  $('#noProjects').hidden = ps.length > 0; $('#noRecent').hidden = ps.length > 0;
  const lists = [[$('#projectList'), ps], [$('#recentList'), ps.slice(0, 6)]];
  for (const [list, arr] of lists) { list.innerHTML = ''; for (const p of arr) {
    const d = document.createElement('div'); d.className = 'pcard';
    const dur = p.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
    d.innerHTML = `<div class="thumb"></div><div class="meta"><b></b><span class="muted small"></span></div><button class="del" title="Usuń">&#x2715;</button>`;
    if (p.thumb) $('.thumb', d).style.backgroundImage = `url(${p.thumb})`;
    $('b', d).textContent = p.name; $('.meta span', d).textContent = fmt(dur) + ' · ' + new Date(p.updated).toLocaleDateString();
    d.onclick = e => { if (e.target.closest('.del')) return; openProject(p); };
    $('.del', d).onclick = async () => { if (!confirm('Usunąć projekt „' + p.name + '”?')) return;
      for (const m of p.media) await DB.del('blobs', m.id).catch(() => {}); await DB.del('projects', p.id).catch(() => {}); listProjects(); };
    list.appendChild(d);
  } }
}

function showScreen(id) { $$('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }
function refresh() { refreshTimeline(); buildToolbar(); }

/* ---------------- Wiring ---------------- */
function startNew(aspect) { openProject(newProject(aspect)).then(() => { save(); $('#fileMedia').click(); }); }
async function newWith(files, aspect = '9:16', opts = {}) {
  const p = newProject(aspect); Object.assign(p, opts); await openProject(p);
  const clips = await importFiles(files); save(); return clips;
}
$('#newProject').onclick = () => startNew('9:16');
$$('.qa').forEach(b => b.onclick = () => startNew(b.dataset.aspect));
$('#btnBack').onclick = () => { setPlaying(false); for (const el of els.values()) el.pause(); save(); setTimeout(listProjects, 700); showScreen('home'); canvas.classList.remove('checker'); };
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

/* =====================================================================
 *  AI tools, home tools grid, templates, Lab AI, camera, collage
 * ===================================================================== */
const AIx = () => window.CFAI;
function aiReady() {
  if (AIx()) return Promise.resolve(AIx());
  return new Promise(res => window.addEventListener('cfai-ready', () => res(AIx()), { once: true }));
}

/* ---------- generic modal ---------- */
const tm = { el: $('#toolModal'), title: $('#tmTitle'), body: $('#tmBody'), row: $('#tmRow') };
function modal(title, build, buttons = [['Zamknij', null]]) {
  tm.title.textContent = title; tm.body.innerHTML = ''; tm.row.innerHTML = '';
  build && build(tm.body);
  for (const [label, fn, cls] of buttons) {
    const b = document.createElement('button'); b.className = cls || 'ghost'; b.textContent = label;
    b.onclick = async () => { if (fn) { const r = await fn(); if (r === false) return; } closeModal(); }; tm.row.appendChild(b);
  }
  tm.el.classList.add('open');
}
function closeModal() { tm.el.classList.remove('open'); }
function progress(title, msg) {
  modal(title, b => { b.innerHTML = `<div class="spinner"></div><div class="progress"><div class="pbar" style="height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2))"></div></div><p class="muted center pmsg"></p>`; }, []);
  const bar = $('.pbar', tm.body), m = $('.pmsg', tm.body); m.textContent = msg || '';
  return { set(p, txt) { if (p != null) bar.style.width = Math.round(clamp(p, 0, 1) * 100) + '%'; if (txt) m.textContent = txt; }, done: closeModal };
}
function pickFiles(accept, multiple = true) {
  return new Promise(res => {
    const inp = $('#filePick'); inp.accept = accept; inp.multiple = multiple; inp.value = '';
    inp.onchange = () => res([...inp.files]); inp.click();
  });
}
async function withVision(msg = 'Ładowanie silników AI…') {
  const A = await aiReady(); if (A.status.vision === 'ready') return A;
  const pr = progress('Silniki AI', msg); pr.set(0.3);
  try { await A.loadVision(); pr.done(); return A; } catch (e) { pr.done(); toast('Nie udało się uruchomić AI: ' + e.message, 5000); throw e; }
}
function frameOf(c) {
  const s = sourceOf(c); if (s && s.w) return s;
  const m = mediaOf(c); const mm = m && media.get(m.id); return mm && mm.img ? { el: mm.img, w: m.w, h: m.h } : null;
}
async function frameReady(c) {
  seek(clamp(t, c.start, c.start + c.dur - 0.05)); for (let i = 0; i < 30; i++) { const f = frameOf(c); if (f) return f; await new Promise(r => setTimeout(r, 100)); }
  return null;
}

/* ---------- AI actions on a clip ---------- */
async function aiAction(id, c) {
  c = c || selClip() || mainClips()[0]; if (!c && id !== 'captions') return toast('Najpierw dodaj klip');
  const m = c && mediaOf(c); const mm = m && media.get(m.id);
  if (!c.ai) c.ai = { bg: 'none', style: 'none', retouch: { smooth: 0, bright: 0, eyes: 0 } };
  if (!c.ai.retouch) c.ai.retouch = { smooth: 0, bright: 0, eyes: 0 };
  switch (id) {
    case 'bgremove': case 'bgblur': case 'bgcolor': case 'bgreplace': {
      await withVision(); commit();
      c.ai.bg = { bgremove: 'remove', bgblur: 'blur', bgcolor: 'color', bgreplace: 'replace' }[id];
      if (P.photo) { c.ai.hq = true; const pr = progress('Silniki AI', 'Ładowanie modelu wysokiej jakości…'); try { await AIx().loadHQ(); } catch (e) {} pr.done(); }
      if (id === 'bgremove' && P.photo) { P.bg = 'transparent'; canvas.classList.add('checker'); }
      save(); refresh(); toast({ bgremove: 'Tło usunięte (AI segmentacja)', bgblur: 'Tło rozmyte', bgcolor: 'Kolor tylko na osobie', bgreplace: 'Tło zamienione' }[id]);
      if (id === 'bgreplace') sheetAI(); break;
    }
    case 'retouch': {
      await withVision(); commit(); const r = c.ai.retouch; if (!r.smooth && !r.bright && !r.eyes) Object.assign(r, { smooth: 0.6, bright: 0.35, eyes: 0.4 });
      save(); select(c.id); sheetRetouch(); break;
    }
    case 'enhance': {
      const f = await frameReady(c); if (!f) return toast('Brak klatki do analizy');
      const A = await aiReady(); const e = A.autoEnhance(f.el); commit();
      Object.assign(c.adj, { b: e.b, c: e.c, s: e.s, temp: e.temp }); save(); toast(`Ulepszono: jasność ${Math.round((e.b - 1) * 100)}, kontrast ${Math.round((e.c - 1) * 100)}, nasycenie ${Math.round((e.s - 1) * 100)}`, 3500); break;
    }
    case 'lighting': {
      const f = await frameReady(c); if (!f) return toast('Brak klatki do analizy');
      const A = await withVision(); const r = await A.smartLighting(f.el, f.w, f.h); commit();
      c.adj.b = +r.b.toFixed(2); c.ai.light = r.light || null; save();
      toast(r.found ? 'Doświetlono twarz (wykryto twarz)' : 'Nie wykryto twarzy — skorygowano ekspozycję', 3500); break;
    }
    case 'styles': select(c.id); sheetStyles(); break;
    case 'silence': {
      if (!m || m.type === 'image' || !mm) return toast('Wybierz klip wideo lub audio');
      const pr = progress('Przycięcie AI', 'Analiza ścieżki dźwiękowej…'); pr.set(0.2);
      try {
        const A = await aiReady(); const { ranges } = await A.detectSpeech(mm.blob); pr.set(0.9);
        const a0 = c.in, a1 = c.in + c.dur * c.speed;
        const keep = ranges.map(([a, b]) => [Math.max(a, a0), Math.min(b, a1)]).filter(([a, b]) => b - a > 0.15);
        pr.done();
        if (!keep.length) return toast('Nie znaleziono fragmentów z dźwiękiem');
        const removed = (a1 - a0) - keep.reduce((s, [a, b]) => s + b - a, 0);
        if (removed < 0.2) return toast('Brak pauz do wycięcia');
        commit(); const idx = P.clips.indexOf(c);
        const parts = keep.map(([a, b], i) => Object.assign(JSON.parse(JSON.stringify(c)), { id: uid(), in: a, dur: (b - a) / c.speed, start: c.track === 'main' ? 0 : c.start + (a - a0) / c.speed, transition: i ? 'none' : c.transition }));
        if (c.track !== 'main') { let st = c.start; for (const p of parts) { p.start = st; st += p.dur; } }
        P.clips.splice(idx, 1, ...parts); syncEls(); layoutMain(); sel = parts[0].id; refresh(); save();
        toast(`Wycięto ${removed.toFixed(1)} s ciszy (${parts.length} fragmentów)`, 4000);
      } catch (e) { pr.done(); toast('Błąd analizy: ' + e.message, 5000); }
      break;
    }
    case 'reframe': {
      if (!m || m.type !== 'video') return toast('Wybierz klip wideo');
      const A = await withVision(); const pr = progress('Inteligentne kadrowanie', 'Śledzenie twarzy i obiektu…');
      try {
        const track = await A.reframeTrack(mm.url, m.duration, p => pr.set(p)); pr.done(); commit();
        if (m.w > m.h && P.aspect !== '9:16') P.aspect = '9:16';
        c.reframe = track; c.fit = 'cover'; save(); refresh(); toast('Kadr podąża za twarzą (format 9:16)', 3500);
      } catch (e) { pr.done(); toast('Błąd: ' + e.message, 5000); }
      break;
    }
    case 'captions': return aiCaptions(c);
    case 'transcribe': return aiTranscribe(c);
  }
}

function sheetAI() {
  const c = selClip(); if (!c) return; const m = mediaOf(c); const isVid = m && m.type === 'video', isAud = m && m.type === 'audio';
  openSheet('Narzędzia AI', b => {
    const grid = document.createElement('div'); grid.className = 'tool-grid';
    const add = (id, label, icon) => { const x = document.createElement('button'); x.className = 'tbtn'; x.innerHTML = `<span class="ic ai">${ICON(icon)}</span>${label}`; x.onclick = () => aiAction(id, c); grid.appendChild(x); };
    if (!isAud) {
      add('bgremove', 'Usuń tło', 'bg'); add('bgblur', 'Rozmyj tło', 'blur'); add('bgcolor', 'Kolor na osobie', 'splash'); add('bgreplace', 'Zamień tło', 'swap');
      add('retouch', 'Retusz', 'face'); add('enhance', 'Auto ulepszanie', 'wand'); add('lighting', 'Inteligentne oświetlenie', 'sun'); add('styles', 'Efekty AI', 'magic');
    }
    if (isVid) add('reframe', 'Inteligentne kadrowanie', 'crop');
    if (isVid || isAud) { add('silence', 'Przycięcie AI (cisza)', 'cut'); add('captions', 'Automatyczne napisy', 'cc'); add('transcribe', 'Transkrypcja', 'lines'); }
    b.appendChild(grid);
    if (c.ai && c.ai.bg && c.ai.bg !== 'none') {
      heading(b, 'Tło: ' + { remove: 'usunięte', blur: 'rozmyte', color: 'kolor na osobie', replace: 'zamienione' }[c.ai.bg]);
      if (c.ai.bg === 'blur') range(b, 'Siła rozmycia', c.ai.bgAmount || 1, 0.3, 3, 0.05, v => c.ai.bgAmount = v);
      if (c.ai.bg === 'replace') { const sw = document.createElement('div'); sw.className = 'chips';
        for (const col of ['#00b140', '#ffffff', '#000000', '#7c5cff', '#ff4d6d', '#4cc9f0', '#ffd166']) { const s = document.createElement('button'); s.className = 'swatch'; s.style.background = col; s.onclick = () => { once(); c.ai.bgColor = col; }; sw.appendChild(s); }
        b.appendChild(sw); }
      const off = document.createElement('button'); off.className = 'chip'; off.style.marginTop = '8px'; off.textContent = 'Przywróć tło';
      off.onclick = () => { once(); c.ai.bg = 'none'; if (P.bg === 'transparent') { P.bg = '#000000'; canvas.classList.remove('checker'); } sheetAI(); }; b.appendChild(off);
    }
    heading(b, 'Wszystkie modele działają lokalnie na urządzeniu — nic nie jest wysyłane do internetu.');
  });
}
function sheetRetouch() {
  const c = selClip(); const r = c.ai.retouch;
  openSheet('Retusz AI', b => {
    range(b, 'Wygładzanie', r.smooth, 0, 1, 0.01, v => r.smooth = v, v => Math.round(v * 100));
    range(b, 'Rozjaśnienie', r.bright, 0, 1, 0.01, v => r.bright = v, v => Math.round(v * 100));
    range(b, 'Wyraziste oczy', r.eyes, 0, 1, 0.01, v => r.eyes = v, v => Math.round(v * 100));
    heading(b, 'Model 478 punktów twarzy wyznacza skórę (bez oczu, brwi i ust) w każdej klatce.');
  });
}
const STYLES = [['none', 'Brak'], ['cartoon', 'Kreskówka'], ['comic', 'Komiks'], ['sketch', 'Szkic'], ['neon', 'Neon'], ['pixel', 'Piksele'], ['thermal', 'Termowizja']];
function sheetStyles() {
  const c = selClip();
  openSheet('Efekty AI', b => { chips(b, STYLES, c.ai.style || 'none', v => { c.ai.style = v; }); heading(b, 'Efekty liczone w czasie rzeczywistym (wykrywanie krawędzi, posteryzacja, mapy jasności).'); });
}

/* ---------- captions / transcription ---------- */
const CAPTION_STYLES = [['classic', 'Klasyczne'], ['box', 'Etykieta'], ['yellow', 'Żółte'], ['karaoke', 'Pop']];
function captionLangPicker(b, st) {
  heading(b, 'Język mowy'); chips(b, [['polish', 'Polski'], ['english', 'Angielski'], ['german', 'Niemiecki'], ['ukrainian', 'Ukraiński'], ['auto', 'Wykryj']], st.lang, v => st.lang = v);
}
async function aiCaptions(c) {
  const targets = c ? [c] : P.clips.filter(x => (x.track === 'main' || x.track === 'audio') && mediaOf(x) && mediaOf(x).type !== 'image' && x.volume > 0);
  if (!targets.length) return toast('Brak klipów z dźwiękiem');
  const A = await aiReady(); if (!A.manifest.whisper) return modal('Napisy AI', b => b.innerHTML = '<p>Ta kompilacja nie zawiera modelu mowy Whisper. Pobierz wersję z GitHub Releases (zawiera model offline).</p>');
  const st = { lang: 'polish', style: 'classic' };
  modal('Automatyczne napisy', b => { captionLangPicker(b, st); heading(b, 'Styl napisów'); chips(b, CAPTION_STYLES, st.style, v => st.style = v); heading(b, `Model: ${A.manifest.whisper} (offline). Pierwsze uruchomienie ładuje model do pamięci.`); },
    [['Anuluj', null], ['Generuj', () => runCaptions(targets, st, false), 'export-btn']]);
}
async function aiTranscribe(c) {
  const A = await aiReady(); if (!A.manifest.whisper) return toast('Brak modelu Whisper w tej kompilacji', 4000);
  const st = { lang: 'polish' };
  modal('Transkrypcja', b => captionLangPicker(b, st), [['Anuluj', null], ['Transkrybuj', () => runCaptions([c], st, true), 'export-btn']]);
}
async function runCaptions(targets, st, transcriptOnly) {
  setTimeout(async () => {
    const A = AIx(); const pr = progress('Rozpoznawanie mowy (Whisper)', 'Ładowanie modelu…'); const t0 = performance.now();
    const tick = setInterval(() => pr.set(null, `Rozpoznawanie mowy… ${Math.round((performance.now() - t0) / 1000)} s`), 1000);
    const all = [];
    try {
      for (const c of targets) {
        const m = mediaOf(c), mm = media.get(m.id); const a0 = c.in, a1 = c.in + c.dur * c.speed;
        const segs = await A.transcribe(mm.blob, { language: st.lang, from: a0, to: a1, onProgress: p => pr.set(p * 0.5, 'Ładowanie modelu… ' + Math.round(p * 100) + '%') });
        for (const l of A.toCaptionLines(segs, transcriptOnly ? 1000 : 6)) {
          const s = c.start + (l.start - a0) / c.speed, e = c.start + (l.end - a0) / c.speed;
          if (e <= c.start || s >= c.start + c.dur) continue;
          all.push({ start: Math.max(c.start, s), end: Math.min(c.start + c.dur, e), text: l.text });
        }
      }
    } catch (e) { clearInterval(tick); pr.done(); return toast('Błąd rozpoznawania: ' + e.message, 6000); }
    clearInterval(tick); pr.done();
    if (!all.length) return toast('Nie rozpoznano mowy', 4000);
    all.sort((a, b) => a.start - b.start);
    if (transcriptOnly) return showTranscript(all);
    addCaptionClips(all, st.style);
  }, 50);
}
function addCaptionClips(lines, style) {
  commit();
  for (const l of lines) {
    const T = { content: l.text, size: 48, color: '#ffffff', font: 'system-ui', bold: true, stroke: '#000000', bg: '', shadow: true, anim: 'fade', align: 'center' };
    if (style === 'box') { T.stroke = ''; T.bg = 'rgba(0,0,0,0.65)'; T.shadow = false; }
    if (style === 'yellow') { T.color = '#ffd166'; }
    if (style === 'karaoke') { T.anim = 'pop'; T.font = 'Arial Black'; T.size = 54; }
    P.clips.push({ id: uid(), track: 'text', caption: true, start: l.start, dur: Math.max(0.3, l.end - l.start), in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, x: 0, y: P.aspect === '9:16' ? 0.28 : 0.36, scale: 1, rot: 0, opacity: 1, text: T });
  }
  refresh(); save(); toast(`Dodano ${lines.length} napisów`, 3000);
}
function showTranscript(lines) {
  const A = AIx(); const txt = lines.map(l => l.text).join(' ');
  modal('Transkrypcja', b => { const ta = document.createElement('textarea'); ta.value = txt; ta.style.minHeight = '220px'; b.appendChild(ta); }, [
    ['Zapisz .txt', () => { saveFile(new Blob([$('textarea', tm.body).value], { type: 'text/plain' }), (P.name || 'transkrypcja') + '.txt'); return false; }],
    ['Zapisz .srt', () => { saveFile(new Blob([A.toSRT(A.toCaptionLines(lines.map(l => ({ ...l })), 7))], { type: 'text/plain' }), (P.name || 'napisy') + '.srt'); return false; }],
    ['Dodaj jako napisy', () => addCaptionClips(A.toCaptionLines(lines, 6), 'classic'), 'export-btn']]);
}

/* ---------- auto montage ---------- */
async function autoMontage(after = []) {
  const files = await pickFiles('video/*,image/*'); if (!files.length) return;
  const st = { music: null, style: 'dynamic', aspect: '9:16' };
  modal('Automatyczny montaż', b => {
    b.insertAdjacentHTML('beforeend', `<p class="muted">Wybrano ${files.length} plików. AI oceni ujęcia (ruch, ostrość, twarze) i zmontuje je w rytm muzyki.</p>`);
    const mb = document.createElement('button'); mb.className = 'chip'; mb.textContent = '♫ Wybierz muzykę (opcjonalnie)';
    mb.onclick = async () => { const f = await pickFiles('audio/*', false); if (f[0]) { st.music = f[0]; mb.textContent = '♫ ' + f[0].name; mb.classList.add('on'); } }; b.appendChild(mb);
    heading(b, 'Tempo'); chips(b, [['dynamic', 'Dynamiczne'], ['calm', 'Spokojne']], st.style, v => st.style = v);
    heading(b, 'Format'); chips(b, [['9:16', '9:16'], ['16:9', '16:9'], ['1:1', '1:1']], st.aspect, v => st.aspect = v);
  }, [['Anuluj', null], ['Zmontuj', () => { setTimeout(() => doMontage(files, st, after), 50); }, 'export-btn']]);
}
async function doMontage(files, st, after) {
  const A = await aiReady(); const pr = progress('Automatyczny montaż', 'Import…');
  try {
    const p = newProject(st.aspect); p.name = 'Automontaż ' + new Date().toLocaleDateString(); await openProject(p);
    const ms = await importFiles(files, null, true);
    let musicMedia = null; if (st.music) musicMedia = (await importFiles([st.music], null, true))[0];
    const items = ms.filter(m => m.type !== 'audio').map(m => ({ media: m, url: media.get(m.id).url, blob: media.get(m.id).blob }));
    const plan = await A.planMontage(items, musicMedia ? { blob: media.get(musicMedia.id).blob, duration: musicMedia.duration } : null, { style: st.style, onProgress: (x, msg) => pr.set(x, msg) });
    P.clips = [];
    for (const pc of plan.clips) {
      const m = P.media.find(x => x.id === pc.mediaId); const c = baseClip(m, 'main');
      Object.assign(c, { in: pc.in, dur: pc.dur, transition: pc.transition, filter: FILTERS[1][1], volume: musicMedia ? 0.15 : 1, fit: 'cover' });
      if (pc.image) c.scale = 1.08; P.clips.push(c);
    }
    if (musicMedia) { const mc = baseClip(musicMedia, 'audio'); const tot = plan.clips.reduce((s, c) => s + c.dur, 0); mc.in = plan.offset || 0; mc.dur = Math.min(musicMedia.duration - mc.in, tot); mc.fadeOut = 1.5; P.clips.push(mc); }
    if (P.clips.length) { const last = mainClips().slice(-1)[0]; last.fadeOut = 0.6; }
    undoStack = []; syncEls(); layoutMain(); refresh(); save(); seek(0); pr.done();
    toast(`Zmontowano ${plan.clips.length} ujęć${plan.bpm ? ` · ${plan.bpm} BPM` : ''}`, 4000);
    for (const a of after) await aiAction(a, mainClips()[0]);
  } catch (e) { console.error(e); pr.done(); toast('Błąd montażu: ' + e.message, 6000); }
}

/* ---------- cover / frame capture ---------- */
async function exportPNG(name, maxSide = 0, title = null) {
  const prevSel = sel; sel = null;
  let w = canvas.width, h = canvas.height;
  if (maxSide) { renderRes = Math.max(480, Math.round(Math.min(maxSide, 2048) * Math.min(w, h) / Math.max(w, h))); setCanvasSize(); }
  for (const c of P.clips) { const el = els.get(c.id); if (el && active(c, t)) await new Promise(r => { if (el.readyState >= 2 && !el.seeking) r(); else { el.addEventListener('seeked', r, { once: true }); setTimeout(r, 1500); } }); }
  render(t);
  if (title) drawCoverTitle(title);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  sel = prevSel; renderRes = 0; setCanvasSize(); render(t);
  await saveFile(blob, name.replace(/[\\/:*?"<>|]+/g, '_'));
}
function drawCoverTitle(o) {
  const W = canvas.width, H = canvas.height; const size = W / 720 * o.size;
  ctx.save(); const g = ctx.createLinearGradient(0, H * 0.55, 0, H); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.7)'); ctx.fillStyle = g; ctx.fillRect(0, H * 0.55, W, H * 0.45);
  ctx.font = `800 ${size}px ${o.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const lines = o.text.split('\n'); lines.forEach((l, i) => { const y = H * 0.8 + (i - (lines.length - 1) / 2) * size * 1.1;
    ctx.lineWidth = size * 0.14; ctx.strokeStyle = '#000'; ctx.strokeText(l, W / 2, y); ctx.fillStyle = o.color; ctx.fillText(l, W / 2, y); });
  ctx.restore();
}
function sheetCover() {
  const o = { text: '', size: 90, color: '#ffffff', font: 'Arial Black' };
  modal('Klatka / okładka', b => {
    b.insertAdjacentHTML('beforeend', '<p class="muted small">Zapisuje bieżącą klatkę jako PNG. Dodaj tytuł, aby utworzyć okładkę.</p>');
    const ta = document.createElement('textarea'); ta.placeholder = 'Tytuł okładki (opcjonalnie)'; ta.oninput = () => o.text = ta.value; b.appendChild(ta);
    heading(b, 'Kolor tytułu'); chips(b, [['#ffffff', 'Biały'], ['#ffd166', 'Żółty'], ['#ff4d6d', 'Czerwony'], ['#22d3a6', 'Miętowy']], o.color, v => o.color = v);
    heading(b, 'Czcionka'); chips(b, [['Arial Black', 'Gruba'], ['Georgia', 'Szeryfowa'], ['Impact', 'Impact']], o.font, v => o.font = v);
  }, [['Anuluj', null], ['Zapisz PNG', () => exportPNG((P.name || 'klatka') + '_' + fmt(t).replace(/[:.]/g, '-') + '.png', 1920, o.text.trim() ? o : null), 'export-btn']]);
}

/* ---------- voice over ---------- */
async function voiceOver() {
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { return toast('Brak dostępu do mikrofonu', 4000); }
  const chunks = []; const rec = new MediaRecorder(stream); const start = t; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach(x => x.stop()); setPlaying(false);
    const f = new File(chunks, 'Lektor ' + new Date().toLocaleTimeString().replace(/:/g, '-') + '.webm', { type: rec.mimeType || 'audio/webm' });
    const prevT = t; t = start; const cl = await importFiles([f], 'audio'); t = prevT; if (cl[0]) { cl[0].start = start; cl[0].voice = true; layoutMain(); refresh(); save(); }
  };
  modal('Nagrywanie głosu', b => b.innerHTML = '<div class="spinner"></div><p class="center">Nagrywanie… Wideo jest odtwarzane, abyś mógł mówić do obrazu.</p>', [['Zatrzymaj', () => rec.stop(), 'export-btn']]);
  rec.start(); setPlaying(true);
}

/* ---------- camera + teleprompter ---------- */
const cam = { stream: null, rec: null, facing: 'user', chunks: [], t0: 0, intoProject: false, prompter: false, text: '', speed: 40, pos: 0 };
async function openCamera(intoProject, prompter = false) {
  cam.intoProject = intoProject && !!P; cam.prompter = prompter;
  showScreen('camera'); await startCam();
  $('#prompter').hidden = !prompter; if (prompter && !cam.text) editPrompter(); else setPrompter();
}
async function startCam() {
  if (cam.stream) cam.stream.getTracks().forEach(x => x.stop());
  try { cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: cam.facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true }); }
  catch (e) { toast('Brak dostępu do kamery: ' + e.message, 4000); closeCamera(); return; }
  const v = $('#camVideo'); v.srcObject = cam.stream; v.classList.toggle('mirror', cam.facing === 'user'); v.play().catch(() => {});
}
function closeCamera() {
  if (cam.rec && cam.rec.state !== 'inactive') cam.rec.stop();
  if (cam.stream) cam.stream.getTracks().forEach(x => x.stop()); cam.stream = null;
  showScreen(cam.intoProject ? 'editor' : 'home');
}
function setPrompter() { $('#prompterText').textContent = cam.text || 'Dotknij „Teleprompter”, aby wpisać tekst.'; cam.pos = 0; $('#prompterText').style.transform = 'translateY(0)'; }
function editPrompter() {
  modal('Teleprompter', b => {
    const ta = document.createElement('textarea'); ta.value = cam.text; ta.placeholder = 'Wklej lub wpisz tekst do przeczytania…'; ta.style.minHeight = '160px'; ta.oninput = () => cam.text = ta.value; b.appendChild(ta);
    range(b, 'Prędkość', cam.speed, 10, 120, 1, v => cam.speed = v);
  }, [['Ukryj', () => { cam.prompter = false; $('#prompter').hidden = true; }], ['Gotowe', () => { cam.prompter = true; $('#prompter').hidden = false; setPrompter(); }, 'export-btn']]);
}
$('#camClose').onclick = closeCamera;
$('#camFlip').onclick = () => { cam.facing = cam.facing === 'user' ? 'environment' : 'user'; startCam(); };
$('#camPrompterBtn').onclick = editPrompter;
$('#camRec').onclick = () => {
  const btn = $('#camRec');
  if (cam.rec && cam.rec.state === 'recording') { cam.rec.stop(); return; }
  if (!cam.stream) return;
  cam.chunks = []; const mime = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  cam.rec = new MediaRecorder(cam.stream, mime ? { mimeType: mime } : undefined);
  cam.rec.ondataavailable = e => e.data.size && cam.chunks.push(e.data);
  cam.rec.onstop = async () => {
    btn.classList.remove('on'); const type = cam.rec.mimeType || 'video/webm';
    const f = new File(cam.chunks, 'Nagranie ' + new Date().toLocaleString().replace(/[/:, ]+/g, '-') + (type.includes('mp4') ? '.mp4' : '.webm'), { type });
    const into = cam.intoProject; closeCamera();
    if (into) await importFiles([f]); else await newWith([f], '9:16');
  };
  cam.rec.start(250); cam.t0 = performance.now(); btn.classList.add('on'); setPrompter();
  const loop = () => { if (!cam.rec || cam.rec.state !== 'recording') return; const el = (performance.now() - cam.t0) / 1000; $('#camTimer').textContent = fmt(el);
    if (cam.prompter) { cam.pos = el * cam.speed; $('#prompterText').style.transform = `translateY(${-cam.pos}px)`; } requestAnimationFrame(loop); };
  loop();
};

/* ---------- collage ---------- */
const LAYOUTS = {
  2: [[[0, 0, .5, 1], [.5, 0, .5, 1]], [[0, 0, 1, .5], [0, .5, 1, .5]]],
  3: [[[0, 0, 1, .5], [0, .5, .5, .5], [.5, .5, .5, .5]], [[0, 0, .5, 1], [.5, 0, .5, .5], [.5, .5, .5, .5]], [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]]],
  4: [[[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]], [[0, 0, 1, .6], [0, .6, 1 / 3, .4], [1 / 3, .6, 1 / 3, .4], [2 / 3, .6, 1 / 3, .4]]],
};
function gridLayout(n) { const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols); const out = []; for (let i = 0; i < n; i++) out.push([(i % cols) / cols, Math.floor(i / cols) / rows, 1 / cols, 1 / rows]); return out; }
async function collage() {
  const files = (await pickFiles('image/*')).slice(0, 9); if (files.length < 2) return files.length && toast('Wybierz co najmniej 2 zdjęcia');
  const imgs = await Promise.all(files.map(f => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = URL.createObjectURL(f); }))).then(a => a.filter(Boolean));
  const st = { layout: 0, aspect: '1:1', gap: 12, radius: 16, bg: '#ffffff' };
  const layouts = () => [...(LAYOUTS[imgs.length] || []), gridLayout(imgs.length)];
  const draw = cv => {
    const [aw, ah] = ASPECTS[st.aspect]; const W = 1600, H = Math.round(W * ah / aw); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.fillStyle = st.bg; g.fillRect(0, 0, W, H); const L = layouts()[st.layout % layouts().length]; const gp = st.gap * 2;
    L.forEach(([x, y, w, h], i) => { const im = imgs[i]; if (!im) return; const rx = x * W + gp / 2 + (x === 0 ? gp / 2 : 0), ry = y * H + gp / 2 + (y === 0 ? gp / 2 : 0);
      const rw = w * W - gp - (x === 0 ? gp / 2 : 0) - (x + w >= 0.999 ? gp / 2 : 0) + gp / 2 * 0, rh = h * H - gp - (y === 0 ? gp / 2 : 0) - (y + h >= 0.999 ? gp / 2 : 0);
      const k = Math.max(rw / im.width, rh / im.height); g.save(); g.beginPath(); const r = st.radius * 2;
      g.moveTo(rx + r, ry); g.arcTo(rx + rw, ry, rx + rw, ry + rh, r); g.arcTo(rx + rw, ry + rh, rx, ry + rh, r); g.arcTo(rx, ry + rh, rx, ry, r); g.arcTo(rx, ry, rx + rw, ry, r); g.clip();
      g.drawImage(im, rx + (rw - im.width * k) / 2, ry + (rh - im.height * k) / 2, im.width * k, im.height * k); g.restore(); });
  };
  modal('Kolaż', b => {
    const cv = document.createElement('canvas'); cv.className = 'preview'; b.appendChild(cv); const re = () => draw(cv); re();
    heading(b, 'Układ'); chips(b, layouts().map((_, i) => [i, 'Układ ' + (i + 1)]), 0, v => { st.layout = v; re(); });
    heading(b, 'Format'); chips(b, [['1:1', '1:1'], ['4:5', '4:5'], ['9:16', '9:16'], ['16:9', '16:9']], st.aspect, v => { st.aspect = v; re(); });
    range(b, 'Odstęp', st.gap, 0, 40, 1, v => { st.gap = v; re(); }); range(b, 'Zaokrąglenie', st.radius, 0, 60, 1, v => { st.radius = v; re(); });
    heading(b, 'Tło'); chips(b, [['#ffffff', 'Białe'], ['#000000', 'Czarne'], ['#7c5cff', 'Fiolet'], ['#ffd166', 'Żółte']], st.bg, v => { st.bg = v; re(); });
  }, [['Zamknij', null], ['Zapisz PNG', () => { const cv = $('canvas', tm.body); cv.toBlob(b => saveFile(b, 'Kolaz_' + Date.now() + '.png'), 'image/png'); }, 'export-btn']]);
}

/* ---------- photo editor ---------- */
async function photoEditor(after) {
  const f = (await pickFiles('image/*', false))[0]; if (!f) return;
  const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = URL.createObjectURL(f); });
  const g = (a, b) => b ? g(b, a % b) : a; const d = g(img.naturalWidth, img.naturalHeight);
  await newWith([f], 'orig', { photo: true, customAspect: [img.naturalWidth / d, img.naturalHeight / d], name: f.name.replace(/\.[^.]+$/, '') });
  const c = mainClips()[0]; if (c) { c.fit = 'contain'; select(c.id); }
  toast('Tryb zdjęcia: „Eksportuj” zapisuje PNG', 3000);
  if (after && c) await aiAction(after, c);
}

/* ---------- icons (original line icons) ---------- */
const ICONS = {
  montage: '<rect x="3" y="5" width="15" height="12" rx="2"/><path d="M9 9l4 2-4 2z"/><path d="M20 12l-2 4h3l-2 4"/>',
  cc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10.5a2 2 0 1 0 0 3M16 10.5a2 2 0 1 0 0 3"/>',
  lines: '<path d="M4 6h16M4 10h10M4 14h16M4 18h8"/><path d="M19 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>',
  bg: '<circle cx="12" cy="9" r="3.2"/><path d="M5.5 20c1-3.6 3.6-5.5 6.5-5.5s5.5 1.9 6.5 5.5"/><path d="M3 3h3M3 3v3M21 3h-3M21 3v3"/>',
  blur: '<circle cx="12" cy="9" r="3"/><path d="M6 20c1-3.4 3.3-5 6-5s5 1.6 6 5"/><circle cx="4" cy="6" r="1"/><circle cx="20" cy="7" r="1.3"/><circle cx="19" cy="15" r=".8"/><circle cx="4" cy="14" r="1.2"/>',
  splash: '<circle cx="12" cy="9" r="3"/><path d="M6 20c1-3.4 3.3-5 6-5s5 1.6 6 5"/><path d="M3 21L21 3"/>',
  swap: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 14l3-3 2 2 3-4 3 5"/><circle cx="8" cy="8" r="1.4"/>',
  face: '<path d="M7 4.5A8 8 0 1 0 19 8"/><circle cx="9.5" cy="11" r=".6"/><circle cx="14.5" cy="11" r=".6"/><path d="M9.5 15c1.4 1.2 3.6 1.2 5 0"/><path d="M19 2l.8 1.8L21.6 4.6l-1.8.8L19 7.2l-.8-1.8-1.8-.8 1.8-.8z"/>',
  wand: '<path d="M4 20L15 9"/><path d="M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 11l.7 1.3 1.3.7-1.3.7L19 15l-.7-1.3L17 13l1.3-.7z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  magic: '<path d="M5 19l2-6 4 4z"/><path d="M11 17l5-5"/><path d="M15 3l1 2.5L18.5 6.5 16 7.5 15 10l-1-2.5L11.5 6.5 14 5.5z"/><path d="M20 12l.6 1.4 1.4.6-1.4.6L20 16l-.6-1.4L18 14l1.4-.6z"/>',
  crop: '<path d="M7 3v14h14"/><path d="M3 7h14v14"/><circle cx="12" cy="12" r="2"/>',
  cut: '<circle cx="6" cy="18" r="2.5"/><circle cx="16" cy="18" r="2.5"/><path d="M7.5 16L17 3M14.5 16L7 5"/><path d="M19 8h2M19 11h3"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.6"/><path d="M3 17l5-5 4 4 3-3 6 6"/>',
  collage: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M12 11h9"/>',
  frame: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M10 9l5 3-5 3z"/>',
  cover: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 16h8M8 13h5"/><path d="M15 6l2 2-4 4h-2v-2z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  prompter: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 8h10M7 11h7M9 20h6M12 16v4"/>',
  templates: '<rect x="4" y="3" width="11" height="18" rx="2"/><path d="M18 6v12M21 8v8"/><path d="M8 10l4 2-4 2z"/>',
  all: '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="7" cy="17" r="3"/><circle cx="17" cy="17" r="3"/>',
};
const ICON = k => `<svg viewBox="0 0 24 24">${ICONS[k] || ''}</svg>`;

/* ---------- tool registry ---------- */
const pickVideoThen = (id, accept = 'video/*') => async () => { const f = await pickFiles(accept, false); if (!f.length) return; const cl = await newWith(f, '9:16'); if (cl[0]) { select(cl[0].id); await aiAction(id, cl[0]); } };
const TOOLS = {
  automontage: { name: 'Automatyczny montaż', icon: 'montage', ai: 1, cat: 'ai', run: () => autoMontage() },
  captions: { name: 'Automatyczne napisy', icon: 'cc', ai: 1, cat: 'ai', run: pickVideoThen('captions', 'video/*,audio/*') },
  retouch: { name: 'Retusz', icon: 'face', ai: 1, cat: 'ai', run: pickVideoThen('retouch', 'video/*,image/*') },
  bgremove: { name: 'Usuń tło', icon: 'bg', ai: 1, cat: 'ai', run: pickVideoThen('bgremove', 'video/*') },
  styles: { name: 'Efekty AI', icon: 'magic', ai: 1, cat: 'ai', run: pickVideoThen('styles', 'video/*,image/*') },
  silence: { name: 'Przycięcie AI', icon: 'cut', ai: 1, cat: 'ai', run: pickVideoThen('silence', 'video/*,audio/*') },
  reframe: { name: 'Inteligentne kadrowanie', icon: 'crop', ai: 1, cat: 'ai', run: pickVideoThen('reframe') },
  enhance: { name: 'Automatyczne ulepszanie', icon: 'wand', ai: 1, cat: 'ai', run: pickVideoThen('enhance', 'video/*,image/*') },
  lighting: { name: 'Inteligentne oświetlenie', icon: 'sun', ai: 1, cat: 'ai', run: pickVideoThen('lighting', 'video/*,image/*') },
  transcribe: { name: 'Transkrybuj film', icon: 'lines', ai: 1, cat: 'quick', run: pickVideoThen('transcribe', 'video/*,audio/*') },
  photo: { name: 'Edytor zdjęć AI', icon: 'photo', ai: 1, cat: 'photo', run: () => photoEditor() },
  photobg: { name: 'Usuń tło ze zdjęcia', icon: 'bg', ai: 1, cat: 'photo', run: () => photoEditor('bgremove') },
  photoenh: { name: 'Ulepsz zdjęcie', icon: 'wand', ai: 1, cat: 'photo', run: () => photoEditor('enhance') },
  collage: { name: 'Kolaż', icon: 'collage', cat: 'photo', run: collage },
  frame: { name: 'Przechwytywanie klatek', icon: 'frame', cat: 'photo', run: async () => { const f = await pickFiles('video/*', false); if (f.length) { await newWith(f); sheetCover(); } } },
  cover: { name: 'Kreator okładek', icon: 'cover', cat: 'photo', run: async () => { const f = await pickFiles('video/*,image/*', false); if (f.length) { await newWith(f); sheetCover(); } } },
  camera: { name: 'Aparat', icon: 'camera', cat: 'rec', run: () => openCamera(false) },
  voice: { name: 'Nagraj', icon: 'mic', cat: 'rec', run: async () => { if (!P || !$('#editor').classList.contains('active')) { await openProject(newProject('9:16')); } voiceOver(); } },
  teleprompter: { name: 'Teleprompter', icon: 'prompter', cat: 'rec', run: () => openCamera(false, true) },
  templates: { name: 'Szablony', icon: 'templates', cat: 'quick', run: () => switchTab('templates') },
};
const CATS = [['ai', 'Generatywna i analityczna AI (offline)'], ['photo', 'Edycja zdjęć'], ['rec', 'Rób zdjęcia i nagrywaj'], ['quick', 'Szybkie działania']];
function toolBtn(id) { const T = TOOLS[id]; const b = document.createElement('button'); b.className = 'tbtn'; b.innerHTML = `<span class="ic${T.ai ? ' ai' : ''}">${ICON(T.icon)}</span>${T.name}`; b.onclick = () => { $('#allTools').classList.remove('open'); T.run(); }; return b; }
function buildHomeTools() {
  const q = $('#quickTools'); q.innerHTML = '';
  for (const id of ['automontage', 'retouch', 'captions', 'bgremove', 'styles', 'silence', 'enhance', 'collage', 'camera', 'photo', 'teleprompter']) q.appendChild(toolBtn(id));
  const all = document.createElement('button'); all.className = 'tbtn'; all.innerHTML = `<span class="ic">${ICON('all')}</span>Wszystkie narzędzia (${Object.keys(TOOLS).length})`;
  all.onclick = () => $('#allTools').classList.add('open'); q.appendChild(all);
  const body = $('#allToolsBody'); body.innerHTML = '';
  for (const [cat, title] of CATS) { const h = document.createElement('h4'); h.textContent = title; body.appendChild(h); const g = document.createElement('div'); g.className = 'tool-grid'; for (const id in TOOLS) if (TOOLS[id].cat === cat) g.appendChild(toolBtn(id)); body.appendChild(g); }
}
$('#allToolsClose').onclick = () => $('#allTools').classList.remove('open');

/* ---------- tabs ---------- */
function switchTab(name) {
  $$('.bottom-nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  tplAnim = name === 'templates'; if (tplAnim) requestAnimationFrame(animTemplates);
  if (name === 'ai') renderEngines();
}
$$('.bottom-nav button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$('#photoEditor').onclick = () => photoEditor();

/* ---------- templates (original designs) ---------- */
const TEMPLATES = [
  { id: 'countdown', name: 'Kinowe odliczanie', cat: 'Klimat', aspect: '9:16', filter: 'Retro', vig: .5, slots: [1.6, 1.6, 1.6, 1.6, 1.6], trans: ['fade'],
    texts: [['3', 0, .6, 'pop', 220, 0, 'Impact'], ['2', .6, .6, 'pop', 220, 0, 'Impact'], ['1', 1.2, .6, 'pop', 220, 0, 'Impact']], hue: 30 },
  { id: 'memories', name: 'Pokaz wspomnień', cat: 'Vlog', aspect: '9:16', filter: 'Sen', slots: [2, 2, 2, 2, 2, 2], trans: ['zoom', 'fade'], texts: [['Wspomnienia', 0, 2.6, 'type', 80, -.3, 'Georgia']], hue: 300 },
  { id: 'weekend', name: 'Weekendowy vlog', cat: 'Vlog', aspect: '9:16', filter: 'Ciepły', slots: [1.4, 1.4, 1.4, 1.4, 1.4, 1.4], trans: ['slideL'], texts: [['WEEKEND', 0, 2, 'pop', 120, -.05, 'Arial Black'], ['mój vlog', .4, 1.6, 'slide', 60, .07, 'Georgia']], hue: 25 },
  { id: 'fast', name: 'Szybkie cięcia', cat: 'Szybkie', aspect: '9:16', filter: 'Żywy', slots: Array(10).fill(.5), trans: ['spin', 'zoom', 'slideU'], texts: [['GO!', 0, 1, 'bounce', 160, 0, 'Impact']], hue: 200 },
  { id: 'travel', name: 'W drogę', cat: 'Vlog', aspect: '9:16', filter: 'Chłodny', slots: [2, 2, 2, 2, 2], trans: ['slideU', 'fade'], texts: [['W DROGĘ', 0, 2.2, 'pop', 110, 0, 'Arial Black']], hue: 190 },
  { id: 'noir', name: 'Rozdział pierwszy', cat: 'Klimat', aspect: '16:9', filter: 'Noir', vig: .6, slots: [2.2, 2.2, 2.2, 2.2, 2.2], trans: ['fade'], texts: [['Rozdział I', 0, 3, 'type', 90, 0, 'Georgia']], hue: 0, mono: true },
  { id: 'neon', name: 'Neonowa noc', cat: 'Szybkie', aspect: '9:16', filter: 'Neon', slots: [1.2, 1.2, 1.2, 1.2, 1.2, 1.2], trans: ['zoom', 'blur'], texts: [['NOCNE MIASTO', 0, 2, 'pop', 90, 0, 'Arial Black', '#ff4d6d']], hue: 320 },
  { id: 'crew', name: 'Nasza ekipa', cat: 'Tekst', aspect: '9:16', filter: 'Żywy', slots: [2, 2, 2], trans: ['slideL'], texts: [['NASZA EKIPA', 0, 2.5, 'bounce', 100, -.25, 'Arial Black', '#4cc9f0']], hue: 220 },
  { id: 'quote', name: 'Cytat dnia', cat: 'Tekst', aspect: '1:1', filter: 'Mat', slots: [5], trans: ['fade'], texts: [['Każdy dzień\nto nowa scena', .3, 4.5, 'type', 80, 0, 'Georgia']], hue: 140 },
];
let tplAnim = false, tplCat = 'Wszystkie';
function buildTemplates() {
  const cats = ['Wszystkie', ...new Set(TEMPLATES.map(t => t.cat))]; const cw = $('#tplCats'); cw.innerHTML = '';
  for (const c of cats) { const b = document.createElement('button'); b.className = 'chip' + (c === tplCat ? ' on' : ''); b.textContent = c; b.onclick = () => { tplCat = c; buildTemplates(); }; cw.appendChild(b); }
  const g = $('#tplGrid'); g.innerHTML = '';
  for (const T of TEMPLATES) {
    if (tplCat !== 'Wszystkie' && T.cat !== tplCat) continue;
    const d = document.createElement('button'); d.className = 'tpl'; const cv = document.createElement('canvas'); cv.width = 180; cv.height = 280; cv.dataset.tpl = T.id;
    d.appendChild(cv); d.insertAdjacentHTML('beforeend', `<div class="meta"><b></b><br><span></span></div>`); $('b', d).textContent = T.name;
    $('span', d).textContent = `${T.slots.length} klipów · ${T.slots.reduce((a, b) => a + b, 0).toFixed(0)} s`; d.onclick = () => applyTemplate(T.id); g.appendChild(d);
  }
}
function animTemplates(ts) {
  if (!tplAnim) return;
  for (const cv of $$('#tplGrid canvas')) {
    const T = TEMPLATES.find(x => x.id === cv.dataset.tpl); const g = cv.getContext('2d'); const W = cv.width, H = cv.height; const tt = (ts / 1000) % (T.slots.reduce((a, b) => a + b, 0));
    let acc = 0, idx = 0; for (; idx < T.slots.length; idx++) { if (tt < acc + T.slots[idx]) break; acc += T.slots[idx]; }
    const hue = (T.hue + idx * 37) % 360; const gr = g.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, T.mono ? `hsl(0,0%,${20 + idx * 8}%)` : `hsl(${hue},70%,45%)`); gr.addColorStop(1, T.mono ? '#111' : `hsl(${(hue + 60) % 360},70%,20%)`); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.12)'; for (let i = 0; i < 5; i++) { g.beginPath(); g.arc((i * 53 + tt * 30) % W, H * (0.2 + 0.15 * i), 18 + i * 4, 0, 7); g.fill(); }
    for (const [txt, s, d, anim, size, y, font, col] of T.texts) {
      if (tt < s || tt > s + d) continue; const p = Math.min(1, (tt - s) / 0.4); const sc = anim === 'pop' ? 0.5 + 0.5 * p : 1;
      g.save(); g.translate(W / 2, H / 2 + y * H); g.scale(sc, sc); g.globalAlpha = anim === 'fade' || anim === 'slide' ? p : 1; g.font = `700 ${size / 4}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 4; g.strokeStyle = '#000'; const shown = anim === 'type' ? txt.slice(0, Math.ceil(txt.length * Math.min(1, (tt - s) / 1.5))) : txt;
      shown.split('\n').forEach((l, i, a) => { g.strokeText(l, 0, (i - (a.length - 1) / 2) * size / 3.6); g.fillStyle = col || '#fff'; g.fillText(l, 0, (i - (a.length - 1) / 2) * size / 3.6); }); g.restore();
    }
  }
  requestAnimationFrame(animTemplates);
}
async function applyTemplate(id) {
  const T = TEMPLATES.find(x => x.id === id); if (!T) return;
  const files = await pickFiles('video/*,image/*'); if (!files.length) return;
  const p = newProject(T.aspect); p.name = T.name; await openProject(p);
  const ms = (await importFiles(files, null, true)).filter(m => m.type !== 'audio');
  if (!ms.length) return;
  P.clips = []; const fl = (FILTERS.find(f => f[0] === T.filter) || FILTERS[0])[1];
  T.slots.forEach((d, i) => {
    const m = ms[i % ms.length]; const c = baseClip(m, 'main'); const used = Math.floor(i / ms.length);
    c.in = m.type === 'video' ? Math.min(Math.max(0, m.duration - d), used * d) : 0; c.dur = m.type === 'video' ? Math.min(d, m.duration) : d;
    c.transition = i === 0 ? 'fade' : T.trans[i % T.trans.length]; c.filter = fl; c.fit = 'cover'; if (T.vig) c.adj.vig = T.vig; P.clips.push(c);
  });
  for (const [txt, s, d, anim, size, y, font, col] of T.texts)
    P.clips.push({ id: uid(), track: 'text', start: s, dur: d, in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0.2, x: 0, y, scale: 1, rot: 0, opacity: 1,
      text: { content: txt, size, color: col || '#ffffff', font, bold: true, stroke: '#000000', bg: '', shadow: true, anim, align: 'center' } });
  undoStack = []; syncEls(); layoutMain(); refresh(); save(); seek(0); toast('Szablon zastosowany — możesz go dowolnie edytować');
}

/* ---------- Lab AI ---------- */
const AI_QUICK = ['automontage', 'captions', 'bgremove', 'retouch', 'styles', 'enhance', 'silence', 'reframe'];
function buildAILab() {
  const w = $('#aiActions'); w.innerHTML = '';
  for (const id of AI_QUICK) { const b = document.createElement('button'); b.innerHTML = ICON(TOOLS[id].icon) + TOOLS[id].name; b.onclick = TOOLS[id].run; w.appendChild(b); }
}
async function runCommand(text) {
  const A = await aiReady(); const acts = A.parseCommand(text || '');
  if (!acts.length) return toast('Nie rozpoznano polecenia. Spróbuj np. „usuń tło”, „dodaj napisy”, „zmontuj w rytm muzyki”.', 5000);
  $('#aiCmdHint').textContent = 'Rozpoznano: ' + acts.map(a => (TOOLS[a] || {}).name || a).join(' → ');
  const special = { collage, teleprompter: () => openCamera(false, true), camera: () => openCamera(false), voice: TOOLS.voice.run };
  if (special[acts[0]]) return special[acts[0]]();
  if (acts[0] === 'automontage') return autoMontage(acts.slice(1).filter(a => !special[a]));
  const f = await pickFiles('video/*,image/*,audio/*', false); if (!f.length) return;
  const cl = await newWith(f, acts.includes('reframe') ? '9:16' : '9:16'); const c = cl[0]; if (!c) return; select(c.id);
  for (const a of acts) { if (special[a]) continue; await aiAction(a === 'bgblur' ? 'bgblur' : a, c); }
}
$('#aiCmdGo').onclick = () => runCommand($('#aiCmd').value);
const ENGINES = [
  ['whisper', 'Whisper — rozpoznawanie mowy', 'Napisy, transkrypcja (99 języków)', () => AIx() && AIx().manifest.whisper ? AIx().manifest.whisper + ' · ONNX q8' : 'niedołączony w tej kompilacji'],
  ['vision', 'Segmentacja osób (wideo, czas rzeczywisty)', 'Usuwanie/rozmycie/zamiana tła', () => 'MediaPipe · 0,25 MB'],
  ['vision', 'Segmentacja HQ (6 klas)', 'Precyzyjne tło na zdjęciach (włosy, skóra, ubrania)', () => 'MediaPipe · 16 MB'],
  ['vision', 'Siatka twarzy 478 punktów', 'Retusz, oczy, rozjaśnienie', () => 'MediaPipe · 3,6 MB'],
  ['vision', 'Detektor twarzy', 'Oświetlenie, kadrowanie, montaż', () => 'BlazeFace · 0,2 MB'],
  ['dsp', 'Analiza rytmu i ciszy', 'Montaż w rytm, przycięcie pauz', () => 'Algorytm DSP'],
  ['dsp', 'Analiza obrazu', 'Auto ulepszanie, ocena ujęć, efekty', () => 'Algorytm'],
];
function renderEngines() {
  const A = AIx(); const list = $('#engineList'); list.innerHTML = '';
  for (const [key, name, desc, info] of ENGINES) {
    const st = key === 'dsp' ? 'ready' : A ? A.status[key] : 'idle';
    const lbl = { idle: 'gotowy do użycia', loading: 'ładowanie…', ready: 'aktywny', error: 'błąd' }[st];
    const d = document.createElement('div'); d.className = 'engine';
    d.innerHTML = `<div><b></b><span class="muted small"></span></div><span class="st ${st === 'ready' ? 'ok' : st === 'error' ? 'err' : ''}"></span>`;
    $('b', d).textContent = name; $('.muted', d).textContent = desc + ' · ' + info(); $('.st', d).textContent = key === 'whisper' && A && !A.manifest.whisper ? 'brak' : lbl; list.appendChild(d);
  }
  const badge = $('#aiBadge'); if (A) badge.textContent = A.manifest.whisper ? 'AI offline · 6 silników' : 'AI offline · 5 silników';
}
$('#engineTest').onclick = async () => {
  const A = await aiReady(); const pr = progress('Test silników AI', 'Ładowanie modeli wizyjnych…');
  const res = [];
  try { await A.loadVision(); res.push(`Wizja: OK (${A.timings.visionLoad} ms)`); } catch (e) { res.push('Wizja: błąd — ' + e.message); }
  if (A.manifest.whisper) { pr.set(0.5, 'Ładowanie Whisper…'); try { await A.loadWhisper(p => pr.set(0.5 + p * 0.5)); res.push(`Whisper: OK (${A.timings.whisperLoad} ms)`); } catch (e) { res.push('Whisper: błąd — ' + e.message); } }
  else res.push('Whisper: niedołączony w tej kompilacji');
  pr.done(); renderEngines(); modal('Wynik testu', b => { b.innerHTML = res.map(r => `<p>${r}</p>`).join('') + `<p class="muted small">crossOriginIsolated: ${self.crossOriginIsolated ? 'tak (wielowątkowo)' : 'nie (1 wątek)'}</p>`; });
};
aiReady().then(A => { A.events.addEventListener('status', renderEngines); renderEngines(); });

buildHomeTools(); buildTemplates(); buildAILab();

window.ClipForge = { get project() { return P; }, _doMontage: doMontage, _saveFile: saveFile, exportPNG, collage, aiAction, newWith, openTool: id => TOOLS[id] && TOOLS[id].run(), get selected() { return sel; }, select, applyTemplate, runCommand, importFiles, seek, setPlaying, splitAtPlayhead, addText, undo, redo, get time() { return t; } };
listProjects();
requestAnimationFrame(tick);
})();
