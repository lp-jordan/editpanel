#!/usr/bin/env node
/**
 * Downloads + extracts a full Python 3.10 distribution into
 * vendor/python-win32/ for electron-builder to bundle.
 *
 * As of 1.2.4 we use NuGet's `python.3.10.11` package — a .nupkg (zip)
 * that ships a full Python install layout under tools/. This replaces
 * the python.org embeddable zip used in 1.2.1–1.2.3, which crashed
 * fusionscript.dll's native init on machines without a parallel full
 * Python install (lp3 saga, 2026-06-17). Although fusionscript uses
 * Python's Stable ABI via python3.dll — and both DLLs were physically
 * present in the embeddable + on the DLL search path — the embeddable
 * distribution is stripped (no Lib/, no DLLs/) in ways that cause AV
 * crashes during fusionscript's own DllMain / PyInit_fusionscript on
 * some Windows configurations. The NuGet package is the redistributable
 * full Python install layout, which is the closest we can get to "what
 * a normal Python installation looks like" without running the python.org
 * installer itself.
 *
 * Why NuGet vs running python-3.10.11-amd64.exe silently: the installer
 * has registry/PATH side effects we don't want; NuGet is just a zip.
 *
 * No _pth patching needed — full Python distributions use the standard
 * sys.path setup including cwd-on-sys.path, so `python -m
 * helper.resolve_worker` with cwd=HELPER_ROOT finds helper/ without
 * any intervention.
 *
 * Runs as the package.json "postinstall" hook on the Windows build box.
 * Idempotent: a current install is left alone; a stale install (from a
 * previous embeddable-bundled version) is wiped and re-fetched.
 */
