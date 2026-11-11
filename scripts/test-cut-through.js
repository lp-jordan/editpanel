/**
 * Cut-through (beta) checks that run without Resolve or a GPU.
 *
 *   node scripts/test-cut-through.js
 *
 * 1. Pure helpers (progress-line parsing, labels, cuts, planner choice).
 * 2. helper/commands/cut_through.py: multicam listing + step exec with print
 *    capture, against a fake Resolve. The REAL cut_through/prepare_multicam.py runs
 *    on it (the fake exports a small synthetic FCPXML).
 * 3. electron/workers/cut_through.js end to end in a temp folder:
 *    prep (fake worker → real day prep) → transcribe (fake transcribe.py
 *    printing the real progress-bar format) → cancel → plan (REAL
 *    place_cuts.py) → build (fake worker reply; the batch needs Resolve).
 * Nothing touches the real Desktop: HOME points at the temp folder.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ct = require('../electron/workers/cut_through');

const REPO = path.join(__dirname, '..');
const PIPELINE = path.join(REPO, 'cut_through');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-test-'));
const HOME = path.join(TMP, 'home');
const DESKTOP = path.join(HOME, 'Desktop');
const FAKE_PIPELINE = path.join(TMP, 'cut_through');
const FILES = path.join(HOME, 'Documents', 'Cut-through');          // run files root (never the real one)
const RUN = (label, name) => path.join(FILES, 'Fake Project', label, name);
fs.mkdirSync(DESKTOP, { recursive: true });
fs.mkdirSync(FAKE_PIPELINE, { recursive: true });

// ── 1. pure helpers ────────────────────────────────────────────
{
  // cost estimate (1.2.144): a line per kind learned from the cost log, else the starting rates
  const est = require('../electron/workers/cut_through_estimate');
  const claudeLib = require('../electron/workers/cut_through_claude');
  const costOf = (m, u) => claudeLib.costOf(m, u);
  const head = 'when,label,step,model,effort,input_tokens,output_tokens,cache_read,cache_write,usd,seconds';
  const rows = est.parseCsv([`${head},minutes,kind`,
    ...[2, 4, 6, 8, 10, 12].map((m, i) => `t,D__v${i},solo_plan,claude-opus-5-5,high,${1000 + 1400 * m},${500 + 1000 * m},0,0,0,1,${m},solo`),
    't,D,slate,claude-opus-5-5,low,9999,9999,0,0,0,1,,',
    `t,OLD__v1,batch_plan,claude-opus-5-5,high,${1000 + 1400 * 5},${500 + 1000 * 5},0,0,0,1`].join('\n'));
  assert.strictEqual(rows[7].minutes, '');
  let looked = 0;
  const rates = est.learnRates(rows, { costOf, effort: 'high', lookup: (label) => { looked += 1; return label === 'OLD__v1' ? { minutes: 5, kind: 'solo' } : null; } });
  assert.strictEqual(looked, 1, 'only the old row is looked up');
  assert.ok(rates.solo.learned && rates.solo.runs === 7, JSON.stringify(rates.solo));
  // usd ≈ (1000·4 + 500·20)/1e6 + m·(1400·4 + 1000·20)/1e6 = 0.014 + 0.0256·m
  assert.ok(Math.abs(rates.solo.fixed - 0.014) < 5e-4 && Math.abs(rates.solo.perMin - 0.0256) < 1e-4, JSON.stringify(rates.solo));   // costOf rounds to 0.001
  assert.ok(!rates.convo.learned && rates.convo.guess && rates.convo.runs === 0);
  const opts = { model: 'claude-opus-5-5', prices: claudeLib.PRICES };
  const e1 = est.estimateCost([{ minutes: 10, kind: 'solo' }, { minutes: 20, kind: 'solo' }], rates, opts);
  assert.deepStrictEqual([e1.live, e1.batch, e1.guess], [0.8, 0.4, false]);       // 2·0.014 + 30·0.0256 = 0.796
  assert.strictEqual(est.estimateCost([{ minutes: 10, kind: 'solo' }], rates, { ...opts, model: 'claude-sonnet-5-5' }).live, 0.14);   // half the price
  assert.ok(est.estimateCost([{ minutes: 10, kind: 'convo' }], rates, opts).guess);
  // too few rows → the starting rates
  assert.deepStrictEqual(est.learnRates(rows.slice(0, 3), { costOf }).solo.fixed, est.START.solo.fixed);
  // transcribe time: the report's read + passes + align over the track minutes (verbatim pass not counted twice)
  const rep = ['Read audio in 136s (camera audio, 1 track(s))', '  Camera 1: 12255 words, 99.0 min in 299s = 19.9x real time (raised 26 dB)',
    '  Camera 1 (verbatim): 12327 words, 99.0 min in 291s = 20.4x real time (raised 26 dB)', 'Aligned 12303 of 12303 words to the audio on cpu in 461s (x)'].join('\n');
  assert.deepStrictEqual(est.transcribeTiming(rep), { seconds: 1187, trackMin: 99 });
  assert.ok(Math.abs(est.transcribeRate([rep, 'junk'], { gpu: false }).secPerTrackMin - 1187 / 99) < 1e-9);
  assert.strictEqual(est.transcribeRate([], { gpu: true }).secPerTrackMin, est.START_TRANSCRIBE.gpu);
  // an old cost log gets the two new columns on its header, rows kept
  const dir = path.join(TMP, 'costlog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cut_through_costs.csv'), `${head}\nt,X,solo_plan,claude-opus-5-5,high,1,1,0,0,0,1\n`);
  claudeLib.logCost({ costsDir: dir, label: 'Y', step: 'solo_plan', model: 'claude-opus-5-5', effort: 'high', usage: { input_tokens: 1, output_tokens: 1 }, minutes: 3.456, kind: 'convo' });
  const csvLines = fs.readFileSync(path.join(dir, 'cut_through_costs.csv'), 'utf8').trim().split('\n');
  assert.ok(csvLines[0].endsWith(',minutes,kind') && csvLines[1] === 't,X,solo_plan,claude-opus-5-5,high,1,1,0,0,0,1' && csvLines[2].endsWith(',3.46,convo'), csvLines.join('\n'));
  // the lookup finds an old row's minutes in its run folder
  fs.mkdirSync(path.join(dir, 'Proj', 'DAY'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Proj', 'DAY', 'videos_DAY.json'), JSON.stringify({ videos: [{ id: 'v02_B', minutes: 7.5, kind: 'convo' }] }));
  assert.deepStrictEqual(est.makeLookup(dir)('DAY__v02_B'), { minutes: 7.5, kind: 'convo' });
  console.log('✓ cost estimate: line per kind from the cost log (old rows looked up), starting rates, other model scaled, transcribe time, old log header upgraded');
}
{
  const p = ct.parseProgress('  Camera 2 [######-------------------]  24%  5.4/22.6 min  41s');
  assert.deepStrictEqual(p, { angle: 'Camera 2', pct: 24, doneMin: 5.4, totalMin: 22.6, seconds: 41 });
  assert.strictEqual(ct.parseProgress('Loading the model on cuda…'), null);
  assert.deepStrictEqual(ct.parseRead('\r  reading 1/3 CAM 1 01.mov  45%  812 MB'), { file: 1, files: 3, name: 'CAM 1 01.mov', pct: 45, mb: 812 });
  assert.strictEqual(ct.parseProgress('  reading 1/3 CAM1_01.mov  45%  812 MB'), null);
  assert.strictEqual(ct.parseProgress('  Camera 3 [#########################] 100%  22.6/22.6 min  180s').pct, 100);
  assert.strictEqual(ct.sanitizeLabel(' Frenzy Q4 / mc_2 '), 'Frenzy_Q4_mc_2');
  // the worker's JSON pipe is UTF-8 even under Windows' cp1252 (a "✗" in a reply killed the Resolve worker)
  const wout = execFileSync(PY, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from helper.worker_runtime import run_worker; ' +
    'run_worker({"x": lambda r: {"t": "\u2717 stopped \u2014 \u2713"}})', REPO],
  { input: '{"id": 1, "cmd": "x"}\n', env: { ...process.env, PYTHONIOENCODING: 'cp1252' } });
  assert.strictEqual(JSON.parse(wout.toString('utf8')).data.t, '✗ stopped — ✓');
  // Plan's From/To: the multicam's timecode, or time from its start (Bill Smith's mc_1 clock)
  const billDay = { frame_sec: [1001, 24000], tc_start_sec: 176475299 / 4000, length_sec: 2699.5, fps: 23.976 };
  assert.strictEqual(ct.frameToTc(0, billDay), '12:14:34:18');
  assert.strictEqual(ct.parseSection(ct.frameToTc(1000, billDay), billDay), 1000);
  assert.strictEqual(ct.parseSection('12:20:00:00', billDay), ct.parseSection('12:20:00', billDay));
  assert.strictEqual(ct.parseSection('12:30', billDay), ct.parseSection('0:12:30', billDay));   // 12 min 30 s in
  assert.strictEqual(ct.parseSection('5', billDay), Math.round(300 / (1001 / 24000)));        // 5 minutes in
  assert.strictEqual(ct.parseSection('', billDay), null);
  assert.throws(() => ct.parseSection('99:00', billDay), /outside the multicam/);
  assert.throws(() => ct.parseSection('abc', billDay), /isn't a time/);
  assert.strictEqual(ct.planKind({ mics: [{ angle: 'Camera 2' }, { angle: 'Camera 2' }] }), 'solo');
  assert.strictEqual(ct.planKind({ mics: [{ angle: 'Camera 2' }, { angle: 'Camera 3' }] }), 'convo');
  assert.strictEqual(ct.dayFrames({ length_sec: 120.12, frame_sec: [1001, 24000] }), 2880);
  const dr = ct.defaultAngleRoles(['Camera 3', 'Camera 1', 'Slate', 'Camera 2', 'Camera 4']);
  assert.deepStrictEqual(dr, { 'Camera 3': 'side', 'Camera 1': 'wide', Slate: 'skip', 'Camera 2': 'closeup', 'Camera 4': 'slider' });
  assert.deepStrictEqual(ct.rolesOf({ ...dr, 'Camera 2': 'side', 'Camera 3': 'closeup' }, Object.keys(dr)),
    { wide: 'Camera 1', punch: 'Camera 3', slider: ['Camera 4'], side: ['Camera 2'], other: [], skip: ['Slate'] });
  assert.strictEqual(ct.defaultAngleRoles(['Angle 2', 'Angle 5'])['Angle 2'], 'wide');   // no Camera 1: the lowest angle is the wide
  console.log('✓ helpers');
}
{
  const { checkTimeline, tcPlus } = require('../electron/workers/cut_through_check');
  assert.strictEqual(tcPlus('01:00:00:00', 24 * 61 + 5, 23.976), '01:01:01:05');
  // source frames at 24 fps; words with aligned times
  const W = (w, s, e) => ({ mic: 'Camera 1', w, s, e, own: true });
  const words = { fps: 24, aligned: true, unheard: [{ mic: 'Camera 1', s: 470, e: 490 }], words: [
    W('So', 10, 20), W('today', 22, 40), W('we', 42, 50), W('talk', 52, 70), W('about', 72, 90), W('pools.', 92, 120),
    W('The', 130, 140), W('the', 142, 150), W('water', 152, 180), W('is', 182, 190), W('warm', 192, 215), W('and', 217, 225),   // removed 130–300 except…
    W('blue', 227, 250), W('today', 252, 270), W('really.', 272, 300),
    W('and', 300, 310), W('clean', 312, 340), W('every', 342, 360), W('single', 362, 380), W('day.', 382, 410),
    W('Say', 440, 450), W('that', 452, 460), W('again.', 462, 468),
    W('Next', 520, 540), W('we', 542, 550), W('dig', 552, 570), W('deep', 572, 600) ] };
  const tl = { name: 'T rough cut', fps: 24, start_frame: 1000, start_tc: '01:00:00:00', pieces: [
    { mc: 'mc', angle: 'Camera 1', start: 1000, end: 1110, src_in: 0, src_out: 110 },
    { mc: 'mc', angle: 'Camera 2', start: 1110, end: 1135, src_in: 110, src_out: 135 },   // angle change only, not a join; cuts "The" (130–140)
    { mc: 'mc', angle: 'Camera 1', start: 1135, end: 1140, src_in: 300, src_out: 305 },   // flash shot
    { mc: 'mc', angle: 'Camera 1', start: 1140, end: 1340, src_in: 305, src_out: 505 },
    { mc: 'mc', angle: 'Camera 1', start: 1340, end: 1420, src_in: 520, src_out: 600 } ] };
  const { markers, data } = checkTimeline({ timeline: tl, words, multicam: 'mc' });
  const at = (name) => markers.filter((m) => m.name.split(' + ').includes(name));
  assert.ok(at('Word cut off').some((m) => m.color === 'Red' && /"The" — end cut by 5 fr/.test(m.note) && m.frame === 135), JSON.stringify(markers));
  assert.ok(at('Cue kept').length === 1 && at('Cue kept')[0].color === 'Red', 'cue');
  assert.ok(at('Sound, no words').length === 1, 'unheard');
  assert.ok(at('Flash shot').length === 1 && at('Flash shot')[0].frame === 135, 'flash');
  assert.ok(at('Ends mid-sentence').length === 1, 'ends mid-sentence ("deep")');
  assert.ok(at('Pause kept').length === 1 && /1\.3 s after "day\."/.test(at('Pause kept')[0].note), JSON.stringify(at('Pause kept')));
  assert.ok(at('Gap at the cut').length === 1 && /1\.5 s/.test(at('Gap at the cut')[0].note), 'gap at the cut');
  assert.strictEqual(data.joins, 2);                                                     // angle changes are not joins
  assert.ok(markers.every((m) => /^01:00:\d\d:\d\d$/.test(m.tc)));
  assert.strictEqual(new Set(markers.map((m) => m.frame)).size, markers.length, 'one marker per frame');
  // a mid-sentence join after a real removal, and a repeat across a cut
  const tl2 = { name: 'T2', fps: 24, start_frame: 0, start_tc: '01:00:00:00', pieces: [
    { mc: 'mc', angle: 'Camera 1', start: 0, end: 226, src_in: 0, src_out: 226 },          // ends "…warm and"
    { mc: 'mc', angle: 'Camera 1', start: 226, end: 340, src_in: 311, src_out: 425 } ] };
  const m2 = checkTimeline({ timeline: tl2, words, multicam: 'mc' }).markers;
  assert.ok(m2.some((m) => m.name.includes('Joins mid-sentence') && /warm and ‖ clean/.test(m.note)), JSON.stringify(m2));
  const tl3 = { name: 'T3', fps: 24, start_frame: 0, start_tc: '01:00:00:00', pieces: [
    { mc: 'mc', angle: 'Camera 1', start: 0, end: 141, src_in: 0, src_out: 141 },
    { mc: 'mc', angle: 'Camera 1', start: 141, end: 300, src_in: 141, src_out: 300 } ] };
  assert.ok(checkTimeline({ timeline: tl3, words, multicam: 'mc' }).markers.some((m) => m.name.includes('Repeated word') && m.color === 'Purple' && /"The the"/.test(m.note)));
  console.log('✓ check: word cut off, cue kept, sound with no words, flash shot, pauses, mid-sentence join, repeats, one marker per frame');
}

// ── energy hints + energy check (on trial) ─────────────────────
{
  const { energyModel, energyLabel, rhythmStats, spearman } = require('../electron/workers/cut_through_energy');
  const { renderTranscript } = require('../electron/workers/cut_through_claude');
  // 60 s calm (2 words/s, -30 dB), 60 s fast + loud (4 words/s, -22 dB), 60 s calm again, at 24 fps
  const ws = [];
  let f = 0;
  for (const [sec, rate, db] of [[60, 2, -30], [60, 4, -22], [60, 2, -30]]) {
    const step = 24 / rate;
    for (let k = 0; k < sec * rate; k++) { ws.push({ mic: 'Camera 1', w: 'word', s: f, e: f + step * 0.8, db }); f += step; }
  }
  const em = energyModel(ws, 1 / 24);
  assert.strictEqual(energyLabel(em.at(30 * 24)), 'normal');
  assert.strictEqual(energyLabel(em.at(90 * 24)), 'fast · loud');
  const tokens = ws.map((w) => ({ kind: 'w', s: w.s, e: w.e, text: w.w, who: w.mic }));
  for (let i = 0; i < tokens.length; i += 9) tokens[i].s += 0;
  // lines need breaks: put a 0.7 s gap every 8 words
  let shift = 0;
  const spaced = tokens.map((t, i) => { if (i && i % 8 === 0) shift += 17; return { ...t, s: t.s + shift, e: t.e + shift }; });
  const em2 = energyModel(spaced.map((t) => ({ mic: t.who, w: t.text, s: t.s, e: t.e, db: ws[0].db })), 1 / 24);
  const tx = renderTranscript(spaced, 1 / 24, null, em2);
  assert.ok(/⟨energy: normal⟩/.test(tx) && /⟨energy: fast⟩/.test(tx), tx.slice(0, 400));
  assert.ok(!/⟨energy/.test(renderTranscript(spaced, 1 / 24)), 'hints only with a model');
  assert.ok((tx.match(/⟨energy/g) || []).length <= 6, 'hints only on a change');
  // a cut that follows the energy: short shots in the fast stretch → negative ρ
  const pieces = [];
  for (let a = 0; a < f;) { const len = a > 60 * 24 && a < 120 * 24 ? 72 : 216; pieces.push({ src_in: a, src_out: Math.min(f, a + len) }); a += len; }
  const r = rhythmStats(pieces, em, 24);
  assert.ok(r.rhoPace < -0.5 && r.byPace.fast.medianSec < r.byPace.normal.medianSec, JSON.stringify({ rho: r.rhoPace, by: r.byPace }));
  assert.strictEqual(spearman([1, 2, 3], [3, 2, 1]), null);
  console.log('✓ energy: pace / level against the talker\'s own usual, transcript hints on a change only, Compare ρ for a cut that follows it');
}

// ── fakes ──────────────────────────────────────────────────────
const FAKE_RESOLVE = String.raw`
import os
XML = '''<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10"><resources>
<format id="r1" frameDuration="1001/24000s" width="1920" height="1080"/>
<asset id="a1" name="CAM1.mov" hasVideo="1" hasAudio="1"><media-rep src="file://localhost/x/CAM1.mov"/></asset>
<asset id="w2" name="02MIC2.WAV" hasAudio="1" audioChannels="1"><media-rep src="file://localhost/x/02MIC2.WAV"/></asset>
<asset id="w3" name="03MIC3.WAV" hasAudio="1" audioChannels="1"><media-rep src="file://localhost/x/03MIC3.WAV"/></asset>
<media id="m1" name="mc_test"><multicam format="r1" tcStart="0s">
<mc-angle name="Camera 1" angleID="1"><asset-clip ref="a1" offset="0s" duration="120120/1000s" start="0s"/></mc-angle>
<mc-angle name="Camera 2" angleID="2"><asset-clip ref="a1" offset="0s" duration="120120/1000s"/><asset-clip ref="w2" offset="0s" duration="120120/1000s" start="0s"/></mc-angle>
<mc-angle name="Camera 3" angleID="3"><asset-clip ref="a1" offset="0s" duration="120120/1000s"/><asset-clip ref="w3" offset="0s" duration="120120/1000s" start="1s"/></mc-angle>
</multicam></media></resources><library/></fcpxml>'''

XML_CAM = '''<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10"><resources>
<format id="r1" frameDuration="1001/24000s" width="1920" height="1080"/>
<asset id="a1" name="CAM1_01.mov" start="35400s" duration="70s" hasVideo="1" hasAudio="1" audioChannels="2"><media-rep src="file://localhost/x/CAM1_01.mov"/></asset>
<asset id="a2" name="CAM1_02.mov" start="36000s" duration="60s" hasVideo="1" hasAudio="1" audioChannels="2"><media-rep src="file://localhost/x/CAM1_02.mov"/></asset>
<asset id="a3" name="CAM2_01.mov" start="35400s" duration="120s" hasVideo="1" hasAudio="1" audioChannels="2"><media-rep src="file://localhost/x/CAM2_01.mov"/></asset>
<asset id="a4" name="CAM3_01.mov" start="35400s" duration="120s" hasVideo="1" hasAudio="0"><media-rep src="file://localhost/x/CAM3_01.mov"/></asset>
<media id="m1" name="mc_test"><multicam format="r1" tcStart="35400s">
<mc-angle name="Camera 1" angleID="1"><asset-clip ref="a1" offset="0s" duration="60s" start="35410s"/><asset-clip ref="a2" offset="60s" duration="60s" start="36000s"/></mc-angle>
<mc-angle name="Camera 2" angleID="2"><clip offset="0s" duration="120s" start="0s"><video ref="a3" offset="0s" duration="120s" start="35400s"/><audio ref="a3" offset="0s" duration="120s" start="35400s"/></clip></mc-angle>
<mc-angle name="Camera 3" angleID="3"><asset-clip ref="a4" offset="0s" duration="120s" start="35400s"/></mc-angle>
</multicam></media></resources><library/></fcpxml>'''
if os.environ.get("CT_FAKE_XML") == "cam":
    XML = XML_CAM

class Clip:
    def __init__(self, name, typ): self.name, self.typ = name, typ
    def GetName(self): return self.name
    def GetClipProperty(self, k): return self.typ if k == "Type" else ""
class Folder:
    def __init__(self, name, clips=(), subs=()): self.name, self.clips, self.subs = name, list(clips), list(subs)
    def GetName(self): return self.name
    def GetClipList(self): return self.clips
    def GetSubFolderList(self): return self.subs
class Timeline:
    def __init__(self, name): self.name = name
    def GetName(self): return self.name
    def Export(self, path, etype):
        with open(path, "w", encoding="utf-8") as fh: fh.write(XML)
        return True
class Pool:
    def __init__(self, project): self.project = project
    def GetRootFolder(self): return self.project.root
    def CreateTimelineFromClips(self, name, clips):
        t = Timeline(name); self.project.timelines.append(t); return t
    def DeleteTimelines(self, tls):
        for t in tls: self.project.timelines.remove(t)
        return True
class Project:
    def __init__(self):
        self.timelines = [Timeline("existing")]
        self.root = Folder("Master", [Clip("CAM1.mov", "Video + Audio")], [
            Folder("MC", [Clip("mc_test", "Multicam")]),
            Folder("MC ORIGINAL", [Clip("mc_old", "Multicam")]),
        ])
    def GetName(self): return "Fake Project"
    def GetMediaPool(self): return Pool(self)
    def GetTimelineCount(self): return len(self.timelines)
    def GetTimelineByIndex(self, i): return self.timelines[i - 1]
    def SetCurrentTimeline(self, t): return True
class PM:
    def __init__(self): self.p = Project()
    def GetCurrentProject(self): return self.p
class Resolve:
    EXPORT_FCPXML_1_10 = 10
    def __init__(self): self.pm = PM()
    def GetProjectManager(self): return self.pm
    def GetVersionString(self): return "fake 21"
`;

// Prints exactly what transcribe.py prints, writes plausible outputs.
const FAKE_TRANSCRIBE = String.raw`
import json, os, sys, time
args = [a for a in sys.argv[1:] if "=" not in a]
opts = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
label, desk = args[0], opts["dir"]
slow = os.environ.get("CT_FAKE_SLOW") == "1"
if opts.get("align_only") == "1":
    # the fixture's word times are already exact: say so (the real one moves s/e onto the audio)
    print("Aligning words to the audio…", flush=True)
    print("Aligning words to the audio 50%…", flush=True)
    open(os.path.join(desk, f"align_{label}.txt"), "w").write("Aligned (fake)\n")
    sys.exit(0)
if opts.get("levels_only") == "1":
    import math
    fs = 1001 / 24000
    day = json.load(open(os.path.join(desk, f"day_{label}.json"), encoding="utf-8"))
    data = json.load(open(os.path.join(desk, f"words_{label}.json"), encoding="utf-8"))
    n = int(day["length_sec"] / fs) + 1
    tracks = {}
    for mic in data["mics"]:
        db = [-60] * n
        ws = sorted((w for w in data["words"] if w["mic"] == mic and w.get("own", True)), key=lambda w: w["s"])
        for k, w in enumerate(ws):
            hi = math.ceil(w["e"]) + 4
            if k + 1 < len(ws):
                hi = min(hi, int(ws[k + 1]["s"]) - 1)
            for f in range(int(w["s"]), min(n, max(hi, int(w["s"]) + 1))):
                db[f] = -20
        for u in data.get("unheard") or []:
            if u.get("mic") == mic:
                for f in range(int(u["s"]), min(n, math.ceil(u["e"]))):
                    db[f] = -22
        tracks[mic] = {"start": 0, "db": db}
    print(f"\r  reading 1/1 CAM1.mov 100%  9 MB", flush=True)
    json.dump({"label": label, "frame_sec": fs, "mics": tracks}, open(os.path.join(desk, f"levels_{label}.json"), "w"))
    sys.exit(0)
if os.environ.get("CT_FAKE_FAIL") == "1":
    print("Reading 2 audio file(s)…", flush=True)
    raise ModuleNotFoundError("No module named 'av'")
day = json.load(open(os.path.join(desk, f"day_{label}.json"), encoding="utf-8"))
print(f"Reading {len(day['mics'])} mic file(s)…", flush=True)
for i, m in enumerate(day["mics"], 1):
    for pct in (30, 60, 100):
        print(f"\r  reading {i}/{len(day['mics'])} {m['name']} {pct:3d}%  {pct * 9:.0f} MB", end="\n" if pct == 100 else "", flush=True)
        time.sleep(0.6 if slow else 0.01)
print("Loading the model on cuda…", flush=True)
words = []
for m in day["mics"]:
    print(f"Finding speech in {m['angle']} (2.0 min)…", flush=True)
    total = (m["to_sec"] - m["from_sec"]) / 60
    for k in range(1, 5):
        pct = 25 * k
        bar = "#" * (pct // 4) + "-" * (25 - pct // 4)
        print(f"\r  {m['angle']} [{bar}] {pct:3d}%  {total * k / 4:.1f}/{total:.1f} min  {k}s", end="", flush=True)
        time.sleep(1.0 if slow else 0.02)
    print(flush=True)
# two people alternating 10 s turns, 24000/1001 fps frames
fps = 24000 / 1001
t, who = 0.5, 0
while t < 118:
    mic = ["Camera 2", "Camera 3"][who]
    for i in range(16):
        s = (t + i * 0.55) * fps
        words.append({"mic": mic, "w": f"word{i}", "s": round(s, 1), "e": round(s + 10, 1), "p": 0.9,
                      "db": -20, "other_db": -40, "own": True, "clear": True})
    t += 11 if who == 0 else 9
    who = 1 - who
# the listener says "yeah" over the talker (a backchannel: opened quieter, not closed)
words.append({"mic": "Camera 3", "w": "yeah", "s": round(4.0 * fps, 1), "e": round(4.0 * fps + 8, 1), "p": 0.9,
              "db": -20, "other_db": -40, "own": True, "clear": True})
words.sort(key=lambda w: w["s"])
json.dump({"label": label, "multicam": day["multicam"], "fps": day["fps"], "frame_sec": day["frame_sec"],
           "angles": day["angles"], "mics": ["Camera 2", "Camera 3"], "words": words},
          open(os.path.join(desk, f"words_{label}.json"), "w", encoding="utf-8"))
open(os.path.join(desk, f"transcribe_{label}.txt"), "w", encoding="utf-8").write(f"Transcribe {label} — fake\n{len(words)} words\n")
print(f"{len(words)} words")
`;

fs.writeFileSync(path.join(TMP, 'fake_resolve.py'), FAKE_RESOLVE);
fs.writeFileSync(path.join(FAKE_PIPELINE, 'transcribe.py'), FAKE_TRANSCRIBE);
for (const f of ['prepare_multicam.py', 'place_cuts.py']) fs.copyFileSync(path.join(PIPELINE, f), path.join(FAKE_PIPELINE, f));
fs.mkdirSync(path.join(FAKE_PIPELINE, 'editor_briefs'));
for (const f of ['solo.md', 'conversation.md']) fs.copyFileSync(path.join(PIPELINE, 'editor_briefs', f), path.join(FAKE_PIPELINE, 'editor_briefs', f));

/** A scripted solo take: count retake, repeat retake, stutter, long pause, a callback that stays. */
function scriptedTake() {
  const fps = 24000 / 1001;
  const words = [];
  let t = 2.0;
  const say = (text, gap) => {
    for (const w of text.split(' ')) {
      words.push({ mic: 'Camera 1', w, s: +(t * fps).toFixed(1), e: +((t + 0.35) * fps).toFixed(1), p: 0.9, db: -20, other_db: -120, own: true, clear: true });
      t += 0.4;
    }
    t += gap;
  };
  say('Leadership starts with listening to your team every single day.', 3.0);
  say('The best managers build trust through small consistent actions and', 0.4);
  say('one, two, three.', 1.0);
  say('The best managers build trust through small consistent actions over time.', 0.5);
  say('When you you ask questions people feel heard.', 0.6);
  say('Feedback should be specific and timely so people', 1.2);
  say('Feedback should be specific and timely so that people can act on it.', 0.5);
  say('We talked about culture and how culture changes when leaders listen.', 0.5);
  say('That is how culture changes.', 2.0);
  return { words, fps, seconds: t + 5 };
}
const CLEAN = 'Leadership starts with listening to your team every single day. The best managers build trust through small consistent actions over time. ' +
  'When you ask questions people feel heard. Feedback should be specific and timely so that people can act on it. ' +
  'We talked about culture and how culture changes when leaders listen. That is how culture changes.';

