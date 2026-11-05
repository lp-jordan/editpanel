'use strict';
/**
 * Cut-through (beta) — main-process orchestration for the Cut-through page.
 *
 * Runs the existing console spikes (editpanel/spikes/) from one place on LP1:
 *
 *   prep        spike_day_prep.py           Resolve worker (ct_run_spike)
 *   transcribe  transcribe_day.py <LABEL>   child process (C:\wxbench venv, GPU)
 *   plan        plan_convo.py               child process (app Python) — 2+ mics
 *               (solo: PLANNERS.solo is the seam for the solo/LLM planner)
 *   build       spike_cut_through_batch.py  Resolve worker (ct_run_spike)
 *
 * Outputs stay where the spikes put them: the Windows Desktop (day_, words_,
 * transcript_, cut_through_ files) and spikes/plans/<LABEL>_plan.json, which
 * the batch reads. Client words/media names never leave this machine.
 *
 * State lives here (not in the renderer) so a run keeps going and keeps its
 * status when the page is closed. Every change is pushed to the renderer on
 * 'cut-through:update'. Pure helpers are exported for scripts/test-cut-through.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');

const STEP_KEYS = ['prep', 'transcribe', 'plan', 'build'];
const DEFAULT_SEQ_BIN = 'MASTER / SEQUENCES';
const DEFAULT_WX_PYTHON = 'C:\\wxbench\\Scripts\\python.exe';
const MAX_LOG_LINES = 400;

// `  Camera 2 [######-------------------]  24%  5.4/22.6 min  41s`
const PROGRESS_RE = /^\s*(.*?)\s*\[([#-]+)\]\s+(\d+)%\s+([\d.]+)\/([\d.]+)\s*min(?:\s+(\d+)s)?/;

function parseProgress(line) {
  const m = PROGRESS_RE.exec(String(line || ''));
  if (!m) return null;
  return {
    angle: m[1],
    pct: Math.max(0, Math.min(100, Number(m[3]))),
    doneMin: Number(m[4]),
    totalMin: Number(m[5]),
    seconds: m[6] !== undefined ? Number(m[6]) : null
  };
}

/** A label is part of Desktop file names (day_<LABEL>.json …): keep it plain. */
function sanitizeLabel(raw) {
  return String(raw || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

/** Distinct mic angles in a day_<LABEL>.json → which planner runs. */
function micAngles(day) {
  const seen = [];
  for (const m of (day && Array.isArray(day.mics) ? day.mics : [])) {
    if (m && m.angle && !seen.includes(m.angle)) seen.push(m.angle);
  }
  return seen;
}

function planKind(day) {
  return micAngles(day).length >= 2 ? 'convo' : 'solo';
}

/** Day length in multicam frames (the unit plan_convo's start=/end= take). */
function dayFrames(day) {
  if (!day || !day.length_sec) return 0;
  const fs_ = Array.isArray(day.frame_sec) && day.frame_sec[1] ? day.frame_sec[0] / day.frame_sec[1] : 1 / (day.fps || 24);
  return Math.floor(day.length_sec / fs_);
}

/** "1200-1500, 3000-3100" → ["1200-1500", "3000-3100"]; throws on junk. */
function parseCuts(text) {
  const parts = String(text || '').split(/[\s,;]+/).filter(Boolean);
  return parts.map((p) => {
    const m = /^(\d+)-(\d+)$/.exec(p);
    if (!m || Number(m[2]) <= Number(m[1])) throw new Error(`Cut "${p}" must be <from>-<to> frames`);
    return `${m[1]}-${m[2]}`;
  });
}

function defaultSpikesDir({ isPackaged, appDir }) {
  if (!isPackaged) return path.join(appDir, 'spikes');
  return process.platform === 'win32' ? 'C:\\lp-app-ecosystem\\editpanel\\spikes' : path.join(os.homedir(), 'lp-app-ecosystem', 'editpanel', 'spikes');
}

function emptyStep() {
  return { status: 'pending', startedAt: null, finishedAt: null, earlier: false, error: null, log: [], report: [], reportFile: null, progress: null, traceId: null, data: null };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return null; }
}

function readLines(p) {
  try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l, i, a) => l || i < a.length - 1); } catch (_) { return null; }
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { proc.kill('SIGTERM'); } catch (_) {}
  }
}

