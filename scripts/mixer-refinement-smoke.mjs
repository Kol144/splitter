import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { trackState } from '../web/mixer-state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.AIMS_BASE_URL || 'http://127.0.0.1:4173';
const names = ['vocals', 'drums', 'bass', 'other'];
const frames = 12 * 44100;
const wav = Buffer.alloc(44 + frames * 8);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(44100 * 8, 28); wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34);
wav.write('data', 36); wav.writeUInt32LE(frames * 8, 40);
let seed = 12345;
for (let frame = 0; frame < frames; frame++) {
  const seconds = frame / 44100;
  seed = (seed * 48271) % 2147483647;
  const noise = (seed / 2147483647 * 2 - 1) * .00015;
  const value = seconds > 3 && seconds < 6 ? noise : .08 * Math.sin(2 * Math.PI * 223 * seconds);
  wav.writeFloatLE(value, 44 + frame * 8); wav.writeFloatLE(value * .98, 48 + frame * 8);
}

const mix = { solo: new Set(['vocals', 'drums']), previewStem: null, masterVolume: .8 };
assert.equal(trackState('bass', { muted: false, volume: 1 }, mix).gain, 0);
assert.equal(trackState('vocals', { muted: false, volume: .5 }, mix).gain, .4);
assert.equal(trackState('vocals', { muted: true, volume: 1 }, mix).dimmed, true);
assert.equal(trackState('vocals', { muted: true, volume: 1 }, mix).gain, 0);

