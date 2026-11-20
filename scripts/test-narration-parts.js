#!/usr/bin/env node
'use strict';
/**
 * Cut-through narration, planned in parts (2026-11-20) — offline checks:
 *   1. partRanges: a 40-min read splits into parts of ≤ 15 min, at a spoken slide cue when one is
 *      near; a 10-min read stays one part
 *   2. preparePlan: each part numbered with the whole read's token numbers, told it is part k of n,
 *      with read-only context either side and its own stretch of the manuscript
 *   3. mergeParts: answers joined; a number outside its own part is dropped
 *   4. engine, live: one Claude call per part, one edit + one plan for the chapter
 *   5. engine, batch: one request per part (`c01__p1`…), collected into one edit; a failed part
 *      fails the chapter
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeLib = require('../electron/workers/cut_through_claude');
const ct = require('../electron/workers/cut_through');

const REPO = path.join(__dirname, '..');
const PIPELINE = path.join(REPO, 'cut_through');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-parts-'));
const FPS = 24000 / 1001;
const FSEC = 1001 / 24000;

/** A read of `minutes`: a word every 11 fr, a 1.5 s pause every 25 words, and at ~12.5 min a
 *  spoken cue after a 2.5 s pause ("End of slide. Slide seven…"). */
function read(minutes, { cueAt = 12.5 } = {}) {
  const words = [];
  let t = 30;
  let n = 0;
  let cued = false;
  const vocab = ['curing', 'kiln', 'heat', 'humidity', 'concrete', 'products', 'steam', 'strength', 'stage', 'cycle'];
  while (t * FSEC < minutes * 60) {
    if (!cued && t * FSEC > cueAt * 60) {
      t += 60;                                         // 2.5 s
      for (const w of ['End', 'of', 'slide.', 'Slide', 'seven,', 'titled', 'venting.']) {
        words.push({ mic: 'Narrator', w, s: t, e: t + 8, own: true, a: 0.9 });
        t += 11;
      }
      cued = true;
    }
    words.push({ mic: 'Narrator', w: `${vocab[n % vocab.length]}${n}`, s: t, e: t + 8, own: true, a: 0.9 });
    t += 11;
    n += 1;
    if (n % 25 === 0) t += 36;
  }
  return { words, frames: t + 60 };
}

const tokensOf = (words) => words.map((w) => ({ kind: 'w', s: w.s, e: w.e, text: w.w, who: 'Narrator' }));

// ── 1. partRanges ─────────────────────────────────────────────
{
  const { words } = read(40);
  const tokens = tokensOf(words);
  const ranges = claudeLib.partRanges(tokens, FSEC);
  assert.ok(ranges.length >= 3 && ranges.length <= 5, JSON.stringify(ranges));
  assert.strictEqual(ranges[0][0], 0);
  assert.strictEqual(ranges[ranges.length - 1][1], tokens.length - 1);
  ranges.forEach(([a, b], k) => {
    const mins = (tokens[b].e - tokens[a].s) * FSEC / 60;
    assert.ok(mins <= 15.01 && mins >= 5, `part ${k + 1}: ${mins.toFixed(1)} min`);
    if (k) assert.strictEqual(a, ranges[k - 1][1] + 1, 'parts must touch');
  });
  const cue = words.findIndex((w) => w.w === 'Slide');
  assert.ok(ranges.some(([a]) => a === cue - 3 || a === cue), `no split at the slide cue (${cue}): ${JSON.stringify(ranges)}`);
  assert.deepStrictEqual(claudeLib.partRanges(tokensOf(read(10).words), FSEC), [[0, tokensOf(read(10).words).length - 1]]);
}
console.log('✓ partRanges: a 40-min read splits into parts of ≤ 15 min (one at the spoken slide cue); 10 min stays one part');