function createCutThrough(opts) {
  const {
    sendWorkerRequest,             // (payload, worker) => Promise<{data}>
    broadcast,                     // (channel, payload) => void
    getPrefs = () => ({}),
    setPrefs = () => {},
    pythonCmd = 'python3',         // the app's own Python (plan_convo is stdlib only)
    ffmpegPath = '',               // bundled ffmpeg: transcribe_day.py's decode fallback
    isPackaged = false,
    appDir = path.join(__dirname, '..', '..'),
    desktopDir = path.join(os.homedir(), 'Desktop')   // = Python's expanduser("~/Desktop")
  } = opts;

  const s = {
    multicams: [],
    multicamsError: null,
    multicamsLoading: false,
    project: null,
    mc: null,
    label: '',
    day: null,                      // parsed day_<LABEL>.json
    planKind: null,
    planExists: false,
    busy: null,                     // step key currently running
    steps: Object.fromEntries(STEP_KEYS.map((k) => [k, emptyStep()]))
  };
  let child = null;                 // transcribe / plan child process
  let canceled = false;

  function settings() {
    const p = (getPrefs() || {}).cutThrough || {};
    return {
      spikesDir: p.spikesDir || defaultSpikesDir({ isPackaged, appDir }),
      wxPython: p.wxPython || (process.platform === 'win32' ? DEFAULT_WX_PYTHON : 'python3'),
      seqBin: p.seqBin === undefined ? DEFAULT_SEQ_BIN : p.seqBin,
      desktopDir
    };
  }

  function files(label = s.label) {
    const st = settings();
    return {
      day: path.join(desktopDir, `day_${label}.json`),
      prepReport: path.join(desktopDir, `day_prep_${label}.txt`),
      words: path.join(desktopDir, `words_${label}.json`),
      transcript: path.join(desktopDir, `transcript_${label}.txt`),
      transcribeReport: path.join(desktopDir, `transcribe_${label}.txt`),
      plan: path.join(st.spikesDir, 'plans', `${label}_plan.json`),
      buildReport: path.join(desktopDir, `cut_through_${label}.txt`)
    };
  }

  function snapshot() {
    return { ...s, settings: settings(), files: s.label ? files() : null, now: Date.now() };
  }

  // Log lines can arrive many per second; coalesce pushes to ~8/s.
  let emitTimer = null;
  function emit() {
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      broadcast('cut-through:update', snapshot());
    }, 120);
  }

  function pushLog(step, line) {
    const st = s.steps[step];
    st.log.push(line);
    if (st.log.length > MAX_LOG_LINES) st.log.splice(0, st.log.length - MAX_LOG_LINES);
  }

  function begin(step) {
    if (s.busy) throw new Error(`${s.busy} is still running`);
    if (!s.label) throw new Error('Pick a multicam and label first');
    s.busy = step;
    canceled = false;
    s.steps[step] = { ...emptyStep(), status: 'running', startedAt: Date.now() };
    emit();
    return s.steps[step];
  }

  function finish(step, { error = null, report = null, reportFile = null, data = undefined } = {}) {
    const st = s.steps[step];
    st.finishedAt = Date.now();
    st.status = canceled && step === 'transcribe' ? 'canceled' : error ? 'failed' : 'done';
    st.error = error;
    if (report) st.report = report;
    st.reportFile = reportFile && fs.existsSync(reportFile) ? reportFile : null;
    if (data !== undefined) st.data = data;
    st.progress = st.status === 'done' && st.progress ? { ...st.progress, pct: 100, overall: 100 } : st.progress;
    s.busy = null;
    child = null;
    refreshFiles();
    emit();
  }

  /** A child process's full output (stdout + stderr, so tracebacks too) as a
   *  Desktop file the step's Open report button can open. */
  function saveLog(step) {
    const p = path.join(desktopDir, `${step}_${s.label}_log.txt`);
    try { fs.writeFileSync(p, s.steps[step].log.join('\n') + '\n', 'utf8'); return p; } catch (_) { return null; }
  }

  /** "exited with code 1" + the last line that says why (a traceback's last line). */
  function exitError(step, script, code) {
    const last = [...s.steps[step].log].reverse().find((l) => l.trim() && !/^\s*\^+\s*$/.test(l));
    return `${script} exited with code ${code}${last ? `: ${last.trim()}` : ''}`;
  }

  /** Re-read what's on disk for the label: day file, plan file. */
  function refreshFiles() {
    if (!s.label) { s.day = null; s.planKind = null; s.planExists = false; return; }
    const f = files();
    s.day = readJson(f.day);
    s.planKind = s.day ? planKind(s.day) : null;
    s.planExists = fs.existsSync(f.plan);
    if (s.day && s.steps.prep.status !== 'running') s.steps.prep.data = prepData(s.day);
  }

  function prepData(day) {
    return {
      multicam: day.multicam,
      fps: day.fps,
      lengthMin: day.length_sec ? day.length_sec / 60 : null,
      frames: dayFrames(day),
      angles: day.angles || [],
      // 'wav' = person mics placed in the multicam; 'camera' = no WAVs used, one
      // angle's own audio (ATEM mix or in-camera, track 1) — see spike_day_prep.py
      audioSource: day.audio_source || 'wav',
      wavMics: day.wav_mics === undefined ? (day.mics || []).length : day.wav_mics,
      cameraAudioAngles: day.camera_audio_angles || [],
      mics: (day.mics || []).map((m) => ({
        name: m.name, angle: m.angle, path: m.path, camera: Boolean(m.camera),
        fromMin: m.from_sec / 60, toMin: m.to_sec / 60,
        found: (() => { try { return fs.existsSync(m.path); } catch (_) { return false; } })()
      })),
      micAngles: micAngles(day)
    };
  }

  /** Steps finished in an earlier session show as done, dated by their file. */
  function inspectEarlier() {
    const f = files();
    const marks = {
      prep: [f.day, f.prepReport],
      transcribe: [f.words, f.transcribeReport],
      plan: [f.plan, null],
      build: [f.buildReport, f.buildReport]
    };
    for (const key of STEP_KEYS) {
      const [out, rep] = marks[key];
      const t = mtime(out);
      if (!t) { s.steps[key] = emptyStep(); continue; }
      const report = rep ? readLines(rep) || [] : [];
      const failed = key === 'build' && report.some((l) => l.trim().startsWith('✗ STOPPED'));
      const reportFile = [rep, out].find((p) => p && fs.existsSync(p)) || null;
      s.steps[key] = { ...emptyStep(), status: failed ? 'failed' : 'done', earlier: true, finishedAt: t, report, reportFile };
    }
  }

  // ── multicam selector ─────────────────────────────────────────
  async function listMulticams() {
    s.multicamsLoading = true;
    s.multicamsError = null;
    emit();
    try {
      const res = await sendWorkerRequest({ cmd: 'ct_list_multicams' }, 'resolve');
      s.multicams = res?.data?.multicams || [];
      s.project = res?.data?.project || null;
    } catch (err) {
      s.multicams = [];
      s.multicamsError = errMsg(err);
    } finally {
      s.multicamsLoading = false;
      emit();
    }
    return snapshot();
  }

  function select({ mc, label }) {
    if (s.busy) throw new Error(`${s.busy} is still running`);
    s.mc = mc || null;
    s.label = sanitizeLabel(label || mc || '');
    if (s.label) inspectEarlier();
    else s.steps = Object.fromEntries(STEP_KEYS.map((k) => [k, emptyStep()]));
    refreshFiles();
    const p = (getPrefs() || {}).cutThrough || {};
    setPrefs({ cutThrough: { ...p, lastMc: s.mc, lastLabel: s.label } });
    emit();
    return snapshot();
  }

  function updateSettings(patch = {}) {
    const p = (getPrefs() || {}).cutThrough || {};
    const next = { ...p };
    for (const k of ['spikesDir', 'wxPython', 'seqBin']) {
      if (patch[k] !== undefined) next[k] = String(patch[k]).trim();
    }
    setPrefs({ cutThrough: next });
    refreshFiles();
    emit();
    return snapshot();
  }

  // ── Resolve steps ─────────────────────────────────────────────
  async function runSpike(step, script, spikeSettings) {
    const st = begin(step);
    st.traceId = randomUUID();
    emit();
    const { spikesDir } = settings();
    try {
      const res = await sendWorkerRequest({ cmd: 'ct_run_spike', spikes_dir: spikesDir, script, settings: spikeSettings, trace_id: st.traceId }, 'resolve');
      const data = res?.data || {};
      return { lines: data.lines || [], error: data.error || null, seconds: data.seconds };
    } catch (err) {
      return { lines: st.log.slice(), error: errMsg(err) };
    }
  }

  /** audioAngle: use that angle's camera audio instead of the mic WAVs ('' = WAVs, or Camera 1 when there are none). */
  async function runPrep({ audioAngle } = {}) {
    if (!s.mc) throw new Error('Pick a multicam first');
    const started = Date.now();
    const out = await runSpike('prep', 'spike_day_prep.py', { LABEL: s.label, MC: s.mc, ...(audioAngle ? { AUDIO_ANGLE: String(audioAngle) } : {}) });
    let error = out.error;
    const f = files();
    if (!error && !(mtime(f.day) >= started - 2000)) error = `day_${s.label}.json was not written`;
    const day = readJson(f.day);
    finish('prep', { error, report: out.lines, reportFile: f.prepReport, data: day && !error ? prepData(day) : null });
    return snapshot();
  }

  async function runBuild({ seqBin } = {}) {
    if (seqBin !== undefined) updateSettings({ seqBin });
    if (!fs.existsSync(files().plan)) throw new Error('No plan for this label yet');
    const bin = settings().seqBin;
    const out = await runSpike('build', 'spike_cut_through_batch.py', { LABEL: s.label, ...(bin ? { SEQ_BIN: bin } : {}) });
    finish('build', { error: out.error, report: out.lines, reportFile: files().buildReport });
    return snapshot();
  }

  /** Lines streamed from the Resolve worker for a running step (by trace id). */
  function onWorkerLog(traceId, message) {
    if (!traceId || !s.busy) return;
    const st = s.steps[s.busy];
    if (st.traceId !== traceId) return;
    pushLog(s.busy, String(message));
    emit();
  }

  // ── child-process steps ───────────────────────────────────────
  function runChild(step, command, args, { onLine } = {}) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(command, args, {
          cwd: settings().spikesDir,
          windowsHide: true,
          env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {}) }
        });
      } catch (err) {
        resolve({ code: null, error: errMsg(err) });
        return;
      }
      child = proc;
      let spawnError = null;
      const feed = (stream) => {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          buf += chunk;
          const parts = buf.split(/\r\n|\r|\n/);
          buf = parts.pop();
          parts.forEach((line) => line.trim() && handle(line));
        });
        stream.on('end', () => { if (buf.trim()) handle(buf); buf = ''; });
      };
      const handle = (line) => {
        if (onLine && onLine(line)) { emit(); return; }
        pushLog(step, line);
        emit();
      };
      feed(proc.stdout);
      feed(proc.stderr);
      proc.on('error', (err) => { spawnError = err.code === 'ENOENT' ? `Not found: ${command}` : errMsg(err); });
      proc.on('close', (code) => resolve({ code, error: spawnError }));
    });
  }

  async function runTranscribe({ minutes } = {}) {
    if (!s.day) throw new Error('Run Prep first');
    const st = begin('transcribe');
    const { spikesDir, wxPython } = settings();
    const mins = Number(minutes) > 0 ? Number(minutes) : 0;
    // Expected minutes per track (all sources on one angle share a track, as in
    // transcribe_day.py), in run order, so the bar covers the whole run.
    const spans = new Map();
    (s.day.mics || []).forEach((m) => {
      const sp = spans.get(m.angle) || { from: m.from_sec, to: m.to_sec };
      spans.set(m.angle, { from: Math.min(sp.from, m.from_sec), to: Math.max(sp.to, m.to_sec) });
    });
    const plan = [...spans.entries()].map(([angle, sp]) => {
      const total = Math.max(0, (sp.to - sp.from) / 60);
      return { angle, totalMin: mins ? Math.min(total, mins) : total };
    });
    const grand = plan.reduce((a, m) => a + m.totalMin, 0) || 1;
    let micIdx = -1;
    let lastAngle = null;
    st.progress = { angle: null, pct: 0, doneMin: 0, totalMin: 0, mic: 0, mics: plan.length, overall: 0, phase: 'Starting' };
    const started = Date.now();
    const args = [path.join(spikesDir, 'transcribe_day.py'), s.label, `dir=${desktopDir}`, ...(mins ? [`minutes=${mins}`] : [])];
    const res = await runChild('transcribe', wxPython, args, {
      onLine: (line) => {
        const p = parseProgress(line);
        if (!p) {
          if (/^Reading |^Loading the model/.test(line.trim())) st.progress.phase = line.trim().replace(/…$/, '');
          return false;
        }
        if (p.angle !== lastAngle) { micIdx += 1; lastAngle = p.angle; }
        const before = plan.slice(0, Math.max(0, micIdx)).reduce((a, m) => a + m.totalMin, 0);
        const overall = Math.min(100, Math.round(100 * (before + p.doneMin) / grand));
        st.progress = { ...p, mic: micIdx + 1, mics: plan.length, overall, phase: null };
        return true;
      }
    });
    let error = res.error;
    if (!error && res.code !== 0 && !canceled) error = exitError('transcribe', 'transcribe_day.py', res.code);
    const f = files();
    if (!error && !canceled && !(mtime(f.words) >= started - 2000)) error = `words_${s.label}.json was not written`;
    // Success: the script's own report. Failure/cancel: this run's output (an
    // older transcribe_<LABEL>.txt would hide the traceback).
    if (error || canceled) {
      finish('transcribe', { error: canceled ? null : error, report: st.log.slice(), reportFile: saveLog('transcribe') });
    } else {
      finish('transcribe', { report: readLines(f.transcribeReport) || st.log.slice(), reportFile: f.transcribeReport });
    }
    return snapshot();
  }

  function cancel() {
    if (!child) return snapshot();
    canceled = true;
    killTree(child);
    return snapshot();
  }

  // Planner seam. A planner takes the day + words files and writes
  // spikes/plans/<LABEL>_plan.json (the batch's input). `convo` is the
  // rule-based plan_convo.py spike; `solo` (one talker, retakes) plugs in here
  // once it exists — until then the page only accepts an existing plan file.
  const PLANNERS = {
    convo: async ({ files: f, start, end, extra, cuts }) => {
      fs.mkdirSync(path.dirname(f.plan), { recursive: true });
      const args = [path.join(settings().spikesDir, 'plan_convo.py'), f.words, f.day, f.plan, `start=${start}`, `end=${end}`,
        ...(extra ? [`extra=${extra}`] : []), ...cuts.map((c) => `cut=${c}`)];
      return runChild('plan', pythonCmd, args);
    },
    solo: null
  };

  async function runPlan({ start, end, extra, cuts } = {}) {
    if (!s.day) throw new Error('Run Prep first');
    const kind = planKind(s.day);
    const planner = PLANNERS[kind];
    if (!planner) throw new Error('Solo planner not built yet');
    const f = files();
    if (!fs.existsSync(f.words)) throw new Error('Run Transcribe first');
    const total = dayFrames(s.day);
    const a = start === '' || start === undefined || start === null ? 0 : Number(start);
    const b = end === '' || end === undefined || end === null ? total : Number(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a) throw new Error('End must be after start');
    const cutList = parseCuts(cuts);
    begin('plan');
    const started = Date.now();
    const res = await planner({ files: f, start: Math.round(a), end: Math.round(b), extra: extra || null, cuts: cutList });
    let error = res.error;
    if (!error && res.code !== 0) error = exitError('plan', 'plan_convo.py', res.code);
    if (!error && !(mtime(f.plan) >= started - 2000)) error = `${s.label}_plan.json was not written`;
    const st = s.steps.plan;
    finish('plan', { error, report: st.log.slice(), reportFile: error ? saveLog('plan') : f.plan, data: error ? null : planSummary(readJson(f.plan)) });
    return snapshot();
  }

  /** Accept spikes/plans/<LABEL>_plan.json as-is (solo days, hand-made plans). */
  function useExistingPlan() {
    if (s.busy) throw new Error(`${s.busy} is still running`);
    const f = files();
    const plan = readJson(f.plan);
    if (!plan) throw new Error(`No readable ${s.label}_plan.json in spikes/plans`);
    const t = mtime(f.plan);
    s.steps.plan = { ...emptyStep(), status: 'done', earlier: true, startedAt: null, finishedAt: t,
      report: [`Using ${f.plan}`], reportFile: f.plan, data: planSummary(plan) };
    refreshFiles();
    emit();
    return snapshot();
  }

  function planSummary(plan) {
    if (!plan) return null;
    const video = Array.isArray(plan.video) ? plan.video : [];
    const counts = {};
    video.forEach((v) => { counts[v.angle] = (counts[v.angle] || 0) + 1; });
    const keptFrames = video.reduce((a, v) => a + Math.max(0, (v.out || 0) - (v.in || 0)), 0);
    return {
      multicam: plan.multicam || null,
      pieces: video.length,
      removals: Array.isArray(plan.removals) ? plan.removals.length : 0,
      keptMin: plan.fps ? keptFrames / plan.fps / 60 : null,
      angles: counts,
      mics: plan.mics ? Object.keys(plan.mics) : [],
      micAngles: plan.mic_angles || null,
      note: plan.note || null
    };
  }

  // Restore the last selection so a reopened app lands on the same day.
  const last = (getPrefs() || {}).cutThrough || {};
  if (last.lastLabel) {
    s.mc = last.lastMc || null;
    s.label = sanitizeLabel(last.lastLabel);
    inspectEarlier();
    refreshFiles();
  }

  return {
    snapshot,
    listMulticams,
    select,
    updateSettings,
    runPrep,
    runTranscribe,
    cancel,
    runPlan,
    useExistingPlan,
    runBuild,
    onWorkerLog,
    _planners: PLANNERS
  };
}

function errMsg(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.error && typeof err.error === 'object') return err.error.message || JSON.stringify(err.error);
  return err.error || err.message || String(err);
}

module.exports = {
  createCutThrough,
  parseProgress,
  sanitizeLabel,
  micAngles,
  planKind,
  dayFrames,
  parseCuts,
  defaultSpikesDir,
  DEFAULT_SEQ_BIN
};
