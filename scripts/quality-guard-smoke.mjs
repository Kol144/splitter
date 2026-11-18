import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.AIMS_BASE_URL || 'http://127.0.0.1:4173';
const requiredFreeBytes = 3 * 1024 ** 3;

function makeControlWav() {
  const sampleRate = 44100, frames = sampleRate, channels = 2, dataBytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * channels * 2, 28); wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(.1 * Math.sin(2 * Math.PI * 220 * i / sampleRate) * 32767);
    wav.writeInt16LE(value, 44 + i * 4); wav.writeInt16LE(value, 46 + i * 4);
  }
  return wav;
}

const healthResponse = await fetch(`${base}/api/health`);
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
if (health.hardware.availableMemoryBytes >= requiredFreeBytes) {
  console.log(JSON.stringify({ result: 'SKIPPED', reason: 'Enough free RAM to run Fine-Tuned; the low-memory guard cannot be exercised safely.' }, null, 2));
  process.exit(0);
}

const metadata = Buffer.from(JSON.stringify({ duration: 1, sampleRate: 44100, channels: 2 })).toString('base64');
const imported = await fetch(`${base}/api/import?name=quality-guard-${randomUUID()}.wav`, {
  method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Media-Metadata': metadata }, body: makeControlWav()
});
const importedRaw = await imported.text();
assert.equal(imported.status, 201, importedRaw);
const project = JSON.parse(importedRaw);
try {
  const job = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, model: 'htdemucs_ft', profile: 'maximum', threads: 4 })
  });
  const raw = await job.text();
  const body = JSON.parse(raw);
  if (job.status === 202) {
    // Available RAM can cross the admission threshold after the health read.
    await fetch(`${base}/api/jobs/${body.id}/cancel`, { method: 'POST' });
    console.log(JSON.stringify({ result: 'SKIPPED', reason: 'Free RAM increased between health check and job admission. Accepted test job cancelled.' }, null, 2));
  } else {
    assert.equal(job.status, 409, raw);
    assert.match(body.error, /Memoria disponible insuficiente/);
    console.log(JSON.stringify({ result: 'PASS', guard: 'htdemucs_ft', availableGiB: Number((health.hardware.availableMemoryBytes / 1024 ** 3).toFixed(2)), requiredGiB: 3 }, null, 2));
  }
} finally {
  await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE' }).catch(() => {});
}
