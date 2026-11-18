/* ClipForge AI — on-device engines bundled with the app (no cloud, works offline).
 *  - Whisper (ONNX, transformers.js)          → automatic captions, transcription
 *  - MediaPipe Selfie Multiclass segmentation → background removal / blur / colour splash
 *  - MediaPipe Face Landmarker (478 points)   → retouch (skin smoothing, eyes, brightening)
 *  - MediaPipe BlazeFace detector             → smart lighting, smart reframe, auto-montage scoring
 *  - Signal-processing engines                → beat detection, silence detection, auto enhance, styles
 */
const BASE = new URL('./ai/', import.meta.url).href;
const LIB = BASE + 'lib/', MODELS = BASE + 'models/';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const AI = {
  status: { vision: 'idle', whisper: 'idle' },
  manifest: { whisper: null },
  timings: {},
  events: new EventTarget(),
};
const emit = () => AI.events.dispatchEvent(new Event('status'));

fetch(MODELS + 'manifest.json').then(r => r.ok ? r.json() : {}).then(m => { AI.manifest = Object.assign(AI.manifest, m); emit(); }).catch(() => {});

/* ======================= Vision engines (MediaPipe) ======================= */
let vision = null, segmenter = null, segmenterHQ = null, hqPromise = null, landmarker = null, detector = null, visionPromise = null;
AI.delegate = (() => { try { return localStorage.getItem('cf-delegate') || 'GPU'; } catch (e) { return 'GPU'; } })();
async function createTask(Cls, opts) {
  if (AI.delegate === 'CPU') return await Cls.createFromOptions(vision, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } });
  try { return await Cls.createFromOptions(vision, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } }); }
  catch (e) { return await Cls.createFromOptions(vision, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }); }
}
AI.loadVision = function () {
  if (visionPromise) return visionPromise;
  AI.status.vision = 'loading'; emit();
  visionPromise = (async () => {
    const t0 = performance.now();
    const mp = await import(LIB + 'mediapipe/vision_bundle.mjs');
    vision = await mp.FilesetResolver.forVisionTasks(LIB + 'mediapipe');
    [segmenter, landmarker, detector] = await Promise.all([
      createTask(mp.ImageSegmenter, { baseOptions: { modelAssetPath: MODELS + 'selfie_segmenter.tflite' }, runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true }),
      createTask(mp.FaceLandmarker, { baseOptions: { modelAssetPath: MODELS + 'face_landmarker.task' }, runningMode: 'IMAGE', numFaces: 4 }),
      createTask(mp.FaceDetector, { baseOptions: { modelAssetPath: MODELS + 'blaze_face_short_range.tflite' }, runningMode: 'IMAGE', minDetectionConfidence: 0.5 }),
    ]);
    AI._mp = mp;
    // Some devices expose only a software GPU: benchmark and fall back to the CPU (XNNPACK) delegate if it is slow.
    if (AI.delegate !== 'CPU') {
      const tc = canvas(256, 256); tc.getContext('2d').fillRect(40, 40, 120, 160); segmenter.segment(tc).close();
      const t1 = performance.now(); for (let i = 0; i < 3; i++) segmenter.segment(tc).close(); const ms = (performance.now() - t1) / 3;
      AI.timings.gpuSegment = Math.round(ms);
      if (ms > 45) { AI.delegate = 'CPU'; segmenter.close(); landmarker.close(); detector.close();
        [segmenter, landmarker, detector] = await Promise.all([
          createTask(mp.ImageSegmenter, { baseOptions: { modelAssetPath: MODELS + 'selfie_segmenter.tflite' }, runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true }),
          createTask(mp.FaceLandmarker, { baseOptions: { modelAssetPath: MODELS + 'face_landmarker.task' }, runningMode: 'IMAGE', numFaces: 4 }),
          createTask(mp.FaceDetector, { baseOptions: { modelAssetPath: MODELS + 'blaze_face_short_range.tflite' }, runningMode: 'IMAGE', minDetectionConfidence: 0.5 })]); }
    }
    AI.timings.visionLoad = Math.round(performance.now() - t0);
    AI.status.vision = 'ready'; emit();
  })().catch(e => { console.error(e); AI.status.vision = 'error'; AI.status.visionError = String(e && e.message || e); visionPromise = null; emit(); throw e; });
  return visionPromise;
};

