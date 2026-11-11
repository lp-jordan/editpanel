'use strict';
/**
 * Slate read: the page moves on the slate camera (Jordan 2026-11-11). Two synthetic slate clips,
 * read with the real local OCR (no Claude):
 *   clip 1 — J1 in the usual tile, then at 20 s the page drops 10% and shows J2 (mid-clip search)
 *   clip 2 — the page sits 6% above the usual tile from the start, J3 then J4 (clip-start search)
 *   clip 3 — same place, J5, then nothing on the page for 15 s, then J6 (the box must not wander)
 * Run: node scripts/test-slate-shift.js   (needs ffmpeg-static or ffmpeg on PATH)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const slate = require('../electron/workers/cut_through_slate');

let FFMPEG = 'ffmpeg';
try { FFMPEG = require('ffmpeg-static'); } catch (_) { /* PATH */ }
const FONT = path.join(__dirname, '..', 'electron', 'renderer', 'fonts', 'Metropolis-Bold.otf');
const W = 1280;
const H = 720;
const TILE = slate.SLATE_BOX;

/** A slate clip: [{ from, to, dy, code }] — the tile shifted dy (share of the height). */
function makeClip(file, dur, parts) {
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');
  const f = ['drawbox=x=40:y=40:w=1200:h=640:color=0x23262d:t=fill'];
  for (const p of parts) {
    const x = Math.round(TILE.x * W);
    const y = Math.round((TILE.y + p.dy) * H);
    const w = Math.round(TILE.w * W);
    const h = Math.round(TILE.h * H);
    const on = `enable='between(t,${p.from},${p.to - 0.04})'`;
    f.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0x3a3f49:t=fill:${on}`);
    f.push(`drawtext=fontfile='${esc(FONT)}':text=${p.code}:fontcolor=white:fontsize=64:x=${x}+(${w}-tw)/2:y=${y}+(${h}-th)/2:${on}`);
    f.push(`drawtext=fontfile='${esc(FONT)}':text=Production Notes:fontcolor=0x9aa0aa:fontsize=26:x=${x + w + 30}:y=${y + 10}:${on}`);
  }
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x15171b:s=${W}x${H}:rate=25:d=${dur}`,
    '-vf', f.join(','), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-shift-'));
  const a = path.join(dir, 'a.mp4');
  const b = path.join(dir, 'b.mp4');
  makeClip(a, 40, [{ from: 0, to: 20, dy: 0, code: 'J1' }, { from: 20, to: 40, dy: 0.1, code: 'J2' }]);
  makeClip(b, 30, [{ from: 0, to: 15, dy: -0.06, code: 'J3' }, { from: 15, to: 30, dy: -0.06, code: 'J4' }]);
  const c = path.join(dir, 'c.mp4');
  makeClip(c, 35, [{ from: 0, to: 10, dy: -0.06, code: 'J5' }, { from: 25, to: 35, dy: -0.06, code: 'J6' }]);
  const clips = [
    { path: a, file_zero_sec: 0, from_sec: 0, to_sec: 40 },
    { path: b, file_zero_sec: 40, from_sec: 40, to_sec: 70 },
    { path: c, file_zero_sec: 70, from_sec: 70, to_sec: 105 }
  ];
  const r = await slate.readSlate({ ffmpeg: FFMPEG, clips, frameSec: 1 / 25, client: null, model: null,
    knownCodes: ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'] });
  const codes = r.reads.filter((x) => x.code).map((x) => x.code);
  assert.deepStrictEqual([...new Set(codes)], ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'], `${r.report}\n${JSON.stringify(r.reads)}`);
  assert.strictEqual(r.moves, 2, r.report);           // the blank stretch didn't move it
  assert.ok(r.reads.some((x) => !x.code && x.from / 25 >= 79 && x.to / 25 <= 96), JSON.stringify(r.reads));
  const j2 = r.reads.find((x) => x.code === 'J2');
  assert.ok(Math.abs(j2.from / 25 - 20) <= 3, `J2 starts at ${j2.from / 25} s`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`✓ slate shift: page dropped mid-clip and sat higher in the next clip, a blank page didn't move it, all codes read free (${r.report})`);
})().catch((err) => { console.error(err); process.exit(1); });
