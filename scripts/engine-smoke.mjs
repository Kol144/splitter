import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(root, '.venv', 'Scripts', 'python.exe');
const runner = path.join(root, 'backend', 'separation', 'runner.py');
const model = process.argv[2] || 'htdemucs';
const threads = process.argv[3] ? Number(process.argv[3]) : 4;
const supported = new Set(['htdemucs', 'htdemucs_ft', 'mdx_extra', 'mdx_extra_q', 'htdemucs_6s']);
assert(supported.has(model), 'Use an official model exposed by the local catalog.');
assert([4, 6].includes(threads), 'Use 4 or 6 threads.');
assert(existsSync(python), 'Run INSTALL.bat before this engine check.');

function makeControlWav(seconds = 5, sampleRate = 44100) {
  const channels = 2;
  const frames = seconds * sampleRate;
  const dataBytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28); wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  let seed = 918273;
  const noise = () => { seed = (seed * 48271) % 2147483647; return (seed / 1073741823.5) - 1; };
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const beat = t % 0.5;
    const kick = 0.45 * Math.exp(-beat * 38) * Math.sin(2 * Math.PI * (58 - beat * 35) * t);
    const hat = beat < 0.012 ? noise() * 0.16 * Math.exp(-beat * 220) : 0;
    const bass = 0.16 * Math.sin(2 * Math.PI * 55 * t) + 0.06 * Math.sin(2 * Math.PI * 110 * t);
    const melody = 0.12 * Math.sin(2 * Math.PI * (220 + 110 * Math.sin(2 * Math.PI * 0.18 * t)) * t);
    const pad = 0.06 * Math.sin(2 * Math.PI * 329.63 * t) + 0.035 * Math.sin(2 * Math.PI * 440 * t);
    const signal = Math.max(-0.9, Math.min(0.9, bass + melody + pad + kick + hat));
    const left = Math.round(signal * 32767);
    const right = Math.round(Math.max(-0.9, Math.min(0.9, signal * 0.96 + 0.02 * Math.sin(2 * Math.PI * 440 * t))) * 32767);
    wav.writeInt16LE(left, 44 + i * 4); wav.writeInt16LE(right, 46 + i * 4);
  }
  return wav;
}

function readWavInfo(filename) {
  const wav = readFileSync(filename);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let offset = 12, sampleRate = 0, channels = 0, bits = 0, dataBytes = 0;
  while (offset + 8 <= wav.length) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (tag === 'fmt ') { channels = wav.readUInt16LE(offset + 10); sampleRate = wav.readUInt32LE(offset + 12); bits = wav.readUInt16LE(offset + 22); }
    if (tag === 'data') dataBytes = size;
    offset += 8 + size + (size % 2);
  }
  assert(sampleRate > 0 && channels > 0 && bits > 0 && dataBytes > 0, `Invalid WAV header: ${filename}`);
  return { sampleRate, channels, bits, bytes: statSync(filename).size, duration: dataBytes / (sampleRate * channels * bits / 8) };
}

const precheck = spawnSync(python, [runner, 'has-model', model], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
assert.equal(precheck.status, 0, precheck.stderr || precheck.stdout);
assert.equal(precheck.stdout.trim().split(/\r?\n/).at(-1), 'installed', `${model} weights are not installed.`);

const fixtureRoot = path.join(root, 'data', 'temp', `engine-check-${randomUUID()}`);
mkdirSync(fixtureRoot, { recursive: true });
try {
  const input = path.join(fixtureRoot, 'control-mix.wav');
  const output = path.join(fixtureRoot, 'out');
  writeFileSync(input, makeControlWav());
  const startedAt = Date.now();
  const child = spawn(python, [runner, 'separate', '--input', input, '--output', output, '--model', model, '--threads', String(threads), '--shifts', '0', '--overlap', '0.1'], { cwd: root, windowsHide: true });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0, `${model} separation process failed.`);
  const modelFolder = path.join(output, model);
  const trackFolder = path.join(modelFolder, path.parse(input).name);
  const stems = readdirSync(trackFolder, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.wav')).map(entry => path.join(trackFolder, entry.name));
  assert.deepEqual(stems.map(filename => path.parse(filename).name).sort(), ['bass', 'drums', 'other', 'vocals']);
  const infos = stems.map(filename => ({ stem: path.parse(filename).name, ...readWavInfo(filename) }));
  assert(infos.every(info => info.channels === 2 && info.sampleRate === 44100 && Math.abs(info.duration - 5) < 0.02));
  console.log(JSON.stringify({ result: 'PASS', model, threads, elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)), stems: infos }, null, 2));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