/** High-quality 6-class segmenter (hair/skin/clothes) used for photos. */
AI.loadHQ = function () {
  if (hqPromise) return hqPromise;
  hqPromise = AI.loadVision().then(() => createTask(AI._mp.ImageSegmenter, { baseOptions: { modelAssetPath: MODELS + 'selfie_multiclass_256x256.tflite' }, runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true }))
    .then(s => { segmenterHQ = s; return s; }).catch(e => { hqPromise = null; throw e; });
  return hqPromise;
};
function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; }

/** Person mask (alpha = person) as a 256×256 canvas. */
const maskCache = new WeakMap();
function personMask(img, key, hq) {
  const res = (hq && segmenterHQ ? segmenterHQ : segmenter).segment(img); const inv = !!(hq && segmenterHQ);
  try {
    const bg = res.confidenceMasks[0]; const w = bg.width, h = bg.height; const a = bg.getAsFloat32Array();
    let st = maskCache.get(key);
    if (!st || st.w !== w) { st = { w, h, prev: new Float32Array(w * h), c: canvas(w, h) }; st.id = st.c.getContext('2d').createImageData(w, h); maskCache.set(key, st); st.fresh = true; }
    const d = st.id.data, prev = st.prev; const k = st.fresh ? 1 : 0.65; st.fresh = false;
    for (let i = 0; i < a.length; i++) {
      let p = inv ? 1 - a[i] : a[i]; p = clamp((p - 0.15) / 0.7, 0, 1);  // sharpen the soft edge a bit
      p = prev[i] = prev[i] * (1 - k) + p * k;             // temporal smoothing against flicker
      const j = i * 4; d[j] = d[j + 1] = d[j + 2] = 255; d[j + 3] = p * 255;
    }
    st.c.getContext('2d').putImageData(st.id, 0, 0);
    return st.c;
  } finally { res.close && res.close(); }
}

