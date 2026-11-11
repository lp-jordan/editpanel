'use strict';
/**
 * Cut-through: read the J-code off the slate angle (Jordan 2026-11-10). Slate notes only hold a
 * code when someone wrote a note under it, so footage already shot is missing codes; the slate
 * screen itself was on camera the whole time.
 *
 * How:
 *   1. Find the code box: local OCR tries the Slate page's usual tile (SLATE_BOX) first. Only if
 *      no code reads there, and the editor allowed Claude, does Claude check that tile and then
 *      get whole frames to say where the code is (a box, 0–1); without Claude the read stops and
 *      the caller asks. Everything after looks only at that box (padded), so a clock or meter
 *      elsewhere on the screen doesn't count as a change, and a two-character code change does.
 *   2. ffmpeg samples the box at SAMPLE_FPS as tiny grey thumbnails; the samples fall into "looks"
 *      where the box stays the same (a new look = differs for PERSIST samples in a row).
 *   3. The box is read at the START of every look (and at its end, and every CHECK_EVERY_SEC
 *      inside a long one — a change the thumbnails missed). Free first: local OCR
 *      (cut_through_ocr.js), trusted when it matches a code on the slate's notes; Claude only
 *      reads what OCR can't vouch for (a code never logged, a blurred frame), and only when asked.
 *   4. Where two neighbouring reads disagree and are more than MIN_GAP_SEC apart, more reads go in
 *      between (three per gap per round, all gaps batched together) until each change is pinned.
 *   5. The reads become { from, to, code } on the multicam (frames). Find videos treats the start of
 *      each as "this code from here on", like a slate note; the cut still lands in the nearest pause.
 *
 * Output (slate_<LABEL>.json): { angle, box, reads: [{ from, to, code, sure }], frames, cost, … }.
 */

const { spawn } = require('child_process');
const ocr = require('./cut_through_ocr');

const SAMPLE_FPS = 1;
const THUMB_W = 64;
const THUMB_H = 32;
// Real slate (Elevate 10-08, ATEM feed): noise median 0.11; one changed character (J5→J6) = 2.0
const CHANGE = 1;             // mean |difference| (0–255) in the code's text area that counts as a new look
const NOISE_X = 6;            // …or this many times the footage's own sample-to-sample noise, if higher
const PERSIST = 2;            // …for this many samples in a row
const READ_AFTER_SEC = 1.5;   // read a look this far in (past the change itself)
const CHECK_EVERY_SEC = 300;  // a long look is also read every 5 min, and at its end
const MIN_GAP_SEC = 3.5;      // a change between two reads closer than this is pinned
const TYPING_SEC = 8;         // a stray read between two good codes this close together = someone typing
const MAX_ROUNDS = 8;
const MAX_LOOKS = 600;        // safety: more looks than this = the box isn't a steady code box
const PER_REQUEST = 8;        // frames per Claude request
const GRAB_W = 1280;          // the whole frame, to find the box
const CROP_W = 640;           // a read of the box
const PAD = 0.3;              // box padding, as a share of its size on each side
// The LPOS Slate page's code tile (Jordan's screenshot 2026-11-10: every slate has this layout, the
// tile left of Production Notes). Tried first; Claude finds the box only if nothing reads there.
const SLATE_BOX = { x: 0.215, y: 0.495, w: 0.13, h: 0.235, ocrMargin: [0.1, 0.25] };

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

/** ffmpeg crop filter for a 0–1 box (null = the whole frame). */
function cropFilter(box) {
  if (!box) return '';
  const f = (v) => v.toFixed(4);
  return `crop=iw*${f(box.w)}:ih*${f(box.h)}:iw*${f(box.x)}:ih*${f(box.y)},`;
}

/** The part of the box the code's text sits in (the tile minus its empty edges). */
function textArea(box) {
  if (!box) return null;
  const [mx, my] = box.ocrMargin || [0.05, 0.05];
  return { x: box.x + box.w * mx, y: box.y + box.h * my, w: box.w * (1 - 2 * mx), h: box.h * (1 - 2 * my) };
}

