import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { pipeline, Transform } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const pipe = promisify(pipeline);
const root = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.join(root, 'data');
const projectsRoot = path.join(dataRoot, 'projects');
const tempRoot = path.join(dataRoot, 'temp');
const exportsRoot = path.join(dataRoot, 'exports');
const webRoot = path.join(root, 'web');
const maxUploadBytes = 2 * 1024 * 1024 * 1024;
const port = Number(process.env.AIMS_PORT || 4173);
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
const terminalJobStatuses = new Set(['completed', 'failed', 'cancelled']);
const activeJobs = new Map();
const mediaOperations = new Map();
let modelOperation = null;
let pythonResolution = undefined;
let pythonResolvedAt = 0;
let gpuDetection = null;
let gpuDetectionPromise = null;

for (const dir of [dataRoot, projectsRoot, tempRoot, exportsRoot]) mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(path.join(dataRoot, 'library.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    original_path TEXT NOT NULL,
    audio_path TEXT,
    media_kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    duration REAL,
    sample_rate INTEGER,
    channels INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'imported'
  );
  CREATE TABLE IF NOT EXISTS stems (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    raw_path TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, name)
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    profile TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT
  );
`);
if (!db.prepare('PRAGMA table_info(stems)').all().some(column => column.name === 'raw_path')) {
  db.exec('ALTER TABLE stems ADD COLUMN raw_path TEXT');
}

const audioExtensions = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.aiff', '.aif', '.wma']);
const videoExtensions = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm']);
const catalog = [
  {
    id: 'htdemucs', name: 'HTDemucs', group: 'Demucs v4', sources: ['vocals', 'drums', 'bass', 'other'],
    description: 'Modelo híbrido de cuatro stems para uso diario.', size: '84 MB aprox.', experimental: false, license: 'MIT',
    quality: 'Estándar', cpuCost: '1×', minFreeMemoryBytes: 1200 * MiB, ensemble: false
  },
  {
    id: 'htdemucs_ft', name: 'HTDemucs Fine-Tuned', group: 'Demucs v4 · ensemble', sources: ['vocals', 'drums', 'bass', 'other'],
    description: 'Ensemble oficial afinado por fuente. Prioriza la calidad de cuatro stems y tarda aproximadamente cuatro veces más que HTDemucs.', size: 'Consultar antes de descargar', experimental: false, license: 'MIT',
    quality: 'Máxima calidad oficial', cpuCost: '≈4×', minFreeMemoryBytes: 3 * GiB, ensemble: true, recommendedForQuality: true
  },
  {
    id: 'mdx_extra', name: 'MDX-Extra', group: 'Demucs v4 · ensemble', sources: ['vocals', 'drums', 'bass', 'other'],
    description: 'Alternativa oficial MDX entrenada con datos adicionales. No requiere DiffQ y permite comparar resultados por canción.', size: 'Consultar antes de descargar', experimental: false, license: 'MIT',
    quality: 'Alternativa de calidad', cpuCost: 'Alto', minFreeMemoryBytes: Math.floor(3.5 * GiB), ensemble: true
  },
  {
    id: 'mdx_extra_q', name: 'MDX-Extra-Q', group: 'Demucs v4', sources: ['vocals', 'drums', 'bass', 'other'],
    description: 'Versión cuantizada de MDX-Extra: reduce almacenamiento, pero puede perder algo de precisión frente al modelo sin cuantizar.', size: 'Consultar antes de descargar', experimental: false, license: 'Demucs MIT · DiffQ CC-BY-NC 4.0',
    quality: 'Alternativa ligera', cpuCost: 'Medio', minFreeMemoryBytes: 2 * GiB, ensemble: true
  },
  {
    id: 'htdemucs_6s', name: 'HTDemucs 6S', group: 'Experimental', sources: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'],
    description: 'Añade guitarra y piano; la separación de piano sigue siendo experimental y puede contener filtraciones.', size: 'Consultar antes de descargar', experimental: true, license: 'MIT',
    quality: 'Fuentes adicionales', cpuCost: 'Alto', minFreeMemoryBytes: 2 * GiB, ensemble: false
  }
];

function formatForProfile(profile, model) {
  if (profile === 'performance') return { shifts: '0', overlap: '0.1', outputFormat: 'pcm16', outputBitDepth: 16, label: 'Rendimiento' };
  if (profile === 'maximum') {
    // The fine-tuned and MDX models are already multi-model ensembles. Running
    // additional randomized passes would multiply their CPU time again without
    // being a sensible default for an 8 GB CPU-only computer.
    const shifts = model.ensemble ? '0' : '2';
    return { shifts, overlap: '0.5', outputFormat: 'float32', outputBitDepth: 32, label: 'Máxima calidad' };
  }
  return { shifts: '0', overlap: '0.25', outputFormat: 'pcm24', outputBitDepth: 24, label: 'Equilibrado' };
}

function expectedStemBytes(project, model, outputFormat) {
  const duration = Number(project.duration);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const bytesPerSample = outputFormat === 'float32' ? 4 : outputFormat === 'pcm24' ? 3 : 2;
  // Demucs writes every source before the app discards unchecked ones, so use
  // the full model source count for the temporary disk reservation.
  return Math.ceil(duration * 44100 * 2 * bytesPerSample * model.sources.length);
}

function availableDiskBytes(folder) {
  try {
    const fs = statfsSync(folder);
    return Number(fs.bavail) * Number(fs.bsize || fs.frsize);
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function safeSpawnSync(command, args, options = {}) {
  try { return spawnSync(command, args, options); }
  catch (error) { return { status: null, stdout: '', stderr: error.message, error }; }
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('La solicitud es demasiado grande.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('El cuerpo JSON no es válido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function saveUpload(req, destination) {
  let bytes = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxUploadBytes) callback(Object.assign(new Error('El archivo supera el límite local de 2 GB.'), { status: 413 }));
    else callback(null, chunk);
  } });
  await pipe(req, limiter, createWriteStream(destination, { flags: 'wx' }));
  if (!bytes) throw Object.assign(new Error('El archivo está vacío.'), { status: 400 });
  return bytes;
}

function validateContainerHeader(filename, ext) {
  const fd = openSync(filename, 'r');
  const header = Buffer.alloc(16);
  let bytes;
  try { bytes = readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  const data = header.subarray(0, bytes);
  const starts = signature => data.subarray(0, signature.length).equals(signature);
  const has = (value, offset = 0) => data.subarray(offset, offset + value.length).equals(Buffer.from(value, 'ascii'));
  if (['.wav'].includes(ext)) return has('RIFF') && has('WAVE', 8);
  if (ext === '.flac') return has('fLaC');
  if (ext === '.ogg' || ext === '.opus') return has('OggS');
  if (ext === '.mp3') return has('ID3') || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
  if (ext === '.aac') return has('ID3') || (data[0] === 0xff && (data[1] & 0xf6) === 0xf0) || has('ftyp', 4);
  if (ext === '.m4a' || ext === '.mp4' || ext === '.mov') return has('ftyp', 4);
  if (ext === '.mkv' || ext === '.webm') return starts(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (ext === '.avi') return has('RIFF') && has('AVI ', 8);
  if (ext === '.aiff' || ext === '.aif') return has('FORM') && (has('AIFF', 8) || has('AIFC', 8));
  if (ext === '.wma') return starts(Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]));
  return false;
}

function resolvePython() {
  if (Date.now() - pythonResolvedAt < 10000) return pythonResolution;
  const local = path.join(root, '.venv', 'Scripts', 'python.exe');
  if (existsSync(local)) { pythonResolution = { command: local, prefix: [] }; pythonResolvedAt = Date.now(); return pythonResolution; }
  const configured = process.env.AIMS_PYTHON;
  if (configured && existsSync(configured)) { pythonResolution = { command: configured, prefix: [] }; pythonResolvedAt = Date.now(); return pythonResolution; }
  for (const candidate of [['py', ['-3']], ['python', []], ['python3', []]]) {
    const check = safeSpawnSync(candidate[0], [...candidate[1], '--version'], { encoding: 'utf8', timeout: 2500, windowsHide: true });
    if (check.status === 0) { pythonResolution = { command: candidate[0], prefix: candidate[1] }; pythonResolvedAt = Date.now(); return pythonResolution; }
  }
  pythonResolution = null; pythonResolvedAt = Date.now(); return null;
}

function pythonCheck() {
  const python = resolvePython();
  if (!python) return { available: false, message: 'Python no está instalado. Ejecuta INSTALL.bat y sigue la guía de instalación.' };
  const result = safeSpawnSync(python.command, [...python.prefix, '-c', 'import importlib.metadata as m, importlib.util as u; print(m.version("torch") if u.find_spec("torch") else "missing"); print(m.version("demucs") if u.find_spec("demucs") else "missing")'], { cwd: root, encoding: 'utf8', timeout: 7000, windowsHide: true });
  const lines = String(result.stdout || '').trim().split(/\r?\n/);
  return result.status === 0 && lines[0] !== 'missing' && lines[1] !== 'missing'
    ? { available: true, version: lines[0], demucsVersion: lines[1], python: python.command, prefix: python.prefix }
    : { available: false, python: python.command, message: 'Falta PyTorch CPU o Demucs en el entorno virtual. Ejecuta INSTALL.bat.' };
}

async function detectGpu() {
  if (gpuDetection) return gpuDetection;
  if (gpuDetectionPromise) return gpuDetectionPromise;
  gpuDetectionPromise = (async () => {
    const nvidia = await spawnCapture('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { timeout: 1800, maxChars: 32 * 1024 });
    if (nvidia.status === 0 && nvidia.stdout.trim()) {
      const [name, driver] = nvidia.stdout.trim().split(/,\s*/, 2);
      gpuDetection = { name, driver, verified: true, cuda: 'No activada; la instalación usa PyTorch CPU.' };
      return gpuDetection;
    }
    const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM | ConvertTo-Json -Compress";
    const query = await spawnCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 3000, maxChars: 256 * 1024 });
    if (query.status === 0 && query.stdout.trim()) {
      try {
        const parsed = JSON.parse(query.stdout.trim());
        const adapters = Array.isArray(parsed) ? parsed : [parsed];
        gpuDetection = { adapters: adapters.map(item => ({ name: item.Name, driver: item.DriverVersion || null, adapterRamBytes: Number(item.AdapterRAM) || null })), verified: true, cuda: 'Desactivada; la instalación usa PyTorch CPU.' };
        return gpuDetection;
      } catch { }
    }
    gpuDetection = { name: null, driver: null, verified: false, status: 'No se pudo consultar el adaptador gráfico ni el controlador; la inferencia permanece en CPU.' };
    return gpuDetection;
  })();
  return gpuDetectionPromise;
}

async function detectCpuTopology() {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Processor | Select-Object NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed | ConvertTo-Json -Compress";
  const query = await spawnCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 3000, maxChars: 64 * 1024 });
  if (query.status !== 0 || !query.stdout.trim()) return { physicalCores: null, logicalCores: null, maxClockMHz: null };
  try {
    const parsed = JSON.parse(query.stdout.trim());
    const processors = Array.isArray(parsed) ? parsed : [parsed];
    return {
      physicalCores: processors.reduce((total, cpu) => total + (Number(cpu.NumberOfCores) || 0), 0) || null,
      logicalCores: processors.reduce((total, cpu) => total + (Number(cpu.NumberOfLogicalProcessors) || 0), 0) || null,
      maxClockMHz: Math.max(0, ...processors.map(cpu => Number(cpu.MaxClockSpeed) || 0)) || null
    };
  } catch { return { physicalCores: null, logicalCores: null, maxClockMHz: null }; }
}

function runPython(args, { timeout = 15000 } = {}) {
  const python = resolvePython();
  if (!python) throw Object.assign(new Error('Python no está instalado. Ejecuta INSTALL.bat.'), { status: 503 });
  return safeSpawnSync(python.command, [...python.prefix, path.join(root, 'backend', 'separation', 'runner.py'), ...args], { cwd: root, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

function runPythonAsync(args, { timeout = 45000 } = {}) {
  const python = resolvePython();
  if (!python) return Promise.reject(Object.assign(new Error('Python no está instalado. Ejecuta INSTALL.bat.'), { status: 503 }));
  return new Promise((resolve, reject) => {
    const child = spawn(python.command, [...python.prefix, path.join(root, 'backend', 'separation', 'runner.py'), ...args], { cwd: root, windowsHide: true, env: { ...process.env } });
    let stdout = '', stderr = '', timedOut = false;
    const timeoutHandle = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-4 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4 * 1024 * 1024); });
    child.on('error', error => { clearTimeout(timeoutHandle); reject(Object.assign(error, { status: 503 })); });
    child.on('close', code => {
      clearTimeout(timeoutHandle);
      resolve({ status: timedOut ? null : code, stdout, stderr: timedOut ? `${stderr}\nTamaño agotó el límite de espera.`.trim() : stderr });
    });
  });
}

function inspectEngine() {
  const check = pythonCheck();
  if (!check.available) return { ready: false, python: check, models: catalog.map(m => ({ ...m, installed: false, state: 'engine-missing' })) };
  const result = runPython(['inventory'], { timeout: 20000 });
  if (result.status !== 0) return { ready: false, python: check, error: result.stderr || result.stdout, models: catalog.map(m => ({ ...m, installed: false, state: 'engine-error' })) };
  let inventory;
  try { inventory = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); }
  catch { return { ready: false, python: check, error: 'No se pudo interpretar el inventario de Demucs.', models: catalog.map(m => ({ ...m, installed: false, state: 'engine-error' })) }; }
  return { ready: true, python: check, models: catalog.map(m => {
    const status = inventory[m.id] || {};
    const dependencyAvailable = status.dependencyAvailable !== false;
    return { ...m, installed: Boolean(status.installed), cacheBytes: status.cacheBytes || 0, dependencyAvailable, dependencyMessage: status.dependencyError || null, state: !dependencyAvailable ? 'dependency-missing' : status.installed ? 'installed' : 'not-installed' };
  }) };
}

function spawnCapture(command, args, { timeout = 12000, maxChars = 2 * 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { windowsHide: true }); }
    catch (error) { resolve({ status: null, stdout: '', stderr: error.message }); return; }
    let stdout = '', stderr = '', timedOut = false;
    const timeoutHandle = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-maxChars); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-maxChars); });
    child.on('error', error => { clearTimeout(timeoutHandle); resolve({ status: null, stdout, stderr: `${stderr}\n${error.message}`.trim() }); });
    child.on('close', code => { clearTimeout(timeoutHandle); resolve({ status: timedOut ? null : code, stdout, stderr: timedOut ? `${stderr}\nEl proceso agotó el límite de espera.`.trim() : stderr }); });
  });
}

async function audioProbe(filePath) {
  const result = await spawnCapture('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath]);
  if (result.status !== 0 || !result.stdout) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function getProject(id) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!row) return null;
  const stems = db.prepare('SELECT name, path, raw_path AS rawPath, created_at AS createdAt FROM stems WHERE project_id = ? ORDER BY name').all(id);
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json); } catch { }
  return {
    id: row.id, name: row.name, originalName: row.original_name, mediaKind: row.media_kind,
    createdAt: row.created_at, duration: row.duration, sampleRate: row.sample_rate, channels: row.channels,
    status: row.status, hasAudio: Boolean(row.audio_path), audioPath: row.audio_path || null,
    metadata, stems
  };
}

function publicProject(project) {
  if (!project) return null;
  const { audioPath, ...safe } = project;
  safe.stems = project.stems.map(({ name, createdAt, rawPath }) => ({ name, createdAt, hasRaw: Boolean(rawPath) }));
  return safe;
}

function safeInside(parent, target) {
  const base = path.resolve(parent) + path.sep;
  const resolved = path.resolve(target);
  return resolved.startsWith(base);
}

function isActiveJob(job) {
  return Boolean(job) && !terminalJobStatuses.has(job.status);
}

function removePathSafely(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch {
    // A Windows file handle can outlive process termination briefly. The next
    // project cleanup still removes it, and an unsuccessful best-effort cleanup
    // must never crash the local API server.
    return false;
  }
}

function cleanupJobOutput(job) {
  if (!job?.outputRoot) return;
  const projectStemRoot = path.join(projectsRoot, job.projectId, 'stems');
  if (safeInside(projectStemRoot, job.outputRoot)) removePathSafely(job.outputRoot);
}

function finishCancelledJob(job) {
  cleanupJobOutput(job);
  job.child = null;
  job.status = 'cancelled';
  job.message = 'Trabajo cancelado por el usuario.';
  job.finishedAt = new Date().toISOString();
  db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run('cancelled', job.finishedAt, job.id);
  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('cancelled', job.projectId);
}

function contentType(ext) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' })[ext] || 'application/octet-stream';
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(webRoot, `.${pathname}`);
  if (!safeInside(webRoot, target) || !existsSync(target) || !statSync(target).isFile()) return send(res, 404, { error: 'No encontrado.' });
  res.writeHead(200, { 'Content-Type': contentType(path.extname(target)), 'Cache-Control': 'no-cache' });
  createReadStream(target).pipe(res);
}

function sendFile(res, filename, downloadName, mime = 'audio/wav') {
  if (!existsSync(filename)) return send(res, 404, { error: 'El archivo solicitado ya no existe.' });
  const stat = statSync(filename);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${downloadName.replace(/[\r\n"\\]/g, '_')}"`, 'Cache-Control': 'private, max-age=0' });
  createReadStream(filename).pipe(res);
}

