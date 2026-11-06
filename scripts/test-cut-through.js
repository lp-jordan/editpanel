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
fs.mkdirSync(DESKTOP, { recursive: true });
fs.mkdirSync(FAKE_PIPELINE, { recursive: true });

// ── 1. pure helpers ────────────────────────────────────────────
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
  console.log('✓ helpers');
}
{
  const { scorePlan } = require('../electron/workers/cut_through_score');
  const plan = { multicam: 'mc', fps: 24, video: [{ in: 0, out: 100, angle: 'A' }, { in: 200, out: 300, angle: 'B' }, { in: 350, out: 500, angle: 'A' }] };
  const finished = { name: 'J', fps: 24, pieces: [{ mc: 'mc', angle: 'A', src_in: 0, src_out: 100 }, { mc: 'mc', angle: 'A', src_in: 220, src_out: 500 },
    { mc: 'other', angle: 'B', src_in: 0, src_out: 999 }] };
  const { data } = scorePlan({ plan, finished });
  assert.deepStrictEqual(data.removed_s, { jordan: 5, ours: 6.3, overlap: 4.2, ours_only: 2.1 });   // he cut 100–220; we cut 100–200 + 300–350
  assert.strictEqual(data.removal_coverage_pct, 83);
  assert.deepStrictEqual(data.cuts, { ours: 2, jordan: 1, ours_within_1s: 1, jordan_within_1s: 1 });
  assert.strictEqual(data.same_angle_pct, 76);   // both keep 0–100 + 350–500 on A (250 fr) and 220–300 on B vs A (80 fr): 250/330
  assert.ok(data.extra.length === 1 && data.extra[0].from === 300 && data.missed.length === 1 && data.missed[0].from === 200);
  console.log('✓ score: removal overlap, cuts within 1 s, same-angle share, disagreement lists');
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
fs.writeFileSync(path.join(FAKE_PIPELINE, 'build_rough_cut.py'), 'REPO = r"C:\\lp-app-ecosystem\\editpanel"\n_lines = []\nprint("repo", REPO)\n_lines.append("✗ STOPPED after 0.1s: fake")\n');

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
bat = run_step(${JSON.stringify(path.join(FAKE_PIPELINE, 'build_rough_cut.py'))}, {"LABEL": "PyT"}, r, events.append, repo_dir="/some/repo")
print(json.dumps({"mcs": mcs, "res": res, "bat": bat, "events": events}))
`], { env: PY_ENV, encoding: 'utf8' });
  const lines = out.trim().split('\n');
  assert.strictEqual(lines.length, 1, `step prints leaked to stdout:\n${out}`);
  const r = JSON.parse(lines[0]);
  assert.deepStrictEqual(r.mcs, [{ name: 'mc_test', bin: 'MC', duplicate: false }]);
  assert.strictEqual(r.res.error, null, r.res.lines.join('\n'));
  assert.ok(r.res.lines.some((l) => l.includes("Multicam 'mc_test'")), r.res.lines.join('\n'));
  assert.ok(r.events.some((l) => l.includes('audio clip 02MIC2.WAV under Camera 2')));
  assert.ok(r.events.includes('repo /some/repo'), 'REPO line not pointed at the pipeline checkout');
  assert.ok(r.events.some((e) => /^▸ Reading mc_test's layout from Resolve$/.test(e)) && !r.res.lines.some((l) => l.startsWith('▸')), 'phase line missing, or in the report');
  assert.ok(r.bat.stopped && r.bat.error.startsWith('✗ STOPPED'));
  const day = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'day_PyT.json'), 'utf8'));
  assert.deepStrictEqual(day.mics.map((m) => m.angle), ['Camera 2', 'Camera 3']);
  assert.strictEqual(day.mics[1].file_zero_sec, -1);
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

// ── 2d. place_cuts.py on a scripted take: count retake, repeat retake, stutter, long pause ──
{
  const { words, fps, seconds: t } = scriptedTake();
  const angles = ['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4'];
  const wp = path.join(TMP, 'solo_words.json'), dp = path.join(TMP, 'solo_day.json'), pp = path.join(TMP, 'solo_plan.json');
  fs.writeFileSync(wp, JSON.stringify({ label: 'SoloT', multicam: 'mc_x', fps, frame_sec: [1001, 24000], angles, mics: ['Camera 1'], words }));
  fs.writeFileSync(dp, JSON.stringify({ multicam: 'mc_x', fps, frame_sec: [1001, 24000], length_sec: t + 5, angles, audio_source: 'camera', mics: [{ angle: 'Camera 1' }] }));
  const out = execFileSync(PY, [path.join(PIPELINE, 'place_cuts.py'), wp, dp, pp, 'extra=Camera 4'], { encoding: 'utf8' });
  const plan = JSON.parse(fs.readFileSync(pp, 'utf8'));
  const cut = (f) => plan.removals.some((r) => r.from <= f && f < r.to);
  const kept = words.filter((w) => !cut(w.s)).map((w) => w.w).join(' ');
  assert.strictEqual(kept, CLEAN, out);
  assert.ok(words.every((w) => cut(w.s) === cut(w.e - 0.5)), 'a word is cut in half');
  const v = plan.video;
  assert.strictEqual(v[0].angle, 'Camera 1');
  assert.strictEqual(v[v.length - 1].angle, 'Camera 1');
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
</mc-angle></multicam></media>
<asset hasVideo="1" hasAudio="1" id="r2" start="100/1s"><media-rep src="file://localhost/N:/cam.MXF" kind="original-media"/></asset>
<asset hasAudio="1" id="r4" start="100/1s"><media-rep src="file://localhost/N:/cam.MXF" kind="original-media"/></asset></resources>'''
refs = m.camera_audio_refs(res)
blk = re.findall(r"<media [^>]*>\s*<multicam .*?</media>", res, re.S)[0]
folded_xml, folded = m.fold_camera_audio(blk, refs)
fixed, wavs = m.split_off_angle_tracks(folded_xml, keep_refs=set(refs))
inside = re.search(r'<video [^>]*ref="r2"[^>]*>\s*<audio [^>]*ref="r2"', fixed) is not None
print(json.dumps({"refs": refs, "folded": sorted(folded), "inside": inside, "r4_left": 'ref="r4"' in fixed, "wavs": len(wavs)}))
`, PIPELINE], { encoding: 'utf8' }));
  // folded back inside the picture clip (a separate clip of the audio-only asset imported as an
  // EMPTY compound clip → silent A1, Bill Smith mc_1 twice)
  assert.deepStrictEqual(sep, { refs: { r4: 'r2' }, folded: ['r4'], inside: true, r4_left: false, wavs: 0 });
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
  console.log('✓ place_cuts.py: last take kept, stutter + count removed, topic repeat kept, no jump cuts, camera audio, no ping-pong at removals');
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
    if (payload.cmd === 'ct_read_timeline') {
      const plan = JSON.parse(fs.readFileSync(path.join(FAKE_PIPELINE, 'plans', `${payload.name.replace(/^Jordan_/, '')}_plan.json`), 'utf8'));
      // "Jordan's edit": our pieces, but he also removed the first 2 s of the longest one
      const longest = plan.video.reduce((b, v, k) => (v.out - v.in > plan.video[b].out - plan.video[b].in ? k : b), 0);
      const pieces = plan.video.map((v, k) => ({ mc: plan.multicam, angle: v.angle, start: 0, end: 0,
        src_in: k === longest ? v.in + 48 : v.in, src_out: v.out }));
      return Promise.resolve({ data: { name: payload.name, fps: plan.fps, track: 1, pieces } });
    }
    if (payload.cmd === 'ct_run_step' && payload.script === 'build_rough_cut.py') {
      return Promise.resolve({ data: { lines: ['1. Exported', '4. Split done (2.0s)', '', 'Total time: 16.0s'], error: null, stopped: null } });
    }
    return Promise.reject(new Error(`unexpected ${payload.cmd}`));
  };
  return { send, calls };
}

