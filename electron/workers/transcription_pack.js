'use strict';
/**
 * Transcription pack — the Python that runs cut_through/transcribe.py (faster-whisper on the GPU,
 * WhisperX alignment) plus its models, as one versioned download.
 *
 * Too big for the installer (~5 GB), so it is built once on LP1 (scripts/build-transcription-pack.mjs),
 * published to the NAS next to the EditPanel builds, and installed from the Cut-through page:
 *
 *   <pack folder>\pack.json                       { version, file, bytes, sha256, python }
 *   <pack folder>\transcription-pack-<v>.tar      python\…  models\hf\…  models\torch\…
 *
 * Installed under %LOCALAPPDATA%\EditPanel\transcription\<version>\ with current.json naming the
 * one in use. Copy + hash in one pass, verify, unpack into <version>.partial, then rename — a
 * half-finished install is never used. Models are read offline from the pack (HF_HUB_OFFLINE).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const DEFAULT_PACK_FOLDER = 'N:\\LPOS\\editpanel dist\\transcription-pack';
const MANIFEST = 'pack.json';

function defaultInstallRoot() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'EditPanel', 'transcription');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** The pack on the NAS (or null + why). */
function availablePack(packFolder) {
  const file = path.join(packFolder, MANIFEST);
  if (!fs.existsSync(packFolder)) return { pack: null, error: `Can't reach ${packFolder}` };
  const m = readJson(file);
  if (!m || !m.version || !m.file || !m.sha256) return { pack: null, error: `No pack published in ${packFolder}` };
  return { pack: { ...m, path: path.join(packFolder, m.file) }, error: null };
}

/** The installed pack, if its Python is really there. */
function installedPack(root = defaultInstallRoot()) {
  const cur = readJson(path.join(root, 'current.json'));
  if (!cur || !cur.version) return null;
  const dir = path.join(root, String(cur.version));
  const python = path.join(dir, cur.python || path.join('python', 'python.exe'));
  if (!fs.existsSync(python)) return null;
  return { version: cur.version, dir, python, models: path.join(dir, 'models') };
}

/** Env for a child process using the pack's Python: models from the pack, never the network. */
function packEnv(pack) {
  if (!pack) return {};
  return {
    HF_HOME: path.join(pack.models, 'hf'),
    TORCH_HOME: path.join(pack.models, 'torch'),
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    PYTHONNOUSERSITE: '1'
  };
}

/** NVIDIA GPUs on this machine (nvidia-smi ships with the driver), or [] . */
function listGpus() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['-L'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split(/\r?\n/).map((l) => (/^GPU \d+: (.*?)(?: \(UUID.*)?$/.exec(l.trim()) || [])[1]).filter(Boolean));
    });
  });
}

/** Copy `src` to `dest`, hashing as it goes. onProgress(bytesDone). */
function copyAndHash(src, dest, onProgress, isCanceled) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rd = fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 });
    const wr = fs.createWriteStream(dest);
    let done = 0;
    let last = 0;
    rd.on('data', (chunk) => {
      if (isCanceled && isCanceled()) { rd.destroy(new Error('Canceled')); return; }
      hash.update(chunk);
      done += chunk.length;
      if (done - last > 32 * 1024 * 1024) { last = done; onProgress && onProgress(done); }
    });
    rd.on('error', (e) => { wr.destroy(); reject(e); });
    wr.on('error', reject);
    wr.on('finish', () => { onProgress && onProgress(done); resolve(hash.digest('hex')); });
    rd.pipe(wr);
  });
}

function untar(tarFile, destDir) {
  return new Promise((resolve, reject) => {
    // Windows 10+ ships bsdtar as tar.exe
    const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const proc = spawn(tarExe, ['-xf', tarFile, '-C', destDir], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking failed (tar ${code}): ${err.trim().slice(-300)}`))));
  });
}

/**
 * Install the published pack. onProgress({ phase, bar }) — bar 0–100 or null.
 * Returns the installed pack. Older installed versions are removed afterwards.
 */
async function installPack({ packFolder, root = defaultInstallRoot(), onProgress = () => {}, isCanceled = () => false }) {
  const { pack, error } = availablePack(packFolder);
  if (!pack) throw new Error(error);
  if (!fs.existsSync(pack.path)) throw new Error(`Pack file missing: ${pack.path}`);
  fs.mkdirSync(root, { recursive: true });
  const bytes = pack.bytes || fs.statSync(pack.path).size;
  const free = freeBytes(root);
  if (free !== null && free < bytes * 2.2) {
    throw new Error(`Not enough disk space: needs ${gb(bytes * 2.2)} free on ${path.parse(root).root}, has ${gb(free)}`);
  }
  const tmpTar = path.join(root, `download-${pack.version}.tar`);
  const partial = path.join(root, `${pack.version}.partial`);
  const final = path.join(root, String(pack.version));
  try {
    onProgress({ phase: `Copying pack ${pack.version} (${gb(bytes)})`, bar: 0 });
    const sha = await copyAndHash(pack.path, tmpTar, (n) => onProgress({ phase: `Copying pack ${pack.version} · ${gb(n)} of ${gb(bytes)}`, bar: Math.round((100 * n) / bytes) }), isCanceled);
    if (sha.toLowerCase() !== String(pack.sha256).toLowerCase()) throw new Error('Pack is damaged (checksum mismatch) — copy it again');
    if (isCanceled()) throw new Error('Canceled');
    onProgress({ phase: 'Unpacking', bar: null });
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true });
    await untar(tmpTar, partial);
    const python = path.join(partial, pack.python || path.join('python', 'python.exe'));
    if (!fs.existsSync(python)) throw new Error(`Pack has no Python at ${pack.python || 'python\\python.exe'}`);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(partial, final);
    fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ version: pack.version, python: pack.python || path.join('python', 'python.exe'), installedAt: new Date().toISOString() }, null, 1));
  } finally {
    fs.rmSync(tmpTar, { force: true });
    fs.rmSync(partial, { recursive: true, force: true });
  }
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== String(pack.version)) {
      try { fs.rmSync(path.join(root, d.name), { recursive: true, force: true }); } catch (_) { /* in use: next time */ }
    }
  }
  return installedPack(root);
}

/** Load both models with the pack's Python: proves CUDA, cuDNN and the model files. */
function selfTest(pack, scriptPath) {
  return new Promise((resolve) => {
    const proc = spawn(pack.python, [scriptPath], { windowsHide: true, env: { ...process.env, ...packEnv(pack), PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('error', (e) => resolve({ ok: false, lines: [String(e.message)] }));
    proc.on('close', (code) => {
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      resolve({ ok: code === 0, lines: lines.slice(-12) });
    });
  });
}

function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch (_) { return null; }
}

function gb(n) { return `${(n / 1e9).toFixed(1)} GB`; }

module.exports = { DEFAULT_PACK_FOLDER, defaultInstallRoot, availablePack, installedPack, packEnv, listGpus, installPack, selfTest };
