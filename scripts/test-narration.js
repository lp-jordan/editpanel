#!/usr/bin/env node
'use strict';
/**
 * Cut-through narration (audiobook, 2026-11-12) — offline checks:
 *   1. manuscript: .docx read without a zip library, chapters split at headings, PDF refused
 *   2. chapters found in the transcript (digits / words / roman numerals, an earlier take kept in)
 *   3. place_cuts.py on a narration day: sound only, no picture, retake removed
 *   4. build_narration.py's frame mapping (kept pieces → file frames, markers → record frames)
 *   5. engine end to end with a fake Resolve + fake Claude: audio timeline listed → Prep
 *      (prepare_audio.py) → manuscript → chapters → Plan (narration brief, manuscript slice, no
 *      shots in the schema) → Build (build_narration.py, one plan per chapter); Check refused
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const narration = require('../electron/workers/cut_through_narration');
const claudeLib = require('../electron/workers/cut_through_claude');
const ct = require('../electron/workers/cut_through');

const REPO = path.join(__dirname, '..');
const PIPELINE = path.join(REPO, 'cut_through');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-narr-'));
const FPS = 24000 / 1001;

/** A minimal .docx: stored (uncompressed) zip entries — the reader must not care. */
function makeDocx(paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`).join('');
  const files = [['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`]];
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 10);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const MANUSCRIPT = ['The Long Road', 'by A. Narrator', '', 'Chapter 1', 'The rain fell all night on the old house.', 'Nobody slept.',
  '', 'Chapter II: Morning', 'Morning came slowly over the hills.', 'Then the bells rang.'];

/** The read as Whisper heard it: chapter one with a flubbed first take, then chapter two. */
function session() {
  const said = ['Chapter', 'one.', 'The', 'rain', 'fell', 'all', 'nigh-', 'The', 'rain', 'fell', 'all', 'night', 'on', 'the', 'old', 'house.',
    'Nobody', 'slept.', 'Chapter', 'two.', 'Morning.', 'Morning', 'came', 'slowly', 'over', 'the', 'hills.', 'Then', 'the', 'bells', 'rang.'];
  const words = [];
  let t = 30;
  said.forEach((w, i) => {
    if (i === 7) t += 40;                 // the narrator stops and goes again
    if (i === 18) t += 60;                // between chapters
    words.push({ mic: 'Narrator', w, s: t, e: t + 8, own: true, a: 0.9 });
    t += 11;
  });
  return { words, frames: t + 60 };
}