(async () => {
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
    desktopDir: DESKTOP,
    claudeClient: convoClaude
  });
  prefs = { cutThrough: { pipelineDir: FAKE_PIPELINE, wxPython: PY } };
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
  fs.writeFileSync(path.join(DESKTOP, 'transcribe_E2E_test.txt'), 'OLD REPORT\n');
  process.env.CT_FAKE_FAIL = '1';
  snap = await c.runTranscribe({});
  delete process.env.CT_FAKE_FAIL;
  const bad = snap.steps.transcribe;
  assert.strictEqual(bad.status, 'failed');
  assert.ok(/exited with code 1: ModuleNotFoundError: No module named 'av'/.test(bad.error), bad.error);
  assert.ok(bad.report.some((l) => l.startsWith('Traceback')) && !bad.report.includes('OLD REPORT'), bad.report.join('\n'));
  assert.strictEqual(bad.reportFile, path.join(DESKTOP, 'transcribe_E2E_test_log.txt'));
  assert.ok(/ModuleNotFoundError/.test(fs.readFileSync(bad.reportFile, 'utf8')));
  assert.strictEqual(snap.steps.prep.reportFile, path.join(DESKTOP, 'day_prep_E2E_test.txt'));

  // transcribe for real (fake engine)
  snap = await c.runTranscribe({ minutes: '1' });
  const tr = snap.steps.transcribe;
  assert.strictEqual(tr.status, 'done', `${tr.error}\n${tr.log.join('\n')}`);
  assert.strictEqual(tr.progress.overall, 100);
  assert.strictEqual(tr.progress.mic, 2);
  assert.ok(tr.report[0].startsWith('Transcribe E2E_test'));
  assert.strictEqual(tr.reportFile, path.join(DESKTOP, 'transcribe_E2E_test.txt'));
  assert.ok(!tr.log.some((l) => /\[#+/.test(l)), 'progress lines leaked into the log');

  // a conversation: Claude edits it too (convo brief, speaker-labelled transcript), place_cuts.py places + gates mics
  snap = await c.runPlan({ start: '', end: '', extra: '' });
  const pl = snap.steps.plan;
  assert.strictEqual(pl.status, 'done', `${pl.error}\n${pl.log.join('\n')}`);
  assert.ok(pl.data.pieces > 0 && pl.data.angles['Camera 1'] >= 1 && pl.data.angles['Camera 2'] >= 1 && pl.data.angles['Camera 3'] >= 1, JSON.stringify(pl.data));
  const creq = convoRequests[convoRequests.length - 1];
  assert.ok(creq.system.includes('Angle = person') && /Delivery: A recorded conversation/.test(creq.messages[0].content) &&
    /2 people, each on their own mic \(Camera 2, Camera 3\)/.test(creq.messages[0].content) &&
    /Camera 2 = close-up of the person speaking on the Camera 2 mic/.test(creq.messages[0].content), creq.messages[0].content.slice(0, 500));
  const convoPlan = JSON.parse(fs.readFileSync(path.join(FAKE_PIPELINE, 'plans', 'E2E_test_plan.json'), 'utf8'));
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
  assert.deepStrictEqual(call.settings, { LABEL: 'E2E_test', SEQ_BIN: 'MASTER / SEQUENCES' });
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
      setPrefs: (patch) => { prefs = { ...prefs, ...patch }; }, pythonCmd: PY, desktopDir: DESKTOP });
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
    assert.ok(fs.existsSync(path.join(DESKTOP, 'day_E2E_test.json')));
    cur = 'Other Project';
    cp.onProject('Other Project');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(cp.snapshot().label, 'E2E_test_Other_Project');
    prefs.cutThrough.lastLabel = 'E2E_test';
    prefs.cutThrough.lastMc = 'mc_test';
  }

  // solo day: Claude edits it (needs a key); an existing plan is accepted too
  const day = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'day_E2E_test.json'), 'utf8'));
  day.mics = day.mics.slice(0, 1);
  fs.writeFileSync(path.join(DESKTOP, 'day_Solo1.json'), JSON.stringify(day));
  fs.copyFileSync(path.join(DESKTOP, 'words_E2E_test.json'), path.join(DESKTOP, 'words_Solo1.json'));
  c2.select({ mc: 'mc_test', label: 'Solo1' });
  assert.strictEqual(c2.snapshot().planKind, 'solo');
  assert.throws(() => c2.useExistingPlan(), /No readable/);
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const noKey = ct.createCutThrough({ sendWorkerRequest: w.send, broadcast: () => {}, getPrefs: () => prefs,
    setPrefs: (patch) => { prefs = { ...prefs, ...patch }; }, pythonCmd: PY, desktopDir: DESKTOP });
  noKey.select({ mc: 'mc_test', label: 'Solo1' });
  await assert.rejects(noKey.runPlan({}), /Add a Claude API key/);
  if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
  fs.copyFileSync(path.join(FAKE_PIPELINE, 'plans', 'E2E_test_plan.json'), path.join(FAKE_PIPELINE, 'plans', 'Solo1_plan.json'));
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
    ], notes: [{ at: at('That'), note: 'check the callback at the end' }] };
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
    setPrefs: (patch) => { prefs = { ...prefs, ...patch }; }, pythonCmd: PY, desktopDir: DESKTOP, claudeClient: fakeClaude });
  c3.select({ mc: 'mc_test', label: 'Solo2' });
  assert.strictEqual(c3.snapshot().planKind, 'solo');
  assert.ok(!fs.existsSync(path.join(DESKTOP, 'levels_Solo2.json')));
  const cl = (await c3.runPlan({ extra: 'Camera 4', delivery: 'scripted', direction: 'Use the wide only to hide cuts.' })).steps.plan;
  assert.strictEqual(c3.snapshot().direction, 'Use the wide only to hide cuts.');
  assert.strictEqual(cl.status, 'done', `${cl.error}\n${cl.log.join('\n')}`);
  assert.ok(fs.existsSync(path.join(DESKTOP, 'levels_Solo2.json')), 'no levels-only pass');
  const req = requests[0];
  assert.strictEqual(req.model, 'claude-opus-5-5');
  assert.deepStrictEqual(req.thinking, { type: 'adaptive' });
  assert.strictEqual(req.output_config.effort, 'high');
  assert.strictEqual(req.output_config.format.type, 'json_schema');
  assert.strictEqual(req.fallbacks, 'default');
  assert.deepStrictEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(req.system.includes('Keep the last good take') && req.system.includes('Cut on the thought') && req.system.includes('Direction from Jordan'));
  assert.ok(/Direction from Jordan for this recording[^\n]*\nUse the wide only to hide cuts\./.test(req.messages[0].content), req.messages[0].content.slice(0, 600));
  assert.deepStrictEqual(req.output_config.format.schema.properties.shots.items.properties.angle.enum,
    ['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4']);
  assert.strictEqual(req.max_tokens, 128000);
  assert.ok(/Delivery: Scripted/.test(req.messages[0].content) &&
    /Angles: Camera 1 = the wide; Camera 2 = the close-up \(punch-in\); Camera 3 = another angle; Camera 4 = an insert angle/.test(req.messages[0].content),
    req.messages[0].content.slice(0, 400));
  assert.ok(/⟨pause 3\.\d s⟩/.test(req.messages[0].content) && /\[0:02\] 0 Leadership/.test(req.messages[0].content), req.messages[0].content.slice(0, 300));
  const soloPlan = JSON.parse(fs.readFileSync(path.join(FAKE_PIPELINE, 'plans', 'Solo2_plan.json'), 'utf8'));
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
  const lv = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'levels_Solo2.json'), 'utf8')).mics['Camera 1'].db;
  const loud = (f) => lv[f] > -40;
  for (const r of soloPlan.removals) {
    const quietBefore = [1, 2, 3].every((k) => !loud(r.from - k));
    const quietAfter = [0, 1, 2].every((k) => !loud(r.to + k));
    assert.ok((quietBefore && quietAfter) || r.to - r.from < 20, `removal ${r.from}-${r.to} (${r.why}) not 3 fr clear of sound`);
  }
  take.words.forEach((x, k) => {
    if (gone(x.s)) return;
    const next = take.words[k + 1];
    const own = next ? Math.min(Math.ceil(x.e) + 3, Math.floor(next.s) - 2) : Math.ceil(x.e) + 3;   // this word's own sound
    for (let f = Math.floor(x.s); f <= own; f++) {
      if (loud(f) && gone(f)) assert.fail(`kept word "${x.w}" clipped at frame ${f}`);
    }
  });
  // head and tail from the waveform: fade-in ends 3 fr before the first sound, fade-out starts 3 fr after the last
  const firstSound = lv.findIndex((v) => v > -40);
  let lastSound = lv.length - 1;
  while (lastSound > 0 && !(lv[lastSound] > -40)) lastSound -= 1;
  assert.strictEqual(vv[0].in, firstSound - 11, 'head');
  assert.strictEqual(vv[vv.length - 1].out, lastSound + 1 + 3 + 8, 'tail');
  const joins = new Set(soloPlan.removals.map((r) => r.to));
  for (const x of vv.slice(1).filter((x) => !joins.has(x.in))) {
    assert.ok(!loud(x.in), `picture cut at ${x.in} lands on sound`);
  }
  assert.ok(!JSON.stringify(soloPlan).includes('managers'), 'client words in the plan');
  assert.ok(cl.log.some((l) => /^Claude \(claude-opus-5-5, effort high, scripted\): 3 removals .*, 6 shots .* \$0\.028/.test(l)), cl.log.join('\n'));
  assert.ok(cl.log.some((l) => /skipped shot/.test(l)), 'bad shot not reported');
  assert.ok(cl.log.some((l) => /shots: Claude; .*cuts placed from the waveform/.test(l)), cl.log.join('\n'));
  assert.ok(cl.log.some((l) => /check \[\d+:\d+\]: check the callback/.test(l)), cl.log.join('\n'));
  assert.strictEqual(cl.reportFile, path.join(DESKTOP, 'claude_edit_Solo2.json'));
  assert.ok(fs.existsSync(path.join(DESKTOP, 'claude_edit_Solo2_claude-opus-5-5.json')), 'no per-model copy');
  assert.ok(/solo_plan,claude-opus-5-5,high,2400,900,0,0,0\.028,/.test(fs.readFileSync(path.join(DESKTOP, 'cut_through_costs.csv'), 'utf8')));
  assert.ok(!JSON.stringify(c3.snapshot()).includes('sk-'), 'key in the snapshot');
  // Score against "Jordan's edit" (the fake worker's copy of this plan minus 2 s he cut)
  const sc = (await c3.runScore({ timeline: 'Jordan_Solo2' })).steps.score;
  assert.strictEqual(sc.status, 'done', sc.error);
  assert.ok(fs.existsSync(path.join(DESKTOP, 'score_Solo2.txt')) && fs.existsSync(path.join(DESKTOP, 'score_Solo2.json')));
  assert.strictEqual(sc.data.removed_s.ours_only, 0);
  assert.ok(sc.data.missed.length === 1 && sc.data.missed[0].seconds === 2 && sc.data.same_angle_pct === 100, JSON.stringify(sc.data));
  assert.ok(sc.report.some((l) => /^Jordan removed, we kept/.test(l)), sc.report.join('\n'));
  // stage: the lighter brief + looser pause rule reach Claude and the planner
  const stage = (await c3.runPlan({ delivery: 'stage' })).steps.plan;
  assert.strictEqual(stage.status, 'done', stage.error);
  assert.ok(/Delivery: Live on stage/.test(requests[requests.length - 1].messages[0].content));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(DESKTOP, 'removals_Solo2.json'), 'utf8')).pauses, { max: 36, left: 18, min_save: 36 });
  assert.ok(stage.log.some((l) => /pauses > 36 fr → 18 fr/.test(l)), stage.log.join('\n'));
  // a declined / broken answer fails the step with the reason, and keeps the log
  fakeClaude.beta.messages.stream = () => ({ on: () => {}, finalMessage: async () => ({ stop_reason: 'refusal', stop_details: { category: 'test' }, content: [], usage: {} }) });
  const declined = (await c3.runPlan({})).steps.plan;
  assert.ok(declined.status === "failed" && /Claude: Claude declined \(test\)/.test(declined.error), declined.error);
  // key setting: saved on this machine, shown masked
  c3.updateSettings({ anthropicKey: 'sk-ant-test-1234' });
  assert.strictEqual(c3.snapshot().settings.claudeKey, 'saved …1234');
  assert.ok(!JSON.stringify(c3.snapshot()).includes('sk-ant-test'), 'key leaked to the renderer');
  console.log('✓ Claude solo editor: request shape, removals + shots → plan (last takes kept, unheard mutter cut, Claude\'s angles), cuts placed from the waveform (levels-only pass), stage delivery, cost logged, refusal reported, key never sent to the page');

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
