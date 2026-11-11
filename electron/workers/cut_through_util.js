'use strict';
/**
 * Small helpers shared by the Cut-through engine files (cut_through*.js, transcription_pack.js)
 * and main.js. Pure functions plus fs reads; no Electron, no Anthropic SDK.
 */

const fs = require('fs');

/** The engine's steps, in order (main.js uses them to name a running step). */
const STEP_KEYS = ['prep', 'transcribe', 'plan', 'build', 'check', 'compare'];

/** A JSON file, or null when it's missing or unreadable. */
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

/** Median of numbers; null for an empty list; the mean of the middle two for an even count. */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Index of the first word with s >= x (words sorted by s). */
function lowerBound(words, x) {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].s < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** A word ({w}) that ends a sentence (closing quotes / brackets allowed after the stop). */
const endsSentence = (w) => /[.?!…]["'”’)\]]*$/.test(String((w && w.w) || '').trim());

/** Words → their text, space-joined. */
const quote = (ws) => ws.map((w) => String(w.w).trim()).join(' ');

/** "Camera 3" → 3; no trailing number → 999 (sorts last). */
function angleNo(a) {
  const m = /(\d+)\s*$/.exec(a || '');
  return m ? Number(m[1]) : 999;
}

/** A timeline's multicam picture pieces (the given multicam's when it has any), by record start. */
function picturePieces(timeline, multicam) {
  let pieces = (timeline.pieces || []).filter((p) => p.src_out > p.src_in && p.end > p.start);
  if (multicam && pieces.some((p) => p.mc === multicam)) pieces = pieces.filter((p) => p.mc === multicam);
  return pieces.sort((a, b) => a.start - b.start);
}

/** Pieces joined wherever source and record both run on (an angle change is not a join). */
function segsOf(pieces) {
  const segs = [];
  for (const p of pieces) {
    const g = segs[segs.length - 1];
    if (g && Math.abs(p.src_in - g.src_out) <= 1 && Math.abs(p.start - g.end) <= 1) {
      g.src_out = p.src_out;
      g.end = p.end;
    } else {
      segs.push({ src_in: p.src_in, src_out: p.src_out, start: p.start, end: p.end });
    }
  }
  return segs;
}

// ── frames and timecode of a day (day_<LABEL>.json) ──

/** Seconds per multicam frame. */
function frameSec(day) {
  return Array.isArray(day.frame_sec) && day.frame_sec[1] ? day.frame_sec[0] / day.frame_sec[1] : 1 / (day.fps || 24);
}

/** Day length in multicam frames (the unit place_cuts.py's start=/end= take); 0 without a length. */
function totalFrames(day) {
  return day && day.length_sec ? Math.floor(day.length_sec / frameSec(day)) : 0;
}

/** Frames per timecode second (24 for 23.976) and the multicam's first frame on the TC clock. */
function tcClock(day) {
  const fsec = frameSec(day);
  return { fsec, nominal: Math.round(1 / fsec), first: Math.round((day.tc_start_sec || 0) / fsec) };
}

/** Multicam frame → its timecode, as Resolve shows it on the multicam (HH:MM:SS:FF, hours wrap at 24). */
function frameToTc(frame, day) {
  const { nominal, first } = tcClock(day);
  const n = first + Math.max(0, Math.round(frame));
  const pad = (x) => String(x).padStart(2, '0');
  const ff = n % nominal;
  const secs = Math.floor(n / nominal);
  return `${pad(Math.floor(secs / 3600) % 24)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(ff)}`;
}

/** "01:00:12:03" + frames (nominal rate, non-drop — what Resolve shows for 23.976). Unlike
 *  frameToTc this starts from a timeline's start TC string and hours don't wrap. */
function tcPlus(startTc, frames, fps) {
  const nom = Math.round(fps) || 24;
  const m = /^(\d+):(\d+):(\d+)[:;](\d+)$/.exec(String(startTc || ''));
  const base = m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * nom + +m[4] : 0;
  const t = base + Math.max(0, Math.round(frames));
  const ff = t % nom;
  const s = Math.floor(t / nom);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

// ── Claude ──

/** Refusal fallback: a safety decline re-runs on a fallback model inside the same call. */
const REFUSAL_FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

/**
 * run(withFallback) → the message. Asks with the refusal fallback; the option is a beta, so if
 * this account/API rejects it (a 400 that names it), asks once without.
 */
async function withRefusalFallback(run) {
  try {
    return await run(true);
  } catch (err) {
    if (err && err.status === 400 && /fallback/i.test(err.message || '')) return run(false);
    throw err;
  }
}

module.exports = {
  STEP_KEYS, readJson, median, lowerBound, endsSentence, quote, angleNo, picturePieces, segsOf,
  frameSec, totalFrames, tcClock, frameToTc, tcPlus, REFUSAL_FALLBACK, withRefusalFallback
};