async function json(url, options, status = 200) {
  const response = await fetch(`${base}${url}`, options);
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}
const imported = await json(`/api/import?name=mixer-control-${randomUUID()}.wav`, {
  method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav
}, 201);
let browser;
try {
  const db = new DatabaseSync(path.join(root, 'data', 'library.sqlite'));
  const source = db.prepare('SELECT original_path FROM projects WHERE id = ?').get(imported.id).original_path;
  for (const name of names) db.prepare('INSERT INTO stems (project_id,name,path,created_at) VALUES (?,?,?,?)').run(imported.id, name, source, new Date().toISOString());
  db.prepare('UPDATE projects SET status = ?, metadata_json = ? WHERE id = ?').run('separated', JSON.stringify({ lastModel: 'htdemucs', inference: { outputFormat: 'float32', outputBitDepth: 32, profile: 'test-fixture', label: 'Control técnico' } }), imported.id);
  db.close();

  const job = await json(`/api/projects/${imported.id}/refine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'conservative-residual' }) }, 202);
  let result;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    result = await json(`/api/jobs/${job.id}`);
    if (['completed', 'failed', 'cancelled'].includes(result.status)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(result?.status, 'completed', result?.message);
  const project = await json(`/api/projects/${imported.id}`);
  assert.equal(project.stems.length, 4);
  assert(project.stems.every(stem => stem.hasRaw));
  assert.equal(project.metadata.refinement.nonDestructive, true);
  assert(project.metadata.refinement.maskedSeconds > 4);
  const raw = Buffer.from(await (await fetch(`${base}/api/projects/${project.id}/stems/vocals?variant=raw&bits=32`)).arrayBuffer());
  const refined = Buffer.from(await (await fetch(`${base}/api/projects/${project.id}/stems/vocals?bits=32`)).arrayBuffer());
  assert.deepEqual(raw, wav, 'Original stem must remain byte-identical.');
  assert.notDeepEqual(refined, raw, 'Refined copy should differ for this known noise fixture.');
  for (const [variant, expected] of [['raw', raw], ['refined', refined]]) {
    const response = await fetch(`${base}/api/projects/${project.id}/export.zip?variant=${variant}&bits=32`);
    assert.equal(response.status, 200);
    const zip = Buffer.from(await response.arrayBuffer());
    assert(zip.includes(expected), `${variant} ZIP must contain the requested stem variant.`);
  }
  console.log('PASS refinement API, original preservation, variant playback/export and ZIP');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(id => {
    localStorage.setItem('aims-current-project', id);
    const NativeAudio = window.Audio;
    window.__testAudio = [];
    window.Audio = class extends NativeAudio {
      constructor(...args) { super(...args); window.__testAudio.push(this); }
    };
    const NativeAudioContext = window.AudioContext;
    window.__testGains = [];
    window.AudioContext = class extends NativeAudioContext {
      createGain() { const gain = super.createGain(); window.__testGains.push(gain); return gain; }
    };
  }, project.id);
  await page.goto(base);
  await expect(page.locator('.track-row')).toHaveCount(4);
  await expect(page.locator('.wave-loading:not(.hidden)')).toHaveCount(0, { timeout: 30000 });
  const row = name => page.locator(`.track-row[data-stem="${name}"]`);
  await row('bass').locator('.track-play').click();
  await expect(row('bass').locator('.track-play')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__testAudio.filter(audio => !audio.paused).length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__testAudio.find(audio => !audio.paused)?.currentTime || 0)).toBeGreaterThan(.1);
  await row('bass').locator('.track-play').click();
  await expect.poll(() => page.evaluate(() => window.__testAudio.filter(audio => !audio.paused).length)).toBe(0);
  await page.locator('#play-all-button').click();
  await expect.poll(() => page.evaluate(() => window.__testAudio.filter(audio => !audio.paused).length)).toBe(4);
  await expect.poll(() => page.evaluate(() => { const times = window.__testAudio.filter(a => !a.paused).map(a => a.currentTime); return Math.max(...times) - Math.min(...times); })).toBeLessThan(.12);

  await row('vocals').locator('.track-solo').click();
  await expect(page.locator('.track-row.is-dimmed')).toHaveCount(3);
  await row('drums').locator('.track-solo').click();
  await expect(page.locator('.track-row.is-dimmed')).toHaveCount(2);
  await row('vocals').locator('.track-mute').click();
  await expect(row('vocals')).toHaveClass(/is-muted/);
  await expect(page.locator('.track-row.is-dimmed')).toHaveCount(3);
  assert.equal(await row('vocals').evaluate(el => getComputedStyle(el).getPropertyValue('--track-color').trim()), '#8a928b');
  assert.equal(await row('bass').evaluate(el => getComputedStyle(el).getPropertyValue('--track-color').trim()), '#8a928b');
  assert.equal(await row('drums').evaluate(el => getComputedStyle(el).getPropertyValue('--track-color').trim()), '#e7ab67');
  // Player creation order follows the actual API order: bass, drums, other, vocals.
  await expect.poll(() => page.evaluate(() => window.__testGains.map(gain => Math.round(gain.gain.value * 100)))).toEqual([0, 80, 0, 0]);
  await page.locator('#transport-play').click();
  await expect.poll(() => page.evaluate(() => window.__testAudio.filter(audio => !audio.paused).length)).toBe(0);
  await page.locator('#timeline').fill('500');
  await expect(page.locator('#current-time')).toHaveText('00:06');
  const shots = path.join(root, 'test-results'); mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, 'mixer-desktop.png'), fullPage: true });

  await page.locator('#stem-variant').selectOption('raw');
  await expect.poll(() => page.locator('.track-download').first().getAttribute('href')).toContain('variant=raw');
  await expect(page.locator('.wave-loading:not(.hidden)')).toHaveCount(0);
  assert((await page.locator('#download-all').getAttribute('href')).includes('variant=raw'));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#results-section').scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile layout overflows horizontally.');
  assert.equal(await row('vocals').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.screenshot({ path: path.join(shots, 'mixer-mobile.png'), fullPage: true });
  await row('vocals').locator('.track-play').click();
  await expect(row('vocals').locator('.track-play')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#transport-play').click();
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ result: 'PASS', browser: 'Chromium', individualPlayback: true, multiSolo: true, muteGrey: true, inactiveSoloGrey: true, actualGainNodes: true, syncWithinMs: 120, variantToggle: true, mobile390px: true, reducedMotion: true }, null, 2));
} finally {
  await browser?.close();
  await fetch(`${base}/api/projects/${imported.id}`, { method: 'DELETE' });
}