/* Mesh contour indices (MediaPipe face mesh topology) */
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_R = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
const LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const BROW_L = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46], BROW_R = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
function poly(g, lm, idx, w, h, scale = 1) {
  let cx = 0, cy = 0; for (const i of idx) { cx += lm[i].x; cy += lm[i].y; } cx /= idx.length; cy /= idx.length;
  idx.forEach((i, n) => { const x = (cx + (lm[i].x - cx) * scale) * w, y = (cy + (lm[i].y - cy) * scale) * h; n ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.closePath();
}

const faceCache = new Map();
function faces(img, key, at) {
  const c = faceCache.get(key);
  if (c && Math.abs(c.at - at) < 0.06) return c.lm;
  const r = landmarker.detect(img); const lm = r.faceLandmarks || [];
  faceCache.set(key, { at, lm }); if (faceCache.size > 64) faceCache.delete(faceCache.keys().next().value);
  return lm;
}

/* ======================= Per-frame effect pipeline ======================= */
const work = new Map(); // clipId -> scratch canvases
function scratch(id, w, h) {
  let s = work.get(id);
  if (!s || s.a.width !== w || s.a.height !== h) { s = { a: canvas(w, h), b: canvas(w, h), o: canvas(w, h) }; work.set(id, s); }
  return s;
}
AI.hasEffects = c => !!(c.ai && ((c.ai.bg && c.ai.bg !== 'none') || (c.ai.style && c.ai.style !== 'none') || (c.ai.retouch && (c.ai.retouch.smooth || c.ai.retouch.bright || c.ai.retouch.eyes))));
AI.needsVision = c => !!(c.ai && ((c.ai.bg && c.ai.bg !== 'none') || (c.ai.retouch && (c.ai.retouch.smooth || c.ai.retouch.bright || c.ai.retouch.eyes))));

/** Returns a canvas with the processed frame, or null to draw the raw frame. */
AI.process = function (c, el, sw, sh, at) {
  if (!AI.hasEffects(c)) return null;
  if (AI.needsVision(c) && AI.status.vision !== 'ready') { if (AI.status.vision === 'idle') AI.loadVision().catch(() => {}); if (!(c.ai.style && c.ai.style !== 'none')) return null; }
  const k = Math.min(1, 960 / Math.max(sw, sh)); const w = Math.round(sw * k), h = Math.round(sh * k);
  const s = scratch(c.id, w, h); const A = s.a.getContext('2d'), B = s.b.getContext('2d'), O = s.o.getContext('2d');
  A.globalCompositeOperation = 'source-over'; A.filter = 'none'; A.globalAlpha = 1;
  A.clearRect(0, 0, w, h); A.drawImage(el, 0, 0, w, h);
  const ready = AI.status.vision === 'ready';
  const rt = c.ai.retouch;
  if (ready && rt && (rt.smooth || rt.bright || rt.eyes)) retouch(s, c, at, rt, w, h);
  if (c.ai.style && c.ai.style !== 'none') stylize(s, c.ai.style, w, h);
  const bg = c.ai.bg;
  if (ready && bg && bg !== 'none') {
    if (c.ai.hq && !segmenterHQ) AI.loadHQ().catch(() => {});
    const m = personMask(s.a, c, c.ai.hq);
    O.globalCompositeOperation = 'source-over'; O.filter = 'none'; O.clearRect(0, 0, w, h);
    if (bg === 'blur') { O.filter = `blur(${Math.round(w / 40 * (c.ai.bgAmount || 1))}px)`; O.drawImage(s.a, 0, 0); O.filter = 'none'; }
    else if (bg === 'color') { O.filter = 'grayscale(1)'; O.drawImage(s.a, 0, 0); O.filter = 'none'; }
    else if (bg === 'replace') { O.fillStyle = c.ai.bgColor || '#00b140'; O.fillRect(0, 0, w, h); }
    // person layer
    B.globalCompositeOperation = 'source-over'; B.clearRect(0, 0, w, h); B.drawImage(s.a, 0, 0);
    B.globalCompositeOperation = 'destination-in'; B.imageSmoothingQuality = 'high'; B.drawImage(m, 0, 0, w, h);
    B.globalCompositeOperation = 'source-over';
    O.drawImage(s.b, 0, 0);
    return s.o;
  }
  return s.a;
};

function retouch(s, c, at, rt, w, h) {
  const A = s.a.getContext('2d'), B = s.b.getContext('2d');
  const list = faces(s.a, c.id, at); if (!list.length) return;
  B.globalCompositeOperation = 'source-over'; B.clearRect(0, 0, w, h);
  B.filter = `blur(${Math.max(1.5, w / 260)}px) brightness(${1 + (rt.bright || 0) * 0.18})`; B.drawImage(s.a, 0, 0); B.filter = 'none';
  for (const lm of list) {
    // skin = face oval minus eyes, brows and lips (even-odd clip)
    A.save(); A.beginPath(); poly(A, lm, OVAL, w, h, 0.97);
    poly(A, lm, EYE_L, w, h, 1.5); poly(A, lm, EYE_R, w, h, 1.5); poly(A, lm, LIPS, w, h, 1.15);
    poly(A, lm, BROW_L, w, h, 1.25); poly(A, lm, BROW_R, w, h, 1.25);
    A.clip('evenodd'); A.globalAlpha = clamp((rt.smooth || 0) * 0.85 + (rt.bright ? 0.25 : 0), 0, 0.92); A.drawImage(s.b, 0, 0); A.restore();
    if (rt.eyes) {
      B.clearRect(0, 0, w, h); B.filter = `contrast(${1 + rt.eyes * 0.35}) brightness(${1 + rt.eyes * 0.2}) saturate(${1 + rt.eyes * 0.3})`; B.drawImage(s.a, 0, 0); B.filter = 'none';
      A.save(); A.beginPath(); poly(A, lm, EYE_L, w, h, 1.05); poly(A, lm, EYE_R, w, h, 1.05); A.clip(); A.drawImage(s.b, 0, 0); A.restore();
      B.clearRect(0, 0, w, h); B.filter = `blur(${Math.max(1.5, w / 260)}px) brightness(${1 + (rt.bright || 0) * 0.18})`; B.drawImage(s.a, 0, 0); B.filter = 'none';
    }
  }
}

function stylize(s, style, w, h) {
  const A = s.a.getContext('2d'), B = s.b.getContext('2d');
  if (style === 'sketch') {
    B.globalCompositeOperation = 'source-over'; B.filter = 'grayscale(1)'; B.drawImage(s.a, 0, 0);
    A.filter = `grayscale(1) invert(1) blur(${Math.max(2, w / 200)}px)`; A.drawImage(s.a, 0, 0); A.filter = 'none';
    B.filter = 'none'; B.globalCompositeOperation = 'color-dodge'; B.drawImage(s.a, 0, 0); B.globalCompositeOperation = 'source-over';
    A.clearRect(0, 0, w, h); A.filter = 'contrast(1.4)'; A.drawImage(s.b, 0, 0); A.filter = 'none'; return;
  }
  if (style === 'pixel') {
    const k = Math.max(4, Math.round(w / 90)); const sw = Math.ceil(w / k), sh = Math.ceil(h / k);
    B.imageSmoothingEnabled = true; B.clearRect(0, 0, w, h); B.drawImage(s.a, 0, 0, sw, sh);
    A.imageSmoothingEnabled = false; A.clearRect(0, 0, w, h); A.filter = 'saturate(1.4)'; A.drawImage(s.b, 0, 0, sw, sh, 0, 0, w, h); A.filter = 'none'; A.imageSmoothingEnabled = true; return;
  }
  // pixel-level styles run on a reduced copy for speed
  const k = Math.min(1, 480 / Math.max(w, h)); const pw = Math.round(w * k), ph = Math.round(h * k);
  B.clearRect(0, 0, w, h); B.drawImage(s.a, 0, 0, pw, ph);
  const img = B.getImageData(0, 0, pw, ph), d = img.data; const n = pw * ph;
  const L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const edge = i => { const x = i % pw; if (x === 0 || x === pw - 1 || i < pw || i >= n - pw) return 0;
    const gx = -L[i - pw - 1] - 2 * L[i - 1] - L[i + pw - 1] + L[i - pw + 1] + 2 * L[i + 1] + L[i + pw + 1];
    const gy = -L[i - pw - 1] - 2 * L[i - pw] - L[i - pw + 1] + L[i + pw - 1] + 2 * L[i + pw] + L[i + pw + 1];
    return Math.sqrt(gx * gx + gy * gy); };
  if (style === 'cartoon' || style === 'comic') {
    const lv = style === 'comic' ? 4 : 6; const q = 255 / (lv - 1);
    for (let i = 0; i < n; i++) {
      const e = edge(i); const j = i * 4;
      if (e > (style === 'comic' ? 110 : 140)) { d[j] = d[j + 1] = d[j + 2] = 20; continue; }
      for (let ch = 0; ch < 3; ch++) d[j + ch] = Math.round(Math.round(d[j + ch] / q) * q);
      if (style === 'comic') { const x = i % pw, y = (i / pw) | 0; if (((x + y) % 4 === 0) && L[i] < 110) { d[j] *= 0.55; d[j + 1] *= 0.55; d[j + 2] *= 0.55; } }
    }
  } else if (style === 'neon') {
    for (let i = 0; i < n; i++) {
      const e = clamp(edge(i) / 180, 0, 1); const j = i * 4; const hue = (i % pw) / pw;
      d[j] = e * (180 + 75 * Math.sin(hue * 6.28)); d[j + 1] = e * (120 + 100 * Math.sin(hue * 6.28 + 2)); d[j + 2] = e * 255;
    }
  } else if (style === 'thermal') {
    for (let i = 0; i < n; i++) { const v = L[i] / 255; const j = i * 4;
      d[j] = 255 * clamp(v * 2.2 - 0.4, 0, 1); d[j + 1] = 255 * clamp(Math.sin(v * Math.PI) * 1.1, 0, 1); d[j + 2] = 255 * clamp(1.2 - v * 2.4, 0, 1); }
  }
  B.putImageData(img, 0, 0);
  A.clearRect(0, 0, w, h);
  if (style === 'neon') { A.fillStyle = '#05010a'; A.fillRect(0, 0, w, h); A.filter = `blur(${Math.max(2, w / 160)}px) brightness(1.6)`; A.drawImage(s.b, 0, 0, pw, ph, 0, 0, w, h); A.filter = 'none'; A.globalCompositeOperation = 'lighter'; }
  A.drawImage(s.b, 0, 0, pw, ph, 0, 0, w, h); A.globalCompositeOperation = 'source-over';
}

/* ======================= Image analysis ======================= */
function stats(img, w = 64, h = 64, rect = null) {
  const c = canvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  if (rect) g.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h); else g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data; let L = 0, L2 = 0, S = 0, R = 0, G = 0, B = 0; const n = w * h;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255; const l = 0.299 * r + 0.587 * gg + 0.114 * b;
    L += l; L2 += l * l; const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b); S += mx ? (mx - mn) / mx : 0; R += r; G += gg; B += b;
  }
  L /= n; return { L, std: Math.sqrt(Math.max(0, L2 / n - L * L)), S: S / n, R: R / n, G: G / n, B: B / n };
}
/** Auto-enhance: exposure, contrast, saturation and white balance from frame statistics. */
AI.autoEnhance = function (img) {
  const s = stats(img);
  const b = clamp(Math.pow(0.48 / Math.max(0.05, s.L), 0.75), 0.75, 1.6);
  const c = clamp(Math.pow(0.22 / Math.max(0.03, s.std), 0.55), 0.85, 1.45);
  const sat = clamp(Math.pow(0.34 / Math.max(0.04, s.S), 0.5), 0.85, 1.5);
  const temp = clamp((s.B - s.R) * 2.5, -0.6, 0.6); // gray-world: positive = image too blue → warm it
  return { b: +b.toFixed(2), c: +c.toFixed(2), s: +sat.toFixed(2), temp: +temp.toFixed(2), stats: s };
};
/** Smart lighting: finds the main face and computes a key light + exposure that targets well-lit skin. */
AI.smartLighting = async function (img, w, h) {
  await AI.loadVision();
  const r = detector.detect(img); const f = (r.detections || []).sort((a, b) => b.boundingBox.width - a.boundingBox.width)[0];
  const glob = stats(img);
  if (!f) return { found: false, b: clamp(Math.pow(0.5 / Math.max(0.05, glob.L), 0.7), 0.8, 1.5) };
  const bb = f.boundingBox; const fs = stats(img, 32, 32, { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height });
  const amt = clamp((0.58 - fs.L) * 1.6, 0, 0.8);
  return { found: true, b: clamp(1 + (0.55 - glob.L) * 0.5, 0.85, 1.3), light: { x: (bb.originX + bb.width / 2) / w - 0.5, y: (bb.originY + bb.height / 2) / h - 0.5, r: Math.max(bb.width / w, bb.height / h) * 1.4, amt: +amt.toFixed(2) } };
};