/** ffmpeg → one grey THUMB_W×THUMB_H thumbnail of the code's text area per sample. */
async function readThumbs(ffmpeg, file, startSec, durSec, box, onProc = () => {}) {
  const buf = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-hwaccel', 'auto', '-ss', String(Math.max(0, startSec)), '-t', String(durSec), '-i', file,
    '-vf', `fps=${SAMPLE_FPS},${cropFilter(textArea(box))}scale=${THUMB_W}:${THUMB_H}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], onProc);
  const size = THUMB_W * THUMB_H;
  const out = [];
  for (let o = 0; o + size <= buf.length; o += size) out.push(buf.subarray(o, o + size));
  return out;
}

/** The box of one frame, ready for OCR: inner part, black text on white, a white margin (PNG). */
function grabForOcr(ffmpeg, file, sec, box, onProc = () => {}) {
  const inner = textArea(box);
  return run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, sec)), '-i', file, '-frames:v', '1',
    '-vf', `${cropFilter(inner)}scale=-2:120,format=gray,lutyuv=y='if(gt(val,140),0,255)',pad=iw+80:ih+80:40:40:white`,
    '-f', 'image2pipe', '-c:v', 'png', '-'], onProc);
}

/** One frame (or the box of it) as a JPEG. */
function grabFrame(ffmpeg, file, sec, box = null, onProc = () => {}) {
  const width = box ? CROP_W : GRAB_W;
  return run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, sec)), '-i', file, '-frames:v', '1',
    '-vf', `${cropFilter(box)}scale=${width}:-2`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', '-'], onProc);
}

function diff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Thumbnails → looks as [first sample, last sample] (indexes). */
function looksOf(thumbs, { change = null, persist = PERSIST } = {}) {
  if (!thumbs.length) return [];
  if (change === null) {
    // the footage's own noise: the median change between neighbouring samples (a code changes rarely)
    const d = [];
    for (let i = 1; i < thumbs.length; i++) d.push(diff(thumbs[i - 1], thumbs[i]));
    d.sort((a, b) => a - b);
    change = Math.max(CHANGE, NOISE_X * (d.length ? d[d.length >> 1] : 0));
  }
  const looks = [];
  let start = 0;
  let ref = thumbs[0];
  let streak = 0;
  for (let i = 1; i < thumbs.length; i++) {
    if (diff(ref, thumbs[i]) > change) {
      streak += 1;
      if (streak >= persist) {
        const at = i - persist + 1;
        looks.push([start, at - 1]);
        start = at;
        ref = thumbs[at];
        streak = 0;
      }
    } else {
      streak = 0;
    }
  }
  looks.push([start, thumbs.length - 1]);
  return looks;
}

async function ask(client, params) {
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
  try {
    return { parsed: JSON.parse(text), usage: msg.usage, model: msg.model || params.model };
  } catch (_) {
    throw Object.assign(new Error('Slate read: answer was not valid JSON'), { usage: msg.usage });
  }
}

const BOX_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    code: { type: 'string' },
    x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }
  },
  required: ['found', 'code', 'x', 'y', 'w', 'h'],
  additionalProperties: false
};

const READ_SCHEMA = {
  type: 'object',
  properties: {
    reads: {
      type: 'array',
      items: {
        type: 'object',
        properties: { image: { type: 'integer' }, code: { type: 'string' }, sure: { type: 'boolean' } },
        required: ['image', 'code', 'sure'],
        additionalProperties: false
      }
    }
  },
  required: ['reads'],
  additionalProperties: false
};

const ABOUT = 'The images come from the slate camera of a video shoot. The slate is a screen showing the code of the ' +
  'video being recorded (a J-code such as H6, J12, A1 or 1A) in its code box. Codes are short: letters and digits.';

function hint(knownCodes) {
  const known = [...new Set((knownCodes || []).filter(Boolean))].slice(0, 300);
  return known.length ? `\n\nCodes written on this project's slate notes include: ${known.join(', ')}. ` +
    'The code on screen may also be one that is not in this list; always write what is on screen.' : '';
}