// ── 1. manuscript ─────────────────────────────────────────────
const docx = path.join(TMP, 'book.docx');
fs.writeFileSync(docx, makeDocx(MANUSCRIPT));
const text = narration.readManuscript(docx);
assert.ok(text.includes('Nobody slept.') && text.includes('Chapter II: Morning'), text);
const chapters = narration.splitChapters(text);
assert.deepStrictEqual(chapters.map((c) => c.title), ['Chapter 1', 'Chapter II: Morning']);
assert.ok(chapters[0].text.startsWith('The Long Road'), 'front matter rides with the first chapter');
assert.deepStrictEqual(narration.splitChapters('Just some text.\nNo headings.').map((c) => c.title), ['Full read']);
assert.throws(() => narration.readManuscript(path.join(TMP, 'x.pdf')), /PDF isn't supported/);
console.log('✓ manuscript: .docx read, chapters split at headings (front matter kept), no headings = one part, PDF refused');

// ── 2. chapters in the transcript ────────────────────────────
const { words, frames } = session();
const day = { frame_sec: [1001, 24000], length_sec: frames / FPS, source: 'audio_timeline', multicam: 'Book session', angles: [] };
const found = narration.findChapters({ day, words: { mics: ['Narrator'], words }, chapters });
assert.strictEqual(found.length, 2, JSON.stringify(found));
assert.strictEqual(found[0].from, 0);
const ch2 = words.findIndex((w) => w.w === 'Chapter' && w.s > 100);
assert.ok(found[1].from > words[ch2 - 1].e && found[1].from < words[ch2].s, `chapter 2 starts at ${found[1].from}`);
assert.strictEqual(found[1].to, frames);
assert.deepStrictEqual(found.map((v) => v.chapters), [[0, 0], [1, 1]]);
assert.ok(found.every((v) => v.kind === 'narration' && v.delivery === 'narration' && v.talker === 'Narrator'));
assert.strictEqual(narration.sliceText({ chapters }, [1, 1]), chapters[1].text);
// a chapter missing from the read joins the one before (and is flagged)
const three = [...chapters, { title: 'Chapter 3', text: 'Chapter 3\nNever recorded at all.' }];
const f3 = narration.findChapters({ day, words: { mics: ['Narrator'], words }, chapters: three });
assert.strictEqual(f3.length, 2);
assert.deepStrictEqual(f3[1].chapters, [1, 2]);
assert.ok(f3[1].flags.some((x) => /Not found: Chapter 3/.test(x)));
console.log('✓ chapters: found in the transcript (digits, words, roman numerals), cut in the pause, a missing chapter joins the one before');

// ── 3. place_cuts.py on a narration day ──────────────────────
{
  const dir = path.join(TMP, 'pc');
  fs.mkdirSync(dir);
  const wp = path.join(dir, 'words_N.json'), dp = path.join(dir, 'day_N.json'), pp = path.join(dir, 'N_plan.json'), rp = path.join(dir, 'removals_N.json');
  fs.writeFileSync(wp, JSON.stringify({ label: 'N', multicam: 'Book session', fps: FPS, frame_sec: [1001, 24000], angles: [], mics: ['Narrator'], words }));
  fs.writeFileSync(dp, JSON.stringify({ ...day, fps: FPS, audio_source: 'wav', mics: [{ angle: 'Narrator', path: '/x.wav', file_zero_sec: 0, from_sec: 0, to_sec: frames / FPS }] }));
  const first = words[2], last = words[6];
  fs.writeFileSync(rp, JSON.stringify({ start: 0, end: frames, delivery: 'narration', review: [], pauses: claudeLib.PAUSES ? null : null, removals: [
    { from: Math.floor(words[1].e) + 3, to: Math.ceil(words[7].s) - 3, why: 'retake', prev_end: words[1].e, cut_start: first.s, cut_end: last.e, next_start: words[7].s }] }));
  const out = execFileSync(PY, [path.join(PIPELINE, 'place_cuts.py'), wp, dp, pp, `removals=${rp}`], { encoding: 'utf8' });
  const plan = JSON.parse(fs.readFileSync(pp, 'utf8'));
  assert.ok(plan.narration && plan.video.length === 0, out);
  assert.deepStrictEqual(Object.keys(plan.mics), ['Narrator']);
  const kept = (f) => plan.mics.Narrator.some(([a, b]) => a <= f && f < b);
  assert.strictEqual(words.filter((w) => kept(w.s)).map((w) => w.w).join(' '),
    'Chapter one. The rain fell all night on the old house. Nobody slept. Chapter two. Morning. Morning came slowly over the hills. Then the bells rang.');
  assert.ok(/narration: \d+ kept piece/.test(out), out);
}
console.log('✓ place_cuts.py: narration keeps sound only (no picture), the flubbed take goes');

// ── 4. build_narration.py frame mapping ──────────────────────
{
  const src = fs.readFileSync(path.join(PIPELINE, 'build_narration.py'), 'utf8');
  const defs = ['pieces_for', 'record_frame'].map((n) => new RegExp(`def ${n}[\\s\\S]*?(?=\\n\\n\\ndef )`).exec(src)[0]).join('\n\n');
  const py = `import json\nfrom typing import List\n${defs}\n` +
    'clips=[{"path":"a.wav","from_sec":0,"to_sec":10,"file_zero_sec":-2},{"path":"b.wav","from_sec":10,"to_sec":20,"file_zero_sec":10}]\n' +
    'p=pieces_for([[24,120],[200,260]],clips,0.1)\n' +
    'print(json.dumps([p,[record_frame(f,p) for f in (30,110,150,255)]]))';
  const [pieces, recs] = JSON.parse(execFileSync(PY, ['-c', py], { encoding: 'utf8' }));
  // fsec 0.1: clip a covers frames 0–100 with its 0:00 at −2 s (= −20 fr); b covers 100–200 from 0:00
  assert.deepStrictEqual(pieces.map((p) => [p.path, p.src_in, p.src_out]), [['a.wav', 44, 120], ['b.wav', 0, 20]]);
  assert.deepStrictEqual(recs, [6, 86, 95, 95]);   // inside a piece (either file); past the last kept frame → the last frame
}
console.log('✓ build_narration.py: kept pieces split at file edges and mapped to file frames; markers land on record frames');

// ── 5. engine end to end ─────────────────────────────────────
(async () => {
  const FILES = path.join(TMP, 'runs');
  fs.mkdirSync(FILES, { recursive: true });
  let prefs = { cutThrough: { pipelineDir: PIPELINE, wxPython: PY, runFolders: { 'Narr Project': FILES } } };
  const calls = [];
  const send = async (payload) => {
    calls.push(payload);
    if (payload.cmd === 'ct_list_multicams') {
      return { data: { project: 'Narr Project', multicams: [{ name: 'mc_1', bin: 'MC', duplicate: false }], audio_timelines: [{ name: 'Book session', clips: 1 }] } };
    }
    if (payload.cmd === 'ct_run_step' && payload.script === 'prepare_audio.py') {
      const st = payload.settings;
      fs.mkdirSync(st.OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(st.OUT_DIR, `day_${st.LABEL}.json`), JSON.stringify({ ...day, fps: FPS, timeline: st.TIMELINE, audio_source: 'wav', wav_mics: 1, camera_audio_angles: [],
        mics: [{ name: 'read.wav', angle: 'Narrator', path: path.join(TMP, 'read.wav'), file_zero_sec: 0, from_sec: 0, to_sec: frames / FPS }], recordings: [] }));
      return { data: { lines: ['Saved'], error: null } };
    }
    if (payload.cmd === 'ct_run_step' && payload.script === 'build_narration.py') return { data: { lines: ['Built 2 of 2 timeline(s)'], error: null } };
    throw new Error(`unexpected ${payload.cmd} ${payload.script || ''}`);
  };
  const requests = [];
  const fakeClaude = { messages: { stream: (params) => {
    requests.push(params);
    const chapterOne = /The rain fell all night on the old house/.test(params.messages[0].content);
    // chapter one: tokens 2–6 are the flubbed first take
    const answer = { removals: chapterOne ? [{ from: 2, to: 6, kind: 'retake', reason: 'flubbed "night"' }] : [], beats: [], notes: [] };
    const handlers = {};
    return {
      on: (ev, fn) => { handlers[ev] = fn; },
      finalMessage: async () => ({ model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }],
        usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    };
  } } };
  fakeClaude.beta = { messages: { stream: fakeClaude.messages.stream } };
  const c = ct.createCutThrough({ sendWorkerRequest: send, broadcast: () => {}, getPrefs: () => prefs, setPrefs: (patch) => { prefs = { ...prefs, ...patch }; },
    pythonCmd: PY, desktopDir: path.join(TMP, 'desk'), filesDir: FILES, claudeClient: fakeClaude });
  await c.listMulticams();
  assert.deepStrictEqual(c.snapshot().audioTimelines.map((t) => t.name), ['Book session']);
  c.select({ mc: 'Book session', source: 'timeline', label: 'Book1' });
  assert.strictEqual(c.snapshot().source, 'timeline');
  const prep = (await c.runPrep({})).steps.prep;
  assert.strictEqual(prep.status, 'done', prep.error);
  const prepCall = calls.find((x) => x.script === 'prepare_audio.py');
  assert.strictEqual(prepCall.settings.TIMELINE, 'Book session');
  assert.strictEqual(c.snapshot().planKind, 'narration');
  assert.strictEqual(c.snapshot().steps.prep.data.source, 'audio_timeline');
  // what Transcribe would leave (words aligned, levels measured)
  const run = c.snapshot().files.dir;
  fs.writeFileSync(path.join(run, 'words_Book1.json'), JSON.stringify({ label: 'Book1', multicam: 'Book session', fps: FPS, frame_sec: [1001, 24000], angles: [], mics: ['Narrator'], words, aligned: true }));
  fs.writeFileSync(path.join(run, 'align_Book1.txt'), 'aligned\n');
  const db = Array(frames).fill(-70);
  for (const w of words) for (let f = w.s; f <= w.e; f += 1) db[f] = -24;
  fs.writeFileSync(path.join(run, 'levels_Book1.json'), JSON.stringify({ label: 'Book1', frame_sec: 1001 / 24000, mics: { Narrator: { start: 0, db } } }));
  await assert.rejects(() => c.findVideos({}), /splits by chapter/);
  const snap = await c.setManuscript({ file: docx });
  assert.deepStrictEqual(snap.manuscript.chapters, ['Chapter 1', 'Chapter II: Morning']);
  assert.deepStrictEqual(snap.videos.videos.map((v) => v.name), ['Chapter 1', 'Chapter II Morning']);
  const planned = (await c.planVideos({})).steps.plan;
  assert.strictEqual(planned.status, 'done', `${planned.error}\n${planned.log.join('\n')}`);
  assert.strictEqual(requests.length, 2);
  const r0 = requests[0];
  assert.ok(r0.system[0].text.includes('Keep the last clean take'), 'not the narration brief');
  assert.ok(!r0.output_config.format.schema.properties.shots && !r0.output_config.format.schema.required.includes('shots'), 'shots asked for');
  assert.ok(/<manuscript>\n[\s\S]*Nobody slept\.[\s\S]*<\/manuscript>/.test(r0.messages[0].content) && !/Morning came/.test(r0.messages[0].content), 'chapter one gets only its own text');
  assert.ok(/Return the edit: removals, notes\./.test(r0.messages[0].content));
  assert.ok(/<manuscript>\n[\s\S]*Morning came slowly/.test(requests[1].messages[0].content));
  const vids = c.snapshot().videos.videos;
  assert.ok(vids.every((v) => v.plan.status === 'planned'), JSON.stringify(vids.map((v) => v.plan)));
  const p1 = JSON.parse(fs.readFileSync(path.join(run, 'Book1__c01_plan.json'), 'utf8'));
  assert.ok(p1.narration && p1.video.length === 0);
  const kept = (f) => p1.mics.Narrator.some(([a, b]) => a <= f && f < b);
  assert.ok(!kept(words[4].s) && kept(words[9].s), 'the flubbed take stayed');
  const built = (await c.runBuild({})).steps.build;
  assert.strictEqual(built.status, 'done', built.error);
  const bc = calls.find((x) => x.script === 'build_narration.py');
  assert.deepStrictEqual(bc.settings.PLAN_FILES.map(([, n]) => n), ['Chapter 1', 'Chapter II Morning']);
  assert.ok(bc.settings.DAY_FILE.endsWith('day_Book1.json'));
  assert.ok(!calls.some((x) => x.cmd === 'ct_read_timeline'), 'Check ran on a narration build');
  await assert.rejects(() => c.runCheck({}), /narration/);
  // dropping the manuscript: one part, no script
  const one = await c.setManuscript({ file: null });
  assert.strictEqual(one.videos.videos.length, 1);
  assert.strictEqual(one.manuscript, null);
  console.log('✓ engine: audio timeline listed → Prep (prepare_audio.py) → manuscript → 2 chapters → Plan (narration brief, own manuscript slice, no shots) → Build (build_narration.py); Check refused');
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('narration checks passed');
})().catch((err) => {
  console.error(err);
  console.error(`(temp folder kept: ${TMP})`);
  process.exit(1);
});
