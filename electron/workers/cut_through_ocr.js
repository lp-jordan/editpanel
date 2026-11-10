'use strict';
/**
 * Free, offline reading of the slate's code tile (Jordan 2026-11-10: the slate read should cost
 * nothing). tesseract.js with the bundled English data; one worker, reused for the whole read.
 * Only letters and digits on one line are allowed, which is all a J-code is. A read that isn't
 * confident (or doesn't look like a code) is left for Claude by the caller.
 */

const path_ = (pkg, ...rest) => require('path').join(require('path').dirname(require.resolve(pkg)), ...rest);

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MIN_CONFIDENCE = 75;
const CODE_RE = /^[A-Z0-9]{1,6}$/;

const INIT_MS = 60000;
const READ_MS = 20000;

let workerP = null;
let workerError = null;

/**
 * tesseract.js starts a worker thread with no 'error' listener, so a crash in it (e.g. a dependency
 * this Electron can't parse — wasm-feature-detect 1.10.0, 2026-11-10) became an uncaught exception
 * in EditPanel's main process. Swap in a spawner that listens: the error is kept, the run's OCR
 * stops (the caller falls back to Claude), and the app keeps going.
 */
function guardWorkerThread() {
  const path = require('path');
  const { Worker } = require('worker_threads');
  const file = path.join(path.dirname(require.resolve('tesseract.js')), 'worker', 'node', 'spawnWorker.js');
  require(file);
  require.cache[file].exports = ({ workerPath }) => {
    const w = new Worker(workerPath);
    w.on('error', (err) => { workerError = err; workerP = null; });
    return w;
  };
}

/** A promise that gives up after ms, or as soon as the worker thread has failed. */
function guarded(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const fail = (err) => { clearInterval(tick); clearTimeout(timer); reject(err); };
    const timer = setTimeout(() => fail(new Error(`OCR ${what} timed out`)), ms);
    const tick = setInterval(() => { if (workerError) fail(new Error(`OCR stopped: ${workerError.message || workerError}`)); }, 200);
    promise.then((v) => { clearInterval(tick); clearTimeout(timer); resolve(v); }, fail);
  });
}

function worker() {
  if (!workerP) {
    workerError = null;
    workerP = guarded((async () => {
      guardWorkerThread();
      // what the worker thread loads first: a module this Electron can't parse fails here, caught
      require(path_('tesseract.js', 'worker-script', 'node', 'getCore.js'));
      const T = require('tesseract.js');
      const eng = require('@tesseract.js-data/eng');
      const w = await T.createWorker(eng.code, T.OEM.LSTM_ONLY, { langPath: eng.langPath, gzip: eng.gzip, cacheMethod: 'none' });
      await w.setParameters({ tessedit_char_whitelist: CHARS, tessedit_pageseg_mode: T.PSM.SINGLE_LINE,
        debug_file: '/dev/null' });   // tesseract's own (virtual) file system: no stats dump on a blank tile
      return w;
    })(), INIT_MS, 'start');
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

/** A prepared image (dark text on light, PNG) → { code | null, confidence, ok }. */
async function readCode(png) {
  const w = await worker();
  const { data } = await guarded(w.recognize(png), READ_MS, 'read');
  const code = String(data.text || '').replace(/\s+/g, '').toUpperCase();
  const confidence = Math.round(data.confidence || 0);
  const ok = CODE_RE.test(code) && confidence >= MIN_CONFIDENCE;
  return { code: code || null, confidence, ok };
}

// characters tesseract mixes up on the slate's font, each mapped to one stand-in
const LOOKALIKE = { O: '0', D: '0', Q: '0', I: '1', L: '1', S: '5', Z: '2', B: '8', G: '6' };
const shape = (c) => [...String(c || '').toUpperCase()].map((ch) => LOOKALIKE[ch] || ch).join('');

/**
 * An OCR read → the code to trust, or null (ask Claude). Known codes (the slate's notes) are what
 * make OCR safe: an exact match, or the one known code with the same shape (O10 read as 010). A
 * code not on the slate goes to Claude unless OCR is very sure and has no look-alike characters.
 * A code that isn't on the slate (nobody logged it, or no slate picked): a confident letters-and-digits
 * read (H6, J12) is taken but marked unsure (Find videos flags it) — real reads were 79–90
 * confident (2026-11-10); look-alike mistakes like 010 / DO / FS lack a letter or a digit.
 * Returns { code, sure } or null.
 */
function trusted(read, known) {
  const code = read && read.code;
  if (!code || !CODE_RE.test(code)) return null;
  const K = known instanceof Set ? known : new Set((known || []).map((k) => String(k).toUpperCase()));
  if (K.has(code) && read.confidence >= 20) return { code, sure: true };
  const same = [...K].filter((k) => k.length === code.length && shape(k) === shape(code));
  if (same.length === 1 && read.confidence >= 40) return { code: same[0], sure: true };
  if (!same.length && read.confidence >= 90 && !/[ODQILSZBG012568]/.test(code)) return { code, sure: true };
  // a code nobody logged (or no slate loaded): a confident letters-and-digits read, marked unsure
  if (!same.length && read.confidence >= 75 && /[A-Z]/.test(code) && /[0-9]/.test(code)) return { code, sure: false };
  return null;
}

/** A read that looks like a code at all (for finding the tile, not for trusting the code). */
const looksLikeCode = (read) => Boolean(read && read.code && CODE_RE.test(read.code) && read.confidence >= 60);

async function close() {
  const p = workerP;
  workerP = null;
  if (p) { try { await (await p).terminate(); } catch (_) { /* already gone */ } }
}

module.exports = { readCode, trusted, looksLikeCode, shape, close, MIN_CONFIDENCE, CODE_RE };
