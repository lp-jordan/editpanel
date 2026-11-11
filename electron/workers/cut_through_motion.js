'use strict';
/**
 * Cut-through slider motion (Jordan 2026-11-10, on trial): when is the slider angle actually
 * moving? Jordan cuts to the slider only while it moves, never on the stop / reset before it
 * reverses. Free and local: ffmpeg + arithmetic, no Claude.
 *
 * How: ffmpeg decodes the slider angle's clips at SAMPLE_FPS and squashes every frame to one
 * row (each column's average brightness, PROFILE_W wide) and one column (each row's average).
 * When the camera slides, the whole picture slides, so the row (or column, for a vertical move)
 * shifts; how far it shifted between samples LAG apart is found by sliding one profile over the
 * other (best normalised correlation, sub-pixel). A person talking or gesturing changes part of
 * the profile but doesn't move all of it, so it barely registers. Steady shift = moving; near
 * zero = stopped; the sign says which way. Moving stretches shorter than MIN_MOVE_SEC are
 * dropped and every stretch is trimmed by EDGE_SEC at both ends (the slow-down into a stop).
 *
 * Output (motion_<LABEL>.json): { [angle]: { moving: [[from, to] multicam frames], sampleFps,
 *   seconds, report } }.
 */

const { spawn } = require('child_process');
const { median } = require('./cut_through_util');   // never called on an empty list here

const SAMPLE_FPS = 4;
const LAG = 2;                    // compare samples 0.5 s apart: a slow slide still shifts a few px
const PROFILE_W = 320;
const PROFILE_H = 180;
const MAX_SHIFT = 24;             // px at PROFILE_W per LAG — a fast whip is not a slider move
const MOVE_PX = 0.6;              // |shift| per LAG above this = moving (≈1.2 px/s at 320 px wide)
const MIN_CORR = 0.6;             // a worse match than this (a cut, a flash) reads as not moving
const SMOOTH = 5;                 // median over this many samples
const MIN_MOVE_SEC = 2;
const EDGE_SEC = 0.5;