// ── 2 + 3. preparePlan / mergeParts ───────────────────────────
const DIR = path.join(TMP, 'unit');
fs.mkdirSync(DIR, { recursive: true });
const long = read(40);
const day = { frame_sec: [1001, 24000], length_sec: long.frames / FPS, source: 'audio_timeline', multicam: 'Webinar', angles: [] };
fs.writeFileSync(path.join(DIR, 'words.json'), JSON.stringify({ mics: ['Narrator'], words: long.words, unheard: [] }));
fs.writeFileSync(path.join(DIR, 'day.json'), JSON.stringify(day));
const script = long.words.map((w) => w.w).join(' ');
{
  const ctx = claudeLib.preparePlan({ label: 'W', wordsPath: path.join(DIR, 'words.json'), dayPath: path.join(DIR, 'day.json'),
    promptPath: path.join(PIPELINE, 'editor_briefs', 'narration.md'), start: 0, end: long.frames, delivery: 'narration', manuscript: script });
  assert.ok(ctx.parts.length >= 3, `${ctx.parts.length} part(s)`);
  ctx.parts.forEach((p, k) => {
    const msg = p.params.messages[0].content;
    assert.ok(msg.includes(`This is part ${k + 1} of ${ctx.parts.length}`), msg.slice(0, 400));
    const first = /<transcript>\n[\s\S]*?\[[0-9:]+\] (\d+) /.exec(msg);
    assert.strictEqual(Number(first[1]), p.range[0], `part ${k + 1} isn't numbered from ${p.range[0]}`);
    assert.strictEqual(k > 0, msg.includes('Just before this part:'));
    assert.strictEqual(k < ctx.parts.length - 1, msg.includes('Just after this part:'));
    // its own stretch of the script: its first and last words, not the far ends of the read
    const m = /<manuscript>\n([\s\S]*)\n<\/manuscript>/.exec(msg)[1];
    assert.ok(m.includes(ctx.tokens[p.range[0]].text) && m.includes(ctx.tokens[p.range[1]].text), `part ${k + 1} manuscript misses its words`);
    if (ctx.parts.length > 2 && k === 1) assert.ok(!m.includes(ctx.tokens[0].text) && !m.includes(ctx.tokens[ctx.tokens.length - 1].text), 'part 2 got the whole script');
  });
  // one part only: the whole read as before (numbers from 0, no part note)
  const short = read(10);
  fs.writeFileSync(path.join(DIR, 'words10.json'), JSON.stringify({ mics: ['Narrator'], words: short.words, unheard: [] }));
  const one = claudeLib.preparePlan({ label: 'S', wordsPath: path.join(DIR, 'words10.json'), dayPath: path.join(DIR, 'day.json'),
    promptPath: path.join(PIPELINE, 'editor_briefs', 'narration.md'), start: 0, end: short.frames, delivery: 'narration' });
  assert.strictEqual(one.parts.length, 1);
  assert.strictEqual(one.params, one.parts[0].params);
  assert.ok(!one.params.messages[0].content.includes('This is part'));

  const [p1, p2] = ctx.parts;
  const ans = (removals, extra = {}) => ({ parsed: { removals, beats: [], notes: [], ...extra }, usage: { input_tokens: 100, output_tokens: 10 }, model: 'm' });
  const answers = ctx.parts.map(() => ans([]));
  answers[0] = ans([{ from: p1.range[0] + 2, to: p1.range[0] + 4, kind: 'retake', reason: 'a' }, { from: p1.range[1], to: p2.range[0] + 1, kind: 'flub', reason: 'across' }],
    { beats: [p1.range[0] + 9, p2.range[0] + 3], notes: [{ at: p2.range[0] + 3, note: 'not mine' }, { at: p1.range[0] + 9, note: 'mine' }] });
  answers[1] = ans([{ from: p2.range[0] + 5, to: p2.range[0] + 5, kind: 'flub', reason: 'b' }]);
  const merged = claudeLib.mergeParts(ctx, answers);
  assert.deepStrictEqual(merged.parsed.removals.map((r) => r.reason), ['a', 'b']);
  assert.ok(merged.problems.some((x) => /part 1: skipped .*outside the part/.test(x)), merged.problems.join('; '));
  assert.deepStrictEqual(merged.parsed.beats, [p1.range[0] + 9]);
  assert.deepStrictEqual(merged.parsed.notes.map((n) => n.note), ['mine']);
  assert.strictEqual(merged.usage.input_tokens, 100 * ctx.parts.length);
  const out = claudeLib.finishPlan(ctx, merged, { outDir: DIR });
  const rem = JSON.parse(fs.readFileSync(out.removalsFile, 'utf8'));
  assert.strictEqual(rem.removals.length, 2);
  assert.ok(out.lines.some((l) => /⚠ part 1: skipped/.test(l)), out.lines.join('\n'));
}
console.log('✓ preparePlan: parts numbered with the read\'s token numbers, told part k of n, context either side, own manuscript stretch; mergeParts drops numbers outside a part');