/* ======================= Video analysis helpers ======================= */
function seekVideo(v, t) { return new Promise(res => { const done = () => { v.removeEventListener('seeked', done); res(); }; v.addEventListener('seeked', done); v.currentTime = t; setTimeout(done, 1500); }); }
async function openVideo(url) {
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video')); setTimeout(res, 4000); });
  return v;
}
/** Samples a video and scores each moment by motion, sharpness, brightness and faces. */
AI.analyzeVideo = async function (url, duration, { step = 0.5, maxSamples = 120, onProgress } = {}) {
  try { await AI.loadVision(); } catch (e) {}
  const v = await openVideo(url); step = Math.max(step, duration / maxSamples);
  const w = 96, h = 54, c = canvas(w, h), g = c.getContext('2d', { willReadFrequently: true }); const fc = canvas(256, 256 * 9 / 16);
  let prev = null; const out = [];
  for (let t = 0.05; t < duration - 0.05; t += step) {
    await seekVideo(v, t); g.drawImage(v, 0, 0, w, h); const d = g.getImageData(0, 0, w, h).data;
    const L = new Float32Array(w * h); let mean = 0; for (let i = 0; i < L.length; i++) { L[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 765; mean += L[i]; } mean /= L.length;
    let motion = 0; if (prev) { for (let i = 0; i < L.length; i++) motion += Math.abs(L[i] - prev[i]); motion /= L.length; }
    let sharp = 0; for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; const lap = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]; sharp += lap * lap; } sharp /= (w * h);
    let facesN = 0, faceX = 0.5, faceY = 0.45;
    if (detector) { fc.getContext('2d').drawImage(v, 0, 0, fc.width, fc.height); const r = detector.detect(fc); const ds = r.detections || []; facesN = ds.length;
      if (ds.length) { const b = ds[0].boundingBox; faceX = (b.originX + b.width / 2) / fc.width; faceY = (b.originY + b.height / 2) / fc.height; } }
    out.push({ t, motion, sharp, mean, faces: facesN, fx: faceX, fy: faceY }); prev = L;
    onProgress && onProgress(t / duration);
  }
  v.removeAttribute('src'); v.load();
  const mx = k => Math.max(1e-6, ...out.map(o => o[k]));
  const mM = mx('motion'), mS = mx('sharp');
  for (const o of out) o.score = 0.38 * Math.min(1, o.motion / mM * 1.3) + 0.22 * (o.sharp / mS) + 0.3 * Math.min(1, o.faces) + 0.1 * (o.mean > 0.12 && o.mean < 0.9 ? 1 : 0) - (o.mean < 0.06 ? 0.5 : 0);
  return out;
};
/** Smart reframe track: face/subject centre over time (source seconds, normalised x/y). */
AI.reframeTrack = async function (url, duration, onProgress) {
  const a = await AI.analyzeVideo(url, duration, { step: 0.33, maxSamples: 180, onProgress });
  let x = 0.5, y = 0.45; const track = [];
  for (const o of a) { const tx = o.faces ? o.fx : x, ty = o.faces ? o.fy : y; x += (tx - x) * 0.45; y += (ty - y) * 0.45; track.push([+o.t.toFixed(2), +x.toFixed(3), +y.toFixed(3)]); }
  return track;
};

