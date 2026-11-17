import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.AIMS_BASE_URL || 'http://127.0.0.1:4173';

function makeControlWav(seconds = 5, sampleRate = 44100) {
  const channels = 2, frames = seconds * sampleRate, dataBytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * channels * 2, 28); wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const mix = 0.16 * Math.sin(2 * Math.PI * 55 * t) + 0.12 * Math.sin(2 * Math.PI * 220 * t) + 0.08 * Math.sin(2 * Math.PI * 329.63 * t);
    const value = Math.round(mix * 32767);
    wav.writeInt16LE(value, 44 + i * 4); wav.writeInt16LE(Math.round(value * 0.97), 46 + i * 4);
  }
  return wav;
}

async function expectStatus(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label}: ${await response.text()}`);
}

const metadata = Buffer.from(JSON.stringify({ duration: 5, sampleRate: 44100, channels: 2 })).toString('base64');
const imported = await fetch(`${base}/api/import?name=app-engine-control-${randomUUID()}.wav`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Media-Metadata': metadata }, body: makeControlWav() });
await expectStatus(imported, 201, 'Control audio import');
const project = await imported.json();
try {
  const start = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, model: 'htdemucs', profile: 'balanced', threads: 4, silenceRefinement: 'conservative-residual' }) });
  await expectStatus(start, 202, 'HTDemucs job start');
  const job = await start.json();
  const deadline = Date.now() + 5 * 60 * 1000;
  let result;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const response = await fetch(`${base}/api/jobs/${job.id}`);
    await expectStatus(response, 200, 'Job status');
    result = await response.json();
    console.log(`job ${result.status}: ${result.message || result.error || ''}`);
    if (['completed', 'failed', 'cancelled'].includes(result.status)) break;
  }
  assert.equal(result?.status, 'completed', result?.message || 'HTDemucs API job did not finish successfully.');

  const projectResponse = await fetch(`${base}/api/projects/${project.id}`);
  await expectStatus(projectResponse, 200, 'Project read after separation');
  const separated = await projectResponse.json();
  assert.deepEqual(separated.stems.map(stem => stem.name).sort(), ['bass', 'drums', 'other', 'vocals']);
  assert.equal(separated.metadata.inference.outputFormat, 'pcm24');
  assert.equal(separated.metadata.inference.silenceRefinement, 'conservative-residual');
  assert.equal(separated.metadata.refinement.nonDestructive, true);
  assert.equal(separated.metadata.refinement.stems.length, 4);
  for (const stem of separated.stems) {
    const audio = await fetch(`${base}/api/projects/${project.id}/stems/${stem.name}?play=1`, { headers: { Range: 'bytes=0-43' } });
    assert.equal(audio.status, 206, `${stem.name} should support range playback`);
    assert.equal(audio.headers.get('content-type'), 'audio/wav');
    const header = Buffer.from(await audio.arrayBuffer());
    assert.equal(header.length, 44);
    assert.equal(header.toString('ascii', 0, 4), 'RIFF');
    assert.equal(header.readUInt16LE(34), 24);
    console.log(`PASS real ${stem.name} WAV playback stream`);
  }
  console.log(JSON.stringify({ result: 'PASS', model: 'htdemucs', jobId: job.id, stems: separated.stems.map(stem => stem.name), duration: separated.duration, sampleRate: separated.sampleRate, channels: separated.channels }, null, 2));
} finally {
  await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE' }).catch(() => {});
}
