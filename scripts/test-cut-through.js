/**
 * Cut-through (beta) checks that run without Resolve or a GPU.
 *
 *   node scripts/test-cut-through.js
 *
 * 1. Pure helpers (progress-line parsing, labels, cuts, planner choice).
 * 2. helper/commands/cut_through.py: multicam listing + spike exec with print
 *    capture, against a fake Resolve. The REAL spikes/spike_day_prep.py runs
 *    on it (the fake exports a small synthetic FCPXML).
 * 3. electron/workers/cut_through.js end to end in a temp folder:
 *    prep (fake worker → real day prep) → transcribe (fake transcribe_day.py
 *    printing the real progress-bar format) → cancel → plan (REAL
 *    plan_convo.py) → build (fake worker reply; the batch needs Resolve).
 * Nothing touches the real Desktop: HOME points at the temp folder.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ct = require('../electron/workers/cut_through');

const REPO = path.join(__dirname, '..');
const SPIKES = path.join(REPO, 'spikes');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-test-'));
const HOME = path.join(TMP, 'home');
const DESKTOP = path.join(HOME, 'Desktop');
const FAKE_SPIKES = path.join(TMP, 'spikes');
fs.mkdirSync(DESKTOP, { recursive: true });
fs.mkdirSync(FAKE_SPIKES, { recursive: true });

// ── 1. pure helpers ────────────────────────────────────────────
{
  const p = ct.parseProgress('  Camera 2 [######-------------------]  24%  5.4/22.6 min  41s');
  assert.deepStrictEqual(p, { angle: 'Camera 2', pct: 24, doneMin: 5.4, totalMin: 22.6, seconds: 41 });
  assert.strictEqual(ct.parseProgress('Loading the model on cuda…'), null);
  assert.strictEqual(ct.parseProgress('  Camera 3 [#########################] 100%  22.6/22.6 min  180s').pct, 100);
  assert.strictEqual(ct.sanitizeLabel(' Frenzy Q4 / mc_2 '), 'Frenzy_Q4_mc_2');
  assert.deepStrictEqual(ct.parseCuts('100-200, 300-450'), ['100-200', '300-450']);
  assert.throws(() => ct.parseCuts('300-100'));
  assert.strictEqual(ct.planKind({ mics: [{ angle: 'Camera 2' }, { angle: 'Camera 2' }] }), 'solo');
  assert.strictEqual(ct.planKind({ mics: [{ angle: 'Camera 2' }, { angle: 'Camera 3' }] }), 'convo');
  assert.strictEqual(ct.dayFrames({ length_sec: 120.12, frame_sec: [1001, 24000] }), 2880);
  console.log('✓ helpers');
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

// Prints exactly what transcribe_day.py prints, writes plausible outputs.
const FAKE_TRANSCRIBE = String.raw`
import json, os, sys, time
args = [a for a in sys.argv[1:] if "=" not in a]
opts = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
label, desk = args[0], opts["dir"]
slow = os.environ.get("CT_FAKE_SLOW") == "1"
day = json.load(open(os.path.join(desk, f"day_{label}.json"), encoding="utf-8"))
print(f"Reading {len(day['mics'])} mic file(s)…", flush=True)
print("Loading the model on cuda…", flush=True)
words = []
for m in day["mics"]:
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
json.dump({"label": label, "multicam": day["multicam"], "fps": day["fps"], "frame_sec": day["frame_sec"],
           "angles": day["angles"], "mics": ["Camera 2", "Camera 3"], "words": words},
          open(os.path.join(desk, f"words_{label}.json"), "w", encoding="utf-8"))
open(os.path.join(desk, f"transcribe_{label}.txt"), "w", encoding="utf-8").write(f"Transcribe {label} — fake\n{len(words)} words\n")
print(f"{len(words)} words")
`;

fs.writeFileSync(path.join(TMP, 'fake_resolve.py'), FAKE_RESOLVE);
fs.writeFileSync(path.join(FAKE_SPIKES, 'transcribe_day.py'), FAKE_TRANSCRIBE);
for (const f of ['spike_day_prep.py', 'plan_convo.py']) fs.copyFileSync(path.join(SPIKES, f), path.join(FAKE_SPIKES, f));
// The batch needs Resolve for real; the worker side is faked below, so a
// placeholder is enough for the allow-list path check.
fs.writeFileSync(path.join(FAKE_SPIKES, 'spike_cut_through_batch.py'), 'REPO = r"C:\\lp-app-ecosystem\\editpanel"\n_lines = []\nprint("repo", REPO)\n_lines.append("✗ STOPPED after 0.1s: fake")\n');

const PY_ENV = { ...process.env, HOME, USERPROFILE: HOME, PYTHONPATH: `${REPO}${path.delimiter}${TMP}`, PYTHONIOENCODING: 'utf-8' };

// ── 2. Python side ─────────────────────────────────────────────
{
  const out = execFileSync(PY, ['-c', String.raw`
import json, builtins
from fake_resolve import Resolve
from helper.commands.cut_through import list_multicams, run_spike
r = Resolve()
mcs = list_multicams(r.GetProjectManager().GetCurrentProject().GetMediaPool().GetRootFolder())
events = []
real_print = builtins.print
res = run_spike(${JSON.stringify(path.join(FAKE_SPIKES, 'spike_day_prep.py'))}, {"LABEL": "PyT", "MC": "mc_test"}, r, events.append)
assert builtins.print is real_print
bat = run_spike(${JSON.stringify(path.join(FAKE_SPIKES, 'spike_cut_through_batch.py'))}, {"LABEL": "PyT"}, r, events.append, repo_dir="/some/repo")
print(json.dumps({"mcs": mcs, "res": res, "bat": bat, "events": events}))
`], { env: PY_ENV, encoding: 'utf8' });
  const lines = out.trim().split('\n');
  assert.strictEqual(lines.length, 1, `spike prints leaked to stdout:\n${out}`);
  const r = JSON.parse(lines[0]);
  assert.deepStrictEqual(r.mcs, [{ name: 'mc_test', bin: 'MC', duplicate: false }]);
  assert.strictEqual(r.res.error, null, r.res.lines.join('\n'));
  assert.ok(r.res.lines.some((l) => l.includes("Multicam 'mc_test'")), r.res.lines.join('\n'));
  assert.ok(r.events.some((l) => l.includes('audio clip 02MIC2.WAV under Camera 2')));
  assert.ok(r.events.includes('repo /some/repo'), 'REPO line not pointed at the spikes checkout');
  assert.ok(r.bat.stopped && r.bat.error.startsWith('✗ STOPPED'));
  const day = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'day_PyT.json'), 'utf8'));
  assert.deepStrictEqual(day.mics.map((m) => m.angle), ['Camera 2', 'Camera 3']);
  assert.strictEqual(day.mics[1].file_zero_sec, -1);
  console.log('✓ python: multicam list, spike exec + print capture, real day prep on a fake Resolve');
}

// ── 2b. day with no mic WAVs: camera audio (ATEM mix / in-camera, track 1) ──
{
  const out = execFileSync(PY, ['-c', String.raw`
import json
from fake_resolve import Resolve
from helper.commands.cut_through import run_spike
p = ${JSON.stringify(path.join(FAKE_SPIKES, 'spike_day_prep.py'))}
a = run_spike(p, {"LABEL": "Cam1", "MC": "mc_test"}, Resolve(), lambda l: None)
b = run_spike(p, {"LABEL": "Cam2", "MC": "mc_test", "AUDIO_ANGLE": "Camera 2"}, Resolve(), lambda l: None)
c = run_spike(p, {"LABEL": "Cam3", "MC": "mc_test", "AUDIO_ANGLE": "Camera 3"}, Resolve(), lambda l: None)
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

// ── 2c. the real transcribe_day.py on that day, Whisper/PyAV stubbed ──
// Needs numpy: CT_TEST_PYTHON=<python with numpy> (skipped otherwise).
if (process.env.CT_TEST_PYTHON) {
  const STUBS = path.join(TMP, 'stubs');
  fs.mkdirSync(path.join(STUBS, 'faster_whisper'), { recursive: true });
  fs.writeFileSync(path.join(STUBS, 'ctranslate2.py'), 'def get_cuda_device_count():\n    return 0\n');
  fs.writeFileSync(path.join(STUBS, 'faster_whisper', 'audio.py'), String.raw`
import numpy as np
def decode_audio(path, sampling_rate=16000):
    # 70 s file: a loud burst at file second 20 (CAM1_01) / 5 (CAM1_02), quiet elsewhere
    x = np.full(70 * sampling_rate, 0.001, np.float32)
    at = 20 if "CAM1_01" in path else 5
    x[at * sampling_rate:(at + 1) * sampling_rate] = 0.1
    return x
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
        return [_S(s, s + 1, [_W(s, s + 0.5, f"w{s}")]) for s in secs], None
`);
  const out = execFileSync(process.env.CT_TEST_PYTHON, [path.join(SPIKES, 'transcribe_day.py'), 'Cam1', `dir=${DESKTOP}`],
    { env: { ...PY_ENV, PYTHONPATH: STUBS }, encoding: 'utf8' });
  const words = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'words_Cam1.json'), 'utf8'));
  assert.deepStrictEqual(words.mics, ['Camera 1'], out);
  // CAM1_01 burst at file 20 s → multicam 10 s; CAM1_02 burst at file 5 s → multicam 65 s
  const fps = 24000 / 1001;
  assert.deepStrictEqual(words.words.map((w) => Math.round(w.s / fps)), [10, 65], JSON.stringify(words.words));
  assert.ok(words.words.every((w) => w.own));
  assert.ok(/camera audio, 1 track/.test(fs.readFileSync(path.join(DESKTOP, 'transcribe_Cam1.txt'), 'utf8')));
  console.log('✓ transcribe_day.py: camera clips on one angle → one track on the multicam clock');
} else {
  console.log('- transcribe_day.py check skipped (set CT_TEST_PYTHON to a Python with numpy)');
}

// ── 3. orchestrator end to end ─────────────────────────────────
function fakeWorker() {
  const calls = [];
  const send = (payload) => {
    calls.push(payload);
    if (payload.cmd === 'ct_list_multicams') {
      return Promise.resolve({ data: { project: 'Fake Project', multicams: [{ name: 'mc_test', bin: 'MC', duplicate: false }] } });
    }
    if (payload.cmd === 'ct_run_spike' && payload.script === 'spike_day_prep.py') {
      // Run the real handler code path (minus the worker loop) on the fake Resolve.
      return new Promise((resolve, reject) => {
        const code = String.raw`
import json, sys
from fake_resolve import Resolve
from helper.commands.cut_through import run_spike
p = json.loads(sys.stdin.read())
res = run_spike(p["spikes_dir"] + "/" + p["script"], p["settings"], Resolve(), lambda l: None)
sys.stdout.write(json.dumps(res))`;
        const proc = spawn(PY, ['-c', code], { env: PY_ENV });
        let out = '';
        proc.stdout.on('data', (d) => { out += d; });
        proc.stderr.on('data', (d) => process.stderr.write(d));
        proc.on('close', () => { try { resolve({ data: JSON.parse(out) }); } catch (e) { reject(e); } });
        proc.stdin.end(JSON.stringify(payload));
      });
    }
    if (payload.cmd === 'ct_run_spike' && payload.script === 'spike_cut_through_batch.py') {
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
  const make = () => ct.createCutThrough({
    sendWorkerRequest: w.send,
    broadcast: (ch, data) => updates.push(data),
    getPrefs: () => prefs,
    setPrefs: (patch) => { prefs = { ...prefs, ...patch }; },
    pythonCmd: PY,
    desktopDir: DESKTOP
  });
  prefs = { cutThrough: { spikesDir: FAKE_SPIKES, wxPython: PY } };
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
  await new Promise((r) => setTimeout(r, 1800));
  const mid = c.snapshot().steps.transcribe;
  assert.strictEqual(mid.status, 'running');
  assert.ok(mid.progress && (mid.progress.angle === 'Camera 2' || mid.progress.phase), JSON.stringify(mid.progress));
  c.cancel();
  snap = await pending;
  assert.strictEqual(snap.steps.transcribe.status, 'canceled');
  delete process.env.CT_FAKE_SLOW;

  // transcribe for real (fake engine)
  snap = await c.runTranscribe({ minutes: '1' });
  const tr = snap.steps.transcribe;
  assert.strictEqual(tr.status, 'done', `${tr.error}\n${tr.log.join('\n')}`);
  assert.strictEqual(tr.progress.overall, 100);
  assert.strictEqual(tr.progress.mic, 2);
  assert.ok(tr.report[0].startsWith('Transcribe E2E_test'));
  assert.ok(!tr.log.some((l) => /\[#+/.test(l)), 'progress lines leaked into the log');

  // plan with the real plan_convo.py
  snap = await c.runPlan({ start: '', end: '', extra: '', cuts: '' });
  const pl = snap.steps.plan;
  assert.strictEqual(pl.status, 'done', `${pl.error}\n${pl.log.join('\n')}`);
  assert.ok(pl.data.pieces > 0 && pl.data.angles['Camera 1'] >= 1, JSON.stringify(pl.data));
  assert.ok(snap.planExists);
  await assert.rejects(c.runPlan({ cuts: 'junk' }), /must be/);

  snap = await c.runBuild({ seqBin: 'MASTER / SEQUENCES' });
  assert.strictEqual(snap.steps.build.status, 'done');
  const call = w.calls.filter((x) => x.cmd === 'ct_run_spike').pop();
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

  // solo day: no planner, existing plan accepted
  const day = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'day_E2E_test.json'), 'utf8'));
  day.mics = day.mics.slice(0, 1);
  fs.writeFileSync(path.join(DESKTOP, 'day_Solo1.json'), JSON.stringify(day));
  fs.copyFileSync(path.join(DESKTOP, 'words_E2E_test.json'), path.join(DESKTOP, 'words_Solo1.json'));
  c2.select({ mc: 'mc_test', label: 'Solo1' });
  assert.strictEqual(c2.snapshot().planKind, 'solo');
  await assert.rejects(c2.runPlan({}), /Solo planner not built yet/);
  assert.throws(() => c2.useExistingPlan(), /No readable/);
  fs.copyFileSync(path.join(FAKE_SPIKES, 'plans', 'E2E_test_plan.json'), path.join(FAKE_SPIKES, 'plans', 'Solo1_plan.json'));
  assert.strictEqual(c2.useExistingPlan().steps.plan.status, 'done');

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
