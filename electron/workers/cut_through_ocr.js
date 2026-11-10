'use strict';
/**
 * Free, offline reading of the slate's code tile (Jordan 2026-11-10: the slate read should cost
 * nothing). tesseract.js with the bundled English data; one worker, reused for the whole read.
 * Only letters and digits on one line are allowed, which is all a J-code is. A read that isn't
 * confident (or doesn't look like a code) is left for Claude by the caller.
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MIN_CONFIDENCE = 75;
const CODE_RE = /^[A-Z0-9]{1,6}$/;

let workerP = null;

function worker() {
  if (!workerP) {
    workerP = (async () => {
      const T = require('tesseract.js');
      const eng = require('@tesseract.js-data/eng');
      const w = await T.createWorker(eng.code, T.OEM.LSTM_ONLY, { langPath: eng.langPath, gzip: eng.gzip, cacheMethod: 'none' });
      await w.setParameters({ tessedit_char_whitelist: CHARS, tessedit_pageseg_mode: T.PSM.SINGLE_LINE,
        debug_file: '/dev/null' });   // tesseract's own (virtual) file system: no stats dump on a blank tile
      return w;
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

/** A prepared image (dark text on light, PNG) → { code | null, confidence, ok }. */
async function readCode(png) {
  const w = await worker();
  const { data } = await w.recognize(png);
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
 */
function trusted(read, known) {
  const code = read && read.code;
  if (!code || !CODE_RE.test(code)) return null;
  const K = known instanceof Set ? known : new Set((known || []).map((k) => String(k).toUpperCase()));
  if (K.has(code) && read.confidence >= 20) return code;
  const same = [...K].filter((k) => k.length === code.length && shape(k) === shape(code));
  if (same.length === 1 && read.confidence >= 40) return same[0];
  if (!same.length && read.confidence >= 90 && !/[ODQILSZBG012568]/.test(code)) return code;
  return null;
}

async function close() {
  const p = workerP;
  workerP = null;
  if (p) { try { await (await p).terminate(); } catch (_) { /* already gone */ } }
}

module.exports = { readCode, trusted, shape, close, MIN_CONFIDENCE, CODE_RE };