/* ======================= Audio engines ======================= */
async function decode(blob, rate) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
  const audio = await ctx.decodeAudioData(buf);
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * rate)), rate);
  const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
  const r = await off.startRendering(); return { data: r.getChannelData(0), rate, duration: audio.duration };
}
AI.decodeAudio = decode;

/** Detects non-silent (speech/sound) ranges in seconds. */
AI.detectSpeech = async function (blob, { minSilence = 0.45, pad = 0.12, sensitivity = 0.5 } = {}) {
  const { data, rate, duration } = await decode(blob, 16000);
  const hop = Math.round(rate * 0.02); const n = Math.floor(data.length / hop); const db = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * hop; j < (i + 1) * hop; j++) s += data[j] * data[j]; db[i] = 10 * Math.log10(s / hop + 1e-10); }
  const sorted = [...db].sort((a, b) => a - b); const floor = sorted[Math.floor(n * 0.1)] || -80, loud = sorted[Math.floor(n * 0.95)] || -20;
  const thr = floor + (loud - floor) * (0.12 + 0.25 * (1 - sensitivity));
  const ranges = []; let start = -1, quiet = 0; const minQ = Math.round(minSilence / 0.02);
  for (let i = 0; i < n; i++) {
    if (db[i] > thr) { if (start < 0) start = i; quiet = 0; }
    else if (start >= 0) { quiet++; if (quiet >= minQ) { ranges.push([start, i - quiet + 1]); start = -1; quiet = 0; } }
  }
  if (start >= 0) ranges.push([start, n]);
  const out = ranges.map(([a, b]) => [Math.max(0, a * 0.02 - pad), Math.min(duration, b * 0.02 + pad)]).filter(([a, b]) => b - a > 0.15);
  for (let i = out.length - 1; i > 0; i--) if (out[i][0] <= out[i - 1][1]) { out[i - 1][1] = out[i][1]; out.splice(i, 1); }
  return { ranges: out, duration, threshold: thr };
};