import {
  createWriteStream,
  mkdirSync,
  existsSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  renameSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import https from 'https';

const PYTHON_VERSION = '3.10.11';
const NUGET_URL = `https://www.nuget.org/api/v2/package/python/${PYTHON_VERSION}`;

// Sanity bounds for the download size. NuGet's package page reports
// 15.53 MB for python.3.10.11. Bracket it loosely — if NuGet ever
// republishes a different .nupkg under the same version (unlikely), we
// want to notice rather than silently bundle whatever shows up.
const EXPECTED_MIN_SIZE = 14 * 1024 * 1024;
const EXPECTED_MAX_SIZE = 18 * 1024 * 1024;

// Marker file inside vendor/python-win32/ tracks which distribution
// we last installed. Lets us detect a 1.2.3-era embeddable bundle still
// sitting on disk after upgrading to 1.2.4+, and wipe it cleanly.
const DISTRIBUTION_MARKER = `nuget-${PYTHON_VERSION}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const VENDOR_DIR = join(REPO_ROOT, 'vendor', 'python-win32');
const PYTHON_EXE = join(VENDOR_DIR, 'python.exe');
const MARKER_FILE = join(VENDOR_DIR, '.distribution');

function log(msg) {
  console.log(`[fetch-python] ${msg}`);
}

async function main() {
  if (process.platform !== 'win32' && !process.env.EP_FORCE_FETCH_PYTHON) {
    log(`skipping: bundled Python only ships in Windows installers (platform=${process.platform}). Set EP_FORCE_FETCH_PYTHON=1 to override.`);
    return;
  }

  // Check what's already on disk:
  //   (a) python.exe + matching marker → skip (already current)
  //   (b) python.exe + missing/stale marker → wipe (1.2.3 embeddable; upgrade)
  //   (c) python.exe missing but vendor/ exists → wipe (interrupted prior run)
  //   (d) nothing → fetch fresh
  const havePythonExe = existsSync(PYTHON_EXE);
  const haveMarker = existsSync(MARKER_FILE);
  const markerValue = haveMarker ? readFileSync(MARKER_FILE, 'utf8').trim() : null;

  if (havePythonExe && markerValue === DISTRIBUTION_MARKER) {
    log(`${DISTRIBUTION_MARKER} already present at ${VENDOR_DIR}`);
    return;
  }

  if (havePythonExe) {
    const reason = markerValue
      ? `stale distribution '${markerValue}'`
      : `unversioned vendor/ (embeddable from editpanel <=1.2.3)`;
    log(`${reason} — wiping and re-fetching ${DISTRIBUTION_MARKER}`);
    rmSync(VENDOR_DIR, { recursive: true, force: true });
  } else if (existsSync(VENDOR_DIR)) {
    log(`incomplete vendor/ at ${VENDOR_DIR} — wiping before fetch`);
    rmSync(VENDOR_DIR, { recursive: true, force: true });
  }

  const tmpExtractDir = `${VENDOR_DIR}-extract-${process.pid}`;
  rmSync(tmpExtractDir, { recursive: true, force: true });
  mkdirSync(tmpExtractDir, { recursive: true });

  // PowerShell's Expand-Archive does a literal extension check and rejects
  // `.nupkg` even though .nupkg is just a zip. Save with .zip suffix.
  const tmpNupkg = join(tmpExtractDir, 'python-nupkg.zip');

  log(`downloading ${NUGET_URL}`);
  await downloadTo(NUGET_URL, tmpNupkg);
  const sz = statSync(tmpNupkg).size;
  log(`download complete (${sz} bytes)`);

  if (sz < EXPECTED_MIN_SIZE || sz > EXPECTED_MAX_SIZE) {
    rmSync(tmpExtractDir, { recursive: true, force: true });
    throw new Error(
      `Unexpected NuGet package size: ${sz} bytes (expected ${EXPECTED_MIN_SIZE}-${EXPECTED_MAX_SIZE}). ` +
      `Either NuGet republished the package or the download is corrupt.`,
    );
  }

  log(`extracting NuGet package`);
  const unzip = process.platform === 'win32'
    ? spawnSync(
        'powershell',
        ['-Command', `Expand-Archive -Path '${tmpNupkg}' -DestinationPath '${tmpExtractDir}' -Force`],
        { stdio: 'inherit', shell: true },
      )
    : spawnSync('unzip', ['-o', tmpNupkg, '-d', tmpExtractDir], { stdio: 'inherit' });

  if (unzip.status !== 0) {
    rmSync(tmpExtractDir, { recursive: true, force: true });
    throw new Error(`unzip failed with exit code ${unzip.status}`);
  }

  // NuGet python package layout: tools/python.exe + tools/Lib/ +
  // tools/DLLs/ + tools/python3.dll + tools/python310.dll + ...
  const toolsDir = join(tmpExtractDir, 'tools');
  if (!existsSync(toolsDir)) {
    rmSync(tmpExtractDir, { recursive: true, force: true });
    throw new Error(`NuGet package layout unexpected — tools/ missing at ${toolsDir}`);
  }
  const stagedExe = join(toolsDir, 'python.exe');
  if (!existsSync(stagedExe)) {
    rmSync(tmpExtractDir, { recursive: true, force: true });
    throw new Error(`NuGet package missing python.exe at ${stagedExe}`);
  }

  // Promote tools/ to vendor/python-win32/.
  mkdirSync(dirname(VENDOR_DIR), { recursive: true });
  renameSync(toolsDir, VENDOR_DIR);
  rmSync(tmpExtractDir, { recursive: true, force: true });

  writeFileSync(MARKER_FILE, `${DISTRIBUTION_MARKER}\n`, 'utf8');

  log(`done — bundled Python ${PYTHON_VERSION} at ${VENDOR_DIR}`);
  log(`  python.exe:    ${existsSync(PYTHON_EXE)}`);
  log(`  python3.dll:   ${existsSync(join(VENDOR_DIR, 'python3.dll'))}`);
  log(`  python310.dll: ${existsSync(join(VENDOR_DIR, 'python310.dll'))}`);
  log(`  Lib/:          ${existsSync(join(VENDOR_DIR, 'Lib'))}`);
  log(`  DLLs/:         ${existsSync(join(VENDOR_DIR, 'DLLs'))}`);
}

function downloadTo(url, dest) {
  return new Promise((res, rej) => {
    const file = createWriteStream(dest);
    https
      .get(url, (response) => {
        if (
          response.statusCode === 301 ||
          response.statusCode === 302 ||
          response.statusCode === 307 ||
          response.statusCode === 308
        ) {
          file.close();
          rmSync(dest, { force: true });
          const next = new URL(response.headers.location, url).toString();
          downloadTo(next, dest).then(res).catch(rej);
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

main().catch((err) => {
  console.error(`[fetch-python] FAILED: ${err.message}`);
  process.exit(1);
});
