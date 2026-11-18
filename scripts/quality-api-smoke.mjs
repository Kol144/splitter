import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.AIMS_BASE_URL || 'http://127.0.0.1:4173';
const minimumFreeBytes = 3 * 1024 ** 3;

const health = await fetch(`${base}/api/health`);
assert.equal(health.status, 200, 'Local health endpoint must be available.');
const healthInfo = await health.json();
if (healthInfo.hardware.availableMemoryBytes < minimumFreeBytes) {
  console.log(JSON.stringify({
    result: 'SKIPPED',
    reason: 'HTDemucs Fine-Tuned needs 3 GB of free RAM for this protected smoke test.',
    availableGiB: Number((healthInfo.hardware.availableMemoryBytes / 1024 ** 3).toFixed(2))
  }, null, 2));
  process.exit(0);
}

function makeControlWav(seconds = 5, sampleRate = 44100) {
  const channels = 2, frames = seconds * sampleRate, dataBytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * channels * 2, 28); wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const kick = (t % .5 < .06 ? .38 * Math.exp(-(t % .5) * 40) * Math.sin(2 * Math.PI * 65 * t) : 0);
    const bass = .16 * Math.sin(2 * Math.PI * 55 * t);
    const melody = .12 * Math.sin(2 * Math.PI * 240 * t);
    const value = Math.round(Math.max(-.92, Math.min(.92, kick + bass + melody)) * 32767);
    wav.writeInt16LE(value, 44 + i * 4); wav.writeInt16LE(Math.round(value * .96), 46 + i * 4);
  }
  return wav;
}

function wavHeader(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.toString('ascii', 12, 16), 'fmt ');
  return {
    format: buffer.readUInt16LE(20),
    channels: buffer.readUInt16LE(22),
    sampleRate: buffer.readUInt32LE(24),
    bits: buffer.readUInt16LE(34)
  };
}

async function expect(response, status, label) {
  if (response.status !== status) throw new Error(`${label}: HTTP ${response.status} ${await response.text()}`);
  return response;
}

const metadata = Buffer.from(JSON.stringify({ duration: 5, sampleRate: 44100, channels: 2 })).toString('base64');
const imported = await expect(await fetch(`${base}/api/import?name=quality-ft-control-${randomUUID()}.wav`, {
  method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Media-Metadata': metadata }, body: makeControlWav()
}), 201, 'Import');
const project = await imported.json();

try {
  const started = await expect(await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, model: 'htdemucs_ft', profile: 'maximum', threads: 4 })
  }), 202, 'HTDemucs Fine-Tuned maximum-quality job');
  const job = await started.json();
  const deadline = Date.now() + 10 * 60 * 1000;
  let status;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const response = await expect(await fetch(`${base}/api/jobs/${job.id}`), 200, 'Job status');
    status = await response.json();
    console.log(`job ${status.status}: ${status.message || status.error || ''}`);
    if (['completed', 'failed', 'cancelled'].includes(status.status)) break;
  }
  assert.equal(status?.status, 'completed', status?.message || 'Fine-Tuned job did not finish.');

  const readProject = await expect(await fetch(`${base}/api/projects/${project.id}`), 200, 'Project read');
  const result = await readProject.json();
  assert.deepEqual(result.stems.map(stem => stem.name).sort(), ['bass', 'drums', 'other', 'vocals']);
  assert.equal(result.metadata.lastModel, 'htdemucs_ft');
  assert.deepEqual(result.metadata.inference && {
    profile: result.metadata.inference.profile,
    shifts: result.metadata.inference.shifts,
    overlap: result.metadata.inference.overlap,
    outputFormat: result.metadata.inference.outputFormat,
    outputBitDepth: result.metadata.inference.outputBitDepth
  }, { profile: 'maximum', shifts: 2, overlap: .5, outputFormat: 'float32', outputBitDepth: 32 });

  const source = await expect(await fetch(`${base}/api/projects/${project.id}/stems/vocals?play=1`, { headers: { Range: 'bytes=0-43' } }), 206, 'Float32 stem playback');
  const header = wavHeader(Buffer.from(await source.arrayBuffer()));
  assert.deepEqual(header, { format: 3, channels: 2, sampleRate: 44100, bits: 32 });

  const converted = await expect(await fetch(`${base}/api/projects/${project.id}/stems/vocals?format=wav&rate=44100&bits=16&channels=2&normalize=0`), 200, 'Requested 16-bit export');
  const convertedHeader = wavHeader(Buffer.from(await converted.arrayBuffer()).subarray(0, 44));
  assert.deepEqual(convertedHeader, { format: 1, channels: 2, sampleRate: 44100, bits: 16 });

  console.log(JSON.stringify({ result: 'PASS', model: 'htdemucs_ft', profile: 'maximum', output: header, convertedOutput: convertedHeader }, null, 2));
} finally {
  await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE' }).catch(() => {});
}
