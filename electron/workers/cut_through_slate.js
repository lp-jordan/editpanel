'use strict';
/**
 * Cut-through: read the J-code off the slate angle (Jordan 2026-11-10). Slate notes only hold a
 * code when someone wrote a note under it, so footage already shot is missing codes; the slate
 * screen itself was on camera the whole time.
 *
 * How:
 *   1. ffmpeg samples the slate angle's clips at SAMPLE_FPS as tiny grey thumbnails (cheap: the
 *      same decode the slider-motion read does).
 *   2. The picture only changes when someone types a new code (or the screen changes), so the
 *      samples fall into "looks": a new look starts where the thumbnail differs from the current
 *      look's for PERSIST samples in a row.
 *   3. One sharp frame from the middle of each look goes to Claude (several per request), which
 *      reads the code in it. A clip of 6 h with ~100 code changes is ~100 frames, well under $1.
 *   4. Each look becomes { from, to, code } on the multicam (frames). Find videos treats the start
 *      of a look as "this code from here on", like a slate note, and the cut still lands in the
 *      longest pause near it.
 *
 * Output (slate_<LABEL>.json): { angle, reads: [{ from, to, code, sure }], frames, cost, ... }.
 */

const { spawn } = require('child_process');

const SAMPLE_FPS = 1;
const THUMB_W = 64;
const THUMB_H = 36;
const CHANGE = 10;            // mean |difference| (0–255) between thumbnails that counts as a new look
const PERSIST = 3;            // …for this many samples in a row (a person walking past isn't a new code)
const MAX_FRAMES = 600;       // safety: more looks than this = the angle isn't a steady slate screen
const PER_REQUEST = 8;        // frames per Claude request
const GRAB_W = 1280;

function run(ffmpeg, args, onProc) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    onProc(p);
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err.trim().split('\n').pop() || 'failed'}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

/** ffmpeg → one grey THUMB_W×THUMB_H thumbnail per sample. */
async function readThumbs(ffmpeg, file, startSec, durSec, onProc = () => {}) {
  const buf = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-hwaccel', 'auto', '-ss', String(Math.max(0, startSec)), '-t', String(durSec), '-i', file,
    '-vf', `fps=${SAMPLE_FPS},scale=${THUMB_W}:${THUMB_H}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], onProc);
  const size = THUMB_W * THUMB_H;
  const out = [];
  for (let o = 0; o + size <= buf.length; o += size) out.push(buf.subarray(o, o + size));
  return out;
}

/** One frame as a JPEG (GRAB_W wide). */
function grabFrame(ffmpeg, file, sec, onProc = () => {}) {
  return run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, sec)), '-i', file, '-frames:v', '1',
    '-vf', `scale=${GRAB_W}:-2`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', '-'], onProc);
}

function diff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Thumbnails → looks as [first sample, last sample] (indexes). */
function looksOf(thumbs, { change = CHANGE, persist = PERSIST } = {}) {
  if (!thumbs.length) return [];
  const looks = [];
  let start = 0;
  let ref = thumbs[0];
  let run_ = 0;
  for (let i = 1; i < thumbs.length; i++) {
    if (diff(ref, thumbs[i]) > change) {
      run_ += 1;
      if (run_ >= persist) {
        const at = i - persist + 1;
        looks.push([start, at - 1]);
        start = at;
        ref = thumbs[at];
        run_ = 0;
      }
    } else {
      run_ = 0;
    }
  }
  looks.push([start, thumbs.length - 1]);
  return looks;
}

const SCHEMA = {
  type: 'object',
  properties: {
    reads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          image: { type: 'integer' },
          code: { type: 'string' },
          sure: { type: 'boolean' }
        },
        required: ['image', 'code', 'sure'],
        additionalProperties: false
      }
    }
  },
  required: ['reads'],
  additionalProperties: false
};

function prompt(knownCodes) {
  const known = (knownCodes || []).filter(Boolean);
  return 'Each image is a frame from the slate camera of a video shoot. The slate is a screen showing the code of the ' +
    'video being recorded (a J-code such as H6, J12 or A1) in its code box. For every image, return the code shown in the ' +
    'code box exactly as written. Return an empty string when no code is readable (screen off, blurred, blocked). ' +
    'Set sure to false when you are guessing between similar characters.' +
    (known.length ? `\n\nCodes written on this project's slate notes include: ${[...new Set(known)].slice(0, 300).join(', ')}. ` +
      'A code on screen may also be one that is not in this list.' : '');
}

