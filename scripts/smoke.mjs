import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.AIMS_BASE_URL || 'http://127.0.0.1:4173';

function makePcmWav(seconds = 1, sampleRate = 44100) {
  const channels = 2;
  const sampleCount = seconds * sampleRate;
  const dataSize = sampleCount * channels * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28); wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index++) {
    const value = Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 0.15 * 32767);
    wav.writeInt16LE(value, 44 + index * 4); wav.writeInt16LE(value, 46 + index * 4);
  }
  return wav;
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

const health = await getJson(`${base}/api/health`);
assert.equal(health.response.status, 200);
assert.equal(health.body.app, 'AI Music Separator Studio');
assert.equal(health.body.hardware.architecture, 'x64');
console.log('PASS local health and hardware endpoint');

const page = await fetch(base);
assert.equal(page.status, 200);
assert.match(await page.text(), /AI Music Separator Studio/);
console.log('PASS static studio page');

const models = await getJson(`${base}/api/models`);
assert.equal(models.response.status, 200);
assert.deepEqual(models.body.models.map(model => model.id), ['htdemucs', 'htdemucs_ft', 'mdx_extra', 'mdx_extra_q', 'htdemucs_6s']);
if (!health.body.python.available) assert(models.body.models.every(model => model.installed === false));
console.log('PASS model inventory reflects installed state');

const mdx = models.body.models.find(model => model.id === 'mdx_extra_q');
if (mdx?.dependencyAvailable === false) {
  assert.equal(mdx.installed, false);
  assert.match(mdx.dependencyMessage || '', /DiffQ/);
  const blockedInstall = await getJson(`${base}/api/models/mdx_extra_q/install`, { method: 'POST' });
  assert.equal(blockedInstall.response.status, 409);
  assert.match(blockedInstall.body.error, /DiffQ/);
  console.log('PASS incompatible MDX dependency is reported and blocked before downloading weights');
}

const audio = makePcmWav();
const encodedMetadata = Buffer.from(JSON.stringify({ duration: 1, sampleRate: 44100, channels: 2 })).toString('base64');
const imported = await getJson(`${base}/api/import?name=${encodeURIComponent(`smoke-${randomUUID()}.wav`)}`, {
  method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Media-Metadata': encodedMetadata }, body: audio
});
assert.equal(imported.response.status, 201);
assert.equal(imported.body.hasAudio, true);
assert.equal(imported.body.duration, 1);
assert.equal(imported.body.sampleRate, 44100);
assert.equal(imported.body.channels, 2);
console.log('PASS real WAV bytes imported and metadata persisted');

const original = await fetch(`${base}/api/projects/${imported.body.id}/original`);
assert.equal(original.status, 200);
assert.deepEqual(Buffer.from(await original.arrayBuffer()), audio);
const playable = await fetch(`${base}/api/projects/${imported.body.id}/audio`);
assert.equal(playable.status, 200);
assert.equal(playable.headers.get('content-type'), 'audio/wav');
console.log('PASS local playback endpoints return the imported WAV');

const noStems = await getJson(`${base}/api/projects/${imported.body.id}/export.zip`);
assert.equal(noStems.response.status, 409);
assert.match(noStems.body.error, /no tiene stems/i);
console.log('PASS export refuses to invent stems');

if (!health.body.python.available) {
  const blockedJob = await getJson(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: imported.body.id, model: 'htdemucs' }) });
  assert.equal(blockedJob.response.status, 503);
  assert.match(blockedJob.body.error, /Python/);
  console.log('PASS separation reports missing runtime instead of fabricating results');
}

const removed = await getJson(`${base}/api/projects/${imported.body.id}`, { method: 'DELETE' });
assert.equal(removed.response.status, 200);
const projects = await getJson(`${base}/api/projects`);
assert(!projects.body.some(project => project.id === imported.body.id));
console.log('PASS project deletion removes the local smoke fixture');