// ── 4 + 5. engine ─────────────────────────────────────────────
(async () => {
  const FILES = path.join(TMP, 'runs');
  fs.mkdirSync(FILES, { recursive: true });
  let prefs = { cutThrough: { pipelineDir: PIPELINE, wxPython: PY, runFolders: { 'Webinar Project': FILES } } };
  const send = async (payload) => {
    if (payload.cmd === 'ct_list_multicams') return { data: { project: 'Webinar Project', multicams: [], audio_timelines: [{ name: 'Webinar', clips: 1 }] } };
    if (payload.cmd === 'ct_run_step' && payload.script === 'prepare_audio.py') {
      const st = payload.settings;
      fs.mkdirSync(st.OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(st.OUT_DIR, `day_${st.LABEL}.json`), JSON.stringify({ ...day, fps: FPS, timeline: st.TIMELINE, audio_source: 'wav', wav_mics: 1, camera_audio_angles: [],
        mics: [{ name: 'read.wav', angle: 'Narrator', path: path.join(TMP, 'read.wav'), file_zero_sec: 0, from_sec: 0, to_sec: long.frames / FPS }], recordings: [] }));
      return { data: { lines: ['Saved'], error: null } };
    }
    throw new Error(`unexpected ${payload.cmd} ${payload.script || ''}`);
  };
  // each part removes its own second and third tokens
  const answer = (params) => {
    const msg = params.messages[0].content;
    const first = Number(/<transcript>\n[\s\S]*?\[[0-9:]+\] (\d+) /.exec(msg)[1]);
    return { model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
      removals: [{ from: first + 1, to: first + 2, kind: 'retake', reason: `part from ${first}` }], beats: [], notes: [] }) }],
    usage: { input_tokens: 4000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  };
  const live = [];
  const sent = { create: null };
  let failPart = null;
  const api = {
    messages: {
      stream: (params) => { live.push(params); return { on: () => {}, finalMessage: async () => answer(params) }; },
      countTokens: async () => ({ input_tokens: 5000 }),
      batches: {
        create: async ({ requests }) => { sent.create = requests; return { id: 'msgbatch_parts', processing_status: 'in_progress',
          request_counts: { processing: requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 } }; },
        retrieve: async () => ({ processing_status: 'ended', request_counts: { processing: 0, succeeded: sent.create.length, errored: 0, canceled: 0, expired: 0 },
          ended_at: new Date().toISOString() }),
        cancel: async () => ({}),
        results: async () => (async function* gen() {
          for (const r of sent.create) {
            yield r.custom_id === failPart ? { custom_id: r.custom_id, result: { type: 'errored', error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } }
              : { custom_id: r.custom_id, result: { type: 'succeeded', message: answer(r.params) } };
          }
        }())
      }
    }
  };
  api.beta = { messages: { stream: api.messages.stream } };
  const c = ct.createCutThrough({ sendWorkerRequest: send, broadcast: () => {}, getPrefs: () => prefs, setPrefs: (patch) => { prefs = { ...prefs, ...patch }; },
    pythonCmd: PY, desktopDir: path.join(TMP, 'desk'), filesDir: FILES, claudeClient: api });
  await c.listMulticams();
  c.select({ mc: 'Webinar', source: 'timeline', label: 'Web1' });
  const prep = (await c.runPrep({})).steps.prep;
  assert.strictEqual(prep.status, 'done', prep.error);
  const run = c.snapshot().files.dir;
  fs.writeFileSync(path.join(run, 'words_Web1.json'), JSON.stringify({ label: 'Web1', multicam: 'Webinar', fps: FPS, frame_sec: [1001, 24000], angles: [], mics: ['Narrator'],
    words: long.words, unheard: [], aligned: true }));
  fs.writeFileSync(path.join(run, 'align_Web1.txt'), 'aligned\n');
  const db = Array(long.frames).fill(-70);
  for (const w of long.words) for (let f = w.s; f <= w.e; f += 1) db[f] = -24;
  fs.writeFileSync(path.join(run, 'levels_Web1.json'), JSON.stringify({ label: 'Web1', frame_sec: FSEC, mics: { Narrator: { start: 0, db } } }));
  const one = await c.setManuscript({ file: null });
  assert.strictEqual(one.videos.videos.length, 1, 'no manuscript = one timeline');

  // live: one call per part, one edit for the chapter
  let snap = await c.planVideos({});
  assert.strictEqual(snap.steps.plan.status, 'done', `${snap.steps.plan.error}\n${snap.steps.plan.log.join('\n')}`);
  const nParts = live.length;
  assert.ok(nParts >= 3, `${nParts} live call(s)`);
  assert.ok(snap.steps.plan.log.some((l) => new RegExp(`in ${nParts} parts`).test(l)), snap.steps.plan.log.join('\n'));
  const edit = JSON.parse(fs.readFileSync(path.join(run, 'claude_edit_Web1__c01.json'), 'utf8'));
  assert.strictEqual(edit.removals.length, nParts);
  const plan = JSON.parse(fs.readFileSync(path.join(run, 'Web1__c01_plan.json'), 'utf8'));
  const kept = (f) => plan.mics.Narrator.some(([a, b]) => a <= f && f < b);
  for (const r of edit.removals) {
    const firstTok = Number(/part from (\d+)/.exec(r.reason)[1]);
    assert.ok(!kept(long.words[firstTok + 1].s) && kept(long.words[firstTok].s), `part from ${firstTok}: removal not placed`);
  }
  const costs = fs.readFileSync(path.join(FILES, 'cut_through_costs.csv'), 'utf8').trim().split('\n').filter((l) => /,solo_plan,/.test(l));
  assert.strictEqual(costs.length, nParts, 'one cost row per part');

  // batch: one request per part, joined on collect
  snap = await c.prepareBatch({});
  assert.strictEqual(snap.videos.batch.items.c01.parts, nParts);
  snap = await c.submitBatch();
  assert.deepStrictEqual(sent.create.map((r) => r.custom_id), Array.from({ length: nParts }, (_, k) => `c01__p${k + 1}`));
  snap = await c.refreshBatch();
  assert.ok(snap.videos.batch.collected, JSON.stringify(snap.videos.batch));
  assert.strictEqual(snap.videos.videos[0].plan.status, 'planned', JSON.stringify(snap.videos.videos[0].plan));
  assert.ok(snap.steps.plan.log.some((l) => new RegExp(`batch, ${nParts} parts`).test(l)), snap.steps.plan.log.join('\n'));
  const edit2 = JSON.parse(fs.readFileSync(path.join(run, 'claude_edit_Web1__c01.json'), 'utf8'));
  assert.strictEqual(edit2.removals.length, nParts);

  // a part that failed fails the chapter (the others are still logged as billed)
  failPart = 'c01__p2';
  const before = fs.readFileSync(path.join(FILES, 'cut_through_costs.csv'), 'utf8').split('\n').filter((l) => /,batch_plan,/.test(l)).length;
  await c.prepareBatch({});
  await c.submitBatch();
  snap = await c.refreshBatch();
  const v = snap.videos.videos[0];
  assert.strictEqual(v.plan.status, 'failed');
  assert.ok(/part 2 of \d+: Batch error: Overloaded/.test(v.plan.error), v.plan.error);
  const after = fs.readFileSync(path.join(FILES, 'cut_through_costs.csv'), 'utf8').split('\n').filter((l) => /,batch_plan,/.test(l)).length;
  assert.strictEqual(after - before, nParts - 1);
  console.log(`✓ engine: a 40-min read with no manuscript plans in ${nParts} parts (live and batch) into one edit + one plan; a failed batch part fails the chapter`);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('narration parts checks passed');
})().catch((err) => {
  console.error(err);
  console.error(`(temp folder kept: ${TMP})`);
  process.exit(1);
});