function normalise(p) {
  const n = p.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += p[i];
  m /= n;
  let v = 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { out[i] = p[i] - m; v += out[i] * out[i]; }
  const sd = Math.sqrt(v / n) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/** How far b is shifted against a (px, sub-pixel), and how well they match there. */
function shiftOf(a, b, maxShift = MAX_SHIFT) {
  const n = a.length;
  const score = (d) => {
    let s = 0;
    let c = 0;
    for (let i = Math.max(0, -d); i < Math.min(n, n - d); i++) { s += a[i] * b[i + d]; c++; }
    return c > n / 2 ? s / c : -Infinity;
  };
  let best = 0;
  let bestS = -Infinity;
  const sc = {};
  for (let d = -maxShift; d <= maxShift; d++) {
    sc[d] = score(d);
    if (sc[d] > bestS) { bestS = sc[d]; best = d; }
  }
  let frac = 0;
  if (best > -maxShift && best < maxShift) {
    const l = sc[best - 1];
    const r = sc[best + 1];
    const den = l - 2 * bestS + r;
    if (den < 0) frac = 0.5 * (l - r) / den;
  }
  return { shift: best + frac, corr: bestS };
}

/** Raw shifts per sample → moving stretches as [fromSec, toSec] (clip-relative). */
function stretchesOf(samples, sampleFps = SAMPLE_FPS) {
  // samples: [{t, dx, dy, cx, cy}] — the axis with more confident moves over the clip
  const moves = (d, c) => samples.filter((s) => s[c] >= MIN_CORR && Math.abs(s[d]) > MOVE_PX).length;
  const [ax, cc] = moves('dx', 'cx') >= moves('dy', 'cy') ? ['dx', 'cx'] : ['dy', 'cy'];
  const v = samples.map((s) => (s[cc] >= MIN_CORR ? s[ax] : 0));
  const sm = v.map((_, i) => median(v.slice(Math.max(0, i - (SMOOTH >> 1)), i + (SMOOTH >> 1) + 1)));
  const out = [];
  let cur = null;
  sm.forEach((x, i) => {
    const dir = Math.abs(x) > MOVE_PX ? Math.sign(x) : 0;
    const t = samples[i].t;
    if (dir && cur && cur.dir === dir) { cur.to = t; return; }
    if (cur) out.push(cur);
    cur = dir ? { from: t, to: t, dir } : null;
  });
  if (cur) out.push(cur);
  // a sample measures the move across ±LAG/2 around it; not widening by that keeps the edges safe
  return out.map((s) => ({ from: s.from + EDGE_SEC, to: s.to - EDGE_SEC, dir: s.dir }))
    .filter((s) => s.to - s.from >= MIN_MOVE_SEC);
}

/** ffmpeg → one row + one column profile per sample. */
function readProfiles(ffmpeg, file, startSec, durSec, sampleFps = SAMPLE_FPS, { onProc = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const frame = PROFILE_W + PROFILE_H;
    const args = ['-hide_banner', '-loglevel', 'error', '-hwaccel', 'auto', '-ss', String(Math.max(0, startSec)), '-t', String(durSec), '-i', file,
      '-filter_complex', `[0:v]fps=${sampleFps},format=gray,split[a][b];[a]scale=${PROFILE_W}:1:flags=area[r];[b]scale=1:${PROFILE_H}:flags=area,transpose=1[c];[r][c]hstack=inputs=2[o]`,
      '-map', '[o]', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
    const p = spawn(ffmpeg, args, { windowsHide: true });
    onProc(p);
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err.trim().split('\n').pop() || 'failed'}`));
      const buf = Buffer.concat(chunks);
      const out = [];
      for (let o = 0; o + frame <= buf.length; o += frame) {
        out.push({ row: normalise(buf.subarray(o, o + PROFILE_W)), col: normalise(buf.subarray(o + PROFILE_W, o + frame)) });
      }
      resolve(out);
    });
  });
}

function samplesOf(profiles, sampleFps = SAMPLE_FPS) {
  const out = [];
  for (let i = LAG; i < profiles.length; i++) {
    const x = shiftOf(profiles[i - LAG].row, profiles[i].row);
    const y = shiftOf(profiles[i - LAG].col, profiles[i].col, Math.round(MAX_SHIFT * PROFILE_H / PROFILE_W));
    out.push({ t: (i - LAG / 2) / sampleFps, dx: x.shift, dy: y.shift, cx: x.corr, cy: y.corr });
  }
  return out;
}

/**
 * clips: [{path, file_zero_sec, from_sec, to_sec}] of one angle (multicam seconds).
 * Returns { moving: [[fromFrame, toFrame]], seconds, movingSec, stretches, report }.
 */
async function sliderMotion({ ffmpeg, clips, frameSec, onProgress = () => {}, onProc }) {
  const t0 = Date.now();
  const moving = [];
  let total = 0;
  for (const [k, c] of clips.entries()) {
    onProgress(k, clips.length, c);
    const dur = c.to_sec - c.from_sec;
    total += dur;
    const prof = await readProfiles(ffmpeg, c.path, c.from_sec - c.file_zero_sec, dur, SAMPLE_FPS, { onProc });
    for (const s of stretchesOf(samplesOf(prof))) {
      moving.push([Math.round((c.from_sec + s.from) / frameSec), Math.round((c.from_sec + s.to) / frameSec)]);
    }
  }
  moving.sort((a, b) => a[0] - b[0]);
  const movingSec = moving.reduce((n, [a, b]) => n + (b - a) * frameSec, 0);
  const seconds = (Date.now() - t0) / 1000;
  const lens = moving.map(([a, b]) => (b - a) * frameSec);
  return { moving, sampleFps: SAMPLE_FPS, seconds: +seconds.toFixed(1), movingSec: +movingSec.toFixed(1), clipSec: +total.toFixed(1),
    report: `${moving.length} moving stretches (median ${lens.length ? median(lens).toFixed(1) : '–'} s), ` +
      `moving ${total ? Math.round((movingSec / total) * 100) : 0}% of ${(total / 60).toFixed(1)} min, read in ${seconds.toFixed(0)} s` };
}

/** Share of a cut's slider shots that sit fully inside a moving stretch (Compare). */
function sliderFit(pieces, angle, moving) {
  const shots = pieces.filter((p) => p.angle === angle);
  const inside = shots.filter((p) => moving.some(([a, b]) => p.src_in >= a - 2 && p.src_out <= b + 2));
  return { shots: shots.length, inside: inside.length };
}

module.exports = { sliderMotion, sliderFit };