const exportFormats = {
  wav: { ext: 'wav', mime: 'audio/wav', lossy: false },
  flac: { ext: 'flac', mime: 'audio/flac', lossy: false },
  mp3: { ext: 'mp3', mime: 'audio/mpeg', lossy: true },
  aac: { ext: 'm4a', mime: 'audio/mp4', lossy: true },
  ogg: { ext: 'ogg', mime: 'audio/ogg', lossy: true },
  aiff: { ext: 'aiff', mime: 'audio/aiff', lossy: false }
};

function readExportOptions(url) {
  const format = (url.searchParams.get('format') || 'wav').toLowerCase();
  const spec = exportFormats[format];
  if (!spec) throw Object.assign(new Error('Formato de exportación no compatible.'), { status: 400 });
  const sampleRate = Number(url.searchParams.get('rate') || 44100);
  if (![44100, 48000, 88200, 96000].includes(sampleRate)) throw Object.assign(new Error('La frecuencia debe ser 44,1, 48, 88,2 o 96 kHz.'), { status: 400 });
  const channels = Number(url.searchParams.get('channels') || 2);
  if (![1, 2].includes(channels)) throw Object.assign(new Error('Elige mono o estéreo.'), { status: 400 });
  const bitDepth = Number(url.searchParams.get('bits') || 16);
  if (![16, 24, 32].includes(bitDepth)) throw Object.assign(new Error('Profundidad de bits no compatible.'), { status: 400 });
  if (format === 'flac' && bitDepth === 32) throw Object.assign(new Error('FLAC admite 16 o 24 bits en este exportador.'), { status: 400 });
  const normalize = url.searchParams.get('normalize') === '1';
  return { format, ...spec, sampleRate, channels, bitDepth, normalize };
}