/** One request: frames [{ jpeg }] → [{ code, sure }] in the same order. */
async function readBatch({ client, model, frames, knownCodes }) {
  const content = [];
  frames.forEach((f, i) => {
    content.push({ type: 'text', text: `Image ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.jpeg.toString('base64') } });
  });
  content.push({ type: 'text', text: 'Read the code in each image.' });
  const params = {
    model,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: prompt(knownCodes),
    messages: [{ role: 'user', content }]
  };
  let msg;
  try {
    // refusal fallback: a safety decline re-runs on a fallback model inside the same call
    msg = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (err && err.status === 400 && /fallback/i.test(err.message || '')) msg = await client.messages.create(params);
    else throw err;
  }
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined to read the slate frames'), { usage: msg.usage });
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { throw Object.assign(new Error('Slate read: answer was not valid JSON'), { usage: msg.usage }); }
  const by = new Map((parsed.reads || []).map((r) => [r.image, r]));
  return {
    reads: frames.map((_, i) => {
      const r = by.get(i + 1);
      const code = r ? String(r.code || '').trim() : '';
      return { code: code || null, sure: Boolean(r && r.sure && code) };
    }),
    usage: msg.usage,
    model: msg.model || model
  };
}

function addUsage(a, b) {
  const out = { ...a };
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) out[k] = (out[k] || 0) + ((b && b[k]) || 0);
  return out;
}

/**
 * clips: [{ path, file_zero_sec, from_sec, to_sec }] of the slate angle (multicam seconds).
 * Returns { reads: [{ from, to, code, sure }] (multicam frames), frames, usage, model, seconds, report }.
 */
async function readSlate({ ffmpeg, clips, frameSec, client, model, knownCodes = [], onProgress = () => {}, onProc = () => {}, isCanceled = () => false }) {
  const t0 = Date.now();
  // 1–2: looks per clip
  const looks = [];
  for (const [k, c] of clips.entries()) {
    if (isCanceled()) throw new Error('Canceled');
    onProgress({ phase: 'Looking for code changes on the slate', bar: Math.round((k / clips.length) * 70) });
    const start = c.from_sec - c.file_zero_sec;
    const thumbs = await readThumbs(ffmpeg, c.path, start, c.to_sec - c.from_sec, onProc);
    for (const [a, b] of looksOf(thumbs)) {
      const mid = (a + b) / 2 / SAMPLE_FPS;
      looks.push({ clip: c, fromSec: c.from_sec + a / SAMPLE_FPS, toSec: Math.min(c.to_sec, c.from_sec + (b + 1) / SAMPLE_FPS), fileSec: start + mid });
    }
  }
  if (looks.length > MAX_FRAMES) {
    throw new Error(`The slate angle changes ${looks.length} times — it doesn't look like a steady slate screen (pick another angle)`);
  }
  // 3: read each look's code
  let usage = {};
  let usedModel = model;
  const reads = [];
  for (let i = 0; i < looks.length; i += PER_REQUEST) {
    if (isCanceled()) throw new Error('Canceled');
    onProgress({ phase: `Reading the codes (${Math.min(i + PER_REQUEST, looks.length)} of ${looks.length} frames)`, bar: 70 + Math.round((i / looks.length) * 30) });
    const group = looks.slice(i, i + PER_REQUEST);
    const frames = [];
    for (const l of group) frames.push({ jpeg: await grabFrame(ffmpeg, l.clip.path, l.fileSec, onProc) });
    const r = await readBatch({ client, model, frames, knownCodes });
    usage = addUsage(usage, r.usage);
    usedModel = r.model;
    group.forEach((l, j) => reads.push({ from: Math.round(l.fromSec / frameSec), to: Math.round(l.toSec / frameSec), ...r.reads[j] }));
  }
  reads.sort((a, b) => a.from - b.from);
  const unreadable = reads.filter((r) => !r.code).length;
  const unsure = reads.filter((r) => r.code && !r.sure).length;
  const codes = new Set(reads.filter((r) => r.code).map((r) => r.code)).size;
  const seconds = (Date.now() - t0) / 1000;
  return {
    reads, frames: looks.length, usage, model: usedModel, seconds: +seconds.toFixed(1),
    report: `${looks.length} slate frames read: ${codes} codes, ${unreadable} unreadable, ${unsure} unsure, in ${seconds.toFixed(0)} s`
  };
}

module.exports = { readSlate, looksOf, readThumbs, grabFrame, readBatch, diff, SAMPLE_FPS, THUMB_W, THUMB_H };
