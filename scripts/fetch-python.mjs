#!/usr/bin/env node
/**
 * Downloads + verifies + extracts the Python 3.10 Windows embeddable
 * distribution into vendor/python-win32/ for electron-builder to bundle.
 *
 * Runs as the package.json "postinstall" hook so `npm install` on the
 * Windows build box materializes Python before `npm run package`.
 * Idempotent — a present, valid extraction is left alone. Skipped on
 * non-Windows (the bundled Python is only shipped in Windows installers).
 *
 * Why bundle: see docs/new-machine-setup.md → the 2026-06-02 lp2 saga.
 * With a pinned interpreter, fusionscript.dll always loads into a
 * known-good ABI — no system-Python wrong-version / two-installs failure
 * mode.
 *
 * Why MD5 not SHA-256: python.org's release page only publishes MD5 for
 * this download. MD5 + HTTPS is sufficient for our threat model
 * (in-flight integrity, not "is python.org compromised"). Upgrade to
 * SHA-256 if python.org starts publishing it.
 */
import { createHash } from 'crypto';
import {
  createWriteStream,
  createReadStream,
  mkdirSync,
  existsSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import https from 'https';

const PYTHON_VERSION = '3.10.11';
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const PYTHON_MD5 = 'f1c0538b060e03cbb697ab3581cb73bc'; // from https://www.python.org/downloads/release/python-31011/

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const VENDOR_DIR = join(REPO_ROOT, 'vendor', 'python-win32');
const PYTHON_EXE = join(VENDOR_DIR, 'python.exe');
const PTH_FILE = join(VENDOR_DIR, 'python310._pth');

function log(msg) {
  console.log(`[fetch-python] ${msg}`);
}

async function main() {
  if (process.platform !== 'win32' && !process.env.EP_FORCE_FETCH_PYTHON) {
    log(`skipping: bundled Python only ships in Windows installers (platform=${process.platform}). Set EP_FORCE_FETCH_PYTHON=1 to override.`);
    return;
  }

  if (existsSync(PYTHON_EXE)) {
    log(`already present at ${VENDOR_DIR} — skipping fetch`);
    return;
  }

  mkdirSync(VENDOR_DIR, { recursive: true });
  const tmpZip = join(VENDOR_DIR, `_download.${process.pid}.zip`);

  log(`downloading ${PYTHON_URL}`);
  await downloadTo(PYTHON_URL, tmpZip);
  log(`download complete (${statSync(tmpZip).size} bytes)`);

  const actualMd5 = await md5OfFile(tmpZip);
  if (actualMd5 !== PYTHON_MD5) {
    rmSync(tmpZip, { force: true });
    throw new Error(`MD5 mismatch for ${PYTHON_URL}: expected ${PYTHON_MD5}, got ${actualMd5}`);
  }
  log(`MD5 verified: ${actualMd5}`);

  log(`extracting to ${VENDOR_DIR}`);
  const unzip = process.platform === 'win32'
    ? spawnSync(
        'powershell',
        ['-Command', `Expand-Archive -Path '${tmpZip}' -DestinationPath '${VENDOR_DIR}' -Force`],
        { stdio: 'inherit', shell: true },
      )
    : spawnSync('unzip', ['-o', tmpZip, '-d', VENDOR_DIR], { stdio: 'inherit' });

  if (unzip.status !== 0) {
    throw new Error(`unzip failed with exit code ${unzip.status}`);
  }

  rmSync(tmpZip, { force: true });

  // Patch python310._pth so the bundled interpreter can find helper/ at runtime.
  //
  // The embed-amd64 zip ships a _pth file that pins sys.path to ONLY:
  //   python310.zip   ← stdlib
  //   .               ← directory containing python.exe (i.e. <resources>/python/)
  // and the mere presence of a _pth disables PYTHONPATH + cwd-on-sys.path entirely.
  //
  // At install time the layout is:
  //   <resources>/python/python.exe
  //   <resources>/python/python310._pth
  //   <resources>/helper/...   ← spawned with `python -m helper.resolve_worker`
  //
  // Adding `..` makes <resources>/ findable, so `import helper.resolve_worker`
  // resolves. Uncommenting `import site` re-enables the standard site machinery
  // (faulthandler hooks, sys.path[0] handling, etc.).
  if (existsSync(PTH_FILE)) {
    const before = readFileSync(PTH_FILE, 'utf8');
    if (!before.split('\n').some((line) => line.trim() === '..')) {
      const after = before.replace(/^#\s*import site\s*$/m, 'import site') + '\n..\n';
      writeFileSync(PTH_FILE, after, 'utf8');
      log(`patched ${PTH_FILE} (added .. + import site)`);
    } else {
      log(`${PTH_FILE} already patched — skipping edit`);
    }
  } else {
    log(`warning: ${PTH_FILE} not found; helper imports may fail at runtime`);
  }

  log(`done — bundled Python ${PYTHON_VERSION} at ${VENDOR_DIR}`);
}

function downloadTo(url, dest) {
  return new Promise((res, rej) => {
    const file = createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          rmSync(dest, { force: true });
          downloadTo(response.headers.location, dest).then(res).catch(rej);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          rmSync(dest, { force: true });
          rej(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(res));
      })
      .on('error', (err) => {
        file.close();
        rmSync(dest, { force: true });
        rej(err);
      });
  });
}

function md5OfFile(file) {
  return new Promise((res, rej) => {
    const hash = createHash('md5');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => res(hash.digest('hex')));
    stream.on('error', rej);
  });
}

main().catch((err) => {
  console.error(`[fetch-python] FAILED: ${err.message}`);
  process.exit(1);
});