function exportCodecArgs(options) {
  const args = [];
  if (options.format === 'wav') args.push('-c:a', options.bitDepth === 16 ? 'pcm_s16le' : options.bitDepth === 24 ? 'pcm_s24le' : 'pcm_f32le');
  else if (options.format === 'flac') args.push('-c:a', 'flac', '-sample_fmt', options.bitDepth === 16 ? 's16' : 's32', '-bits_per_raw_sample', String(options.bitDepth));
  else if (options.format === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '320k');
  else if (options.format === 'aac') args.push('-c:a', 'aac', '-b:a', '256k', '-f', 'ipod');
  else if (options.format === 'ogg') args.push('-c:a', 'libvorbis', '-q:a', '6');
  else if (options.format === 'aiff') args.push('-c:a', options.bitDepth === 16 ? 'pcm_s16be' : options.bitDepth === 24 ? 'pcm_s24be' : 'pcm_f32be');
  return args;
}

function convertStem(source, options, onAbort) {
  return new Promise((resolve, reject) => {
    const output = path.join(tempRoot, `${crypto.randomUUID()}.${options.ext}`);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-ar', String(options.sampleRate), '-ac', String(options.channels)];
    if (options.normalize) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    args.push(...exportCodecArgs(options), output);
    let child;
    try { child = spawn('ffmpeg', args, { windowsHide: true }); }
    catch (error) { reject(Object.assign(new Error(`FFmpeg no está disponible: ${error.message}`), { status: 503 })); return; }
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => { child.kill(); finish(new Error('La conversión superó el límite de espera de 15 minutos.')); }, 15 * 60 * 1000);
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) { child.kill(); rmSync(output, { force: true }); reject(error); }
      else resolve(output);
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', error => finish(Object.assign(new Error(`No se pudo ejecutar FFmpeg: ${error.message}`), { status: 503 })));
    child.on('close', code => code === 0 && existsSync(output) ? finish(null) : finish(Object.assign(new Error(stderr.trim() || `FFmpeg terminó con código ${code}.`), { status: 500 })));
    onAbort?.(() => finish(Object.assign(new Error('Exportación cancelada por el cliente.'), { status: 499 })));
  });
}

function sourceWavMatchesOptions(options, project) {
  const outputFormat = project?.metadata?.inference?.outputFormat || 'pcm16';
  const sourceBitDepth = outputFormat === 'float32' ? 32 : outputFormat === 'pcm24' ? 24 : 16;
  return options.format === 'wav' && options.sampleRate === 44100 && options.channels === 2 && options.bitDepth === sourceBitDepth && !options.normalize;
}