/** Beat tracking: low-band onset envelope + autocorrelation tempo + phase alignment. */
AI.detectBeats = async function (blob) {
  const rate = 11025; const { data, duration } = await decode(blob, rate);
  const hop = 256, n = Math.floor(data.length / hop), env = new Float32Array(n);
  let lp = 0; const a = Math.exp(-2 * Math.PI * 180 / rate);
  for (let i = 0; i < n; i++) { let e = 0, eh = 0; for (let j = i * hop; j < (i + 1) * hop; j++) { lp = a * lp + (1 - a) * data[j]; e += lp * lp; eh += data[j] * data[j]; } env[i] = Math.log(1 + 1000 * (e * 0.7 + eh * 0.3) / hop); }
  const on = new Float32Array(n); for (let i = 1; i < n; i++) on[i] = Math.max(0, env[i] - env[i - 1]);
  const fps = rate / hop; let best = 0, bestLag = Math.round(fps * 0.5);
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = fps * 60 / bpm; let s = 0; for (let i = Math.ceil(lag); i < n; i++) s += on[i] * on[Math.round(i - lag)];
    s *= Math.exp(-Math.pow(Math.log2(bpm / 120), 2) / 0.6); if (s > best) { best = s; bestLag = lag; }
  }
  let bestPh = 0, bestS = -1; for (let ph = 0; ph < bestLag; ph++) { let s = 0; for (let i = ph; i < n; i += bestLag) s += on[Math.round(i)] || 0; if (s > bestS) { bestS = s; bestPh = ph; } }
  const beats = []; for (let i = bestPh; i < n; i += bestLag) beats.push(+(i / fps).toFixed(3));
  return { bpm: +(60 * fps / bestLag).toFixed(1), beats, duration };
};

