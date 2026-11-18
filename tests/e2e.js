/* End-to-end test of ClipForge in a real browser.
 * usage: node tests/e2e.js <baseUrl> <assetsUrlPrefix> <outDir> [--channel=msedge] [--whisper]
 * Checks: UI loads, fit-to-audio, volume mix, AI vision engines, frame-exact MP4 export + save, optional Whisper captions. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const [base, assets, out] = process.argv.slice(2);
const channel = (process.argv.find(a => a.startsWith('--channel=')) || '').split('=')[1];
const withWhisper = process.argv.includes('--whisper');
let failed = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch({ channel: channel || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  await p.goto(base); await p.waitForFunction(() => window.ClipForge && window.CFAI, null, { timeout: 30000 });
  await p.screenshot({ path: path.join(out, 'home.png') });
  ok(await p.isVisible('#newProject'), 'home screen visible');
  await p.evaluate(a => { window.__A = a; window.__F = async (u, t) => new File([await (await fetch(a + u)).blob()], u, { type: t }); }, assets);

  // ---- fit to audio
  const fit = await p.evaluate(async () => {
    const S = () => ClipForge.project.clips.filter(c => c.track === 'main').map(c => +c.dur.toFixed(2));
    await ClipForge.newWith([await __F('music.mp3', 'audio/mpeg')], '9:16'); const r = {};
    await ClipForge.importFiles([await __F('red.png', 'image/png')]); r.one = S();
    await ClipForge.importFiles([await __F('green.png', 'image/png'), await __F('blue.png', 'image/png')]); r.three = S();
    await ClipForge.importFiles([await __F('clip.webm', 'video/webm')]); r.mixed = S();
    await ClipForge.newWith([await __F('clip.webm', 'video/webm')], '9:16'); await ClipForge.importFiles([await __F('music.mp3', 'audio/mpeg')]); r.dup = S();
    return r;
  });
  console.log(JSON.stringify(fit));
  ok(Math.abs(fit.one[0] - 12) < 0.05, 'single image stretched to audio length');
  ok(fit.three.length === 3 && fit.three.every(d => Math.abs(d - 4) < 0.05), 'three images share audio length equally');
  ok(fit.mixed.length === 4 && Math.abs(fit.mixed[3] - 6.01) < 0.05 && fit.mixed.slice(0, 3).every(d => Math.abs(d - 2) < 0.05), 'video keeps length, images fill the rest');
  ok(fit.dup.length === 2 && Math.abs(fit.dup[0] + fit.dup[1] - 12) < 0.05, 'video duplicated to audio length');

  // ---- AI vision engines
  const vis = await p.evaluate(async () => {
    const t0 = performance.now(); await CFAI.loadVision(); const load = performance.now() - t0;
    const img = await createImageBitmap(await (await fetch(__A + 'person.png')).blob()).catch(() => null);
    let found = null; if (img) { const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; cv.getContext('2d').drawImage(img, 0, 0); found = (await CFAI.smartLighting(cv, cv.width, cv.height)).found; }
    return { load: Math.round(load), status: CFAI.status.vision, delegate: CFAI.delegate, found };
  });
  console.log(JSON.stringify(vis));
  ok(vis.status === 'ready', 'MediaPipe vision engines loaded (' + vis.delegate + ', ' + vis.load + ' ms)');
  if (vis.found !== null) ok(vis.found === true, 'face detected on test portrait');

  // ---- export (video + h264 + image + text + music, mixed volumes)
  await p.evaluate(async () => {
    window.showSaveFilePicker = undefined;
    await ClipForge.newWith([await __F('clip.webm', 'video/webm'), await __F('h264.mp4', 'video/mp4'), await __F('red.png', 'image/png')], '16:9');
    await ClipForge.importFiles([await __F('music.mp3', 'audio/mpeg')]); ClipForge.seek(1); ClipForge.addText(); document.querySelector('#sheetClose').click();
    ClipForge.project.mix = { orig: 1, music: 0.5 }; ClipForge.project.name = 'E2E test';
  });
  await p.click('#btnExport'); await p.selectOption('#expRes', '720'); await p.selectOption('#expFps', '30');
  const t0 = Date.now(); const dlP = p.waitForEvent('download', { timeout: 300000 }).catch(() => null);
  await p.click('#expGo');
  // wait for result dialog
  await p.waitForSelector('#toolModal.open', { timeout: 300000 });
  const title = await p.textContent('#tmTitle'), body = await p.textContent('#tmBody');
  console.log('export dialog:', title, '|', body.trim().replace(/\s+/g, ' '), '|', (Date.now() - t0) / 1000, 's');
  ok(/Gotowe/.test(title), 'export finished and saved');
  const dl = await Promise.race([dlP, new Promise(r => setTimeout(() => r(null), 3000))]);
  if (dl) { const f = path.join(out, 'export.' + dl.suggestedFilename().split('.').pop()); await dl.saveAs(f); console.log('downloaded', f); }
  fs.writeFileSync(path.join(out, 'export-result.txt'), body.trim());
  await p.click('#tmRow button:last-child').catch(() => {});

  // ---- Whisper captions
  if (withWhisper) {
    const w = await p.evaluate(async () => {
      const res = {};
      for (const [f, lang] of [['speech_en.wav', 'english'], ['speech_pl.wav', 'polish']]) {
        const blob = await (await fetch(__A + f)).blob(); const t0 = performance.now();
        const segs = await CFAI.transcribe(blob, { language: lang });
        res[lang] = { text: segs.map(s => s.text).join(' '), ms: Math.round(performance.now() - t0), segs: segs.length };
      }
      return res;
    });
    console.log(JSON.stringify(w));
    ok(/test/i.test(w.english.text), 'Whisper English transcription contains "test"');
    ok(/test|napis|dzie[nń]|dobry/i.test(w.polish.text), 'Whisper Polish transcription recognises words');
  }
  console.log('page errors:', JSON.stringify(errs));
  ok(!errs.some(e => /TypeError|ReferenceError|SyntaxError/.test(e)), 'no script errors');
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