// The batch needs Resolve for real; the worker side is faked below, so a
// placeholder is enough for the allow-list path check.
// It prints the folder it finds its sibling scripts in (the real build takes it from __file__).
fs.writeFileSync(path.join(FAKE_PIPELINE, 'build_rough_cut.py'), 'import os\n_lines = []\nprint("pipeline", os.path.dirname(os.path.abspath(__file__)))\n_lines.append("✗ STOPPED after 0.1s: fake")\n');

const PY_ENV = { ...process.env, HOME, USERPROFILE: HOME, PYTHONPATH: `${REPO}${path.delimiter}${TMP}`, PYTHONIOENCODING: 'utf-8' };

// ── 2. Python side ─────────────────────────────────────────────
{
  const out = execFileSync(PY, ['-c', String.raw`
import json, builtins
from fake_resolve import Resolve
from helper.commands.cut_through import list_multicams, run_step
r = Resolve()
mcs = list_multicams(r.GetProjectManager().GetCurrentProject().GetMediaPool().GetRootFolder())
events = []
real_print = builtins.print
res = run_step(${JSON.stringify(path.join(FAKE_PIPELINE, 'prepare_multicam.py'))}, {"LABEL": "PyT", "MC": "mc_test"}, r, events.append)
assert builtins.print is real_print
bat = run_step(${JSON.stringify(path.join(FAKE_PIPELINE, 'build_rough_cut.py'))}, {"LABEL": "PyT"}, r, events.append)
print(json.dumps({"mcs": mcs, "res": res, "bat": bat, "events": events}))
`], { env: PY_ENV, encoding: 'utf8' });
  const lines = out.trim().split('\n');
  assert.strictEqual(lines.length, 1, `step prints leaked to stdout:\n${out}`);
  const r = JSON.parse(lines[0]);
  assert.deepStrictEqual(r.mcs, [{ name: 'mc_test', bin: 'MC', duplicate: false }]);
  assert.strictEqual(r.res.error, null, r.res.lines.join('\n'));
  assert.ok(r.res.lines.some((l) => l.includes("Multicam 'mc_test'")), r.res.lines.join('\n'));
  assert.ok(r.events.some((l) => l.includes('audio clip 02MIC2.WAV under Camera 2')));
  assert.ok(r.events.includes(`pipeline ${path.resolve(FAKE_PIPELINE)}`), 'step run without __file__ (the build finds its pipeline folder from it)');
  assert.ok(r.events.some((e) => /^▸ Reading mc_test's layout from Resolve$/.test(e)) && !r.res.lines.some((l) => l.startsWith('▸')), 'phase line missing, or in the report');
  assert.ok(r.bat.stopped && r.bat.error.startsWith('✗ STOPPED'));
  const day = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'day_PyT.json'), 'utf8'));
  assert.deepStrictEqual(day.mics.map((m) => m.angle), ['Camera 2', 'Camera 3']);
  assert.strictEqual(day.mics[1].file_zero_sec, -1);
  // every angle's picture clips are listed (for reading the slider's movement)
  assert.ok(Array.isArray(day.picture_clips) && day.picture_clips.length && day.picture_clips.every((c) => c.angle && c.path && c.to_sec > c.from_sec),
    JSON.stringify(day.picture_clips));
  console.log('✓ python: multicam list, step exec + print capture, real day prep on a fake Resolve');
}

// ── 2b. day with no mic WAVs: camera audio (ATEM mix / in-camera, track 1) ──
{
  const out = execFileSync(PY, ['-c', String.raw`
import json
from fake_resolve import Resolve
from helper.commands.cut_through import run_step
p = ${JSON.stringify(path.join(FAKE_PIPELINE, 'prepare_multicam.py'))}
a = run_step(p, {"LABEL": "Cam1", "MC": "mc_test"}, Resolve(), lambda l: None)
b = run_step(p, {"LABEL": "Cam2", "MC": "mc_test", "AUDIO_ANGLE": "Camera 2"}, Resolve(), lambda l: None)
c = run_step(p, {"LABEL": "Cam3", "MC": "mc_test", "AUDIO_ANGLE": "Camera 3"}, Resolve(), lambda l: None)
print(json.dumps([a, b, c]))
`], { env: { ...PY_ENV, CT_FAKE_XML: 'cam' }, encoding: 'utf8' });
  const [a, b, c] = JSON.parse(out.trim());
  assert.strictEqual(a.error, null, a.lines.join('\n'));
  const d1 = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'day_Cam1.json'), 'utf8'));
  assert.strictEqual(d1.audio_source, 'camera');
  assert.strictEqual(d1.wav_mics, 0);
  assert.deepStrictEqual(d1.camera_audio_angles, ['Camera 1', 'Camera 2']);
  assert.deepStrictEqual(d1.mics.map((m) => [m.angle, m.file_zero_sec, m.from_sec, m.to_sec]),
    [['Camera 1', -10, 0, 60], ['Camera 1', 60, 60, 120]]);
  assert.strictEqual(b.error, null, b.lines.join('\n'));
  const d2 = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'day_Cam2.json'), 'utf8'));
  assert.deepStrictEqual(d2.mics.map((m) => [m.angle, m.file_zero_sec]), [['Camera 2', 0]]);   // <clip> = one source
  assert.ok(c.error && /no camera audio on Camera 3/.test(c.error), c.error);
  console.log('✓ python: no mic WAVs → Camera 1 camera audio (TOD timecode), AUDIO_ANGLE pick, angle without audio refused');
}