/* ======================= Whisper (speech → text) ======================= */
let asr = null, asrPromise = null;
AI.loadWhisper = function (onProgress) {
  if (asrPromise) return asrPromise;
  asrPromise = (async () => {
    const m = await fetch(MODELS + 'manifest.json').then(r => r.json()).catch(() => ({}));
    if (!m.whisper) throw new Error('Model Whisper nie jest dołączony do tej wersji aplikacji.');
    AI.status.whisper = 'loading'; emit(); const t0 = performance.now();
    const T = await import(LIB + 'transformers.min.js');
    T.env.allowRemoteModels = false; T.env.allowLocalModels = true; T.env.localModelPath = MODELS; T.env.useBrowserCache = false;
    T.env.backends.onnx.wasm.wasmPaths = LIB;
    T.env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    asr = await T.pipeline('automatic-speech-recognition', m.whisper, {
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, device: 'wasm',
      progress_callback: p => { if (onProgress && p.status === 'progress' && p.total) onProgress(p.loaded / p.total, p.file); },
    });
    AI.timings.whisperLoad = Math.round(performance.now() - t0);
    AI.status.whisper = 'ready'; emit(); return asr;
  })().catch(e => { AI.status.whisper = 'error'; AI.status.whisperError = String(e.message || e); asrPromise = null; emit(); throw e; });
  return asrPromise;
};
/** Transcribes an audio/video blob → [{start, end, text}] in source seconds. */
AI.transcribe = async function (blob, { language = 'polish', from = 0, to = Infinity, onProgress } = {}) {
  const p = await AI.loadWhisper(onProgress);
  const { data, rate } = await decode(blob, 16000);
  const a = Math.floor(Math.max(0, from) * rate), b = Math.min(data.length, Math.floor(Math.min(to, data.length / rate) * rate));
  const audio = data.slice(a, b);
  const opts = { task: 'transcribe', return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 };
  if (language && language !== 'auto') opts.language = language;
  const t0 = performance.now(); const r = await p(audio, opts); AI.timings.lastTranscribe = Math.round(performance.now() - t0);
  const chunks = (r.chunks && r.chunks.length ? r.chunks : [{ timestamp: [0, audio.length / rate], text: r.text }]);
  return chunks.map(c => ({ start: (c.timestamp[0] || 0) + from, end: (c.timestamp[1] == null ? audio.length / rate : c.timestamp[1]) + from, text: (c.text || '').trim() })).filter(c => c.text);
};
/** Splits transcript segments into short caption lines with proportional timing. */
AI.toCaptionLines = function (segs, maxWords = 6) {
  const out = [];
  for (const s of segs) {
    const words = s.text.split(/\s+/).filter(Boolean); if (!words.length) continue;
    const total = words.join(' ').length; let t = s.start; const span = Math.max(0.3, s.end - s.start);
    for (let i = 0; i < words.length; i += maxWords) {
      const part = words.slice(i, i + maxWords).join(' '); const d = span * (part.length + 1) / (total + 1);
      out.push({ start: t, end: Math.min(s.end, t + d), text: part }); t += d;
    }
  }
  return out;
};
AI.toSRT = function (lines) {
  const ts = v => { const ms = Math.round(v * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  return lines.map((l, i) => `${i + 1}\n${ts(l.start)} --> ${ts(l.end)}\n${l.text}\n`).join('\n');
};

/* ======================= Auto montage planner ======================= */
/** items: [{media, url, blob}] ; music: {blob, duration} | null → plan of clips */
AI.planMontage = async function (items, music, { target = 0, style = 'dynamic', onProgress } = {}) {
  let beats = null, bpm = 0;
  if (music) { onProgress && onProgress(0.02, 'Analiza rytmu muzyki…'); const b = await AI.detectBeats(music.blob); beats = b.beats; bpm = b.bpm; }
  const beatLen = beats && beats.length > 2 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.6;
  const per = style === 'calm' ? 4 : bpm > 140 ? 4 : 2;
  const segLen = beatLen * per;
  const want = target || (music ? Math.min(60, music.duration) : Math.min(30, items.length * 3.5));
  const cands = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k]; const m = it.media;
    if (m.type === 'image') { cands.push({ k, it, in: 0, score: 0.6, image: true }); continue; }
    onProgress && onProgress(0.05 + 0.85 * k / items.length, `Analiza ujęć: ${m.name}`);
    const a = await AI.analyzeVideo(it.url, m.duration, { step: 0.5, onProgress: p => onProgress && onProgress(0.05 + 0.85 * (k + p) / items.length, `Analiza ujęć: ${m.name}`) });
    const win = Math.max(1, Math.round(segLen / 0.5)); const used = [];
    const scored = [];
    for (let i = 0; i + win <= a.length; i++) { let s = 0; for (let j = i; j < i + win; j++) s += a[j].score; scored.push({ i, s: s / win }); }
    if (!scored.length) scored.push({ i: 0, s: 0.3 });
    scored.sort((x, y) => y.s - x.s);
    for (const sc of scored) { if (used.some(u => Math.abs(u - sc.i) < win)) continue; used.push(sc.i);
      cands.push({ k, it, in: a.length ? a[sc.i].t : 0, score: sc.s, fx: a[sc.i] ? a[sc.i].fx : 0.5 }); if (used.length >= 8) break; }
  }
  // pick best moments, keeping variety (round-robin by source)
  const bySrc = new Map(); for (const c of cands) { if (!bySrc.has(c.k)) bySrc.set(c.k, []); bySrc.get(c.k).push(c); }
  const picked = []; let total = 0, round = 0;
  while (total < want && round < 20) {
    let any = false;
    for (const [, list] of bySrc) { const c = list[round]; if (!c) continue; any = true; picked.push(c); total += segLen; if (total >= want) break; }
    if (!any) { if (!picked.length) break; for (const c of [...picked]) { if (total >= want) break; picked.push(c); total += segLen; } }
    round++;
  }
  picked.sort((a, b) => a.k - b.k || a.in - b.in);
  const trans = style === 'calm' ? ['fade'] : ['zoom', 'slideL', 'fade', 'spin', 'slideU', 'blur'];
  const clips = picked.map((c, i) => ({ mediaId: c.it.media.id, in: c.image ? 0 : Math.max(0, Math.min(c.in, c.it.media.duration - segLen)), dur: c.image ? segLen : Math.min(segLen, c.it.media.duration),
    transition: i === 0 ? 'fade' : trans[i % trans.length], image: !!c.image }));
  onProgress && onProgress(1, 'Gotowe');
  return { clips, bpm, segLen, offset: beats && beats.length ? beats[0] : 0 };
};

