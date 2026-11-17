import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.AIMS_BASE_URL || 'http://127.0.0.1:4173';

function makeControlWav(seconds = 3, sampleRate = 44100) {
  const channels = 2, frames = seconds * sampleRate, dataBytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * channels * 2, 28); wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(0.2 * Math.sin(2 * Math.PI * 220 * i / sampleRate) * 32767);
    wav.writeInt16LE(sample, 44 + i * 4); wav.writeInt16LE(sample, 46 + i * 4);
  }
  return wav;
}

const metadata = Buffer.from(JSON.stringify({ duration: 3, sampleRate: 44100, channels: 2 })).toString('base64');
const projects = [];

async function waitForTerminalJob(id) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/jobs/${id}`);
    assert.equal(response.status, 200, 'Cancelled job status must remain available.');
    last = await response.json();
    if (['completed', 'failed', 'cancelled'].includes(last.status)) return last;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Cancellation did not settle in time: ${last?.status || 'unknown'}`);
}

try {
  for (let i = 0; i < 2; i++) {
    const imported = await fetch(`${base}/api/import?name=cancel-control-${randomUUID()}.wav`, {
      method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Media-Metadata': metadata }, body: makeControlWav()
    });
    assert.equal(imported.status, 201, 'Control audio import must succeed.');
    projects.push(await imported.json());
  }

  const started = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: projects[0].id, model: 'htdemucs', profile: 'performance', threads: 4 })
  });
  assert.equal(started.status, 202, 'HTDemucs job must start before cancellation.');
  const job = await started.json();

  const parallel = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: projects[1].id, model: 'htdemucs', profile: 'performance', threads: 4 })
  });
  assert.equal(parallel.status, 409, 'A second simultaneous separation must be refused.');

  const cancelled = await fetch(`${base}/api/jobs/${job.id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 202, 'Cancellation must wait for the Python process to close safely.');
  assert.equal((await cancelled.json()).status, 'cancelling');

  const status = await waitForTerminalJob(job.id);
  assert.equal(status.status, 'cancelled');

  const readProject = await fetch(`${base}/api/projects/${projects[0].id}`);
  assert.equal(readProject.status, 200);
  const cancelledProject = await readProject.json();
  assert.equal(cancelledProject.status, 'cancelled');
  assert.deepEqual(cancelledProject.stems, []);
  console.log(JSON.stringify({ result: 'PASS', concurrentJobRefused: parallel.status === 409, jobStatus: 'cancelled', generatedStems: 0 }, null, 2));
} finally {
  await Promise.all(projects.map(project => fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE' }).catch(() => {})));
}
