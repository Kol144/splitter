import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.AIMS_BASE_URL || 'http://127.0.0.1:4173';
const temp = path.join(root, 'data', 'temp', `video-check-${randomUUID()}`);
mkdirSync(temp, { recursive: true });
let projectId = null;

async function expectStatus(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label}: ${await response.text()}`);
}

try {
  const video = path.join(temp, 'two-audio-tracks.mp4');
  const generated = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
    '-metadata:s:a:0', 'title=LowTone', '-metadata:s:a:1', 'title=HighTone',
    '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac', '-b:a', '96k', '-shortest', video
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(generated.status, 0, generated.stderr || 'Could not generate test video.');

  const imported = await fetch(`${base}/api/import?name=two-audio-tracks.mp4`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: readFileSync(video) });
  await expectStatus(imported, 201, 'Video import');
  const project = await imported.json();
  projectId = project.id;
  assert.equal(project.mediaKind, 'video');
  assert.equal(project.metadata.probeAvailable, true);
  assert.equal(project.metadata.audioStreams.length, 2);
  assert.equal(project.metadata.audioStreams[0].audioIndex, 0);
  assert.equal(project.metadata.audioStreams[1].audioIndex, 1);
  assert.equal(project.metadata.audioStreams[1].sampleRate, 48000);
  console.log('PASS MP4 import reports both indexed audio streams');

  const start = await fetch(`${base}/api/projects/${project.id}/extract`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audioIndex: 1 }) });
  await expectStatus(start, 202, 'Audio stream extraction start');
  const operation = await start.json();
  const deadline = Date.now() + 60_000;
  let status;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const response = await fetch(`${base}/api/projects/${project.id}/extract`);
    await expectStatus(response, 200, 'Extraction status');
    status = await response.json();
    if (['completed', 'failed', 'cancelled'].includes(status.status)) break;
  }
  assert.equal(status?.id, operation.id);
  assert.equal(status?.status, 'completed', status?.error || 'FFmpeg extraction did not complete.');

  const updatedResponse = await fetch(`${base}/api/projects/${project.id}`);
  await expectStatus(updatedResponse, 200, 'Extracted project read');
  const updated = await updatedResponse.json();
  assert.equal(updated.hasAudio, true);
  assert.equal(updated.metadata.selectedAudio.audioIndex, 1);
  assert.equal(updated.sampleRate, 48000);
  const audio = await fetch(`${base}/api/projects/${project.id}/audio`, { headers: { Range: 'bytes=0-43' } });
  assert.equal(audio.status, 206);
  assert.equal(Buffer.from(await audio.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');

  const extracted = path.join(root, 'data', 'projects', project.id, 'audio-extracted.wav');
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  const spectrum = spawnSync(python, ['-c', 'import sys,soundfile as sf,numpy as np; x,s=sf.read(sys.argv[1]); x=x if x.ndim==1 else x[:,0]; p=np.abs(np.fft.rfft(x)); f=np.fft.rfftfreq(len(x),1/s); print(round(f[p.argmax()]))', extracted], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(spectrum.status, 0, spectrum.stderr);
  assert(Math.abs(Number(spectrum.stdout.trim()) - 880) < 5, `Selected stream frequency was ${spectrum.stdout.trim()} Hz`);
  console.log('PASS selected 48 kHz audio stream was extracted and retained its 880 Hz tone');
} finally {
  if (projectId) await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
