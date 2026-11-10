#!/usr/bin/env node
/**
 * Builds the cut-through transcription pack and publishes it to the NAS.
 * Run on LP1 (Windows, NVIDIA GPU, internet), from the editpanel checkout:
 *
 *   node scripts/build-transcription-pack.mjs
 *
 * What it does:
 *   1. Locks the package versions from LP1's working C:\wxbench (pip freeze) into
 *      cut_through/pack/requirements.lock.txt — commit that file. --lock skips this and uses the
 *      committed lock as it is.
 *   2. Fetches the same Python version as a relocatable full install (python.org's NuGet package).
 *   3. pip installs the lock into it, exactly (--no-deps: the freeze is already the full set).
 *   4. Runs cut_through/pack/selftest.py online (downloads Whisper large-v3 + the alignment model
 *      into the pack's models\), then again offline to prove the pack needs no network.
 *   5. Writes transcription-pack-<version>.tar to the NAS folder, hashes it there, and writes
 *      pack.json LAST — EditPanel only sees a pack once its manifest exists.
 *
 * Options: --from <python.exe> (default C:\wxbench\Scripts\python.exe)  --lock
 *          --out <folder> (default N:\LPOS\editpanel dist\transcription-pack)
 *          --work <folder> (default C:\wxpack-build)  --python-version 3.12.10
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(REPO, 'cut_through', 'pack', 'requirements.lock.txt');
const SELFTEST = path.join(REPO, 'cut_through', 'pack', 'selftest.py');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const FROM = opt('from', 'C:\\wxbench\\Scripts\\python.exe');
const OUT = opt('out', 'N:\\LPOS\\editpanel dist\\transcription-pack');
const WORK = opt('work', 'C:\\wxpack-build');
const USE_LOCK = argv.includes('--lock');

function step(msg) { console.log(`\n▸ ${msg}`); }
function die(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }
function run(cmd, args, { env, capture } = {}) {
  const r = spawnSync(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) die(`${path.basename(cmd)} ${args.slice(0, 3).join(' ')} … exited ${r.status}`);
  return capture ? r.stdout : '';
}

if (process.platform !== 'win32') die('Run this on the Windows machine (LP1).');
if (!fs.existsSync(OUT)) die(`Can't reach ${OUT} (is N: mapped?)`);

// 1. lock
let pyVersion = opt('python-version', '');
if (!USE_LOCK) {
  if (!fs.existsSync(FROM)) die(`No Python at ${FROM}. Pass --from <python.exe>, or --lock to use the committed lock.`);
  step(`Locking package versions from ${FROM}`);
  pyVersion ||= run(FROM, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { capture: true }).trim();
  const frozen = run(FROM, ['-m', 'pip', 'freeze'], { capture: true }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const odd = frozen.filter((l) => l.startsWith('-e') || l.includes(' @ '));
  if (odd.length) die(`These aren't plain PyPI pins, so the pack can't reproduce them:\n  ${odd.join('\n  ')}`);
  fs.writeFileSync(LOCK, `# python ${pyVersion}\n# from ${FROM} on ${new Date().toISOString().slice(0, 10)}\n${frozen.join('\n')}\n`);
  console.log(`  ${frozen.length} packages → ${path.relative(REPO, LOCK)}`);
} else {
  if (!fs.existsSync(LOCK)) die(`No lock at ${LOCK}`);
  pyVersion ||= ((/^# python (\S+)/m.exec(fs.readFileSync(LOCK, 'utf8')) || [])[1] || '');
}
if (!/^\d+\.\d+\.\d+$/.test(pyVersion)) die('Unknown Python version: pass --python-version 3.x.y');
const lockText = fs.readFileSync(LOCK, 'utf8');
for (const need of ['faster-whisper', 'ctranslate2', 'whisperx', 'torch', 'av', 'numpy']) {
  if (!new RegExp(`^${need}==`, 'mi').test(lockText)) die(`The lock has no ${need} — is ${FROM} the working transcription Python?`);
}

// 2. python
const packDir = path.join(WORK, 'pack');
const pyDir = path.join(packDir, 'python');
const python = path.join(pyDir, 'python.exe');
step(`Fetching Python ${pyVersion} (NuGet)`);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'nuget'), { recursive: true });
const nupkg = path.join(WORK, 'python.nupkg');
const res = await fetch(`https://www.nuget.org/api/v2/package/python/${pyVersion}`);
if (!res.ok) die(`NuGet has no python ${pyVersion} (HTTP ${res.status}) — pass --python-version with a published one`);
fs.writeFileSync(nupkg, Buffer.from(await res.arrayBuffer()));
run(TAR, ['-xf', nupkg, '-C', path.join(WORK, 'nuget')]);
fs.mkdirSync(packDir, { recursive: true });
fs.renameSync(path.join(WORK, 'nuget', 'tools'), pyDir);
if (!fs.existsSync(python)) die('NuGet package had no tools\\python.exe');

// 3. packages
step('Installing the locked packages');
const pyEnv = { PYTHONNOUSERSITE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
run(python, ['-m', 'ensurepip', '--upgrade'], { env: pyEnv });
const cu = (/\+(cu\d+)/.exec(lockText) || [])[1];
run(python, ['-m', 'pip', 'install', '--no-deps', '--no-warn-script-location', '-r', LOCK,
  ...(cu ? ['--extra-index-url', `https://download.pytorch.org/whl/${cu}`] : [])], { env: pyEnv });

// 4. models + checks
const models = path.join(packDir, 'models');
const modelEnv = { ...pyEnv, HF_HOME: path.join(models, 'hf'), TORCH_HOME: path.join(models, 'torch'), PYTHONIOENCODING: 'utf-8' };
step('Downloading the models into the pack (self-test, online)');
run(python, [SELFTEST], { env: modelEnv });
step('Self-test offline');
run(python, [SELFTEST], { env: { ...modelEnv, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
for (const d of [path.join(models, 'hf', 'xet'), path.join(models, 'hf', '.locks')]) fs.rmSync(d, { recursive: true, force: true });

// 5. publish
const now = new Date();
const version = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
const file = `transcription-pack-${version}.tar`;
const target = path.join(OUT, file);
step(`Writing ${target}`);
run(TAR, ['-cf', target, '-C', packDir, 'python', 'models']);
step('Hashing the copy on the NAS');
const hash = createHash('sha256');
await new Promise((resolve, reject) => {
  fs.createReadStream(target, { highWaterMark: 8 * 1024 * 1024 }).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
});
const manifest = { version, file, bytes: fs.statSync(target).size, sha256: hash.digest('hex'), python: 'python\\python.exe', pythonVersion: pyVersion, builtAt: now.toISOString() };
const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'pack.json'), 'utf8')); } catch (_) { return null; } })();
fs.writeFileSync(path.join(OUT, 'pack.json'), JSON.stringify(manifest, null, 1));
// keep this pack and the one before it (a machine may still be copying it)
for (const f of fs.readdirSync(OUT)) {
  if (/^transcription-pack-.*\.tar$/.test(f) && f !== file && f !== (prev && prev.file)) fs.rmSync(path.join(OUT, f), { force: true });
}
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n✓ Published transcription pack ${version} (${(manifest.bytes / 1e9).toFixed(1)} GB). Commit ${path.relative(REPO, LOCK)}.`);