// ── 2c. the real transcribe.py on that day, Whisper/PyAV stubbed ──
// Needs numpy: CT_TEST_PYTHON=<python with numpy> (skipped otherwise).
if (process.env.CT_TEST_PYTHON) {
  const STUBS = path.join(TMP, 'stubs');
  fs.mkdirSync(path.join(STUBS, 'faster_whisper'), { recursive: true });
  fs.writeFileSync(path.join(STUBS, 'ctranslate2.py'), 'def get_cuda_device_count():\n    return 0\n');
  // faster-whisper's decode_audio breaks on LP1's newer PyAV (metadata_errors=…): must not be used
  fs.writeFileSync(path.join(STUBS, 'faster_whisper', 'audio.py'),
    'def decode_audio(*a, **k):\n    raise TypeError("open() got an unexpected keyword argument \'metadata_errors\'")\n');
  // new-style PyAV: open() without metadata_errors, resample() returns a list
  fs.writeFileSync(path.join(STUBS, 'av.py'), String.raw`
import numpy as np
class _Frame:
    def __init__(self, x, t): self.x, self.pts, self.time = x, 0, t
    def to_ndarray(self): return self.x.reshape(1, -1)
class AudioResampler:
    def __init__(self, format, layout, rate): assert (format, layout, rate) == ("s16", "mono", 16000)
    def resample(self, f): return [] if f is None else [f]
class _Stream:
    duration, time_base = 70, 1
class _Streams:
    audio = [_Stream()]
DECODED = []
class _Container:
    def __init__(self, path): self.path, self.streams = path, _Streams()
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def decode(self, stream):
        # 70 s file: a loud burst at file second 20 (CAM1_01) / 5 (CAM1_02), quiet elsewhere
        x = np.full(70 * 16000, 33, np.int16)
        at = 20 if "CAM1_01" in self.path else 5
        x[at * 16000:(at + 1) * 16000] = 3277
        for i in range(0, len(x), 16000):
            DECODED.append((self.path, i // 16000))
            yield _Frame(x[i:i + 16000], i / 16000)
def open(path, mode="r"):
    return _Container(path)
`);
  fs.writeFileSync(path.join(STUBS, 'faster_whisper', '__init__.py'), String.raw`
import numpy as np
class _W:
    def __init__(self, s, e, w): self.start, self.end, self.word, self.probability = s, e, w, 0.9
class _S:
    def __init__(self, s, e, words): self.start, self.end, self.words = s, e, words
class WhisperModel:
    def __init__(self, *a, **k): pass
    def transcribe(self, clip, **k):
        # a "word" wherever the clip is loud (seconds from the clip's start)
        loud = np.flatnonzero(np.abs(clip) > 0.5)
        secs = sorted({int(i // 16000) for i in loud})
        if k.get("initial_prompt"):
            return [_S(s, s + 1, [_W(s, s + 0.5, f"w{s}"), _W(s + 0.6, s + 0.8, "uh")]) for s in secs], None
        return [_S(s, s + 1, [_W(s, s + 0.5, f"w{s}")]) for s in secs], None
`);
  const out = execFileSync(process.env.CT_TEST_PYTHON, [path.join(PIPELINE, 'transcribe.py'), 'Cam1', `dir=${DESKTOP}`],
    { env: { ...PY_ENV, PYTHONPATH: STUBS }, encoding: 'utf8' });
  const words = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'words_Cam1.json'), 'utf8'));
  assert.deepStrictEqual(words.mics, ['Camera 1'], out);
  // CAM1_01 burst at file 20 s → multicam 10 s; CAM1_02 burst at file 5 s → multicam 65 s
  const fps = 24000 / 1001;
  assert.deepStrictEqual(words.words.map((w) => Math.round(w.s / fps)), [10, 65], JSON.stringify(words.words));
  assert.ok(words.words.every((w) => w.own));
  assert.ok(/camera audio, 1 track/.test(fs.readFileSync(path.join(DESKTOP, 'transcribe_Cam1.txt'), 'utf8')));
  assert.ok(/reading 1\/2 CAM1_01\.mov 100%/.test(out) && /Finding speech in Camera 1 \(2\.0 min\)…/.test(out), out);
  assert.ok(fs.existsSync(path.join(DESKTOP, 'levels_Cam1.json')), 'no levels file');
  // verbatim=1: the second pass adds only what the clean pass missed (the "uh"s), marked v
  const vout = execFileSync(process.env.CT_TEST_PYTHON, [path.join(PIPELINE, 'transcribe.py'), 'Cam1', `dir=${DESKTOP}`, 'verbatim=1'],
    { env: { ...PY_ENV, PYTHONPATH: STUBS }, encoding: 'utf8' });
  const vw = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'words_Cam1.json'), 'utf8')).words;
  assert.deepStrictEqual(vw.map((w) => `${w.w}${w.v ? '*' : ''}`), ['w10', 'uh*', 'w65', 'uh*'], vout);
  assert.ok(/Camera 1 \(verbatim\) \[/.test(vout) && /verbatim pass added 2 word/.test(fs.readFileSync(path.join(DESKTOP, 'transcribe_Cam1.txt'), 'utf8')));
  // quick test (minutes=0.5 → first 30 s of the multicam): stops reading CAM1_01 early, skips CAM1_02
  const q = execFileSync(process.env.CT_TEST_PYTHON, ['-c', [
    'import sys, runpy, av',
    `sys.argv = ["transcribe.py", "Cam1", ${JSON.stringify('dir=' + DESKTOP)}, "minutes=0.5"]`,
    `runpy.run_path(${JSON.stringify(path.join(PIPELINE, 'transcribe.py'))}, run_name="__main__")`,
    'print("DECODED", max(t for p, t in av.DECODED if "CAM1_01" in p), sum(1 for p, t in av.DECODED if "CAM1_02" in p))'
  ].join('\n')], { env: { ...PY_ENV, PYTHONPATH: STUBS }, encoding: 'utf8' });
  const dec = /DECODED (\d+) (\d+)/.exec(q);
  assert.ok(dec && Number(dec[1]) <= 42 && Number(dec[2]) === 0, q);   // file 10 s + 30 s window + 1 s margin
  console.log('✓ transcribe.py: camera clips on one angle → one track on the multicam clock');
  // ffmpeg fallback on a real file (needs an ffmpeg binary; EditPanel passes its bundled one)
  let ffmpeg = null;
  try { ffmpeg = require('ffmpeg-static'); } catch (_) {}
  if (ffmpeg && fs.existsSync(ffmpeg)) {
    const mov = path.join(TMP, 'tone.mov');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2', '-shortest', '-ac', '2', mov]);
    const n = execFileSync(process.env.CT_TEST_PYTHON, ['-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(PIPELINE)}); import transcribe as t; x = t.decode_ffmpeg(${JSON.stringify(mov)}); print(len(x), round(float(abs(x).max()), 2))`],
      { env: { ...PY_ENV, FFMPEG_PATH: ffmpeg }, encoding: 'utf8' }).trim().split(' ');
    assert.ok(Math.abs(Number(n[0]) - 32000) < 400 && Number(n[1]) > 0.05, n.join(' '));
    console.log('✓ transcribe.py: ffmpeg fallback decodes a real camera-style file (first track, 16 kHz mono)');
  }
  // loud stretches with no words (dropped flubs) — what Claude sees as ⟨unheard speech⟩
  const uh = execFileSync(process.env.CT_TEST_PYTHON, ['-c', [
    'import sys, math, numpy as np', `sys.path.insert(0, ${JSON.stringify(PIPELINE)})`, 'import transcribe as t',
    'SR = 16000; fs = 1001 / 24000; rng = np.random.default_rng(1)',
    'x = (rng.standard_normal(10 * SR) * 0.001).astype(np.float32)',
    'x[1 * SR:3 * SR] = rng.standard_normal(2 * SR) * 0.1',
    'x[5 * SR:int(5.8 * SR)] = rng.standard_normal(int(0.8 * SR)) * 0.08',
    'x[8 * SR:int(8.15 * SR)] = rng.standard_normal(int(0.15 * SR)) * 0.1',
    'words = []',
    'for k in range(10):',
    '    a = 1 + k * 0.2; seg = x[int(a * SR):int((a + 0.18) * SR)]',
    '    words.append({"mic": "Camera 1", "s": a / fs, "e": (a + 0.18) / fs, "own": True, "db": 20 * math.log10(float(np.sqrt(np.mean(seg.astype(np.float64) ** 2))) + 1e-9)})',
    'u = t.unheard_speech({"angle": "Camera 1", "audio": x, "lo": 0, "hi": len(x), "gain": 1.0}, words, fs)',
    'print(" ".join(f"{v[\'s\'] * fs:.2f}-{v[\'e\'] * fs:.2f}" for v in u))'
  ].join('\n')], { encoding: 'utf8' }).trim();
  assert.strictEqual(uh, '5.00-5.80', uh);
  console.log('✓ transcribe.py: finds a 0.8 s mutter with no words, ignores a 150 ms click');
  // a word Whisper stretched over a dropped stumble is clipped where the audio goes quiet (Z8)
  const sw = execFileSync(process.env.CT_TEST_PYTHON, ['-c', [
    'import sys, numpy as np', `sys.path.insert(0, ${JSON.stringify(PIPELINE)})`, 'import transcribe as t',
    'SR = 16000; fs = 1001 / 24000; rng = np.random.default_rng(2)',
    'x = (rng.standard_normal(8 * SR) * 0.001).astype(np.float32)',
    'x[int(1.0 * SR):int(1.4 * SR)] = rng.standard_normal(int(0.4 * SR)) * 0.1',
    'x[int(2.2 * SR):int(2.8 * SR)] = rng.standard_normal(int(0.6 * SR)) * 0.1',
    'm = {"angle": "Camera 1", "audio": x, "lo": 0, "hi": len(x), "gain": 1.0}',
    'words = [{"mic": "Camera 1", "w": "produced.", "s": 1.0 / fs, "e": 3.0 / fs, "own": True, "db": -20}]',
    'for k in range(12):',
    '    a = 4 + k * 0.2; x[int(a * SR):int((a + 0.15) * SR)] = rng.standard_normal(int(0.15 * SR)) * 0.1',
    '    words.append({"mic": "Camera 1", "w": "x", "s": a / fs, "e": (a + 0.15) / fs, "own": True, "db": -20})',
    'n = t.clip_stretched(words, m, fs); u = t.unheard_speech(m, words, fs)',
    'print(n, f"{words[0][\'e\'] * fs:.2f}", " ".join(f"{v[\'s\'] * fs:.2f}-{v[\'e\'] * fs:.2f}" for v in u))'
  ].join('\n')], { encoding: 'utf8' }).trim().split(' ');
  assert.ok(sw[0] === '1' && Number(sw[1]) > 1.35 && Number(sw[1]) < 1.55 && sw[2] === '2.20-2.80', sw.join(' '));
  console.log('✓ transcribe.py: verbatim pass adds only the missed words; a stretched word is clipped and the stumble it hid surfaces');
} else {
  console.log('- transcribe.py check skipped (set CT_TEST_PYTHON to a Python with numpy)');
}

// ── 2d. place_cuts.py on a scripted take: Claude's removals (two retakes, a stutter), no shot list ──
{
  const { words, fps, seconds: t } = scriptedTake();
  const angles = ['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4'];
  const wp = path.join(TMP, 'solo_words.json'), dp = path.join(TMP, 'solo_day.json'), pp = path.join(TMP, 'solo_plan.json');
  const rp = path.join(TMP, 'removals_solo.json');
  fs.writeFileSync(wp, JSON.stringify({ label: 'SoloT', multicam: 'mc_x', fps, frame_sec: [1001, 24000], angles, mics: ['Camera 1'], words }));
  fs.writeFileSync(dp, JSON.stringify({ multicam: 'mc_x', fps, frame_sec: [1001, 24000], length_sec: t + 5, angles, audio_source: 'camera', mics: [{ angle: 'Camera 1' }] }));
  // Claude's edit as word ranges [first, last] → frame spans (~6 fr after the kept word before,
  // ~5 fr before the kept word after); no shots, so the picture is the rule rhythm
  const nth = (w, n = 0) => words.map((x, k) => [x.w, k]).filter(([x]) => x === w)[n][1];
  const start = Math.floor(words[0].s) - 18, end = Math.floor(words[words.length - 1].e) + 24;
  const span = (i, j, why) => {
    const a = Math.floor(words[i - 1].e + Math.min(6, Math.max(0, words[i].s - words[i - 1].e)));
    const n = words[j + 1];
    const b = Math.min(Math.ceil(n.s - Math.min(5, Math.max(0, n.s - words[j].e))), Math.floor(n.s));
    return { from: a, to: Math.max(a, b), why };
  };
  fs.writeFileSync(rp, JSON.stringify({ start, end, review: [], removals: [
    span(nth('The'), nth('three.'), 'retake'), span(nth('you'), nth('you'), 'false_start'),
    span(nth('Feedback'), nth('people', 1), 'retake')] }));
  const out = execFileSync(PY, [path.join(PIPELINE, 'place_cuts.py'), wp, dp, pp, 'extra=Camera 4', `removals=${rp}`], { encoding: 'utf8' });
  const plan = JSON.parse(fs.readFileSync(pp, 'utf8'));
  const cut = (f) => plan.removals.some((r) => r.from <= f && f < r.to);
  const kept = words.filter((w) => !cut(w.s)).map((w) => w.w).join(' ');
  assert.strictEqual(kept, CLEAN, out);
  assert.ok(words.every((w) => cut(w.s) === cut(w.e - 0.5)), 'a word is cut in half');
  const v = plan.video;
  assert.strictEqual(v[0].angle, 'Camera 1');
  assert.strictEqual(v[v.length - 1].angle, 'Camera 1');
  assert.deepStrictEqual([v[0].why, v[v.length - 1].why], ['open on the wide', 'close on the wide']);   // the rule rhythm
  assert.ok(v.every((x, k) => k === 0 || x.angle !== v[k - 1].angle), 'jump cut');
  assert.deepStrictEqual(plan.audio, { source: 'camera', angle: 'Camera 1' });
  assert.deepStrictEqual(plan.mics, {});
  assert.ok(!JSON.stringify(plan).includes('managers'), 'words leaked into the plan');
  // a camera's own audio on its own track under the picture (Bill Smith mc_1): camera audio, kept in the copy
  const sep = JSON.parse(execFileSync(PY, ['-c', String.raw`
import json, re, sys, io, contextlib
sys.path.insert(0, sys.argv[1])
with contextlib.redirect_stdout(io.StringIO()):
    import write_timeline_xml as m
res = '''<resources><media name="mc" id="r5"><multicam tcStart="0/1s"><mc-angle name="Angle 1" angleID="a1">
<clip offset="0/1s" duration="10/1s" start="100/1s"><video offset="100/1s" duration="10/1s" start="100/1s" ref="r2"/></clip>
<clip offset="0/1s" duration="10/1s" start="100/1s"><audio offset="100/1s" duration="10/1s" start="100/1s" ref="r4"/></clip>
</mc-angle><mc-angle name="Angle 2" angleID="a2">
<clip offset="0/1s" duration="10/1s" start="100/1s"><video offset="100/1s" duration="10/1s" start="100/1s" ref="r6"/></clip>
</mc-angle></multicam></media>
<asset hasVideo="1" hasAudio="1" id="r2" start="100/1s"><media-rep src="file://localhost/N:/cam.MXF" kind="original-media"/></asset>
<asset hasAudio="1" id="r4" start="100/1s"><media-rep src="file://localhost/N:/cam.MXF" kind="original-media"/></asset>
<asset hasVideo="1" hasAudio="1" id="r6" start="100/1s"><media-rep src="file://localhost/N:/cam.MXF" kind="original-media"/></asset></resources>'''
refs = m.camera_audio_refs(res)
blk = re.findall(r"<media [^>]*>\s*<multicam .*?</media>", res, re.S)[0]
folded_xml, folded = m.fold_camera_audio(blk, refs)
fixed, wavs = m.split_off_angle_tracks(folded_xml, keep_refs=set(refs))
inside = re.search(r'<video [^>]*ref="r2"[^>]*>\s*<audio [^>]*ref="r2"', fixed) is not None
print(json.dumps({"refs": {k: sorted(v) for k, v in refs.items()}, "folded": sorted(folded), "inside": inside, "r4_left": 'ref="r4"' in fixed, "wavs": len(wavs)}))
`, PIPELINE], { encoding: 'utf8' }));
  // folded back inside the picture clip (a separate clip of the audio-only asset imported as an
  // EMPTY compound clip → silent A1, Bill Smith mc_1 twice)
  // the same file is also Angle 2's picture (a punch-in cut from the 4K wide — Elevate, 2026-11-06):
  // the audio still folds into ITS angle's picture clip
  assert.deepStrictEqual(sep, { refs: { r4: ['r2', 'r6'] }, folded: ['r4'], inside: true, r4_left: false, wavs: 0 });
  // the timeline writer: review markers land on record frames (inside a removal → the splice), a
  // quieter backchannel gets adjust-volume; the split step places markers + crossfades the duck
  const wt = path.join(TMP, 'writer');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, 'mcdef.fcpxml'), String.raw`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
    <resources>
        <format width="1920" frameDuration="1001/24000s" height="1080" name="FFVideoFormat1080p2398" id="r0"/>
        <media name="mc_t" id="r5">
            <multicam tcFormat="NDF" format="r0" tcStart="0/1s">
                <mc-angle angleID="a1" name="Camera 1">
                    <clip offset="0/1s" duration="100/1s" enabled="1" format="r0" name="c1.mov" start="0/1s">
                        <video offset="0/1s" duration="100/1s" start="0/1s" ref="r2"><audio lane="-1" srcCh="1" offset="0/1s" duration="100/1s" start="0/1s" ref="r2"/></video>
                    </clip>
                </mc-angle>
                <mc-angle angleID="a2" name="Camera 2">
                    <clip offset="0/1s" duration="100/1s" enabled="1" format="r0" name="c2.mov" start="0/1s">
                        <video offset="0/1s" duration="100/1s" start="0/1s" ref="r3"><audio lane="-1" srcCh="1" offset="0/1s" duration="100/1s" start="0/1s" ref="r3"/></video>
                    </clip>
                </mc-angle>
            </multicam>
        </media>
        <asset hasVideo="1" hasAudio="1" audioChannels="1" duration="100/1s" format="r0" name="c1.mov" start="0/1s" id="r2"><media-rep src="file://localhost/N:/c1.mov" kind="original-media"/></asset>
        <asset hasVideo="1" hasAudio="1" audioChannels="1" duration="100/1s" format="r0" name="c2.mov" start="0/1s" id="r3"><media-rep src="file://localhost/N:/c2.mov" kind="original-media"/></asset>
    </resources>
    <library><event name="x"><project name="x"><sequence tcFormat="NDF" duration="100/1s" format="r0" tcStart="3600/1s"><spine>
        <mc-clip offset="3600/1s" duration="100/1s" name="mc_t" start="0/1s" ref="r5"><mc-source srcEnable="all" angleID="a1"/></mc-clip>
    </spine></sequence></project></event></library>
</fcpxml>
`);
  fs.writeFileSync(path.join(wt, 'review_T.json'), JSON.stringify({ label: 'T', markers: [
    { frame: 50, color: 'Red', name: 'Check', note: 'a' }, { frame: 250, color: 'Yellow', name: 'Retake replaced', note: 'b' }] }));
  fs.writeFileSync(path.join(wt, 'T_plan.json'), JSON.stringify({ label: 'T', multicam: 'mc_t', fps: 23.976, review_file: path.join(wt, 'review_T.json'),
    video: [{ in: 0, out: 200, angle: 'Camera 1' }, { in: 300, out: 600, angle: 'Camera 2' }],
    mics: { 'Camera 2': [[0, 120], [400, 420, -2.5]] }, mic_angles: { 'Camera 2': 'Camera 2' }, audio: { source: 'wav', angle: 'Camera 2' }, removals: [] }));
  const wr = JSON.parse(execFileSync(PY, ['-c', String.raw`
import json, sys, io, contextlib, os
sys.path.insert(0, sys.argv[1]); os.chdir(sys.argv[2])
with contextlib.redirect_stdout(io.StringIO()):
    import write_timeline_xml as m
    m.main(["mcdef.fcpxml", "out.fcpxml", "Camera 2=Camera 2", "joined=J", "T_plan.json"])
import split_into_videos as sv
class It:
    def __init__(s, a, b): s.a, s.b, s.tr = a, b, []
    def GetStart(s): return 1000 + s.a
    def GetEnd(s): return 1000 + s.b
    def AddTransition(s, o): s.tr.append(o["duration"]); return True
class TL:
    def __init__(s): s.m, s.its = {}, [It(0, 300), It(300, 320), It(320, 500)]
    def GetStartFrame(s): return 1000
    def AddMarker(s, f, c, n, note, d): s.m[f] = c; return True
    def GetTrackCount(s, kind): return 1 if kind == "audio" else 0
    def GetItemListInTrack(s, kind, k): return s.its
v = json.load(open("out_ranges.json"))["videos"][0]
tl = TL()
line = sv.review(tl, v)
x = open("out.fcpxml").read()
print(json.dumps({"v": v, "line": line, "marks": tl.m, "tr": [i.tr for i in tl.its], "vol": x.count('<adjust-volume amount="-2.5dB"/>')}))
`, PIPELINE, wt], { encoding: 'utf8', env: { ...process.env, HOME: wt } }).trim().split('\n').pop());   // its import-time run writes a report to ~/Desktop
  assert.deepStrictEqual(wr.v.markers.map((m) => m.frame), [50, 200]);
  assert.deepStrictEqual(wr.v.ducks, [[300, 320, -2.5]]);
  assert.strictEqual(wr.vol, 1);
  assert.deepStrictEqual(wr.marks, { 50: 'Red', 200: 'Yellow' });
  assert.deepStrictEqual(wr.tr, [[2], [2], []], wr.line);
  assert.ok(/markers 2\/2 \(red 1, yellow 1\); backchannels opened quieter: 1\/1, 2 crossfade/.test(wr.line), wr.line);
  // stage (Bill Smith, 2026-11-05): a short pause isn't worth an angle change; a trimmed long one is
  // covered on the other angle for a beat, then back to Claude's shot (and its later shots kept)
  const stageDir = path.join(TMP, 'stage');
  fs.mkdirSync(stageDir, { recursive: true });
  const stageOut = JSON.parse(execFileSync(PY, ['-c', String.raw`
import json, os, sys, subprocess
os.chdir(sys.argv[2])
fps = 24000 / 1001
words = []
def say(t0, t1):
    t = t0
    while t < t1:
        s = t * fps
        words.append({"mic": "Angle 1", "w": "word", "s": round(s, 1), "e": round(s + 8, 1), "p": 0.9, "own": True, "clear": True})
        t += 0.5
say(1, 20); say(22.0, 60); say(64, 120)
json.dump({"label": "S", "multicam": "mc", "fps": fps, "frame_sec": [1001, 24000], "angles": ["Angle 1", "Angle 2"], "mics": ["Angle 1"], "words": words}, open("words_S.json", "w"))
json.dump({"multicam": "mc", "fps": fps, "frame_sec": [1001, 24000], "tc_start_sec": 0, "length_sec": 125, "angles": ["Angle 1", "Angle 2"],
  "mics": [{"name": "c.mxf", "angle": "Angle 1", "path": "x", "file_zero_sec": 0, "from_sec": 0, "to_sec": 125, "channels": 1, "camera": True}],
  "audio_source": "camera", "label": "S"}, open("day_S.json", "w"))
st = lambda sec, a: {"at": int(sec * fps), "start": sec * fps, "prev_end": sec * fps - 4, "angle": a}
json.dump({"start": 0, "end": int(125 * fps), "delivery": "stage", "removals": [], "shots": [{**st(1, "Angle 2"), "prev_end": None}, st(100, "Angle 1")],
  "review": [], "pauses": {"max": 36, "left": 18, "min_save": 36}}, open("removals_S.json", "w"))
subprocess.run([sys.executable, os.path.join(sys.argv[1], "place_cuts.py"), "words_S.json", "day_S.json", "S_plan.json", "removals=removals_S.json"],
               check=True, stdout=subprocess.DEVNULL)
p = json.load(open("S_plan.json"))
print(json.dumps({"removals": [r["why"] for r in p["removals"]], "video": [[v["angle"], round((v["out"] - v["in"]) / fps, 1)] for v in p["video"]]}))
`, PIPELINE, stageDir], { encoding: 'utf8' }));
  assert.deepStrictEqual(stageOut.removals.length, 1, JSON.stringify(stageOut));          // the 2 s pause stays
  assert.deepStrictEqual(stageOut.video.map((v) => v[0]), ['Angle 2', 'Angle 1', 'Angle 2', 'Angle 1'], JSON.stringify(stageOut));
  assert.ok(stageOut.video[1][1] >= 3 && stageOut.video[1][1] <= 6, JSON.stringify(stageOut));   // a beat of cover, not 36 s
  // Claude's shots across removals: no ping-pong (a short other-angle shot, the splice, straight back)
  const fit = JSON.parse(execFileSync(PY, ['-c', String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
import place_cuts as p
P = lambda f, t, a, j=False: {"from": f, "to": t, "angle": a, "kind": "claude", "join": j}
out = {
  "across": p.fit_angles([P(0, 300, "A"), P(300, 348, "B"), P(348, 396, "B", True), P(396, 700, "A")], ["A", "B"]),
  "flip": p.fit_angles([P(0, 300, "A"), P(300, 700, "A", True), P(700, 900, "B")], ["A", "B"]),
  "pick": p.fit_angles([P(0, 300, "A"), P(300, 600, "B"), P(600, 900, "B", True), P(900, 1200, "A")], ["A", "B", "C"]),
}
print(json.dumps({k: [[x["from"], x["to"], x["angle"]] for x in v] for k, v in out.items()}))
`, PIPELINE], { encoding: 'utf8' }));
  // B straddled the removal: rather than A | B 2 s ‖ A 2 s | B … the cut moves onto the join
  assert.ok(fit.across.every((x, k) => !k || x[2] !== fit.across[k - 1][2]) && fit.across.length <= 3, JSON.stringify(fit.across));
  assert.deepStrictEqual(fit.flip.map((x) => x[2]), ['A', 'B']);   // the opening stays; the shot after the removal changes
  assert.ok(fit.pick.every((x) => x[2] !== 'C'), JSON.stringify(fit.pick));
  // slider motion (2026-11-10): Claude's slider shots are kept only inside the moving stretches
  const slDir = path.join(TMP, 'slider');
  fs.mkdirSync(slDir, { recursive: true });
  const slOut = JSON.parse(execFileSync(PY, ['-c', String.raw`
import json, os, sys, subprocess
os.chdir(sys.argv[2])
fps = 24
words = []
t = 1.0
while t < 120:
    words.append({"mic": "Angle 1", "w": "word", "s": round(t * fps, 1), "e": round(t * fps + 8, 1), "p": 0.9, "own": True, "clear": True})
    t += 0.5
A = ["Angle 1", "Angle 2", "Angle 4"]
json.dump({"label": "L", "multicam": "mc", "fps": fps, "frame_sec": [1, 24], "angles": A, "mics": ["Angle 1"], "words": words}, open("words_L.json", "w"))
json.dump({"multicam": "mc", "fps": fps, "frame_sec": [1, 24], "tc_start_sec": 0, "length_sec": 125, "angles": A,
  "mics": [{"name": "c.mxf", "angle": "Angle 1", "path": "x", "file_zero_sec": 0, "from_sec": 0, "to_sec": 125, "channels": 1, "camera": True}],
  "audio_source": "camera", "label": "L"}, open("day_L.json", "w"))
st = lambda sec, a: {"at": int(sec * fps), "start": sec * fps, "prev_end": sec * fps - 4, "angle": a}
json.dump({"start": 0, "end": 125 * fps, "delivery": "scripted", "removals": [], "review": [],
  "shots": [{**st(1, "Angle 1"), "prev_end": None}, st(20, "Angle 4"), st(50, "Angle 2"), st(80, "Angle 4"), st(100, "Angle 1")]}, open("removals_L.json", "w"))
json.dump({"Angle 4": {"moving": [[25 * fps, 40 * fps], [85 * fps, 95 * fps]]}}, open("motion_L.json", "w"))
for name, extra in (("on", ["motion=motion_L.json"]), ("off", [])):
    subprocess.run([sys.executable, os.path.join(sys.argv[1], "place_cuts.py"), "words_L.json", "day_L.json", f"L_{name}.json", "removals=removals_L.json",
                    "extra=Angle 4"] + extra, check=True, stdout=subprocess.DEVNULL)
out = {n: [[v["angle"], round(v["in"] / fps, 1), round(v["out"] / fps, 1)] for v in json.load(open(f"L_{n}.json"))["video"]] for n in ("on", "off")}
print(json.dumps(out))
`, PIPELINE, slDir], { encoding: 'utf8' }));
  const sl = slOut.on.filter((v) => v[0] === 'Angle 4');
  assert.strictEqual(sl.length, 2, JSON.stringify(slOut));
  assert.ok(sl.every(([, a, b]) => (a >= 25 && b <= 40) || (a >= 85 && b <= 95)), JSON.stringify(slOut.on));
  assert.ok(slOut.on.every((v, k) => !k || v[0] !== slOut.on[k - 1][0]), JSON.stringify(slOut.on));
  assert.ok(slOut.off.some((v) => v[0] === 'Angle 4' && v[1] < 25), 'without motion, Claude\'s slider shot is untouched');
  // angle rules (2026-11-10): "never Angle 2 ↔ Angle 4" — Claude's 1 → 4 → 2 → 4 → 1 never cuts 2 ↔ 4
  const nc = JSON.parse(execFileSync(PY, ['-c', String.raw`
import json, os, sys, subprocess
os.chdir(sys.argv[2])
for name, extra in (("rules", ["nocut=Angle 2>Angle 4", "nocut=Angle 4>Angle 2"]), ("none", [])):
    subprocess.run([sys.executable, os.path.join(sys.argv[1], "place_cuts.py"), "words_L.json", "day_L.json", f"N_{name}.json", "removals=removals_L.json",
                    "extra=Angle 4"] + extra, check=True, stdout=subprocess.DEVNULL)
print(json.dumps({n: [v["angle"] for v in json.load(open(f"N_{n}.json"))["video"]] for n in ("rules", "none")}))
`, PIPELINE, slDir], { encoding: 'utf8' }));
  const pairs = (xs) => xs.slice(1).map((a, k) => `${xs[k]}>${a}`);
  assert.ok(pairs(nc.none).some((x) => x === 'Angle 4>Angle 2' || x === 'Angle 2>Angle 4'), JSON.stringify(nc));
  assert.ok(!pairs(nc.rules).some((x) => x === 'Angle 4>Angle 2' || x === 'Angle 2>Angle 4'), JSON.stringify(nc));
  assert.ok(nc.rules.includes('Angle 4'), 'the slider is still used, via the wide');
  const AR = require('../electron/shared/angle_rules');
  const four = ['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4'];
  const roles = { 'Camera 1': 'wide', 'Camera 2': 'closeup', 'Camera 3': 'side', 'Camera 4': 'slider' };
  assert.deepStrictEqual(AR.check(four, ['Camera 2>Camera 3', 'Camera 3>Camera 2'], roles), { errors: [], warnings: [] });
  assert.ok(/can't cut to any angle/.test(AR.check(four, ['Camera 3>Camera 1', 'Camera 3>Camera 2', 'Camera 3>Camera 4'], roles).errors[0]));
  assert.ok(/No angle can cut to Camera 4/.test(AR.check(four, ['Camera 1>Camera 4', 'Camera 2>Camera 4', 'Camera 3>Camera 4'], roles).errors[0]));
  assert.ok(AR.check(['A', 'B', 'C'], ['A>C', 'B>C', 'C>A'], { A: 'wide' }).errors.length, 'C reachable only from nothing');
  assert.ok(/side angle/.test(AR.check(four, ['Camera 1>Camera 3'], roles).warnings[0]));
  assert.deepStrictEqual(AR.clean(['Camera 2>Camera 3', 'Camera 2>Camera 3', 'Camera 9>Camera 1', 'Camera 1>Camera 1'], four), ['Camera 2>Camera 3']);
  console.log('✓ place_cuts.py: Claude\'s removals placed (last take kept, no word cut in half), rule-rhythm shots, no jump cuts, camera audio, no ping-pong at removals, slider only while moving');
}

// ── 2e. removal joins on aligned word times (Elevate, 2026-11-06) ──
{
  const fps = 24000 / 1001;
  const W = (w, s, e, extra = {}) => ({ mic: 'Camera 1', w, s, e, own: true, a: 0.9, ...extra });
  const words = [W('So', 20, 30), W('clock', 100, 110), W('in', 114, 119), W('the', 140, 146), W('show', 146, 147, { ghost: true }),
    W('Show', 160, 166), W('them', 167, 172), W('the', 200, 210), W('end.', 230, 240)];
  const n = 400;
  const db = Array(n).fill(-70);
  for (const w of words) if (!w.ghost) for (let f = w.s; f <= Math.min(n - 1, w.e + 1); f++) db[f] = -25;   // a word's tail rings 1 fr
  for (let f = 130; f <= 136; f++) db[f] = -32;                                                             // an "uh" nobody wrote
  const dir = path.join(TMP, 'joins');
  fs.mkdirSync(dir, { recursive: true });
  const wp = path.join(dir, 'words_J.json'), dp = path.join(dir, 'day_J.json'), pp = path.join(dir, 'J_plan.json');
  const lp = path.join(dir, 'levels_J.json'), rp = path.join(dir, 'removals_J.json');
  fs.writeFileSync(wp, JSON.stringify({ label: 'J', multicam: 'mc_j', fps, frame_sec: [1001, 24000], angles: ['Camera 1', 'Camera 2'], mics: ['Camera 1'], words, aligned: true }));
  fs.writeFileSync(dp, JSON.stringify({ multicam: 'mc_j', fps, frame_sec: [1001, 24000], length_sec: n / fps, angles: ['Camera 1', 'Camera 2'], audio_source: 'camera', mics: [{ angle: 'Camera 1' }] }));
  fs.writeFileSync(lp, JSON.stringify({ label: 'J', frame_sec: 1001 / 24000, mics: { 'Camera 1': { start: 0, db } } }));
  fs.writeFileSync(rp, JSON.stringify({ start: 0, end: 260, delivery: 'scripted', shots: [], review: [], pauses: null, removals: [
    { from: 116, to: 135, why: 'flub', prev_end: 110, cut_start: 114, cut_end: 119, next_start: 140 },
    { from: 205, to: 220, why: 'flub', prev_end: null, cut_start: 205, cut_end: 220, next_start: null }] }));
  execFileSync(PY, [path.join(PIPELINE, 'place_cuts.py'), wp, dp, pp, `removals=${rp}`, `levels=${lp}`, 'start=0', 'end=260'], { encoding: 'utf8' });
  const plan = JSON.parse(fs.readFileSync(pp, 'utf8'));
  const r1 = plan.removals.find((r) => r.why.includes('flub') && r.from < 150);
  // the cut starts after "clock"'s ringing tail but before "in"; ends after the "uh", before "the"
  assert.ok(r1.from >= 112 && r1.from <= 113, JSON.stringify(r1));
  assert.ok(r1.to >= 137 && r1.to <= 139, JSON.stringify(r1));
  // the head starts 3 + 8 fr (air + fade) before the first sound, not at the old ±10-fr guess
  assert.strictEqual(plan.video[0].in, 20 - 3 - 8);
  const notes = JSON.parse(fs.readFileSync(plan.review_file, 'utf8')).markers;
  assert.ok(notes.some((m) => m.name.includes('Word cut off') && m.note.includes('"the"')), JSON.stringify(notes));
  assert.ok(!notes.some((m) => /fr of quiet/.test(m.note)), 'old "fr of quiet" wording');
  assert.ok(!plan.removals.some((r) => r.from <= 146 && 147 <= r.to && r.why.includes('stutter')));   // Whisper's doubled "show" is not a stutter
  console.log('✓ place_cuts.py: joins on aligned words keep the tail, drop an unwritten "uh", flag a word cut in half in plain words');
  // second pass: Check on the plan → trims/keeps → placed once more; the cut-in-half "the" is fixed
  const { checkTimeline, planTimeline } = require('../electron/workers/cut_through_check');
  const wf = JSON.parse(fs.readFileSync(wp, 'utf8'));
  const c1 = checkTimeline({ timeline: planTimeline(plan), words: wf, multicam: 'mc_j' });
  assert.ok(c1.markers.some((m) => m.name.includes('Word cut off')) && c1.fixes.fixed['Word cut off'] === 1, JSON.stringify(c1.fixes));
  execFileSync(PY, [path.join(PIPELINE, 'place_cuts.py'), wp, dp, pp, `removals=${rp}`, `levels=${lp}`, 'start=0', 'end=260',
    ...c1.fixes.trims.map(([x, y]) => `trim=${x}-${y}`), ...c1.fixes.keeps.map(([x, y]) => `keep=${x}-${y}`)], { encoding: 'utf8' });
  const c2 = checkTimeline({ timeline: planTimeline(JSON.parse(fs.readFileSync(pp, 'utf8'))), words: wf, multicam: 'mc_j' });
  assert.ok(!c2.markers.some((m) => m.name.includes('Word cut off')), JSON.stringify(c2.markers));
  // keep= gives a word back out of a removal; trim= takes silence out
  execFileSync(PY, [path.join(PIPELINE, 'place_cuts.py'), wp, dp, pp, `removals=${rp}`, `levels=${lp}`, 'start=0', 'end=260', 'keep=112-122', 'trim=241-260'], { encoding: 'utf8' });
  const kp = JSON.parse(fs.readFileSync(pp, 'utf8'));
  assert.ok(!kp.removals.some((r) => r.from < 122 && r.to > 112), JSON.stringify(kp.removals));
  assert.ok(kp.video[kp.video.length - 1].out <= 241, JSON.stringify(kp));
  // a beat after "clock" (end of a thought): the removal after it keeps 6 more frames of air
  const rj = JSON.parse(fs.readFileSync(rp, 'utf8'));
  fs.writeFileSync(rp, JSON.stringify({ ...rj, beats: [110] }));
  execFileSync(PY, [path.join(PIPELINE, 'place_cuts.py'), wp, dp, pp, `removals=${rp}`, `levels=${lp}`, 'start=0', 'end=260'], { encoding: 'utf8' });
  const bp = JSON.parse(fs.readFileSync(pp, 'utf8'));
  const rb = bp.removals.find((r) => r.why.includes('flub') && r.from < 150);
  assert.ok((r1.to - r1.from) - (rb.to - rb.from) === 6 && rb.to >= 120, `beat: ${JSON.stringify(r1)} → ${JSON.stringify(rb)}`);
  // the second pass keeps that beat when it closes a gap after the thought
  const cb = checkTimeline({ timeline: { name: 'b', fps: 24, start_frame: 0, start_tc: '01:00:00:00', pieces: [
    { mc: 'mc_j', angle: 'Camera 1', start: 0, end: 150, src_in: 0, src_out: 150 },
    { mc: 'mc_j', angle: 'Camera 2', start: 150, end: 250, src_in: 155, src_out: 255 }] },
    words: { fps: 24, words: [W('So', 20, 30), W('done.', 100, 110), W('Next', 190, 200), W('one.', 210, 220)] }, beats: [110] });
  assert.ok(cb.fixes.trims.some(([x]) => x === 110 + 5 + 6), JSON.stringify(cb.fixes));
  fs.writeFileSync(rp, JSON.stringify(rj));
  console.log('✓ second pass: Check on the plan → trim/keep → a word cut in half is fixed before the build; a finished thought keeps its beat');
}

// ── 3. orchestrator end to end ─────────────────────────────────
function fakeWorker() {
  const calls = [];
  const send = (payload) => {
    calls.push(payload);
    if (payload.cmd === 'ct_list_multicams') {
      return Promise.resolve({ data: { project: 'Fake Project', multicams: [{ name: 'mc_test', bin: 'MC', duplicate: false }] } });
    }
    if (payload.cmd === 'ct_run_step' && payload.script === 'prepare_multicam.py') {
      // Run the real handler code path (minus the worker loop) on the fake Resolve.
      return new Promise((resolve, reject) => {
        const code = String.raw`
import json, sys
from fake_resolve import Resolve
from helper.commands.cut_through import run_step
p = json.loads(sys.stdin.read())
res = run_step(p["pipeline_dir"] + "/" + p["script"], p["settings"], Resolve(), lambda l: None)
sys.stdout.write(json.dumps(res))`;
        const proc = spawn(PY, ['-c', code], { env: PY_ENV });
        let out = '';
        proc.stdout.on('data', (d) => { out += d; });
        proc.stderr.on('data', (d) => process.stderr.write(d));
        proc.on('close', () => { try { resolve({ data: JSON.parse(out) }); } catch (e) { reject(e); } });
        proc.stdin.end(JSON.stringify(payload));
      });
    }
    if (payload.cmd === 'ct_mark_in_out') return Promise.resolve({ data: globalThis.FAKE_MARKS || { in: null, out: null, bin: null, multicams: 1 } });
    if (payload.cmd === 'list_timelines') {
      return Promise.resolve({ data: { timelines: [{ name: 'Solo2 rough cut' }, { name: 'Solo2 rough cut 2' }, { name: 'Other' }] } });
    }
    if (payload.cmd === 'ct_read_timeline') {
      // the rough cut as built: the plan's pieces laid end to end from frame 86400
      const plan = JSON.parse(fs.readFileSync(RUN('Solo2', 'Solo2_plan.json'), 'utf8'));
      let t = 86400;
      const pieces = plan.video.map((v) => { const p = { mc: plan.multicam, angle: v.angle, start: t, end: t + v.out - v.in, src_in: v.in, src_out: v.out }; t = p.end; return p; });
      return Promise.resolve({ data: { name: payload.name, fps: plan.fps, track: 1, pieces, start_frame: 86400, start_tc: '01:00:00:00' } });
    }
    if (payload.cmd === 'ct_set_markers') {
      return Promise.resolve({ data: { removed: 0, placed: payload.markers.length, failed: 0 } });
    }
    if (payload.cmd === 'ct_run_step' && payload.script === 'build_rough_cut.py') {
      return Promise.resolve({ data: { lines: ['1. Exported', '4. Split done (2.0s)', '', 'Total time: 16.0s'], error: null, stopped: null } });
    }
    return Promise.reject(new Error(`unexpected ${payload.cmd}`));
  };
  return { send, calls };
}

// ── 3a0. phantom doubles: Whisper's doubted repeat goes, a real or one-letter repeat stays ──
{
  const src = fs.readFileSync(path.join(PIPELINE, 'transcribe.py'), 'utf8');
  const code = [/def norm_word[\s\S]*?(?=\n\ndef )/, /PHANTOM_P.*\n/, /def drop_phantom_doubles[\s\S]*?(?=\n\n\ndef )/].map((re) => re.exec(src)[0]).join('\n');
  const py = `import json,re,sys\n${code}\nw=json.loads(sys.argv[1])\nprint(drop_phantom_doubles(w),' '.join(x['w'] for x in w))`;
  const W = (w, s, e, p) => ({ mic: 'M', w, s, e, p });
  const out = execFileSync(PY, ['-c', py, JSON.stringify([W('business.', 0, 10, 1), W('business.', 10, 14, 0.07), W('recruiting,', 20, 30, 0.99), W('recruiting,', 31, 40, 1),
    W('I', 50, 52, 0.9), W('I', 52, 54, 0.1), W('make', 60, 70, 1), W('make', 90, 95, 0.1)])], { encoding: 'utf8' }).trim();
  assert.strictEqual(out, '1 business. recruiting, recruiting, I I make make');
  console.log('✓ transcribe: phantom doubled words dropped, real repeats kept');
}

// ── 3a. Compare: differences in source frames, whatever the timeline's position ──
{
  const cmp = require('../electron/workers/cut_through_compare');
  assert.deepStrictEqual(cmp.subtract([[0, 10], [20, 30]], [[5, 25]]), [[0, 5], [25, 30]]);
  const plan = { multicam: 'mc', fps: 24, video: [{ in: 0, out: 100, angle: 'Camera 1' }, { in: 200, out: 300, angle: 'Camera 2' }], removals: [{ from: 100, to: 200, why: 'claude flub' }] };
  const words = { words: [{ w: 'one.', s: 10, e: 20 }, { w: 'lost', s: 150, e: 160 }, { w: 'two.', s: 210, e: 220 }, { w: 'three.', s: 280, e: 295 }] };
  const piece = (a, b, angle, t) => ({ mc: 'mc', angle, src_in: a, src_out: b, start: t, end: t + b - a });
  const same = { name: 'x', fps: 24, start_frame: 1000, start_tc: '01:00:00:00', pieces: [piece(0, 100, 'Camera 1', 1000), piece(200, 300, 'Camera 2', 1100)] };
  assert.strictEqual(cmp.compareTimeline({ timeline: same, plan, words }).changed, false);
  assert.strictEqual(cmp.planMatch(same, plan), 1);
  // the flub put back, 10 frames off the tail (5 of them the end of "three."), the second piece on another camera, and the whole thing later on the timeline
  const edited = { ...same, pieces: [piece(0, 200, 'Camera 1', 5000), piece(200, 290, 'Camera 3', 5200)] };
  const r = cmp.compareTimeline({ timeline: edited, plan, words });
  assert.deepStrictEqual(r.events.map((e) => [e.type, e.from, e.to, e.position]), [['restored', 100, 200, 'join'], ['word_clipped', 290, 300, 'tail']]);
  assert.strictEqual(r.events[0].why, 'claude flub');
  assert.deepStrictEqual(r.angles.map((a) => [a.plan, a.now, a.from, a.to]), [['Camera 2', 'Camera 3', 200, 290]]);
  assert.deepStrictEqual(r.stats.words, { planKept: 3, nowKept: 4, restored: 1, cut: 0, finished: 0, clipped: 1, clippedPlan: 0, clippedNow: 1 });
  assert.strictEqual(r.soundRead, false);
  // the sound is what's measured: a word the plan clipped by 6 fr, given back by moving the cut on
  // A1 only (picture as planned), and the next piece's head trimmed into a word
  {
    const w2 = { words: [{ w: 'one', s: 10, e: 20 }, { w: 'end.', s: 90, e: 106 }, { w: 'next', s: 204, e: 216 }, { w: 'two.', s: 230, e: 240 }] };
    const pic = { ...same, pieces: [piece(0, 100, 'Camera 1', 1000), piece(200, 300, 'Camera 2', 1100)] };
    assert.strictEqual(cmp.compareTimeline({ timeline: pic, plan, words: w2 }).changed, false);
    const a1 = (a, b, t) => ({ track: 1, name: 'mc', mc: 'mc', src_in: a, src_out: b, start: t, end: t + b - a });
    const heard = { ...pic, audio: [a1(0, 108, 1000), a1(208, 300, 1108), { track: 2, name: 'room.wav', start: 1000, end: 1200 }] };
    const h = cmp.compareTimeline({ timeline: heard, plan, words: w2 });
    assert.strictEqual(h.soundRead, true);
    assert.deepStrictEqual(h.events.map((e) => [e.type, e.from, e.to]), [['word_finished', 100, 108], ['word_clipped', 200, 208]]);
    assert.deepStrictEqual(h.events[0].parts, [{ w: 'end.', frames: 6, len: 16, plan: 10, now: 16 }]);
    assert.deepStrictEqual(h.events[1].parts, [{ w: 'next', frames: 4, len: 12, plan: 12, now: 8 }]);
    assert.ok(h.events[0].partNote.includes('"end." +6 fr (plan 10/16, now 16/16)'), h.events[0].partNote);
    assert.deepStrictEqual([h.stats.words.finished, h.stats.words.clipped, h.stats.words.clippedPlan, h.stats.words.clippedNow], [1, 1, 1, 1]);
    assert.strictEqual(h.stats.sound, 'A1');
    // reaching into a word the plan took out whole is a scrap, not a finished word
    const scrap = cmp.compareTimeline({ timeline: { ...pic, audio: [a1(0, 100, 1000), a1(196, 300, 1100)] }, plan, words: { words: [{ w: 'gone', s: 190, e: 199 }, { w: 'two.', s: 230, e: 240 }] } });
    assert.deepStrictEqual(scrap.events.map((e) => [e.type, e.parts[0] && e.parts[0].plan]), [['word_scrap', 0]]);
    // sound from another multicam (or none readable) → the picture stands in
    const other = { ...pic, audio: [{ ...a1(0, 108, 1000), mc: 'other' }] };
    assert.strictEqual(cmp.compareTimeline({ timeline: other, plan, words: w2 }).soundRead, false);
    const lines = cmp.reportLines([h], cmp.totals([h])).join('\n');
    assert.ok(lines.includes('Word finished — "end." +6 fr') && lines.includes('Word clipped — "next" −4 fr'), lines);
    assert.ok(cmp.reportHtml({ label: 'x', results: [h], sum: cmp.totals([h]), levels: null, plans: { x: plan } }).includes('Word finished'));
  }
  const html = cmp.reportHtml({ label: '<x>', results: [r], sum: cmp.totals([r]), levels: null, plans: { x: plan } });
  assert.ok(html.includes('&lt;x&gt;') && !html.includes('<x>'));
  console.log('✓ compare: restored / trimmed / camera changes found in source frames, untouched is unchanged');
  console.log('✓ compare: the sound (A1) is measured; a cut moved on the sound only gives back / clips part of a word');
}

// ── 3b. videos: find (recordings + slate) → plan now → batch → build ──
const vlib = require('../electron/workers/cut_through_videos');
{
  // pure: the slate's clock (another time zone, ~2 s late) is found from the notes alone
  const fps = 24000 / 1001;
  const day = { frame_sec: [1001, 24000], fps: 23.976, tc_start_sec: 36036, length_sec: 600,
    recordings: [{ from_sec: 0, to_sec: 200 }, { from_sec: 210, to_sec: 400 }, { from_sec: 420, to_sec: 600 }] };
  const tc = (sec) => { const t = 36000 + sec / 1.001 + 5 * 3600 + 2; const p = (x) => String(Math.floor(x)).padStart(2, '0');
    return `${p(t / 3600)}:${p((t / 60) % 60)}:${p(t % 60)}:${p((t % 1) * 24)}`; };
  const notes = [
    { timestamp: tc(0), code: 'ATEM', note: 'Recording started' }, { timestamp: tc(4), code: 'A1', note: '' },
    { timestamp: tc(200), code: 'ATEM', note: 'Recording stopped' },
    { timestamp: tc(210), code: 'ATEM', note: 'Recording started' },
    { timestamp: tc(300), code: 'B2', note: '' },                       // a code change inside a recording
    { timestamp: tc(420), code: 'ATEM', note: 'Recording started' }, { timestamp: tc(425), code: 'A1', note: 'again' }
  ];
  const off = vlib.slateOffset(day, notes);
  assert.deepStrictEqual([off.hours, off.seconds, off.matched], [-5, -2, 4], JSON.stringify(off));
  // words: one talker, a long pause at 290–296 s (where B2's split should land)
  const words = { mics: ['Camera 1'], words: [] };
  for (let t = 1; t < 600; t += 0.5) if (!(t > 290 && t < 296) && !(t > 199 && t < 422)) words.words.push({ mic: 'Camera 1', w: 'x', s: t * fps, e: t * fps + 8 });
  for (let t = 211; t < 290; t += 0.5) words.words.push({ mic: 'Camera 1', w: 'y', s: t * fps, e: t * fps + 8 });
  for (let t = 296; t < 399; t += 0.5) words.words.push({ mic: 'Camera 1', w: 'z', s: t * fps, e: t * fps + 8 });
  const v = vlib.findVideos({ day, words, notes, offsetSec: off.offsetSec, label: 'Day' });
  assert.deepStrictEqual(v.map((x) => x.name), ['A1 (1)', 'B2', 'A1 (2)'], JSON.stringify(v.map((x) => [x.name, x.fromTc, x.toTc])));
  // A1 runs on across the stop at 200 s (same code: one video, the gap cut), until B2's pause
  assert.deepStrictEqual(v[0].gaps.map(([a, b]) => [Math.round(a * 1001 / 24000), Math.round(b * 1001 / 24000)]), [[200, 210]]);
  assert.ok(v[0].flags.includes('Restart') && v[0].flags.some((f) => /^A1 again at 10:06:59:14$/.test(f)), JSON.stringify(v[0].flags));
  const split = v[1].from * 1001 / 24000;
  assert.ok(split > 290 && split < 296, `B2 starts at ${split} s, not in the pause`);
  assert.ok(v.every((x) => x.kind === 'solo' && x.talker === 'Camera 1' && x.include), JSON.stringify(v));
  // no slate: one video per recording, flagged, named by the label
  const plain = vlib.findVideos({ day, words, notes: [], label: 'Day' });
  assert.deepStrictEqual(plain.map((x) => [x.name, x.flags.includes('No J-code')]), [['Day video 1', true], ['Day video 2', true], ['Day video 3', true]]);
  assert.strictEqual(vlib.cleanName('A1: "intro" = x'), 'A1 intro x');
  // "starts at H6": a project shot over several days, only that day from H6 on
  const dayM = { frame_sec: [1, 24], tc_start_sec: 36000, length_sec: 1300, recordings: [{ from_sec: 0, to_sec: 600 }, { from_sec: 700, to_sec: 1200 }] };
  const N = (timestamp, code, note = '') => ({ timestamp, code, note });
  const multiDay = [
    N('10:00:00:00', 'ATEM', 'Recording started'), N('10:00:05:00', 'A1'), N('10:03:00:00', 'A2'), N('10:10:00:00', 'ATEM', 'Recording stopped'),
    N('09:00:00:00', 'X1'), N('10:00:00:00', 'ATEM', 'Recording started'), N('10:00:40:00', 'H6'), N('10:05:00:00', 'H7'), N('10:10:00:00', 'ATEM', 'Recording stopped'),
    N('10:11:40:00', 'ATEM', 'Recording started'), N('10:11:45:00', 'H8'), N('10:30:00:00', 'ATEM', 'Recording stopped'),
    N('08:00:00:00', 'Z9'), N('10:02:00:00', 'Z10')
  ];
  const fromH6 = vlib.notesFrom(dayM, multiDay, 'h6');
  assert.deepStrictEqual(fromH6.map((n) => n.code).filter((c) => c !== 'ATEM'), ['H6', 'H7', 'H8']);
  assert.strictEqual(fromH6[0].code, 'ATEM', 'the Recording started note before the code stays');
  const startH6 = vlib.findVideos({ day: dayM, notes: fromH6, offsetSec: 0, label: 'Day', firstCode: 'h6' });
  assert.deepStrictEqual(startH6.map((v) => v.name), ['H6', 'H7', 'H8']);
  assert.strictEqual(startH6[0].from, 0, 'typed 40 s late, still names the first recording');
  assert.strictEqual(vlib.notesFrom(dayM, multiDay, 'Q1'), null);
  console.log('✓ videos: slate clock found (time zone + seconds), J-code split in a pause, same code across a stop = one video, flags, no slate');
}

/** Per-project run folder: required, earlier runs copied across, one project doesn't affect another. */
async function runFolderChecks(make) {
  const c = make();
  await c.listMulticams();
  c.select({ mc: 'mc_test', label: 'Fold' });
  assert.strictEqual(c.snapshot().settings.runFolder, null);
  await assert.rejects(() => c.runPrep({}), /Choose a run folder/);
  await assert.rejects(() => c.findVideos({}), /Choose a run folder/);
  const oldDir = RUN('Fold', '');
  fs.mkdirSync(oldDir, { recursive: true });
  const oldReview = RUN('Fold', 'review_Fold.json');
  fs.writeFileSync(RUN('Fold', 'words_Fold.json'), '{"words":[]}');
  fs.writeFileSync(oldReview, '[]');
  fs.writeFileSync(RUN('Fold', 'Fold_plan.json'), JSON.stringify({ review_file: oldReview }));
  const nas = path.join(HOME, 'NAS share', 'runs');
  await assert.rejects(() => c.setRunFolder({ folder: 'relative/path' }), /full folder path/);
  const snap = await c.setRunFolder({ folder: nas });
  assert.strictEqual(snap.settings.runFolder, nas);
  const moved = path.join(nas, 'Fake Project', 'Fold');
  assert.strictEqual(snap.files.words, path.join(moved, 'words_Fold.json'));
  assert.ok(fs.existsSync(snap.files.words), 'earlier run copied');
  assert.ok(fs.existsSync(RUN('Fold', 'words_Fold.json')), 'original kept');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(moved, 'Fold_plan.json'), 'utf8')).review_file, path.join(moved, 'review_Fold.json'));
  // a folder that went away (NAS unmounted) stops the run with a clear reason
  fs.rmSync(nas, { recursive: true, force: true });
  await assert.rejects(() => c.runPrep({}), /not reachable/);
  fs.rmSync(oldDir, { recursive: true, force: true });
  console.log('✓ run folder: required per project, earlier runs copied, plan repointed, unreachable folder refused');
}

async function videosEndToEnd({ w, getPrefs, setPrefs }) {
  // the E2E conversation day, recorded as two takes, slate on a clock 5 h + 2 s ahead
  const fsec = 1001 / 24000;
  fs.mkdirSync(RUN('Vids', ''), { recursive: true });
  const day = JSON.parse(fs.readFileSync(RUN('E2E_test', 'day_E2E_test.json'), 'utf8'));
  day.tc_start_sec = 36036;   // TC 10:00:00:00 (real seconds at 23.976)
  day.recordings = [{ from_sec: 0, to_sec: 30 }, { from_sec: 31, to_sec: day.length_sec }];
  fs.writeFileSync(RUN('Vids', 'day_Vids.json'), JSON.stringify(day));
  fs.copyFileSync(RUN('E2E_test', 'words_E2E_test.json'), RUN('Vids', 'words_Vids.json'));
  fs.copyFileSync(RUN('E2E_test', 'levels_E2E_test.json'), RUN('Vids', 'levels_Vids.json'));
  fs.copyFileSync(RUN('E2E_test', 'align_E2E_test.txt'), RUN('Vids', 'align_Vids.txt'));
  const at = (sec) => { const t = 36000 + sec / 1.001 + 5 * 3600 + 2; const p = (x) => String(Math.floor(x)).padStart(2, '0');
    return `${p(t / 3600)}:${p((t / 60) % 60)}:${p(t % 60)}:${p((t % 1) * 24)}`; };
  const notes = [
    { timestamp: at(0), code: 'ATEM', note: 'Recording started' }, { timestamp: at(3), code: 'A1', note: '' },
    { timestamp: at(25), code: 'S1', note: '' },
    { timestamp: at(30), code: 'ATEM', note: 'Recording stopped' }, { timestamp: at(31), code: 'ATEM', note: 'Recording started' },
    { timestamp: at(60), code: 'B2', note: '' }
  ];
  const lpos = { isConfigured: () => true, listProjects: async () => ({ projects: [{ projectId: 'p1', name: 'Day', clientName: 'Client' }] }),
    getSlateNotes: async (id) => { assert.strictEqual(id, 'p1'); return { notes, tabs: [] }; } };
  // a stand-in Claude: live calls and the batch API (the real one isn't called)
  const answer = (params) => {
    const shots = [];
    for (const line of params.messages[0].content.split('\n')) {
      const m = /^\[\d+:\d+\] (Camera \d+): (\d+) /.exec(line);
      if (m) shots.push({ from: Number(m[2]), angle: shots.length ? m[1] : 'Camera 1', why: 'turn' });
    }
    return { model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ removals: [], shots, beats: [], notes: [] }) }],
      usage: { input_tokens: 4000, output_tokens: 2000 } };
  };
  const live = [];
  const sent = { create: null, canceled: 0, retrieves: 0 };
  const api = {
    beta: { messages: { stream: (params) => { live.push(params); return { on: () => {}, finalMessage: async () => answer(params) }; } } },
    messages: {
      countTokens: async () => ({ input_tokens: 5000 }),
      batches: {
        create: async ({ requests }) => { sent.create = requests; return { id: 'msgbatch_test', processing_status: 'in_progress',
          request_counts: { processing: requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 } }; },
        retrieve: async () => { sent.retrieves += 1; return sent.retrieves < 2
          ? { processing_status: 'in_progress', request_counts: { processing: 3, succeeded: 0, errored: 0, canceled: 0, expired: 0 }, ended_at: null }
          : { processing_status: 'ended', request_counts: { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 0 }, ended_at: new Date().toISOString() }; },
        cancel: async () => { sent.canceled += 1; return {}; },
        results: async () => (async function* gen() {
          for (const [k, r] of sent.create.entries()) {
            yield k === 0 ? { custom_id: r.custom_id, result: { type: 'errored', error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } }
              : { custom_id: r.custom_id, result: { type: 'succeeded', message: answer(r.params) } };
          }
        }())
      }
    }
  };
  const c = ct.createCutThrough({ sendWorkerRequest: w.send, broadcast: () => {}, getPrefs, setPrefs, pythonCmd: PY, desktopDir: DESKTOP,
    filesDir: FILES, claudeClient: api, getLpos: () => lpos });
  await c.listMulticams();
  c.select({ mc: 'mc_test', label: 'Vids' });
  let snap = await c.listLposProjects();
  assert.deepStrictEqual(snap.lposProjects, [{ id: 'p1', name: 'Day', client: 'Client' }]);
  c.updateSettings({ lposProject: { id: 'p1', name: 'Day' } });
  snap = await c.findVideos({});
  const vs = snap.videos;
  assert.deepStrictEqual([vs.offset.hours, vs.offset.seconds], [-5, -2], JSON.stringify(vs.offset));
  assert.deepStrictEqual(vs.videos.map((v) => v.name), ['A1', 'S1', 'B2'], JSON.stringify(vs.videos.map((v) => [v.name, v.fromTc, v.toTc])));
  const [a1, s1, b2] = vs.videos;
  assert.ok(a1.kind === 'solo' && a1.talker === 'Camera 2' && a1.flags.includes('Few words'), JSON.stringify(a1));
  assert.ok(s1.gaps.length === 1 && s1.flags.includes('Restart'), JSON.stringify(s1));
  assert.strictEqual(b2.kind, 'convo');
  assert.ok(fs.existsSync(RUN('Vids', 'videos_Vids.json')));
  // a type changed by hand sticks when the videos are found again
  c.updateVideo(s1.id, { delivery: 'free' });
  snap = await c.findVideos({});
  assert.strictEqual(snap.videos.videos[1].delivery, 'free');

  // plan now: one Claude call per ticked video
  c.updateVideo(b2.id, { include: false });
  snap = await c.planVideos({ delivery: 'scripted' });
  assert.strictEqual(snap.steps.plan.status, 'done', `${snap.steps.plan.error}\n${snap.steps.plan.log.join('\n')}`);
  assert.strictEqual(live.length, 2);
  assert.ok(/one speaker \(audio: Camera 2\)/.test(live[0].messages[0].content) && /Delivery: Scripted/.test(live[0].messages[0].content), live[0].messages[0].content.slice(0, 300));
  assert.ok(/Delivery: Free talk/.test(live[1].messages[0].content));
  const p1 = JSON.parse(fs.readFileSync(RUN('Vids', `Vids__${a1.id}_plan.json`), 'utf8'));
  // a solo video on a two-mic day keeps both mic tracks; the other mic stays closed
  assert.deepStrictEqual(Object.keys(p1.mics), ['Camera 2', 'Camera 3']);
  assert.ok(p1.mics['Camera 2'].length > 0 && p1.mics['Camera 3'].length === 0, JSON.stringify(p1.mics));
  assert.ok(p1.review_file.endsWith(`review_Vids__${a1.id}.json`));
  const p2 = JSON.parse(fs.readFileSync(RUN('Vids', `Vids__${s1.id}_plan.json`), 'utf8'));
  const g = snap.videos.videos[1].gaps[0];
  assert.ok(p2.removals.some((r) => r.from <= g[0] && r.to >= g[1]), 'the gap between recordings was not cut');
  assert.strictEqual(snap.videosReady, 2);
  snap = await c.runBuild({});
  const call = w.calls.filter((x) => x.cmd === 'ct_run_step').pop();
  assert.deepStrictEqual(call.settings.PLAN_FILES, [[RUN('Vids', `Vids__${a1.id}_plan.json`), 'A1'], [RUN('Vids', `Vids__${s1.id}_plan.json`), 'S1']]);
  assert.ok(!('PLAN_FILE' in call.settings));

  // batch: priced first (nothing sent), then sent, followed, collected — half price
  c.updateVideo(b2.id, { include: true });
  snap = await c.prepareBatch({ delivery: 'scripted' });
  assert.strictEqual(snap.steps.plan.status, 'done', snap.steps.plan.error);
  assert.strictEqual(sent.create, null, 'sent before Submit');
  const draft = snap.videos.batch;
  assert.strictEqual(draft.status, 'draft');
  assert.deepStrictEqual(Object.keys(draft.items), [a1.id, s1.id, b2.id]);
  assert.ok(draft.items[a1.id].input === 5000 && draft.estimate > 0 && Math.abs(draft.liveEstimate - 2 * draft.estimate) < 0.02, JSON.stringify(draft));
  assert.deepStrictEqual(draft.replans, ['A1', 'S1']);
  // the page's estimate: whole day after Prep, the ticked videos, what the planned ones cost
  assert.ok(snap.estimate && snap.estimate.day.live > 0 && snap.estimate.ticked.videos === 3 && snap.estimate.spent.videos === 2, JSON.stringify(snap.estimate));
  assert.ok(new RegExp(`Vids__${a1.id},solo_plan,claude-opus-5-5,high,4000,2000,0,0,0\\.056,\\d+,[\\d.]+,solo`).test(fs.readFileSync(path.join(FILES, 'cut_through_costs.csv'), 'utf8')),
    'the cost row has no minutes / kind');
  assert.throws(() => c.updateVideo(a1.id, { include: false }), /Discard or finish the batch/);
  snap = c.discardBatch();
  assert.strictEqual(snap.videos.batch, null);
  assert.ok(!fs.existsSync(RUN('Vids', 'batch_Vids.json')));
  await c.prepareBatch({ delivery: 'scripted' });
  snap = await c.submitBatch();
  assert.ok(sent.create.length === 3 && sent.create.every((r) => r.params.model === 'claude-opus-5-5' && !r.params.fallbacks && !r.params.betas &&
    r.params.max_tokens === 128000 && r.params.output_config.format.type === 'json_schema'), JSON.stringify(sent.create.map((r) => r.custom_id)));
  assert.deepStrictEqual(sent.create.map((r) => r.custom_id), [a1.id, s1.id, b2.id]);
  assert.strictEqual(snap.videos.batch.id, 'msgbatch_test');
  assert.ok(snap.videos.videos.every((v) => v.plan.status === 'queued'));
  await assert.rejects(c.findVideos({}), /batch is still running/);
  // nothing can send it again while it's in the queue (1.2.144)
  await assert.rejects(c.submitBatch(), /already in the queue/);
  await assert.rejects(c.prepareBatch({ delivery: 'scripted' }), /already in the queue/);
  await assert.rejects(c.planVideos({ delivery: 'scripted' }), /already in the queue/);
  assert.ok(getPrefs().cutThrough.queuedBatches.msgbatch_test.label === 'Vids', JSON.stringify(getPrefs().cutThrough));
  // … nor from another label on the same multicam (Anthropic is asked first: still in the queue)
  for (const n of ['day_Vids.json', 'words_Vids.json', 'levels_Vids.json']) {
    if (fs.existsSync(RUN('Vids', n))) { fs.mkdirSync(RUN('Vids2', ''), { recursive: true }); fs.copyFileSync(RUN('Vids', n), RUN('Vids2', n.replace('Vids', 'Vids2'))); }
  }
  const vids2 = JSON.parse(fs.readFileSync(RUN('Vids', 'videos_Vids.json'), 'utf8'));
  fs.writeFileSync(RUN('Vids2', 'videos_Vids2.json'), JSON.stringify({ ...vids2, batch: null, videos: vids2.videos.map((v) => ({ ...v, plan: null })) }));
  const realRetrieve = api.messages.batches.retrieve;
  api.messages.batches.retrieve = async () => ({ processing_status: 'in_progress' });
  c.select({ mc: 'mc_test', label: 'Vids2' });
  await assert.rejects(c.prepareBatch({ delivery: 'scripted' }), /already in the queue: Vids \(3 videos/);
  // once Anthropic says it has ended, the other label may send
  api.messages.batches.retrieve = async () => ({ processing_status: 'ended' });
  snap = await c.prepareBatch({ delivery: 'scripted' });
  assert.strictEqual(snap.videos.batch.status, 'draft', snap.steps.plan.error);
  assert.ok(!getPrefs().cutThrough.queuedBatches.msgbatch_test);
  c.discardBatch();
  api.messages.batches.retrieve = async () => ({ processing_status: 'in_progress' });
  c.select({ mc: 'mc_test', label: 'Vids' });
  await new Promise((r) => setTimeout(r, 20));          // its status check on opening
  api.messages.batches.retrieve = realRetrieve;
  // (the registry entry comes back when Vids is opened: its own batch is still live)
  assert.ok(getPrefs().cutThrough.queuedBatches.msgbatch_test);
  assert.ok(!fs.existsSync(RUN('Vids', 'batch_Vids.json')), 'the draft (client words) was kept after sending');
  // EditPanel restarted while it runs: the batch is picked up from the run folder
  const c2 = ct.createCutThrough({ sendWorkerRequest: w.send, broadcast: () => {}, getPrefs, setPrefs, pythonCmd: PY, desktopDir: DESKTOP,
    filesDir: FILES, claudeClient: api, getLpos: () => lpos });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(c2.snapshot().videos.batch.status, 'in_progress');
  snap = await c2.cancelBatch();       // the next status says it ended (2 done, 1 failed) → collected
  assert.strictEqual(sent.canceled, 1);
  snap = c2.snapshot();
  assert.ok(snap.videos.batch.collected, JSON.stringify(snap.videos.batch));
  const st = snap.videos.videos.map((v) => v.plan.status);
  assert.deepStrictEqual(st, ['failed', 'planned', 'planned'], JSON.stringify(snap.videos.videos.map((v) => v.plan)));
  assert.ok(/overloaded|Overloaded/.test(snap.videos.videos[0].plan.error));
  assert.ok(snap.videos.videos[1].plan.via === 'batch' && snap.videos.videos[1].plan.cost === 0.028, JSON.stringify(snap.videos.videos[1].plan));
  assert.ok(/batch_plan,claude-opus-5-5,high,4000,2000,0,0,0\.028,/.test(fs.readFileSync(path.join(FILES, 'cut_through_costs.csv'), 'utf8')));
  assert.ok(snap.steps.plan.log.some((l) => /Batch collected: 2 of 3 video\(s\) planned/.test(l)), snap.steps.plan.log.join('\n'));
  assert.strictEqual(snap.videosReady, 2);
  // a failed video is re-sent live on its own
  snap = await c2.planVideos({ ids: [a1.id], delivery: 'scripted' });
  assert.strictEqual(snap.videos.videos[0].plan.status, 'planned');
  assert.strictEqual(snap.videosReady, 3);
  // a section plan switches Build back to the one rough cut
  snap = await c2.runPlan({});
  assert.ok(snap.steps.plan.status === 'done' && !snap.videos.active && snap.videosReady === 0, snap.steps.plan.error);
  console.log('✓ videos end to end: slate J-codes → A1 / S1 (restart) / B2 → plan now (solo keeps both mic tracks, gap cut) → build PLAN_FILES → batch priced, sent, survives a restart, canceled, collected at half price, failed one re-sent');
}

(async () => {
  {
    let FFMPEG = null;
    try { FFMPEG = require('ffmpeg-static'); } catch (_) {}
    let hasFfmpeg = false;
    for (const c of [FFMPEG, 'ffmpeg'].filter(Boolean)) {
      try { execFileSync(c, ['-hide_banner', '-version'], { stdio: 'ignore' }); FFMPEG = c; hasFfmpeg = true; break; } catch (_) {}
    }
    const slDir = path.join(TMP, 'slider');
    fs.mkdirSync(slDir, { recursive: true });
    // slider detector: a synthetic slide (move 8 s, stop 2 s, back 8 s, stop 2 s) and a static shot
    if (hasFfmpeg) {
      const { sliderMotion } = require('../electron/workers/cut_through_motion');
      const clip = path.join(slDir, 'slide.mp4');
      const still = path.join(slDir, 'still.mp4');
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1200x360:r=24:d=40', '-vf',
        "crop=640:360:x='if(lt(mod(t,20),8),70*mod(t,20),if(lt(mod(t,20),10),560,if(lt(mod(t,20),18),560-70*(mod(t,20)-10),0)))':y=0",
        '-c:v', 'libx264', '-preset', 'ultrafast', clip]);
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', still]);
      const mv = await sliderMotion({ ffmpeg: FFMPEG, clips: [{ path: clip, file_zero_sec: 100, from_sec: 100, to_sec: 140 }], frameSec: 1 / 24 });
      const secs = mv.moving.map(([a, b]) => [a / 24 - 100, b / 24 - 100]);
      assert.strictEqual(secs.length, 4, JSON.stringify(secs));
      secs.forEach(([a, b], k) => assert.ok(a >= k * 10 && a <= k * 10 + 1.5 && b <= k * 10 + 8 && b >= k * 10 + 6.5, JSON.stringify(secs)));
      const st = await sliderMotion({ ffmpeg: FFMPEG, clips: [{ path: still, file_zero_sec: 0, from_sec: 0, to_sec: 20 }], frameSec: 1 / 24 });
      assert.strictEqual(st.moving.length, 0, st.report);
    } else {
      console.log('- slider detector check skipped (no ffmpeg)');
    }
    if (hasFfmpeg) console.log('✓ slider motion: a synthetic slide (move 8 s, stop, back) found, a static shot with movement in it not');
  }
  let prefs = {};
  const updates = [];
  const w = fakeWorker();
  // a stand-in Claude for the conversation: cuts to whoever's line it is (the wide first), removes nothing
  const convoRequests = [];
  const convoClaude = { beta: { messages: { stream: (params) => {
    convoRequests.push(params);
    const shots = [];
    for (const line of params.messages[0].content.split('\n')) {
      const m = /^\[\d+:\d+\] (Camera \d+): (\d+) /.exec(line);
      if (m) shots.push({ from: Number(m[2]), angle: shots.length ? m[1] : 'Camera 1', why: shots.length ? `${m[1]} talks` : 'open wide' });
    }
    const body = JSON.stringify({ removals: [], shots, notes: [] });
    return { on: () => {}, finalMessage: async () => ({ model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: body }],
      usage: { input_tokens: 1000, output_tokens: 200 } }) };
  } } } };
  const make = () => ct.createCutThrough({
    sendWorkerRequest: w.send,
    broadcast: (ch, data) => updates.push(data),
    getPrefs: () => prefs,
    setPrefs: (patch) => { prefs = { ...prefs, ...patch }; },
    pythonCmd: PY,
    desktopDir: DESKTOP, filesDir: FILES,
    claudeClient: convoClaude
  });
  // no run folder yet: nothing runs until the project has one
  prefs = { cutThrough: { pipelineDir: FAKE_PIPELINE, wxPython: PY } };
  await runFolderChecks(make);
  prefs = { cutThrough: { pipelineDir: FAKE_PIPELINE, wxPython: PY, runFolders: { 'Fake Project': FILES } } };
  const c = make();

  let snap = await c.listMulticams();
  assert.strictEqual(snap.multicams.length, 1);
  snap = c.select({ mc: 'mc_test', label: 'E2E test' });
  assert.strictEqual(snap.label, 'E2E_test');
  assert.strictEqual(snap.steps.prep.status, 'pending');

  snap = await c.runPrep();
  assert.strictEqual(snap.steps.prep.status, 'done', snap.steps.prep.error);
  assert.deepStrictEqual(snap.steps.prep.data.micAngles, ['Camera 2', 'Camera 3']);
  assert.strictEqual(snap.planKind, 'convo');
  // the recordings: every angle's camera clips, one stretch here (cameras rolled once)
  const prepDay = JSON.parse(fs.readFileSync(RUN('E2E_test', 'day_E2E_test.json'), 'utf8'));
  assert.deepStrictEqual(prepDay.recordings, [{ from_sec: 0, to_sec: 120.12 }]);

  // transcribe, canceled midway
  process.env.CT_FAKE_SLOW = '1';
  const pending = c.runTranscribe({});
  await new Promise((r) => setTimeout(r, 900));
  const reading = c.snapshot().steps.transcribe;
  assert.ok(/^Reading audio 1\/2 · 02MIC2.WAV · \d+ MB$/.test(reading.progress.phase), JSON.stringify(reading.progress));
  assert.ok(reading.progress.bar > 0 && reading.progress.bar < 50 && reading.progress.phaseAt, JSON.stringify(reading.progress));
  await new Promise((r) => setTimeout(r, 3600));
  const mid = c.snapshot().steps.transcribe;
  assert.strictEqual(mid.status, 'running');
  assert.ok(mid.progress && (mid.progress.angle === 'Camera 2' || /^Finding speech in Camera 2/.test(mid.progress.phase || '')), JSON.stringify(mid.progress));
  assert.ok(!mid.log.some((l) => /reading \d/.test(l)), 'reading lines leaked into the log');
  c.cancel();
  snap = await pending;
  assert.strictEqual(snap.steps.transcribe.status, 'canceled');
  delete process.env.CT_FAKE_SLOW;

  // a failing run: its own output (traceback) is the report, not an older file
  fs.writeFileSync(RUN('E2E_test', 'transcribe_E2E_test.txt'), 'OLD REPORT\n');
  process.env.CT_FAKE_FAIL = '1';
  snap = await c.runTranscribe({});
  delete process.env.CT_FAKE_FAIL;
  const bad = snap.steps.transcribe;
  assert.strictEqual(bad.status, 'failed');
  assert.ok(/exited with code 1: ModuleNotFoundError: No module named 'av'/.test(bad.error), bad.error);
  assert.ok(bad.report.some((l) => l.startsWith('Traceback')) && !bad.report.includes('OLD REPORT'), bad.report.join('\n'));
  assert.strictEqual(bad.reportFile, RUN('E2E_test', 'transcribe_E2E_test_log.txt'));
  assert.ok(/ModuleNotFoundError/.test(fs.readFileSync(bad.reportFile, 'utf8')));
  assert.strictEqual(snap.steps.prep.reportFile, RUN('E2E_test', 'day_prep_E2E_test.txt'));

  // transcribe for real (fake engine)
  snap = await c.runTranscribe({ minutes: '1' });
  const tr = snap.steps.transcribe;
  assert.strictEqual(tr.status, 'done', `${tr.error}\n${tr.log.join('\n')}`);
  assert.strictEqual(tr.progress.overall, 100);
  assert.strictEqual(tr.progress.mic, 2);
  assert.ok(tr.report[0].startsWith('Transcribe E2E_test'));
  assert.strictEqual(tr.reportFile, RUN('E2E_test', 'transcribe_E2E_test.txt'));
  assert.ok(!tr.log.some((l) => /\[#+/.test(l)), 'progress lines leaked into the log');

  // a conversation: Claude edits it too (convo brief, speaker-labelled transcript), place_cuts.py places + gates mics
  snap = await c.runPlan({ start: '', end: '' });
  const pl = snap.steps.plan;
  assert.strictEqual(pl.status, 'done', `${pl.error}\n${pl.log.join('\n')}`);
  assert.ok(pl.data.pieces > 0 && pl.data.angles['Camera 1'] >= 1 && pl.data.angles['Camera 2'] >= 1 && pl.data.angles['Camera 3'] >= 1, JSON.stringify(pl.data));
  const creq = convoRequests[convoRequests.length - 1];
  assert.ok(creq.system[0].text.includes('Angle = person') && /Delivery: A recorded conversation/.test(creq.messages[0].content) &&
    /2 people, each on their own mic \(Camera 2, Camera 3\)/.test(creq.messages[0].content) &&
    /Camera 2 = close-up of the person speaking on the Camera 2 mic/.test(creq.messages[0].content), creq.messages[0].content.slice(0, 500));
  const convoPlan = JSON.parse(fs.readFileSync(RUN('E2E_test', 'E2E_test_plan.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(convoPlan.mics).sort(), ['Camera 2', 'Camera 3']);
  assert.deepStrictEqual(convoPlan.mic_angles, { 'Camera 2': 'Camera 2', 'Camera 3': 'Camera 3' });
  // each mic opens around its owner's turns only: Camera 2 talks first (0.5–~9 s), Camera 3 from ~11.5 s
  const opens2 = convoPlan.mics['Camera 2'];
  const opens3 = convoPlan.mics['Camera 3'].filter((o) => o.length === 2);
  const duck3 = convoPlan.mics['Camera 3'].filter((o) => o.length === 3);
  assert.ok(duck3.length === 1 && duck3[0][2] === -2.5 && duck3[0][0] < 96 && duck3[0][1] > 96, JSON.stringify(convoPlan.mics['Camera 3'].slice(0, 3)));
  assert.ok(opens2[0][0] < 24 && opens3[0][0] > 250, JSON.stringify({ opens2: opens2.slice(0, 2), opens3: opens3.slice(0, 2) }));
  assert.ok(convoPlan.video.every((x, k) => !k || x.angle !== convoPlan.video[k - 1].angle));
  assert.ok(snap.planExists);
  await assert.rejects(c.runPlan({ start: '0:30', end: '0:10' }), /To must be after From/);
  // In/Out from Resolve: none marked → a clear error; marks from the clip start or on its TC clock
  await assert.rejects(c.readMarks(), /No In\/Out marked/);
  globalThis.FAKE_MARKS = { in: 240, out: 1199, bin: 'MC', multicams: 1 };
  let inOut = (await c.readMarks()).marks;
  assert.deepStrictEqual([inOut.from, inOut.to], [240, 1200]);
  globalThis.FAKE_MARKS = { in: null, out: 1199, bin: 'MC', multicams: 1 };
  inOut = (await c.readMarks()).marks;
  assert.deepStrictEqual([inOut.from, inOut.to], [0, 1200]);
  globalThis.FAKE_MARKS = null;

  snap = await c.runBuild({ seqBin: 'MASTER / SEQUENCES' });
  assert.strictEqual(snap.steps.build.status, 'done');
  const call = w.calls.filter((x) => x.cmd === 'ct_run_step').pop();
  assert.deepStrictEqual(call.settings, { LABEL: 'E2E_test', OUT_DIR: RUN('E2E_test', ''), PLAN_FILE: RUN('E2E_test', 'E2E_test_plan.json'), SEQ_BIN: 'MASTER / SEQUENCES' });
  assert.ok(call.trace_id);

  // live worker log lines land on the running step only
  c.onWorkerLog('nope', 'ignored');
  assert.ok(!c.snapshot().steps.build.log.includes('ignored'));

  // a fresh orchestrator finds earlier work on disk
  const c2 = make();
  const s2 = c2.snapshot();
  assert.strictEqual(s2.label, 'E2E_test');
  for (const k of ['prep', 'transcribe', 'plan']) {
    assert.strictEqual(s2.steps[k].status, 'done', k);
    assert.ok(s2.steps[k].earlier, k);
  }

  // switching Resolve projects: each project shows its own last run; nothing is deleted, and a
  // multicam name another project already used gets the project name in its label
  {
    let cur = 'Other Project';
    const send2 = (pl) => pl.cmd === 'ct_list_multicams'
      ? Promise.resolve({ data: { project: cur, multicams: [{ name: 'E2E test', bin: 'MC', duplicate: false }] } }) : w.send(pl);
    const cp = ct.createCutThrough({ sendWorkerRequest: send2, broadcast: () => {}, getPrefs: () => prefs,
      setPrefs: (patch) => { prefs = { ...prefs, ...patch }; }, pythonCmd: PY, desktopDir: DESKTOP, filesDir: FILES });
    assert.strictEqual(cp.snapshot().label, 'E2E_test', 'restored before the project is known');
    let sp = await cp.listMulticams();
    assert.strictEqual(sp.project, 'Other Project');
    assert.strictEqual(sp.label, '', 'another project\'s run still showing');
    assert.strictEqual(sp.steps.prep.status, 'pending');
    sp = cp.select({ mc: 'E2E test' });
    assert.strictEqual(sp.label, 'E2E_test_Other_Project', 'label clashes with Fake Project\'s run');
    cur = 'Fake Project';
    cp.onProject('Fake Project');
    await new Promise((r) => setImmediate(r));
    sp = cp.snapshot();
    assert.strictEqual(sp.label, 'E2E_test');
    assert.strictEqual(sp.steps.prep.status, 'done', 'earlier work gone after switching back');
    assert.ok(fs.existsSync(RUN('E2E_test', 'day_E2E_test.json')));
    cur = 'Other Project';
    cp.onProject('Other Project');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(cp.snapshot().label, 'E2E_test_Other_Project');
    prefs.cutThrough.lastLabel = 'E2E_test';
    prefs.cutThrough.lastMc = 'mc_test';
  }

  // solo day: Claude edits it (needs a key); an existing plan is accepted too
  const day = JSON.parse(fs.readFileSync(RUN('E2E_test', 'day_E2E_test.json'), 'utf8'));
  day.mics = day.mics.slice(0, 1);
  fs.writeFileSync(path.join(DESKTOP, 'day_Solo1.json'), JSON.stringify(day));
  fs.copyFileSync(RUN('E2E_test', 'words_E2E_test.json'), path.join(DESKTOP, 'words_Solo1.json'));
  c2.select({ mc: 'mc_test', label: 'Solo1' });
  assert.strictEqual(c2.snapshot().planKind, 'solo');
  assert.throws(() => c2.useExistingPlan(), /No readable/);
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const noKey = ct.createCutThrough({ sendWorkerRequest: w.send, broadcast: () => {}, getPrefs: () => prefs,
    setPrefs: (patch) => { prefs = { ...prefs, ...patch }; }, pythonCmd: PY, desktopDir: DESKTOP, filesDir: FILES });
  noKey.select({ mc: 'mc_test', label: 'Solo1' });
  await assert.rejects(noKey.runPlan({}), /Add a Claude API key/);
  if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
  fs.copyFileSync(RUN('E2E_test', 'E2E_test_plan.json'), RUN('Solo1', 'Solo1_plan.json'));
  assert.strictEqual(c2.useExistingPlan().steps.plan.status, 'done');

  // ── Claude as the solo editor (a stand-in client; the real API isn't called) ──
  const take = scriptedTake();
  const unheardAt = take.words.filter((w) => w.w === 'Feedback')[1].s - 20;   // a dropped mutter before the retake
  const soloDay = { ...day, angles: ['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4'], length_sec: take.seconds, audio_source: 'camera',
    mics: [{ ...day.mics[0], angle: 'Camera 1' }] };
  fs.writeFileSync(path.join(DESKTOP, 'day_Solo2.json'), JSON.stringify(soloDay));
  fs.writeFileSync(path.join(DESKTOP, 'words_Solo2.json'), JSON.stringify({ label: 'Solo2', multicam: 'mc_test', fps: take.fps, frame_sec: [1001, 24000],
    angles: soloDay.angles, mics: ['Camera 1'], words: take.words, unheard: [{ mic: 'Camera 1', s: unheardAt, e: unheardAt + 14 }] }));
  const requests = [];
  const fakeClaude = { beta: { messages: { stream: (params) => {
    requests.push(params);
    const text = params.messages[0].content;
    const ids = [...text.matchAll(/(\d+) (\S+)/g)].map((m) => ({ id: Number(m[1]), w: m[2] }));
    const at = (w, n = 0) => ids.filter((x) => x.w === w)[n].id;
    const unheard = Number(/(\d+) ⟨unheard sound/.exec(text)[1]);
    const answer = { removals: [
      { from: at('The'), to: at('three.'), kind: 'retake', reason: 'first try, redone after the count' },
      { from: at('you', 0), to: at('you', 0), kind: 'false_start', reason: 'you you' },
      { from: at('Feedback', 0), to: unheard, kind: 'retake', reason: 'first try + a mutter' }
    ], shots: [
      { from: at('Leadership'), angle: 'Camera 1', why: 'open wide' },
      { from: at('every'), angle: 'Camera 2', why: 'the point' },
      { from: at('The', 1), angle: 'Camera 1', why: 'after the retake' },
      { from: at('Feedback', 1), angle: 'Camera 2', why: 'new point' },
      { from: at('We'), angle: 'Camera 4', why: 'insert' },
      { from: at('That'), angle: 'Camera 1', why: 'close wide' },
      { from: 99999, angle: 'Camera 9', why: 'bad' }
    ], beats: [at('Leadership'), at('The'), 99999], notes: [{ at: at('That'), note: 'check the callback at the end' }] };
    const handlers = {};
    return {
      on: (ev, fn) => { handlers[ev] = fn; },
      finalMessage: async () => {
        const body = JSON.stringify(answer);
        if (handlers.text) handlers.text(body);
        return { model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: body }],
          usage: { input_tokens: 2400, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
      }
    };
  } } } };
  const c3 = ct.createCutThrough({ sendWorkerRequest: w.send, broadcast: () => {}, getPrefs: () => prefs,
    setPrefs: (patch) => { prefs = { ...prefs, ...patch }; }, pythonCmd: PY, desktopDir: DESKTOP, filesDir: FILES, claudeClient: fakeClaude });
  c3.select({ mc: 'mc_test', label: 'Solo2' });
  assert.strictEqual(c3.snapshot().planKind, 'solo');
  // a run from before 1.2.94 left its files on the Desktop: opening the label moves them into the run folder
  assert.ok(!fs.existsSync(path.join(DESKTOP, 'day_Solo2.json')) && fs.existsSync(RUN('Solo2', 'day_Solo2.json')), 'Desktop files not moved');
  assert.ok(!fs.existsSync(path.join(DESKTOP, 'words_Solo2.json')) && fs.existsSync(RUN('Solo2', 'words_Solo2.json')));
  assert.ok(!fs.existsSync(RUN('Solo2', 'levels_Solo2.json')));
  // angle rules: saved per project + multicam, checked, sent to Claude and the placer
  if (!c3.snapshot().project) c3.onProject('ProjT');
  assert.throws(() => c3.saveAngleRules({ rules: ['Camera 1>Camera 2', 'Camera 1>Camera 3', 'Camera 1>Camera 4'] }), /can't cut to any angle/);
  c3.saveAngleRules({ rules: ['Camera 2>Camera 3', 'Camera 3>Camera 2', 'Camera 9>Camera 1'] });
  assert.deepStrictEqual(c3.snapshot().angleRules, ['Camera 2>Camera 3', 'Camera 3>Camera 2']);
  const cl = (await c3.runPlan({ delivery: 'scripted', direction: 'Use the wide only to hide cuts.' })).steps.plan;
  assert.ok(/Never cut directly between these angles[^\n]*Camera 2 → Camera 3, Camera 3 → Camera 2/.test(requests[0].messages[0].content), 'rules not sent to Claude');
  assert.strictEqual(c3.snapshot().direction, 'Use the wide only to hide cuts.');
  assert.strictEqual(cl.status, 'done', `${cl.error}\n${cl.log.join('\n')}`);
  assert.ok(fs.existsSync(RUN('Solo2', 'levels_Solo2.json')), 'no levels-only pass');
  const req = requests[0];
  assert.strictEqual(req.model, 'claude-opus-5-5');
  assert.deepStrictEqual(req.thinking, { type: 'adaptive' });
  assert.strictEqual(req.output_config.effort, 'high');
  assert.strictEqual(req.output_config.format.type, 'json_schema');
  assert.strictEqual(req.fallbacks, 'default');
  assert.deepStrictEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(req.system[0].text.includes('Keep the last good take') && req.system[0].text.includes('Cut on the thought') && req.system[0].text.includes('Direction from Jordan'));
  assert.ok(/Direction from Jordan for this recording[^\n]*\nUse the wide only to hide cuts\./.test(req.messages[0].content), req.messages[0].content.slice(0, 600));
  assert.deepStrictEqual(req.output_config.format.schema.properties.shots.items.properties.angle.enum,
    ['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4']);
  assert.strictEqual(req.max_tokens, 128000);
  assert.ok(/Delivery: Scripted/.test(req.messages[0].content) &&
    /Angles:\n- Camera 1 = the wide — .+\n- Camera 2 = the close-up \(punch-in\) — .+\n- Camera 3 = the side angle — .+\n- Camera 4 = the slider \(moving shot\) — an insert/.test(req.messages[0].content) &&
    /about a quarter of his cuts after a removal land on one/.test(req.messages[0].content),
    req.messages[0].content.slice(0, 400));
  assert.ok(/⟨pause 3\.\d s⟩/.test(req.messages[0].content) && /\[0:02\] 0 Leadership/.test(req.messages[0].content), req.messages[0].content.slice(0, 300));
  const soloPlan = JSON.parse(fs.readFileSync(RUN('Solo2', 'Solo2_plan.json'), 'utf8'));
  const gone = (f) => soloPlan.removals.some((r) => r.from <= f && f < r.to);
  assert.strictEqual(take.words.filter((x) => !gone(x.s)).map((x) => x.w).join(' '), CLEAN);
  assert.ok(gone(unheardAt + 7), 'the unheard mutter stayed');
  assert.ok(soloPlan.removals.some((r) => r.why.startsWith('claude retake')) && /Claude/.test(soloPlan.note));
  // review markers: the retake (yellow, with Claude's reason) and Claude's check spot (red)
  assert.ok(!soloPlan.markers && soloPlan.review_file, 'markers belong beside the transcript, not in the plan');
  const mk = JSON.parse(fs.readFileSync(soloPlan.review_file, 'utf8')).markers;
  assert.ok(mk.some((m) => m.color === 'Yellow' && /Retake replaced/.test(m.name) && /first try/.test(m.note)), JSON.stringify(mk));
  assert.ok(mk.some((m) => m.color === 'Red' && /Check/.test(m.name) && /callback/.test(m.note)), JSON.stringify(mk));
  assert.ok(mk.every((m, k) => !k || m.frame - mk[k - 1].frame > 12), 'markers not combined');
  // a pause trim is cut in the quiet, so it never earns a "Clipped word" marker (Bill: 37 false alarms)
  const realCut = (f) => soloPlan.removals.some((r) => !r.why.startsWith('pause') && r.from - f >= 0 && r.from - f <= 24);
  assert.ok(mk.filter((m) => /Clipped word/.test(m.name)).every((m) => realCut(m.frame)), JSON.stringify(mk));
  const vv = soloPlan.video;
  assert.ok(vv[0].angle === 'Camera 1' && vv[vv.length - 1].angle === 'Camera 1' && vv.every((x, k) => !k || x.angle !== vv[k - 1].angle),
    JSON.stringify(vv.map((x) => x.angle)));
  assert.ok(vv.some((x) => x.angle === 'Camera 4') && vv.some((x) => x.why === 'claude shot'), 'Claude shots not used');
  // Z8 placement: every cut sits on the waveform, not on Whisper's (early) word ends
  const lv = JSON.parse(fs.readFileSync(RUN('Solo2', 'levels_Solo2.json'), 'utf8')).mics['Camera 1'].db;
  const loud = (f) => lv[f] > -40;
  for (const r of soloPlan.removals) {
    const quietBefore = [1, 2, 3].every((k) => !loud(r.from - k));
    const quietAfter = [0, 1].every((k) => !loud(r.to + k));      // scripted: ~2 fr before the incoming word
    assert.ok((quietBefore && quietAfter) || r.to - r.from < 20, `removal ${r.from}-${r.to} (${r.why}) not clear of sound`);
  }
  take.words.forEach((x, k) => {
    if (gone(x.s)) return;
    const next = take.words[k + 1];
    const own = next ? Math.min(Math.ceil(x.e) + 3, Math.floor(next.s) - 2) : Math.ceil(x.e) + 3;   // this word's own sound
    for (let f = Math.floor(x.s); f <= own; f++) {
      if (loud(f) && gone(f)) assert.fail(`kept word "${x.w}" clipped at frame ${f}`);
    }
  });
  // scripted head and tail (Jordan's edits, Compare 2026-11-09): 6 fr before the first word, 24 after the last sound
  const firstSound = lv.findIndex((v) => v > -40);
  let lastSound = lv.length - 1;
  while (lastSound > 0 && !(lv[lastSound] > -40)) lastSound -= 1;
  assert.strictEqual(vv[0].in, firstSound - 6, 'head');
  assert.ok(vv[vv.length - 1].out > lastSound + 12 && vv[vv.length - 1].out <= lastSound + 1 + 24, 'tail');   // capped by the recording's end
  const joins = new Set(soloPlan.removals.map((r) => r.to));
  for (const x of vv.slice(1).filter((x) => !joins.has(x.in))) {
    assert.ok(!loud(x.in), `picture cut at ${x.in} lands on sound`);
  }
  assert.ok(!JSON.stringify(soloPlan).includes('managers'), 'client words in the plan');
  assert.ok(cl.log.some((l) => /^Claude \(claude-opus-5-5, effort high, scripted\): 3 removals .*, 6 shots .* \$0\.028/.test(l)), cl.log.join('\n'));
  assert.ok(cl.log.some((l) => /skipped shot/.test(l)), 'bad shot not reported');
  assert.ok(cl.log.some((l) => /^Second pass/.test(l)), `no second pass line\n${cl.log.join('\n')}`);
  // beats: a kept word only (a removed one and a bad index dropped), saved as its end frame
  const rf = JSON.parse(fs.readFileSync(RUN('Solo2', 'removals_Solo2.json'), 'utf8'));
  assert.ok(Array.isArray(rf.beats) && rf.beats.length === 1 && Number.isFinite(rf.beats[0]), JSON.stringify(rf.beats));
  assert.ok(requests[requests.length - 1].output_config.format.schema.required.includes('beats'));
  assert.ok(cl.log.some((l) => /beats: 1/.test(l)), cl.log.join('\n'));
  assert.ok(cl.log.some((l) => /shots: Claude; .*cuts placed from the waveform/.test(l)), cl.log.join('\n'));
  assert.ok(cl.log.some((l) => /check \[\d+:\d+\]: check the callback/.test(l)), cl.log.join('\n'));
  assert.strictEqual(cl.reportFile, RUN('Solo2', 'claude_edit_Solo2.json'));
  assert.ok(fs.existsSync(RUN('Solo2', 'claude_edit_Solo2_claude-opus-5-5.json')), 'no per-model copy');
  assert.ok(/solo_plan,claude-opus-5-5,high,2400,900,0,0,0\.028,/.test(fs.readFileSync(path.join(FILES, 'cut_through_costs.csv'), 'utf8')));
  assert.ok(!JSON.stringify(c3.snapshot()).includes('sk-'), 'key in the snapshot');
  // Check every "<LABEL> rough cut" timeline (not "Other"); markers replaced under Check's tag
  const nCalls = w.calls.length;
  const ck = (await c3.runCheck({})).steps.check;
  assert.strictEqual(ck.status, 'done', ck.error);
  const sent = w.calls.slice(nCalls);
  assert.deepStrictEqual(sent.filter((c) => c.cmd === 'ct_read_timeline').map((c) => c.name), ['Solo2 rough cut', 'Solo2 rough cut 2']);
  assert.ok(sent.filter((c) => c.cmd === 'ct_set_markers').every((c) => c.tag === 'cut-through-check' && Array.isArray(c.markers)));
  assert.ok(fs.existsSync(RUN('Solo2', 'check_Solo2.txt')) && fs.existsSync(RUN('Solo2', 'check_Solo2.json')));
  assert.ok(ck.data.timelines === 2 && Number.isInteger(ck.data.red) && Number.isInteger(ck.data.yellow), JSON.stringify(ck.data));
  assert.ok(/^Checked 2 timeline\(s\)/.test(ck.report[0]), ck.report.join('\n'));
  const one = (await c3.runCheck({ timeline: 'Solo2 rough cut 2' })).steps.check;
  assert.ok(one.status === 'done' && one.data.timelines === 1, one.error);
  // Compare: an untouched rough cut is unchanged, read-only (no markers), with the audio read asked for
  const nCmp = w.calls.length;
  const cmp = (await c3.runCompare({})).steps.compare;
  assert.strictEqual(cmp.status, 'done', cmp.error);
  const cmpSent = w.calls.slice(nCmp);
  assert.ok(cmpSent.filter((c) => c.cmd === 'ct_read_timeline').every((c) => c.audio === true) && !cmpSent.some((c) => c.cmd === 'ct_set_markers'));
  assert.ok(cmp.data.timelines === 2 && cmp.data.changed === 0 && cmp.reportFile === RUN('Solo2', 'compare_Solo2.html'), JSON.stringify(cmp.data));
  assert.ok(fs.existsSync(RUN('Solo2', 'compare_Solo2.json')));
  // the brief is marked for caching; the transcript after it is not
  const lastReq = requests[requests.length - 1];
  assert.deepStrictEqual(lastReq.system[0].cache_control, { type: 'ephemeral' });
  assert.strictEqual(typeof lastReq.messages[0].content, 'string');
  // stage: the lighter brief + looser pause rule reach Claude and the planner
  const stage = (await c3.runPlan({ delivery: 'stage', roles: { 'Camera 3': 'skip' } })).steps.plan;
  assert.strictEqual(stage.status, 'done', stage.error);
  // angle roles: "don't use" never reaches Claude; saved for this project and shown back
  assert.deepStrictEqual(requests[requests.length - 1].output_config.format.schema.properties.shots.items.properties.angle.enum, ['Camera 1', 'Camera 2', 'Camera 4']);
  assert.strictEqual(c3.snapshot().angleRoles['Camera 3'], 'skip');
  assert.strictEqual(c3.snapshot().angleRoles['Camera 4'], 'slider');
  assert.strictEqual(prefs.cutThrough.lastAngleRoles['Camera 3'], 'skip');
  assert.ok(/Delivery: Live on stage/.test(requests[requests.length - 1].messages[0].content));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(RUN('Solo2', 'removals_Solo2.json'), 'utf8')).pauses, { max: 36, left: 18, min_save: 36 });
  assert.ok(stage.log.some((l) => /pauses > 36 fr → 18 fr/.test(l)), stage.log.join('\n'));
  // a declined / broken answer fails the step with the reason, and keeps the log
  fakeClaude.beta.messages.stream = () => ({ on: () => {}, finalMessage: async () => ({ stop_reason: 'refusal', stop_details: { category: 'test' }, content: [], usage: {} }) });
  const declined = (await c3.runPlan({})).steps.plan;
  assert.ok(declined.status === "failed" && /Claude: Claude declined \(test\)/.test(declined.error), declined.error);
  // an answer that ran out of room is still billed: its cost goes in the csv and the error (2026-11-06)
  fakeClaude.beta.messages.stream = () => ({ on: () => {}, finalMessage: async () => ({ model: 'claude-opus-5-5', stop_reason: 'max_tokens', content: [],
    usage: { input_tokens: 100000, output_tokens: 128000 } }) });
  const long = (await c3.runPlan({})).steps.plan;
  assert.ok(long.status === 'failed' && /billed \$2\.96/.test(long.error), long.error);
  assert.ok(/solo_plan_failed,claude-opus-5-5,high,100000,128000,0,0,2\.96,/.test(fs.readFileSync(path.join(FILES, 'cut_through_costs.csv'), 'utf8')));
  // key setting: saved on this machine, shown masked
  c3.updateSettings({ anthropicKey: 'sk-ant-test-1234' });
  assert.strictEqual(c3.snapshot().settings.claudeKey, 'saved …1234');
  assert.ok(!JSON.stringify(c3.snapshot()).includes('sk-ant-test'), 'key leaked to the renderer');
  console.log('✓ Claude solo editor: request shape, removals + shots → plan (last takes kept, unheard mutter cut, Claude\'s angles), cuts placed from the waveform (levels-only pass), stage delivery, cost logged, refusal reported, key never sent to the page');

  await videosEndToEnd({ w, getPrefs: () => prefs, setPrefs: (patch) => { prefs = { ...prefs, ...patch }; } });

  await new Promise((r) => setTimeout(r, 200));
  assert.ok(updates.length > 0, 'no updates broadcast');
  console.log('✓ orchestrator: select → prep → transcribe (cancel + run) → plan → build; earlier runs; solo seam');
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('cut-through checks passed');
})().catch((err) => {
  console.error(err);
  console.error(`(temp folder kept: ${TMP})`);
  process.exit(1);
});