/* ======================= Simple offline command parser (Lab AI) ======================= */
AI.parseCommand = function (text) {
  const t = text.toLowerCase();
  const has = (...w) => w.some(x => t.includes(x));
  const acts = [];
  if (has('montaż', 'montaz', 'rytm', 'teledysk', 'beat', 'zmontuj')) acts.push('automontage');
  if (has('napis', 'podpis', 'transkryp', 'caption')) acts.push(has('transkryp') && !has('napis') ? 'transcribe' : 'captions');
  if (has('tło', 'tlo', 'background')) acts.push(has('rozmyj', 'rozmy', 'bokeh') ? 'bgblur' : 'bgremove');
  if (has('retusz', 'wygładź', 'wygladz', 'skór', 'skor', 'upiększ', 'upieksz')) acts.push('retouch');
  if (has('ulepsz', 'popraw', 'jakość', 'jakosc', 'kolor')) acts.push('enhance');
  if (has('oświetl', 'oswietl', 'światł', 'swiatl', 'ciemn')) acts.push('lighting');
  if (has('cisz', 'pauz', 'przytnij', 'wytnij')) acts.push('silence');
  if (has('kadr', 'pion', '9:16', 'reframe')) acts.push('reframe');
  if (has('kresk', 'cartoon', 'komiks', 'szkic', 'neon', 'pixel', 'piksel', 'termo', 'efekt')) acts.push('styles');
  if (has('kolaż', 'kolaz')) acts.push('collage');
  if (has('teleprompt', 'prompter')) acts.push('teleprompter');
  if (has('nagraj', 'kamer', 'aparat')) acts.push(has('głos', 'glos', 'lektor') ? 'voice' : 'camera');
  return [...new Set(acts)];
};

window.CFAI = AI;
window.dispatchEvent(new Event('cfai-ready'));
export default AI;