/** Where the code box is, on one whole frame → { box (padded, 0–1) | null, code }. */
async function locateBox({ client, model, jpeg, knownCodes }) {
  const r = await ask(client, {
    model,
    max_tokens: 2000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: BOX_SCHEMA } },
    system: ABOUT + hint(knownCodes),
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
      { type: 'text', text: 'Find the code box. Return found, the code shown, and the box around the code text as x, y, w, h ' +
        'fractions of the image width and height (x, y = top-left corner). found = false when there is no slate code on screen.' }
    ] }]
  });
  const p = r.parsed || {};
  if (!p.found || !(p.w > 0) || !(p.h > 0)) return { box: null, code: null, usage: r.usage, model: r.model };
  const x0 = Math.max(0, p.x - p.w * PAD);
  const y0 = Math.max(0, p.y - p.h * PAD);
  const x1 = Math.min(1, p.x + p.w * (1 + PAD));
  const y1 = Math.min(1, p.y + p.h * (1 + PAD));
  return { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, code: String(p.code || '').trim() || null, usage: r.usage, model: r.model };
}

/** One request: box crops [{ jpeg }] → [{ code, sure }] in the same order. */
async function readBatch({ client, model, frames, knownCodes }) {
  const content = [];
  frames.forEach((f, i) => {
    content.push({ type: 'text', text: `Image ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.jpeg.toString('base64') } });
  });
  content.push({ type: 'text', text: 'Each image is the code box. Read the code in each image exactly as written; an empty string when ' +
    'no code is readable. sure = false when you are guessing between similar characters.' });
  const r = await ask(client, {
    model,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: READ_SCHEMA } },
    system: ABOUT + hint(knownCodes),
    messages: [{ role: 'user', content }]
  });
  const by = new Map(((r.parsed && r.parsed.reads) || []).map((x) => [x.image, x]));
  return {
    reads: frames.map((_, i) => {
      const x = by.get(i + 1);
      const code = x ? String(x.code || '').trim() : '';
      return { code: code || null, sure: Boolean(x && x.sure && code) };
    }),
    usage: r.usage,
    model: r.model
  };
}

function addUsage(a, b) {
  const out = { ...a };
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) out[k] = (out[k] || 0) + ((b && b[k]) || 0);
  return out;
}

/** Sorted samples of one clip → [{ fromSec, toSec, code, sure }] covering the clip (multicam seconds). */
function segmentsOf(samples, clip) {
  const out = [];
  samples.forEach((p, i) => {
    const from = i === 0 ? clip.from_sec : (samples[i - 1].t + p.t) / 2;
    const to = i === samples.length - 1 ? clip.to_sec : (p.t + samples[i + 1].t) / 2;
    const last = out[out.length - 1];
    if (last && last.code === p.code) { last.toSec = to; last.sure = last.sure && p.sure; return; }
    out.push({ fromSec: from, toSec: to, code: p.code, sure: p.sure });
  });
  return out;
}

/**
 * clips: [{ path, file_zero_sec, from_sec, to_sec }] of the slate angle (multicam seconds).
 * Returns { reads: [{ from, to, code, sure }] (multicam frames), box, frames, usage, model, seconds, report }.
 */
async function readSlate({ ffmpeg, clips, frameSec, client, model, knownCodes = [], onProgress = () => {}, onProc = () => {}, isCanceled = () => false,
  grab = grabFrame, grabOcr = grabForOcr, ocrRead = ocr.readCode }) {
  const t0 = Date.now();
  let usage = {};
  let usedModel = model;
  let asked = 0;                 // frames Claude read
  let byOcr = 0;                 // frames OCR read (free)
  let ocrOff = null;             // why OCR isn't used (it failed to start)
  const known = new Set((knownCodes || []).map((k) => String(k).trim().toUpperCase()).filter(Boolean));
  /** OCR one frame's box → { code, sure } it can vouch for, or null; raw: any code-like read at all
   *  (finding the tile). OCR trouble switches it off for the run. */
  const tryOcr = async (clip, t, box_, raw = false) => {
    if (ocrOff || !box_) return null;
    try {
      const r = await ocrRead(await grabOcr(ffmpeg, clip.path, fileSec(clip, t), box_, onProc));
      return raw ? (ocr.looksLikeCode(r) ? r : null) : ocr.trusted(r, known);
    } catch (err) {
      ocrOff = err.message || String(err);
      return null;
    }
  };
  const check = () => { if (isCanceled()) throw new Error('Canceled'); };
  const fileSec = (clip, t) => t - clip.file_zero_sec;

  // 1. the code box: the Slate page's usual tile if a code reads there, else Claude finds it
  onProgress({ phase: 'Finding the code box', bar: 0 });
  let box = null;
  let boxFrom = 'none';
  const probes = clips.slice(0, 3).map((c) => ({ c, t: c.from_sec + Math.min(10, (c.to_sec - c.from_sec) / 2) }));
  for (const { c, t } of probes) {
    if (box) break;
    if (await tryOcr(c, t, SLATE_BOX, true)) { box = SLATE_BOX; boxFrom = 'usual'; byOcr += 1; }
  }
  if (probes.length && !box && client) {
    const frames = [];
    for (const { c, t } of probes) frames.push({ jpeg: await grab(ffmpeg, c.path, fileSec(c, t), SLATE_BOX, onProc) });
    const r = await readBatch({ client, model, frames, knownCodes });
    usage = addUsage(usage, r.usage);
    usedModel = r.model;
    asked += frames.length;
    if (r.reads.some((x) => x.code)) { box = SLATE_BOX; boxFrom = 'usual'; }
  }
  for (const c of box || !client ? [] : clips.slice(0, 4)) {
    check();
    const t = c.from_sec + Math.min(10, (c.to_sec - c.from_sec) / 2);
    const found = await locateBox({ client, model, jpeg: await grab(ffmpeg, c.path, fileSec(c, t), null, onProc), knownCodes });
    usage = addUsage(usage, found.usage);
    usedModel = found.model;
    asked += 1;
    if (found.box) { box = found.box; boxFrom = 'found'; break; }
  }

  if (!box && !client) {
    // no code tile where it usually is, and finding it needs Claude: stop here (the caller asks first)
    await ocr.close();
    const seconds = (Date.now() - t0) / 1000;
    return { reads: [], box: null, boxMissing: true, needsClaude: null, frames: byOcr, byOcr, byClaude: 0, ocrOff, usage, model: usedModel,
      seconds: +seconds.toFixed(1), report: `the code tile isn't where it usually is — Claude is needed to find it${ocrOff ? ` (OCR off: ${ocrOff})` : ''}` };
  }

  // 2. looks per clip (inside the box)
  const perClip = [];
  let looks = 0;
  for (const [k, c] of clips.entries()) {
    check();
    onProgress({ phase: 'Looking for code changes on the slate', bar: Math.round((k / clips.length) * 50) });
    const thumbs = await readThumbs(ffmpeg, c.path, fileSec(c, c.from_sec), c.to_sec - c.from_sec, box, onProc);
    const L = looksOf(thumbs).map(([a, b]) => [c.from_sec + a / SAMPLE_FPS, Math.min(c.to_sec, c.from_sec + (b + 1) / SAMPLE_FPS)]);
    looks += L.length;
    // 3. where to read: each look's start, then every CHECK_EVERY_SEC and its end when it's long
    const times = new Set();
    for (const [a, b] of L) {
      const first = Math.min(a + READ_AFTER_SEC, (a + b) / 2);
      times.add(+first.toFixed(2));
      for (let t = a + CHECK_EVERY_SEC; t < b - READ_AFTER_SEC; t += CHECK_EVERY_SEC) times.add(+t.toFixed(2));
      if (b - a > 2 * READ_AFTER_SEC + MIN_GAP_SEC) times.add(+(b - READ_AFTER_SEC).toFixed(2));
    }
    perClip.push({ clip: c, samples: [...times].sort((x, y) => x - y).map((t) => ({ t, code: undefined, sure: false })) });
  }
  if (looks > MAX_LOOKS) {
    throw new Error(`The slate's code box changes ${looks} times — it doesn't look like a steady slate screen (pick another angle)`);
  }

  // reads every sample that has no code yet, batched
  const readPending = async (label, barFrom, barTo) => {
    const pending = [];
    for (const pc of perClip) for (const s of pc.samples) if (s.code === undefined) pending.push({ pc, s });
    // free first: OCR, trusted only when it matches the slate's codes
    const todo = [];
    for (const [i, x] of pending.entries()) {
      check();
      if (i % 10 === 0) onProgress({ phase: `${label} (${i + 1} of ${pending.length})`, bar: Math.round(barFrom + (i / Math.max(1, pending.length)) * (barTo - barFrom) / 2) });
      const got = await tryOcr(x.pc.clip, x.s.t, box);
      if (got) { x.s.code = got.code; x.s.sure = got.sure; byOcr += 1; } else todo.push(x);
    }
    if (!client) { for (const { s } of todo) { s.code = null; s.sure = false; } return pending.length; }
    for (let i = 0; i < todo.length; i += PER_REQUEST) {
      check();
      onProgress({ phase: `${label}: asking Claude (${Math.min(i + PER_REQUEST, todo.length)} of ${todo.length})`, bar: Math.round(barFrom + (barTo - barFrom) / 2 + (i / todo.length) * (barTo - barFrom) / 2) });
      const group = todo.slice(i, i + PER_REQUEST);
      const frames = [];
      for (const { pc, s } of group) frames.push({ jpeg: await grab(ffmpeg, pc.clip.path, fileSec(pc.clip, s.t), box, onProc) });
      const r = await readBatch({ client, model, frames, knownCodes });
      usage = addUsage(usage, r.usage);
      usedModel = r.model;
      asked += frames.length;
      group.forEach(({ s }, j) => { s.code = r.reads[j].code; s.sure = r.reads[j].sure; });
    }
    return pending.length;
  };
  await readPending('Reading the codes', 50, 80);

  // 4. pin each change: more reads between neighbours that disagree
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let added = 0;
    for (const pc of perClip) {
      const extra = [];
      for (let i = 1; i < pc.samples.length; i++) {
        const a = pc.samples[i - 1];
        const b = pc.samples[i];
        if ((!a.code && !b.code) || a.code === b.code || b.t - a.t <= MIN_GAP_SEC) continue;
        for (const q of [0.25, 0.5, 0.75]) extra.push({ t: +(a.t + (b.t - a.t) * q).toFixed(2), code: undefined, sure: false });
      }
      if (extra.length) { pc.samples = [...pc.samples, ...extra].sort((x, y) => x.t - y.t); added += extra.length; }
    }
    if (!added) break;
    await readPending('Pinning where codes change', 80, 98);
  }

  // someone typing in the code box (J2 → "J" → J5, Elevate 2026-11-10): an unread or partial read
  // squeezed between two good reads within TYPING_SEC is the edit in progress, not a code — dropped
  // a good read: a slate code (or, with none loaded, letters and digits like H6 / J12)
  const good = (y) => Boolean(y.code) && (known.size ? known.has(y.code) : /[A-Z]/.test(y.code) && /[0-9]/.test(y.code));
  for (const pc of perClip) {
    pc.samples = pc.samples.filter((x, i, all) => {
      if (good(x)) return true;
      const before = all.slice(0, i).reverse().find(good);
      const after = all.slice(i + 1).find(good);
      if (!before || !after || after.t - before.t > TYPING_SEC) return true;
      return Boolean(x.code) && (x.code === before.code || x.code === after.code);
    });
  }

  // 5. reads on the multicam
  const reads = [];
  for (const pc of perClip) {
    if (!pc.samples.length) continue;
    for (const g of segmentsOf(pc.samples, pc.clip)) {
      reads.push({ from: Math.round(g.fromSec / frameSec), to: Math.round(g.toSec / frameSec), code: g.code || null, sure: Boolean(g.code && g.sure) });
    }
  }
  reads.sort((a, b) => a.from - b.from);
  const unreadable = reads.filter((r) => !r.code).length;
  const codes = new Set(reads.filter((r) => r.code).map((r) => r.code)).size;
  const seconds = (Date.now() - t0) / 1000;
  await ocr.close();
  // free pass (no client): the frames OCR couldn't vouch for are what Claude would be asked to read
  const needsClaude = client ? 0 : perClip.reduce((n, pc) => n + pc.samples.filter((x) => !x.code).length, 0);
  return {
    reads, box, needsClaude, frames: asked + byOcr, byOcr, byClaude: asked, ocrOff, usage, model: usedModel, seconds: +seconds.toFixed(1),
    report: `${boxFrom === 'usual' ? 'usual code tile' : boxFrom === 'found' ? 'code box found by Claude' : 'no code box found (whole frame used)'}; ` +
      `${byOcr} frames read free (OCR), ${asked} by Claude${ocrOff ? ` (OCR off: ${ocrOff})` : ''}` +
      `${needsClaude ? `, ${needsClaude} left for Claude` : ''}: ${codes} codes, ` +
      `${unreadable} unreadable stretches, in ${seconds.toFixed(0)} s`
  };
}

module.exports = { readSlate, diff };