function streamMedia(req, res, filename, mime) {
  if (!existsSync(filename)) return send(res, 404, { error: 'El archivo solicitado ya no existe.' });
  const stat = statSync(filename);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0' });
    return createReadStream(filename).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Accept-Ranges': 'bytes' });
    return res.end();
  }
  let start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : stat.size - 1;
  if (start > end || start >= stat.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Accept-Ranges': 'bytes' });
    return res.end();
  }
  end = Math.min(end, stat.size - 1);
  res.writeHead(206, { 'Content-Type': mime, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0' });
  return createReadStream(filename, { start, end }).pipe(res);
}

async function crc32File(filename) {
  let crc = 0xffffffff, size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    for (const byte of chunk) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return { crc: (crc ^ 0xffffffff) >>> 0, size };
}

async function writeChunk(stream, buffer) {
  if (stream.writeError) throw stream.writeError;
  const ready = stream.write(buffer);
  if (!ready) await new Promise((resolve, reject) => { stream.once('drain', resolve); stream.once('error', reject); });
  if (stream.writeError) throw stream.writeError;
}

async function makeZipFile(entries) {
  let offset = 0;
  const metadata = [];
  for (const entry of entries) {
    const fileInfo = await crc32File(entry.path);
    const filename = Buffer.from(entry.name.replace(/\\/g, '/'));
    if (fileInfo.size > 0xffffffff || offset + 30 + filename.length + fileInfo.size > 0xffffffff) throw new Error('El ZIP supera el límite de 4 GB del formato ZIP32.');
    metadata.push({ ...entry, ...fileInfo, filename, offset });
    offset += 30 + filename.length + fileInfo.size;
  }
  const zipPath = path.join(exportsRoot, `${crypto.randomUUID()}.zip`);
  const output = createWriteStream(zipPath, { flags: 'wx' });
  output.on('error', error => { output.writeError = error; });
  try {
    const centrals = [];
    let localOffset = 0;
    for (const entry of metadata) {
      const local = Buffer.alloc(30 + entry.filename.length);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
      local.writeUInt32LE(entry.crc, 14); local.writeUInt32LE(entry.size, 18); local.writeUInt32LE(entry.size, 22);
      local.writeUInt16LE(entry.filename.length, 26); entry.filename.copy(local, 30);
      await writeChunk(output, local);
      for await (const chunk of createReadStream(entry.path)) await writeChunk(output, chunk);
      const central = Buffer.alloc(46 + entry.filename.length);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
      central.writeUInt32LE(entry.crc, 16); central.writeUInt32LE(entry.size, 20); central.writeUInt32LE(entry.size, 24);
      central.writeUInt16LE(entry.filename.length, 28); central.writeUInt32LE(localOffset, 42); entry.filename.copy(central, 46);
      centrals.push(central);
      localOffset += local.length + entry.size;
    }
    for (const central of centrals) await writeChunk(output, central);
    const centralSize = centrals.reduce((total, buffer) => total + buffer.length, 0);
    if (localOffset + centralSize + 22 > 0xffffffff) throw new Error('El ZIP supera el límite de 4 GB del formato ZIP32.');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(localOffset, 16);
    await writeChunk(output, end);
    output.end();
    await new Promise((resolve, reject) => { output.once('finish', resolve); output.once('error', reject); });
    return zipPath;
  } catch (error) {
    output.destroy(); rmSync(zipPath, { force: true }); throw error;
  }
}

function spawnManaged(python, args, onLine, onFinish) {
  const child = spawn(python.command, [...python.prefix, path.join(root, 'backend', 'separation', 'runner.py'), ...args], { cwd: root, windowsHide: true, env: { ...process.env } });
  let finished = false;
  for (const stream of [child.stdout, child.stderr]) {
    let carry = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      carry += chunk;
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || '';
      for (const line of lines) if (line.trim()) onLine(line.trim());
    });
    stream.on('end', () => { if (carry.trim()) onLine(carry.trim()); });
  }
  child.on('error', error => { if (finished) return; finished = true; onFinish(error, null); });
  child.on('close', code => { if (finished) return; finished = true; onFinish(null, code); });
  return child;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const cpus = os.cpus();
    const [gpu, cpuTopology] = await Promise.all([detectGpu(), detectCpuTopology()]);
    return send(res, 200, {
      app: 'AI Music Separator Studio', version: '0.1.0', ready: true,
      hardware: { os: `${os.type()} ${os.release()}`, platform: process.platform, architecture: process.arch, cpu: cpus[0]?.model || 'No detectado', physicalCores: cpuTopology.physicalCores, logicalCores: cpuTopology.logicalCores || cpus.length, maxClockMHz: cpuTopology.maxClockMHz, totalMemoryBytes: os.totalmem(), availableMemoryBytes: os.freemem(), gpu },
      python: pythonCheck(),
      ffmpeg: safeSpawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).status === 0,
      ffprobe: safeSpawnSync('ffprobe', ['-version'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).status === 0,
      activeJob: (() => { const j = [...activeJobs.values()].find(isActiveJob); return j ? { id: j.id, status: j.status, projectId: j.projectId } : null; })()
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const ids = db.prepare('SELECT id FROM projects ORDER BY created_at DESC').all();
    return send(res, 200, ids.map(({ id }) => publicProject(getProject(id))));
  }

  if (req.method === 'POST' && url.pathname === '/api/import') {
    const originalName = path.basename(url.searchParams.get('name') || 'audio');
    const ext = path.extname(originalName).toLowerCase();
    const isAudio = audioExtensions.has(ext), isVideo = videoExtensions.has(ext);
    if (!isAudio && !isVideo) return send(res, 415, { error: `Formato no admitido: ${ext || 'sin extensión'}.` });
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > maxUploadBytes) return send(res, 413, { error: 'El archivo supera el límite local de 2 GB.' });
    const id = crypto.randomUUID();
    const folder = path.join(projectsRoot, id);
    mkdirSync(folder, { recursive: false });
    const originalPath = path.join(folder, `original${ext}`);
    try {
      const bytes = await saveUpload(req, originalPath);
      if (!validateContainerHeader(originalPath, ext)) throw Object.assign(new Error('El contenido del archivo no coincide con su extensión o no es un contenedor compatible.'), { status: 422 });
      let browserMetadata = {};
      try { browserMetadata = JSON.parse(Buffer.from(req.headers['x-media-metadata'] || '', 'base64').toString('utf8') || '{}'); } catch { }
      const probe = await audioProbe(originalPath);
      const audioStreams = (probe?.streams || []).filter(stream => stream.codec_type === 'audio').map((stream, audioIndex) => ({ audioIndex, streamIndex: stream.index, codec: stream.codec_name, sampleRate: Number(stream.sample_rate) || null, channels: stream.channels || null, duration: Number(stream.duration || probe.format?.duration) || null, label: stream.tags?.title || stream.tags?.handler_name || `Audio ${audioIndex + 1}`, language: stream.tags?.language || null }));
      const duration = Number(probe?.format?.duration || browserMetadata.duration) || null;
      const sampleRate = Number(audioStreams[0]?.sampleRate || browserMetadata.sampleRate) || null;
      const channels = Number(audioStreams[0]?.channels || browserMetadata.channels) || null;
      const metadata = { bytes, browser: browserMetadata, audioStreams, probeAvailable: Boolean(probe), needsExtraction: isVideo, ffmpegAvailable: safeSpawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).status === 0 };
      db.prepare('INSERT INTO projects (id,name,original_name,original_path,media_kind,created_at,duration,sample_rate,channels,metadata_json,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, originalName.replace(/\.[^.]+$/, ''), originalName, originalPath, isVideo ? 'video' : 'audio', new Date().toISOString(), duration, sampleRate, channels, JSON.stringify(metadata), isVideo ? 'needs-audio-extraction' : 'imported');
      if (isAudio) db.prepare('UPDATE projects SET audio_path = original_path WHERE id = ?').run(id);
      return send(res, 201, publicProject(getProject(id)));
    } catch (error) {
      rmSync(folder, { recursive: true, force: true });
      throw error;
    }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/temp') {
    const entries = readdirSync(tempRoot, { withFileTypes: true });
    let deleted = 0;
    for (const entry of entries) {
      const target = path.join(tempRoot, entry.name);
      if (!safeInside(tempRoot, target)) continue;
      rmSync(target, { recursive: true, force: true });
      deleted++;
    }
    return send(res, 200, { deleted });
  }

  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    send(res, 200, { stopped: true });
    setTimeout(() => server.close(() => process.exit(0)), 100);
    return;
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'original' && parts.length === 4) {
    const row = db.prepare('SELECT original_path, original_name FROM projects WHERE id = ?').get(parts[2]);
    if (!row) return send(res, 404, { error: 'Proyecto no encontrado.' });
    const mime = ({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.aac': 'audio/aac' })[path.extname(row.original_name).toLowerCase()] || 'application/octet-stream';
    return streamMedia(req, res, row.original_path, mime);
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'audio' && parts.length === 4) {
    const row = db.prepare('SELECT audio_path FROM projects WHERE id = ?').get(parts[2]);
    if (!row?.audio_path) return send(res, 404, { error: 'Audio no disponible.' });
    const audioExt = path.extname(row.audio_path).toLowerCase();
    const audioMime = ({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.wma': 'audio/x-ms-wma' })[audioExt] || 'application/octet-stream';
    return streamMedia(req, res, row.audio_path, audioMime);
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 3) {
    const project = getProject(parts[2]);
    return project ? send(res, 200, publicProject(project)) : send(res, 404, { error: 'Proyecto no encontrado.' });
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'extract') {
    const project = getProject(parts[2]);
    if (!project) return send(res, 404, { error: 'Proyecto no encontrado.' });
    if (project.mediaKind !== 'video') return send(res, 400, { error: 'El proyecto ya es audio.' });
    if ([...activeJobs.values()].some(job => job.projectId === project.id && isActiveJob(job))) return send(res, 409, { error: 'Espera a que termine el trabajo del proyecto.' });
    if (mediaOperations.get(project.id) && !['completed', 'failed', 'cancelled'].includes(mediaOperations.get(project.id).status)) return send(res, 409, { error: 'Ya se está extrayendo el audio de este vídeo.' });
    const ffmpeg = safeSpawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    if (ffmpeg.status !== 0) return send(res, 503, { error: 'FFmpeg no está disponible. Instálalo y vuelve a iniciar la aplicación.' });
    const body = await readJson(req);
    const audioIndex = Number(body.audioIndex || 0);
    const metaRow = db.prepare('SELECT original_path, metadata_json FROM projects WHERE id = ?').get(project.id);
    const metadata = JSON.parse(metaRow.metadata_json || '{}');
    const selected = metadata.audioStreams?.[audioIndex];
    if (!selected) return send(res, 400, { error: 'No se pudo seleccionar una pista de audio del vídeo. Instala FFmpeg actualizado.' });
    const output = path.join(projectsRoot, project.id, 'audio-extracted.wav');
    const operation = { id: crypto.randomUUID(), projectId: project.id, status: 'extracting', message: `Extrayendo ${selected.label || `Audio ${audioIndex + 1}`} con FFmpeg…`, startedAt: new Date().toISOString(), selected, output, error: null };
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', metaRow.original_path, '-map', `0:${selected.streamIndex}`, '-c:a', 'pcm_s16le', output], { windowsHide: true });
    operation.child = child;
    mediaOperations.set(project.id, operation);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => {
      operation.child = null; operation.status = 'failed'; operation.error = error.message; operation.message = error.message; operation.finishedAt = new Date().toISOString();
      rmSync(output, { force: true });
    });
    child.on('close', code => {
      operation.child = null;
      if (operation.status === 'cancelled') return;
      operation.finishedAt = new Date().toISOString();
      if (code !== 0 || !existsSync(output)) {
        operation.status = 'failed'; operation.error = stderr.trim() || `FFmpeg terminó con código ${code}.`; operation.message = operation.error;
        rmSync(output, { force: true });
        return;
      }
      const updatedMetadata = { ...metadata, selectedAudio: selected };
      db.prepare('UPDATE projects SET audio_path = ?, status = ?, duration = ?, sample_rate = ?, channels = ?, metadata_json = ? WHERE id = ?')
        .run(output, 'imported', selected.duration || project.duration, selected.sampleRate || project.sampleRate, selected.channels || project.channels, JSON.stringify(updatedMetadata), project.id);
      operation.status = 'completed'; operation.message = 'Audio extraído y guardado como WAV.';
    });
    return send(res, 202, { id: operation.id, projectId: operation.projectId, status: operation.status, message: operation.message });
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'extract' && parts.length === 4) {
    const operation = mediaOperations.get(parts[2]);
    if (!operation) return send(res, 404, { error: 'No hay una operación de extracción para este proyecto.' });
    return send(res, 200, { id: operation.id, projectId: operation.projectId, status: operation.status, message: operation.message, error: operation.error, startedAt: operation.startedAt, finishedAt: operation.finishedAt });
  }

  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'extract' && parts.length === 4) {
    const operation = mediaOperations.get(parts[2]);
    if (!operation || !['extracting'].includes(operation.status)) return send(res, 409, { error: 'La extracción ya no se puede cancelar.' });
    operation.status = 'cancelled'; operation.message = 'Extracción cancelada por el usuario.'; operation.finishedAt = new Date().toISOString();
    operation.child?.kill(); operation.child = null; rmSync(operation.output, { force: true });
    return send(res, 200, { id: operation.id, status: operation.status });
  }

  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 3) {
    const id = parts[2];
    const row = db.prepare('SELECT original_path FROM projects WHERE id = ?').get(id);
    if (!row) return send(res, 404, { error: 'Proyecto no encontrado.' });
    const folder = path.dirname(row.original_path);
    if (!safeInside(projectsRoot, folder)) return send(res, 400, { error: 'Ruta de proyecto no válida.' });
    const activeJob = activeJobs.get(id);
    if (isActiveJob(activeJob)) { activeJob.status = 'cancelling'; activeJob.child?.kill(); }
    if (!isActiveJob(activeJob)) activeJobs.delete(id);
    if (mediaOperations.get(id)?.status === 'extracting') { mediaOperations.get(id).status = 'cancelled'; mediaOperations.get(id).child?.kill(); }
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    rmSync(folder, { recursive: true, force: true });
    return send(res, 200, { deleted: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    const inventory = inspectEngine();
    const operation = modelOperation ? { id: modelOperation.id, model: modelOperation.model, status: modelOperation.status, detail: modelOperation.detail, startedAt: modelOperation.startedAt, finishedAt: modelOperation.finishedAt, error: modelOperation.error, log: modelOperation.log } : null;
    return send(res, 200, { ...inventory, operation });
  }

  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'models' && parts.length === 3) {
    const model = catalog.find(item => item.id === parts[2]);
    if (!model) return send(res, 404, { error: 'Modelo desconocido.' });
    if ([...activeJobs.values()].some(isActiveJob)) return send(res, 409, { error: 'No se pueden quitar pesos durante una separación.' });
    if (modelOperation && !['completed', 'failed', 'cancelled'].includes(modelOperation.status)) return send(res, 409, { error: 'Espera o cancela la operación de modelo actual.' });
    const result = runPython(['remove', model.id], { timeout: 15000 });
    if (result.status !== 0) return send(res, 503, { error: result.stderr || 'No se pudo quitar el modelo.' });
    return send(res, 200, JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)));
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'models' && parts[3] === 'size') {
    const model = catalog.find(item => item.id === parts[2]);
    if (!model) return send(res, 404, { error: 'Modelo desconocido.' });
    const result = await runPythonAsync(['size', model.id], { timeout: 45000 });
    if (result.status !== 0) return send(res, 503, { error: result.stderr || 'No se pudo comprobar el tamaño. Comprueba la conexión y el estado de Demucs.' });
    return send(res, 200, JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)));
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'models' && parts[3] === 'install') {
    const model = catalog.find(item => item.id === parts[2]);
    if (!model) return send(res, 404, { error: 'Modelo desconocido.' });
    if (model.id === 'mdx_extra_q') {
      const dependency = runPython(['has-diffq'], { timeout: 15000 });
      if (dependency.status !== 0 || dependency.stdout.trim().split(/\r?\n/).at(-1) !== 'available') return send(res, 409, { error: 'MDX-Extra-Q requiere DiffQ. En Windows, instala Microsoft C++ Build Tools y ejecuta .venv\\Scripts\\python.exe -m pip install diffq==0.2.4.' });
    }
    if (modelOperation && !['completed', 'failed', 'cancelled'].includes(modelOperation.status)) return send(res, 409, { error: 'Ya hay una operación de modelo en curso.' });
    if ([...activeJobs.values()].some(isActiveJob)) return send(res, 409, { error: 'Espera a que termine el trabajo activo antes de instalar otro modelo.' });
    const available = os.freemem();
    const minimumFreeMemory = model.minFreeMemoryBytes || 1200 * MiB;
    if (available < minimumFreeMemory) return send(res, 409, { error: `Memoria disponible insuficiente para preparar ${model.name} (${(available / GiB).toFixed(1)} GB libres; se requieren ${(minimumFreeMemory / GiB).toFixed(1)} GB). Cierra otras aplicaciones e inténtalo de nuevo.` });
    const python = resolvePython();
    if (!python) return send(res, 503, { error: 'Instala Python y las dependencias con INSTALL.bat antes de instalar modelos.' });
    const operation = { id: crypto.randomUUID(), model: model.id, status: 'downloading', detail: 'Descargando pesos oficiales; el tamaño se mostró antes de empezar.', startedAt: new Date().toISOString(), log: [] };
    modelOperation = operation;
    operation.child = spawnManaged(python, ['install', model.id], line => { operation.log = [...operation.log.slice(-39), line]; operation.detail = line.slice(0, 220); }, (error, code) => {
      if (operation.status === 'cancelled') return;
      operation.child = null;
      operation.finishedAt = new Date().toISOString();
      operation.status = error ? 'failed' : code === 0 ? 'completed' : 'failed';
      if (error) operation.error = error.message;
      else if (code !== 0) operation.error = operation.log.at(-1) || `La instalación terminó con código ${code}.`;
    });
    return send(res, 202, { id: operation.id, model: operation.model, status: operation.status });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/models/operation') {
    if (modelOperation?.child && !['completed', 'failed', 'cancelled'].includes(modelOperation.status)) {
      modelOperation.child.kill(); modelOperation.status = 'cancelled'; modelOperation.finishedAt = new Date().toISOString(); modelOperation.child = null;
    }
    return send(res, 200, { operation: modelOperation });
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'refine' && parts.length === 4) {
    const project = getProject(parts[2]);
    if (!project) return send(res, 404, { error: 'Proyecto no encontrado.' });
    if (!project.stems.length) return send(res, 409, { error: 'Primero separa las pistas de este proyecto.' });
    if ([...activeJobs.values()].some(isActiveJob)) return send(res, 409, { error: 'Espera a que termine el trabajo activo.' });
    const body = await readJson(req);
    const mode = body.mode;
    if ([...activeJobs.values()].some(isActiveJob)) return send(res, 409, { error: 'Espera a que termine el trabajo activo.' });
    if (modelOperation && !['completed', 'failed', 'cancelled'].includes(modelOperation.status)) return send(res, 409, { error: 'Espera a que termine la operación del modelo.' });
    if (!['exact', 'conservative-residual'].includes(mode)) return send(res, 400, { error: 'Selecciona un modo de limpieza válido.' });
    const python = resolvePython();
    if (!python) return send(res, 503, { error: 'Python no está disponible.' });
    if (os.freemem() < 256 * MiB) return send(res, 409, { error: 'Se necesitan 256 MB libres para analizar los stems.' });
    const inputs = project.stems.map(stem => ({ name: stem.name, path: stem.rawPath || stem.path }));
    if (inputs.some(stem => !safeInside(path.join(projectsRoot, project.id), stem.path) || !existsSync(stem.path))) return send(res, 409, { error: 'Falta un stem original en el proyecto.' });
    const needed = Math.ceil(inputs.reduce((sum, stem) => sum + statSync(stem.path).size, 0) * 1.1);
    const freeDisk = availableDiskBytes(projectsRoot);
    if (freeDisk !== null && freeDisk < needed) return send(res, 409, { error: 'No hay espacio suficiente para conservar originales y copias revisadas.' });
    const id = crypto.randomUUID();
    const outputRoot = path.join(projectsRoot, project.id, 'stems', id);
    mkdirSync(outputRoot, { recursive: true });
    const manifest = path.join(outputRoot, 'inputs.json');
    writeFileSync(manifest, JSON.stringify({ stems: inputs }), 'utf8');
    const job = { id, projectId: project.id, model: project.metadata.lastModel || 'htdemucs', profile: 'refinement', outputRoot, status: 'refining', message: 'Revisando silencios de las pistas originales…', startedAt: new Date().toISOString(), logs: [] };
    activeJobs.set(project.id, job);
    db.prepare('INSERT INTO jobs (id,project_id,model,profile,status,started_at) VALUES (?,?,?,?,?,?)').run(id, project.id, job.model, job.profile, job.status, job.startedAt);
    job.child = spawnManaged(python, ['refine', '--manifest', manifest, '--output', outputRoot, '--mode', mode], line => {
      job.logs = [...job.logs.slice(-19), line];
      if (job.status !== 'cancelling') job.message = line;
    }, (error, code) => {
      job.child = null;
      job.finishedAt = new Date().toISOString();
      if (job.status === 'cancelling') { finishCancelledJob(job); return; }
      try {
        if (error || code !== 0) throw error || new Error(job.logs.at(-1) || `El análisis terminó con código ${code}.`);
        const refinement = JSON.parse(readFileSync(path.join(outputRoot, 'refinement-report.json'), 'utf8'));
        const metadata = { ...getProject(project.id).metadata, refinement };
        db.exec('BEGIN');
        try {
          for (const stem of inputs) {
            const revised = path.join(outputRoot, `${stem.name}.wav`);
            const applied = existsSync(revised);
            db.prepare('UPDATE stems SET path = ?, raw_path = ? WHERE project_id = ? AND name = ?').run(applied ? revised : stem.path, applied ? stem.path : null, project.id, stem.name);
          }
          db.prepare('UPDATE projects SET metadata_json = ?, status = ? WHERE id = ?').run(JSON.stringify(metadata), 'separated', project.id);
          db.exec('COMMIT');
        } catch (failure) { db.exec('ROLLBACK'); throw failure; }
        rmSync(manifest, { force: true });
        job.status = 'completed';
        job.message = `${Number(refinement.maskedSeconds).toFixed(1)} s revisados. Los originales siguen disponibles para comparar.`;
        db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run('completed', job.finishedAt, id);
      } catch (failure) {
        cleanupJobOutput(job);
        job.status = 'failed'; job.message = failure.message;
        db.prepare('UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?').run('failed', job.finishedAt, job.message, id);
      }
    });
    return send(res, 202, { id, status: job.status });
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'jobs' && parts.length === 2) {
    const body = await readJson(req);
    const project = getProject(String(body.projectId || ''));
    if (!project) return send(res, 404, { error: 'Selecciona un proyecto válido.' });
    if (!project.hasAudio) return send(res, 409, { error: 'Extrae el audio del vídeo antes de separar.' });
    if ([...activeJobs.values()].some(isActiveJob)) return send(res, 409, { error: 'Solo se permite una separación simultánea.' });
    if (modelOperation && !['completed', 'failed', 'cancelled'].includes(modelOperation.status)) return send(res, 409, { error: 'Espera a que termine la operación del modelo.' });
    const model = catalog.find(m => m.id === body.model);
    if (!model) return send(res, 400, { error: 'Selecciona un modelo compatible.' });
    const requestedSources = Array.isArray(body.sources) ? body.sources : model.sources;
    if (!requestedSources.some(source => model.sources.includes(source))) return send(res, 400, { error: 'Selecciona al menos una fuente compatible.' });
    if (requestedSources.some(source => !model.sources.includes(source))) return send(res, 400, { error: 'La fuente seleccionada no es compatible con el modelo actual.' });
    const profile = ['performance', 'balanced', 'maximum'].includes(body.profile) ? body.profile : 'balanced';
    const silenceRefinement = body.silenceRefinement || 'off';
    if (!['off', 'exact', 'conservative-residual'].includes(silenceRefinement)) return send(res, 400, { error: 'Selecciona un modo de limpieza de silencios válido.' });
    const threads = Number(body.threads) === 6 ? 6 : 4;
    const profileOptions = formatForProfile(profile, model);
    const inventoryResult = runPython(['has-model', model.id], { timeout: 15000 });
    if (inventoryResult.status !== 0 || inventoryResult.stdout.trim().split(/\r?\n/).at(-1) !== 'installed') return send(res, 409, { error: `El modelo ${model.name} no está instalado. Abre AI Models y pulsa Instalar para descargarlo desde la fuente oficial.` });
    const minimumFreeMemory = Math.max(model.minFreeMemoryBytes || 1200 * MiB, profile === 'maximum' ? 1600 * MiB : 0);
    if (os.freemem() < minimumFreeMemory) return send(res, 409, { error: `Memoria disponible insuficiente para ${model.name} (${(os.freemem() / GiB).toFixed(1)} GB libres; se requieren ${(minimumFreeMemory / GiB).toFixed(1)} GB antes de iniciar). Cierra otras aplicaciones e inténtalo de nuevo.` });
    const estimatedBytes = expectedStemBytes(project, model, profileOptions.outputFormat);
    const freeDisk = availableDiskBytes(projectsRoot);
    const requiredDisk = estimatedBytes === null ? null : Math.max(256 * MiB, Math.ceil(estimatedBytes * (silenceRefinement === 'off' ? 1.35 : 2.35)));
    if (freeDisk !== null && requiredDisk !== null && freeDisk < requiredDisk) return send(res, 409, { error: `Espacio en disco insuficiente para los stems de alta calidad. Se estiman ${(requiredDisk / MiB).toFixed(0)} MB libres necesarios y hay ${(freeDisk / MiB).toFixed(0)} MB disponibles.` });
    const python = resolvePython();
    if (!python) return send(res, 503, { error: 'Python no está instalado. Ejecuta INSTALL.bat.' });
    const id = crypto.randomUUID();
    const outputRoot = path.join(projectsRoot, project.id, 'stems', id);
    mkdirSync(outputRoot, { recursive: true });
    const inference = {
      profile,
      label: profileOptions.label,
      shifts: Number(profileOptions.shifts),
      overlap: Number(profileOptions.overlap),
      outputFormat: profileOptions.outputFormat,
      outputBitDepth: profileOptions.outputBitDepth,
      threads,
      silenceRefinement,
      expectedStemBytes: estimatedBytes
    };
    const job = { id, projectId: project.id, model: model.id, profile, threads, inference, outputRoot, status: 'preparing', progress: null, message: 'Preparando el modelo en CPU…', startedAt: new Date().toISOString(), logs: [] };
    activeJobs.set(project.id, job);
    db.prepare('INSERT INTO jobs (id,project_id,model,profile,status,started_at) VALUES (?,?,?,?,?,?)').run(id, project.id, model.id, profile, 'preparing', job.startedAt);
    db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('processing', project.id);
    job.child = spawnManaged(python, ['separate', '--input', project.audioPath, '--output', outputRoot, '--model', model.id, '--threads', String(threads), '--shifts', profileOptions.shifts, '--overlap', profileOptions.overlap, '--output-format', profileOptions.outputFormat, '--silence-refinement', silenceRefinement], line => {
      job.logs = [...job.logs.slice(-39), line];
      if (job.status === 'cancelling') return;
      if (/loading|model/i.test(line)) { job.status = 'loading-model'; job.message = 'Cargando el modelo local…'; }
      if (/separat|stem|apply model/i.test(line)) { job.status = 'separating'; job.message = 'Separando en CPU; el tiempo depende de la duración y el perfil.'; }
      if (/^Refinamiento[: ]/i.test(line)) { job.status = 'refining'; job.message = 'Analizando silencios y preservando los stems originales…'; }
    }, (error, code) => {
      job.child = null; job.finishedAt = new Date().toISOString();
      if (job.status === 'cancelling') { finishCancelledJob(job); return; }
      if (error || code !== 0) {
        job.status = 'failed'; job.message = error?.message || job.logs.at(-1) || `El motor terminó con código ${code}.`;
        cleanupJobOutput(job);
        db.prepare('UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?').run('failed', job.finishedAt, job.message, id);
        db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('error', project.id);
        return;
      }
      const modelFolder = path.join(outputRoot, model.id);
      const trackFolder = path.join(modelFolder, path.parse(project.audioPath).name);
      const files = existsSync(trackFolder) ? requireListFiles(trackFolder) : [];
      const acceptedSources = new Set(requestedSources);
      const recognized = files.filter(file => acceptedSources.has(path.parse(file).name.toLowerCase()) && model.sources.includes(path.parse(file).name.toLowerCase()));
      if (!recognized.length) {
        job.status = 'failed'; job.message = 'Demucs terminó, pero no se encontraron stems WAV para este trabajo.';
        cleanupJobOutput(job);
        db.prepare('UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?').run('failed', job.finishedAt, job.message, id);
        db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('error', project.id);
        return;
      }
      let refinement = { mode: silenceRefinement, stems: [], maskedSeconds: 0 };
      const reportPath = path.join(outputRoot, 'refinement-report.json');
      if (existsSync(reportPath)) refinement = JSON.parse(readFileSync(reportPath, 'utf8'));
      refinement.stems = refinement.stems.filter(stem => acceptedSources.has(stem.stem));
      refinement.maskedSeconds = refinement.stems.reduce((sum, stem) => sum + stem.maskedSeconds, 0);
      const metadataRow = db.prepare('SELECT metadata_json FROM projects WHERE id = ?').get(project.id);
      const metadata = JSON.parse(metadataRow?.metadata_json || '{}');
      metadata.lastModel = model.id;
      metadata.inference = inference;
      metadata.refinement = refinement;
      // Only publish new files once the entire job has succeeded. Existing
      // project files remain on disk until the user deletes the project.
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM stems WHERE project_id = ?').run(project.id);
        const insertStem = db.prepare('INSERT INTO stems (project_id,name,path,raw_path,created_at) VALUES (?,?,?,?,?)');
        for (const file of recognized) {
          const refined = path.join(outputRoot, 'refined', model.id, path.parse(project.audioPath).name, path.basename(file));
          const hasRefined = silenceRefinement !== 'off' && existsSync(refined);
          insertStem.run(project.id, path.parse(file).name.toLowerCase(), hasRefined ? refined : file, hasRefined ? file : null, job.finishedAt);
        }
        db.prepare('UPDATE projects SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), project.id);
        db.exec('COMMIT');
      } catch (failure) { db.exec('ROLLBACK'); throw failure; }
      for (const file of files) if (!recognized.includes(file)) {
        rmSync(file, { force: true });
        const uncheckedRefined = path.join(outputRoot, 'refined', model.id, path.parse(project.audioPath).name, path.basename(file));
        rmSync(uncheckedRefined, { force: true });
      }
      job.status = 'completed'; job.message = `${recognized.length} stems WAV ${profileOptions.outputBitDepth}-bit guardados.`;
      db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run('completed', job.finishedAt, id);
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('separated', project.id);
    });
    return send(res, 202, { id, status: job.status, job: { id: job.id, status: job.status, projectId: job.projectId, model: job.model, profile: job.profile, inference: job.inference } });
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'jobs' && parts.length === 3) {
    const job = [...activeJobs.values()].find(item => item.id === parts[2]);
    if (job) return send(res, 200, { ...job, child: undefined, logs: job.logs.slice(-20) });
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(parts[2]);
    return row ? send(res, 200, row) : send(res, 404, { error: 'Trabajo no encontrado.' });
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'cancel') {
    const job = [...activeJobs.values()].find(item => item.id === parts[2]);
    if (!job || terminalJobStatuses.has(job.status)) return send(res, 409, { error: 'El trabajo ya no se puede cancelar.' });
    if (job.status === 'cancelling') return send(res, 202, { id: job.id, status: job.status });
    job.status = 'cancelling';
    job.message = 'Cancelando el proceso de IA…';
    if (job.child) job.child.kill();
    else finishCancelledJob(job);
    return send(res, 202, { id: job.id, status: job.status });
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'stems' && parts.length === 5) {
    const stem = db.prepare('SELECT name,path,raw_path AS rawPath FROM stems WHERE project_id = ? AND name = ?').get(parts[2], parts[4]);
    if (!stem) return send(res, 404, { error: 'Stem no encontrado.' });
    if (url.searchParams.get('variant') === 'raw' && stem.rawPath) stem.path = stem.rawPath;
    if (url.searchParams.get('play') === '1') return streamMedia(req, res, stem.path, 'audio/wav');
    const options = readExportOptions(url);
    const project = getProject(parts[2]);
    const projectName = project?.name || 'audio';
    if (sourceWavMatchesOptions(options, project)) return sendFile(res, stem.path, `${projectName}_${stem.name}.wav`);
    if (safeSpawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).status !== 0) return send(res, 503, { error: 'FFmpeg no está disponible. Instálalo para exportar en otro formato o cambiar los parámetros WAV.' });
    let abortConversion = null;
    const cancel = () => abortConversion?.();
    req.once('aborted', cancel); res.once('close', () => { if (!res.writableEnded) cancel(); });
    const converted = await convertStem(stem.path, options, abort => { abortConversion = abort; });
    if (res.destroyed) { rmSync(converted, { force: true }); return; }
    const stat = statSync(converted);
    res.writeHead(200, { 'Content-Type': options.mime, 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${`${projectName}_${stem.name}.${options.ext}`.replace(/[\r\n"\\]/g, '_')}"`, 'Cache-Control': 'private, max-age=0' });
    const stream = createReadStream(converted);
    stream.on('close', () => rmSync(converted, { force: true }));
    stream.on('error', () => rmSync(converted, { force: true }));
    return stream.pipe(res);
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'export.zip' && parts.length === 4) {
    const project = getProject(parts[2]);
    if (!project) return send(res, 404, { error: 'Proyecto no encontrado.' });
    if (!project.stems.length) return send(res, 409, { error: 'Este proyecto todavía no tiene stems exportables.' });
    const options = readExportOptions(url);
    const converted = [];
    let abortConversion = null;
    const cancel = () => abortConversion?.();
    req.once('aborted', cancel); res.once('close', () => { if (!res.writableEnded) cancel(); });
    try {
      if (!sourceWavMatchesOptions(options, project) && safeSpawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).status !== 0) return send(res, 503, { error: 'FFmpeg no está disponible. Instálalo para exportar en otro formato o cambiar los parámetros WAV.' });
      const entries = [];
      for (const stem of project.stems) {
        if (url.searchParams.get('variant') === 'raw' && stem.rawPath) stem.path = stem.rawPath;
        const filename = sourceWavMatchesOptions(options, project) ? stem.path : await convertStem(stem.path, options, abort => { abortConversion = abort; });
        if (!sourceWavMatchesOptions(options, project)) converted.push(filename);
        entries.push({ name: `${project.name}/${stem.name}.${options.ext}`, path: filename });
      }
      const zipPath = await makeZipFile(entries);
      const stat = statSync(zipPath);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${project.name.replace(/[\r\n"\\]/g, '_')}_stems_${options.format}.zip"`, 'Cache-Control': 'private, max-age=0' });
      const stream = createReadStream(zipPath);
      stream.on('close', () => rmSync(zipPath, { force: true }));
      stream.on('error', () => rmSync(zipPath, { force: true }));
      return stream.pipe(res);
    } finally {
      for (const file of converted) rmSync(file, { force: true });
    }
  }

  return send(res, 404, { error: 'Ruta de API no encontrada.' });
}

function requireListFiles(folder) {
  return readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.wav')).map(entry => path.join(entry.parentPath || folder, entry.name));
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '';
  if (!allowedHosts.has(host)) return send(res, 403, { error: 'La aplicación solo acepta conexiones locales.' });
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: 'Origen no autorizado para la aplicación local.' });
  const url = new URL(req.url, `http://${host}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET') serveStatic(req, res, url);
    else send(res, 404, { error: 'No encontrado.' });
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.message || 'Error interno.' });
    else res.destroy();
  }
});

server.listen(port, '127.0.0.1', () => console.log(`AI Music Separator Studio is running at http://127.0.0.1:${port}`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
