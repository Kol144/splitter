import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.AIMS_BASE_URL || 'http://127.0.0.1:4173';
const temp = path.join(root, 'data', 'temp', `export-check-${randomUUID()}`);
mkdirSync(temp, { recursive: true });

function makeWav(seconds = 1, sampleRate = 44100) {
  const channels = 2, frames = seconds * sampleRate, dataBytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * channels * 2, 28); wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.2 * 32767);
    wav.writeInt16LE(value, 44 + i * 4); wav.writeInt16LE(value, 46 + i * 4);
  }
  return wav;
}

function probe(filename) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,duration', '-of', 'json', filename], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || 'ffprobe failed');
  const stream = JSON.parse(result.stdout).streams?.[0];
  assert(stream, `No audio stream in ${filename}`);
  return stream;
}

async function expectStatus(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label}: ${await response.text()}`);
}

const healthResponse = await fetch(`${base}/api/health`);
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.ffmpeg, true, 'Restart the app after installing FFmpeg.');

const wav = makeWav();
const metadata = Buffer.from(JSON.stringify({ duration: 1, sampleRate: 44100, channels: 2 })).toString('base64');
const createdResponse = await fetch(`${base}/api/import?name=export-control.wav`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Media-Metadata': metadata }, body: wav });
await expectStatus(createdResponse, 201, 'WAV import');
const project = await createdResponse.json();
const original = path.join(root, 'data', 'projects', project.id, 'original.wav');
let db;
try {
  db = new DatabaseSync(path.join(root, 'data', 'library.sqlite'));
  db.prepare('INSERT INTO stems (project_id,name,path,created_at) VALUES (?,?,?,?)').run(project.id, 'control', original, new Date().toISOString());
  db.close(); db = null;

  const raw = await fetch(`${base}/api/projects/${project.id}/stems/control`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), wav);
  console.log('PASS original WAV stem download');

  const formats = [
    { format: 'wav', rate: 48000, bits: 24, channels: 1, codec: 'pcm_s24le', sampleRate: '48000', channelCount: 1 },
    { format: 'flac', rate: 44100, bits: 24, channels: 2, codec: 'flac', sampleRate: '44100', channelCount: 2 },
    { format: 'mp3', rate: 44100, bits: 16, channels: 2, codec: 'mp3', sampleRate: '44100', channelCount: 2, normalize: true },
    { format: 'aac', rate: 48000, bits: 16, channels: 2, codec: 'aac', sampleRate: '48000', channelCount: 2 },
    { format: 'ogg', rate: 44100, bits: 16, channels: 2, codec: 'vorbis', sampleRate: '44100', channelCount: 2 },
    { format: 'aiff', rate: 44100, bits: 16, channels: 2, codec: 'pcm_s16be', sampleRate: '44100', channelCount: 2 }
  ];

  for (const options of formats) {
    const query = new URLSearchParams({ format: options.format, rate: String(options.rate), bits: String(options.bits), channels: String(options.channels), normalize: options.normalize ? '1' : '0' });
    const response = await fetch(`${base}/api/projects/${project.id}/stems/control?${query}`);
    await expectStatus(response, 200, `${options.format} export`);
    const expectedExtension = options.format === 'aac' ? 'm4a' : options.format;
    const filename = path.join(temp, `control.${expectedExtension}`);
    writeFileSync(filename, Buffer.from(await response.arrayBuffer()));
    const info = probe(filename);
    assert.equal(info.codec_name, options.codec, `${options.format} codec`);
    assert.equal(Number(info.sample_rate), options.rate, `${options.format} sample rate`);
    assert.equal(Number(info.channels), options.channelCount, `${options.format} channel count`);
    if (options.format === 'wav') assert.equal(Number(info.bits_per_sample || info.bits_per_raw_sample), 24, 'WAV 24-bit depth');
    if (options.format === 'flac') assert.equal(Number(info.bits_per_raw_sample), 24, 'FLAC 24-bit depth');
    console.log(`PASS ${options.format.toUpperCase()} export (${info.sample_rate} Hz, ${info.channels} ch, ${info.codec_name})`);
  }

  for (const format of ['wav', 'mp3']) {
    const response = await fetch(`${base}/api/projects/${project.id}/export.zip?format=${format}`);
    await expectStatus(response, 200, `${format} ZIP`);
    const zipPath = path.join(temp, `stems-${format}.zip`);
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
    assert.equal(readFileSync(zipPath).readUInt32LE(0), 0x04034b50, 'ZIP local-file signature');
    const python = path.join(root, '.venv', 'Scripts', 'python.exe');
    const check = spawnSync(python, ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print("|".join(z.namelist()))', zipPath], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(check.status, 0, check.stderr);
    assert(check.stdout.includes(`export-control/control.${format}`));
    console.log(`PASS ZIP ${format.toUpperCase()} package contains the exported stem`);
  }
} finally {
  db?.close();
  await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE' }).catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
