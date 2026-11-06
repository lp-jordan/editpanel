'use strict';
/**
 * Cut-through (beta) — main-process orchestration for the Cut-through page.
 *
 * Runs the cut-through pipeline (editpanel/cut_through/) from one place on LP1:
 *
 *   prep        prepare_multicam.py         Resolve worker (ct_run_step)
 *   transcribe  transcribe.py <LABEL>       child process (C:\wxbench venv, GPU)
 *   plan        Claude (editor_briefs/) + place_cuts.py (app Python) — 2+ mic angles =
 *               conversation, else one speaker
 *   build       build_rough_cut.py          Resolve worker (ct_run_step)
 *
 * Outputs: one folder per run, <files folder>\<Resolve project>\<label>\ (default
 * Documents\Cut-through): day_, words_, levels_, transcript_, claude_edit_, the plan, reports.
 * Client words/media names never leave this machine. Runs from before 1.2.94 left their files on
 * the Desktop (plan in cut_through/plans); they move into the run folder when the label is opened.
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
const claude = require('./cut_through_claude');
const { scorePlan } = require('./cut_through_score');

const STEP_KEYS = ['prep', 'transcribe', 'plan', 'build', 'score'];
const DEFAULT_SEQ_BIN = 'MASTER / SEQUENCES';
const DEFAULT_WX_PYTHON = 'C:\\wxbench\\Scripts\\python.exe';
const MAX_LOG_LINES = 400;

// `  Camera 2 [######-------------------]  24%  5.4/22.6 min  41s`
const PROGRESS_RE = /^\s*(.*?)\s*\[([#-]+)\]\s+(\d+)%\s+([\d.]+)\/([\d.]+)\s*min(?:\s+(\d+)s)?/;

// `  reading 1/3 CAM1_01.mov  45%  812 MB` (transcribe.py while it reads the audio)
const READ_RE = /^\s*reading (\d+)\/(\d+) (.*?)\s+(\d+)%\s+([\d.]+) MB/;

function parseRead(line) {
  const m = READ_RE.exec(String(line || ''));
  if (!m) return null;
  return { file: Number(m[1]), files: Number(m[2]), name: m[3], pct: Math.min(100, Number(m[4])), mb: Number(m[5]) };
}

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

/** Day length in multicam frames (the unit place_cuts.py's start=/end= take). */
function dayFrames(day) {
  if (!day || !day.length_sec) return 0;
  const fs_ = Array.isArray(day.frame_sec) && day.frame_sec[1] ? day.frame_sec[0] / day.frame_sec[1] : 1 / (day.fps || 24);
  return Math.floor(day.length_sec / fs_);
}

/** Frames per timecode second (24 for 23.976) and the multicam's first frame on the TC clock. */
function tcClock(day) {
  const fsec = Array.isArray(day.frame_sec) && day.frame_sec[1] ? day.frame_sec[0] / day.frame_sec[1] : 1 / (day.fps || 24);
  const nominal = Math.round(1 / fsec);
  return { fsec, nominal, first: Math.round((day.tc_start_sec || 0) / fsec) };
}

/** Multicam frame → its timecode, as Resolve shows it on the multicam (HH:MM:SS:FF). */
function frameToTc(frame, day) {
  const { nominal, first } = tcClock(day);
  const n = first + Math.max(0, Math.round(frame));
  const pad = (x) => String(x).padStart(2, '0');
  const ff = n % nominal;
  const secs = Math.floor(n / nominal);
  return `${pad(Math.floor(secs / 3600) % 24)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(ff)}`;
}

/**
 * A From/To entry → multicam frame. Accepts the multicam's timecode (HH:MM:SS:FF or HH:MM:SS),
 * or time from the start of the multicam (MM:SS, H:MM:SS, or plain minutes like 12.5) when it
 * isn't inside the multicam's timecode range. Empty → null. Throws on junk / out of range.
 */
function parseSection(text, day) {
  const t = String(text === undefined || text === null ? '' : text).trim();
  if (!t) return null;
  const total = dayFrames(day);
  const { fsec, nominal, first } = tcClock(day);
  const inside = (f) => f >= 0 && f <= total;
  if (/^\d+(\.\d+)?$/.test(t)) {                                   // minutes from the start
    const f = Math.round(Number(t) * 60 / fsec);
    if (inside(f)) return f;
    throw new Error(`${t} min is past the end of the multicam`);
  }
  const parts = t.split(/[:;.]/).map(Number);
  if (parts.length < 2 || parts.length > 4 || parts.some((x) => !Number.isFinite(x) || x < 0)) {
    throw new Error(`"${t}" isn't a time (use 01:12:30:00, 1:12:30 or 12:30)`);
  }
  if (parts.length >= 3) {                                           // timecode on the multicam's clock
    const [h, m, sec, ff = 0] = parts;
    const f = ((h * 60 + m) * 60 + sec) * nominal + ff - first;
    if (inside(f)) return f;
  }
  const [h, m, sec] = parts.length === 2 ? [0, ...parts] : parts.slice(0, 3);   // time from the start
  const f = Math.round(((h * 60 + m) * 60 + sec) / fsec);
  if (inside(f)) return f;
  throw new Error(`"${t}" is outside the multicam (${frameToTc(0, day)} – ${frameToTc(total, day)})`);
}

function defaultPipelineDir({ isPackaged, appDir }) {
  if (!isPackaged) return path.join(appDir, 'cut_through');
  return process.platform === 'win32' ? 'C:\\lp-app-ecosystem\\editpanel\\cut_through' : path.join(os.homedir(), 'lp-app-ecosystem', 'editpanel', 'cut_through');
}

/** A folder saved before the rename (…\\editpanel\\spikes) → its cut_through sibling. */
function pipelineDirFrom(saved, fallback) {
  if (!saved) return fallback;
  const p = saved.includes('\\') ? path.win32 : path.posix;
  return /[\\/]spikes[\\/]?$/.test(saved) ? p.join(p.dirname(saved.replace(/[\\/]+$/, '')), 'cut_through') : saved;
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
    pythonCmd = 'python3',         // the app's own Python (place_cuts.py is stdlib only)
    ffmpegPath = '',               // bundled ffmpeg: transcribe.py's decode fallback
    claudeClient = null,           // tests: a stand-in for the Anthropic client
    isPackaged = false,
    appDir = path.join(__dirname, '..', '..'),
    desktopDir = path.join(os.homedir(), 'Desktop'),  // where runs before 1.2.94 left their files
    filesDir = path.join(os.homedir(), 'Documents', 'Cut-through')   // default home of run files
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
    marks: null,                    // the In/Out read from the multicam in Resolve (Plan's toggle)
    planExists: false,
    busy: null,                     // step key currently running
    steps: Object.fromEntries(STEP_KEYS.map((k) => [k, emptyStep()]))
  };
  let child = null;                 // transcribe / plan child process
  let canceled = false;

  function settings() {
    const p = (getPrefs() || {}).cutThrough || {};
    return {
      pipelineDir: pipelineDirFrom(p.pipelineDir || p.spikesDir, defaultPipelineDir({ isPackaged, appDir })),
      wxPython: p.wxPython || (process.platform === 'win32' ? DEFAULT_WX_PYTHON : 'python3'),
      seqBin: p.seqBin === undefined ? DEFAULT_SEQ_BIN : p.seqBin,
      claudeModel: p.claudeModel || claude.DEFAULT_MODEL,
      claudeEffort: p.claudeEffort || 'high',
      filesDir: p.filesDir || filesDir,
      // the key itself never goes to the renderer
      claudeKey: claudeKey() ? (p.anthropicKey ? `saved …${p.anthropicKey.slice(-4)}` : 'from ANTHROPIC_API_KEY') : null
    };
  }

  /** Claude API key: the one saved on this machine (page settings), else ANTHROPIC_API_KEY. */
  function claudeKey() {
    const p = (getPrefs() || {}).cutThrough || {};
    return p.anthropicKey || process.env.ANTHROPIC_API_KEY || null;
  }

  /** Windows-safe folder name for a Resolve project. */
  function folderName(name) {
    return String(name || 'No project').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/[. ]+$/g, '').trim() || 'No project';
  }

  /** Every file of one run: <files folder>\<Resolve project>\<label>\ (Jordan 2026-11-06: off the Desktop). */
  function runDir(label = s.label) {
    return path.join(settings().filesDir, folderName(s.project), label);
  }

  function files(label = s.label) {
    const dir = runDir(label);
    return {
      dir,
      claudeEdit: path.join(dir, `claude_edit_${label}.json`),
      day: path.join(dir, `day_${label}.json`),
      prepReport: path.join(dir, `day_prep_${label}.txt`),
      words: path.join(dir, `words_${label}.json`),
      levels: path.join(dir, `levels_${label}.json`),
      align: path.join(dir, `align_${label}.txt`),
      transcript: path.join(dir, `transcript_${label}.txt`),
      transcribeReport: path.join(dir, `transcribe_${label}.txt`),
      plan: path.join(dir, `${label}_plan.json`),
      buildReport: path.join(dir, `cut_through_${label}.txt`),
      scoreReport: path.join(dir, `score_${label}.txt`)
    };
  }

  /** Jordan's plain-language direction for Claude, saved per label on this machine. */
  function direction(label = s.label) {
    const p = (getPrefs() || {}).cutThrough || {};
    return (label && (p.directions || {})[label]) || '';
  }

  function snapshot() {
    return { ...s, direction: direction(), settings: settings(), files: s.label ? files() : null, now: Date.now() };
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
    fs.mkdirSync(files().dir, { recursive: true });
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
    if (pendingProject) { const n = pendingProject; pendingProject = null; onProject(n); }
    emit();
  }

  /** A child process's full output (stdout + stderr, so tracebacks too) as a
   *  file in the run folder that the step's Open report button can open. */
  function saveLog(step) {
    const p = path.join(files().dir, `${step}_${s.label}_log.txt`);
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
      startTc: frameToTc(0, day),
      endTc: frameToTc(dayFrames(day), day),
      angles: day.angles || [],
      // 'wav' = person mics placed in the multicam; 'camera' = no WAVs used, one
      // angle's own audio (ATEM mix or in-camera, track 1) — see prepare_multicam.py
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
      build: [f.buildReport, f.buildReport],
      score: [f.scoreReport, f.scoreReport]
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
      applyProject(res?.data?.project || null);
    } catch (err) {
      s.multicams = [];
      s.multicamsError = errMsg(err);
    } finally {
      s.multicamsLoading = false;
      emit();
    }
    return snapshot();
  }

  /** A new pick's label: the multicam's name, unless another Resolve project's run already
   *  uses that label (multicams are often all called mc_1) — then the project name is added. */
  function defaultLabel(mc) {
    const base = sanitizeLabel(mc || '');
    const owner = (((getPrefs() || {}).cutThrough || {}).labelProjects || {})[base];
    if (!base || !s.project || !owner || owner === s.project) return base;
    return sanitizeLabel(`${base}_${s.project}`);
  }

  /** Runs from before 1.2.94 left their files on the Desktop (plan in cut_through/plans): move
   *  them into this project's run folder — only when the label isn't another project's. */
  function adoptLegacyFiles(label) {
    if (!label || !s.project) return;
    const owner = (((getPrefs() || {}).cutThrough || {}).labelProjects || {})[label];
    if (owner && owner !== s.project) return;
    const dir = runDir(label);
    const fixed = [`day_${label}.json`, `day_prep_${label}.txt`, `words_${label}.json`, `levels_${label}.json`,
      `transcript_${label}.txt`, `transcribe_${label}.txt`, `cut_through_${label}.txt`, `score_${label}.txt`, `score_${label}.json`,
      `removals_${label}.json`, `review_${label}.json`, `mcdef_${label}.fcpxml`, `mcdef_${label}.fcpxmld`, `${label}_joined.fcpxml`,
      `${label}_joined_ranges.json`, `import_${label}.txt`, ...STEP_KEYS.map((k) => `${k}_${label}_log.txt`)];
    let names = [];
    try { names = fs.readdirSync(desktopDir); } catch (_) { return; }
    const ours = names.filter((n) => fixed.includes(n) || (n.startsWith(`claude_edit_${label}`) && n.endsWith('.json')
      && /^(|_[A-Za-z0-9_.-]+)$/.test(n.slice(`claude_edit_${label}`.length, -5))));
    const moves = ours.map((n) => [path.join(desktopDir, n), path.join(dir, n)]);
    const oldPlan = path.join(settings().pipelineDir, 'plans', `${label}_plan.json`);
    if (fs.existsSync(oldPlan)) moves.push([oldPlan, path.join(dir, `${label}_plan.json`)]);
    if (!moves.length) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const [from, to] of moves) {
      if (fs.existsSync(to)) continue;               // never overwrite a newer run's file
      try { fs.renameSync(from, to); } catch (_) {
        try { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); } catch (__) { /* leave it */ }
      }
    }
    // the plan points at its review markers by full path
    const planPath = path.join(dir, `${label}_plan.json`);
    const plan = readJson(planPath);
    const review = path.join(dir, `review_${label}.json`);
    if (plan && plan.review_file && plan.review_file !== review && fs.existsSync(review)) {
      try { fs.writeFileSync(planPath, JSON.stringify({ ...plan, review_file: review }, null, 1), 'utf8'); } catch (_) { /* keep */ }
    }
  }

  function show(mc, label) {
    s.mc = mc || null;
    s.marks = null;
    s.label = sanitizeLabel(label || '');
    adoptLegacyFiles(s.label);
    if (s.label) inspectEarlier();
    else s.steps = Object.fromEntries(STEP_KEYS.map((k) => [k, emptyStep()]));
    refreshFiles();
  }

  /** label omitted = a fresh pick (see defaultLabel); label given = what the editor typed. */
  function select({ mc, label }) {
    if (s.busy) throw new Error(`${s.busy} is still running`);
    show(mc, label === undefined || label === null ? defaultLabel(mc) : label || (mc ? defaultLabel(mc) : ''));
    const p = (getPrefs() || {}).cutThrough || {};
    const next = { ...p, lastMc: s.mc, lastLabel: s.label, lastProject: s.project };
    if (s.project) {
      next.byProject = { ...(p.byProject || {}), [s.project]: { mc: s.mc, label: s.label } };
      if (s.label) next.labelProjects = { ...(p.labelProjects || {}), [s.label]: s.project };
    }
    setPrefs({ cutThrough: next });
    emit();
    return snapshot();
  }

  /** Resolve's open project changed: show what this page last had for that project (its files
   *  stay on the Desktop either way — switching never throws work away). Waits out a running step. */
  let pendingProject = null;
  function applyProject(name) {
    if (!name || name === s.project) return;
    if (s.busy) { pendingProject = name; return; }
    const first = s.project === null;
    s.project = name;
    const p = (getPrefs() || {}).cutThrough || {};
    const saved = (p.byProject || {})[name];
    if (saved) show(saved.mc, saved.label);
    else if (!(first && s.label && (p.labelProjects || {})[s.label] === name)) show(null, '');
    emit();
  }

  function onProject(name) {
    if (!name || name === s.project) return;
    applyProject(name);
    if (s.project === name) listMulticams().catch(() => {});
  }

  function updateSettings(patch = {}) {
    const p = (getPrefs() || {}).cutThrough || {};
    const next = { ...p };
    for (const k of ['pipelineDir', 'wxPython', 'seqBin', 'anthropicKey', 'claudeModel', 'claudeEffort', 'filesDir']) {
      if (patch[k] !== undefined) next[k] = String(patch[k]).trim();
    }
    setPrefs({ cutThrough: next });
    refreshFiles();
    emit();
    return snapshot();
  }

  // ── Resolve steps ─────────────────────────────────────────────
  async function runStep(step, script, stepSettings) {
    const st = begin(step);
    st.traceId = randomUUID();
    st.progress = { phase: 'Waiting for Resolve', phaseAt: Date.now(), bar: null };
    emit();
    const { pipelineDir } = settings();
    try {
      const res = await sendWorkerRequest({ cmd: 'ct_run_step', pipeline_dir: pipelineDir, script, settings: stepSettings, trace_id: st.traceId }, 'resolve');
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
    const out = await runStep('prep', 'prepare_multicam.py', { LABEL: s.label, MC: s.mc, OUT_DIR: runDir(), ...(audioAngle ? { AUDIO_ANGLE: String(audioAngle) } : {}) });
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
    const out = await runStep('build', 'build_rough_cut.py', { LABEL: s.label, OUT_DIR: runDir(), PLAN_FILE: files().plan, ...(bin ? { SEQ_BIN: bin } : {}) });
    finish('build', { error: out.error, report: out.lines, reportFile: files().buildReport });
    return snapshot();
  }

  /** Compare the plan with Jordan's finished timeline (Z8): removals, cuts, angles, pacing. */
  /**
   * The In/Out marked on the multicam in Resolve (source viewer) → a section of the day, in
   * multicam frames. Resolve may give marks from the clip's start or on its timecode clock;
   * both are handled. Out is inclusive in Resolve, so the section ends one frame after it.
   */
  async function readMarks() {
    if (!s.day || !s.mc) throw new Error('Run Prep first');
    const res = await sendWorkerRequest({ cmd: 'ct_mark_in_out', name: String(s.mc) }, 'resolve');
    const d = (res && res.data) || {};
    const total = dayFrames(s.day);
    const { first } = tcClock(s.day);
    const conv = (v) => {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
      const n = Math.round(Number(v));
      return n > total + 1 && n - first >= 0 && n - first <= total + 1 ? n - first : n;
    };
    const a = conv(d.in);
    const o = conv(d.out);
    if (a === null && o === null) throw new Error(`No In/Out marked on ${s.mc} in Resolve`);
    const from = Math.max(0, a === null ? 0 : a);
    const to = Math.min(total, o === null ? total : o + 1);
    if (to <= from) throw new Error(`The Out on ${s.mc} is before its In`);
    s.marks = { from, to, fromTc: frameToTc(from, s.day), toTc: frameToTc(to, s.day),
      minutes: ((to - from) * tcClock(s.day).fsec) / 60, bin: d.bin || null };
    emit();
    return snapshot();
  }

  async function runScore({ timeline } = {}) {
    if (!timeline) throw new Error('Pick the finished timeline');
    const f = files();
    const plan = readJson(f.plan);
    if (!plan) throw new Error('No plan for this label yet');
    const st = begin('score');
    st.traceId = randomUUID();
    st.progress = { phase: `Reading ${timeline} from Resolve`, phaseAt: Date.now(), bar: null };
    emit();
    let error = null;
    let report = [];
    try {
      const res = await sendWorkerRequest({ cmd: 'ct_read_timeline', name: String(timeline), trace_id: st.traceId }, 'resolve');
      st.progress = { phase: 'Comparing it with the plan', phaseAt: Date.now(), bar: null };
      emit();
      const out = scorePlan({ plan, finished: res.data, words: readJson(f.words) });
      report = out.lines;
      fs.writeFileSync(f.scoreReport, report.join('\n') + '\n', 'utf8');
      fs.writeFileSync(f.scoreReport.replace(/\.txt$/, '.json'), JSON.stringify(out.data, null, 1), 'utf8');
      st.data = out.data;
    } catch (err) {
      error = err instanceof Error ? err.message : errMsg(err);
    }
    finish('score', { error, report, reportFile: f.scoreReport, data: error ? null : st.data });
    return snapshot();
  }

  /** Lines streamed from the Resolve worker for a running step (by trace id). */
  function onWorkerLog(traceId, message) {
    if (!traceId || !s.busy) return;
    const st = s.steps[s.busy];
    if (st.traceId !== traceId) return;
    const text = String(message);
    if (text.startsWith('▸ ')) {                      // the script saying what it's doing now
      st.progress = { phase: text.slice(2).trim(), phaseAt: Date.now(), bar: null };
    } else {
      pushLog(s.busy, text);
    }
    emit();
  }

  // ── child-process steps ───────────────────────────────────────
  function runChild(step, command, args, { onLine } = {}) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(command, args, {
          cwd: settings().pipelineDir,
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
    const { pipelineDir, wxPython } = settings();
    const mins = Number(minutes) > 0 ? Number(minutes) : 0;
    // Expected minutes per track (all sources on one angle share a track, as in
    // transcribe.py), in run order, so the bar covers the whole run.
    const spans = new Map();
    (s.day.mics || []).forEach((m) => {
      const sp = spans.get(m.angle) || { from: m.from_sec, to: m.to_sec };
      spans.set(m.angle, { from: Math.min(sp.from, m.from_sec), to: Math.max(sp.to, m.to_sec) });
    });
    // one speaker: a second, verbatim pass (Z8 — hears the restarts and "uh"s the clean pass drops)
    const verbatim = spans.size === 1;
    const plan = [...spans.entries()].flatMap(([angle, sp]) => {
      const total = Math.max(0, (sp.to - sp.from) / 60);
      const one = { angle, totalMin: mins ? Math.min(total, mins) : total };
      return verbatim ? [one, { ...one, angle: `${angle} (verbatim)` }] : [one];
    });
    const grand = plan.reduce((a, m) => a + m.totalMin, 0) || 1;
    let micIdx = -1;
    let lastAngle = null;
    st.progress = { angle: null, pct: 0, doneMin: 0, totalMin: 0, mic: 0, mics: plan.length, overall: 0, phase: 'Starting' };
    const started = Date.now();
    const args = [path.join(pipelineDir, 'transcribe.py'), s.label, `dir=${runDir()}`, ...(mins ? [`minutes=${mins}`] : []),
      ...(verbatim ? ['verbatim=1'] : [])];
    const res = await runChild('transcribe', wxPython, args, {
      onLine: (line) => {
        const r = parseRead(line);
        if (r) {
          // reading the audio (a long camera file off the NAS takes minutes): its own bar
          const phase = `Reading audio ${r.file}/${r.files} · ${r.name} · ${Math.round(r.mb)} MB`;
          if (st.progress.phase !== phase && !String(st.progress.phase || '').startsWith(`Reading audio ${r.file}/`)) st.progress.phaseAt = Date.now();
          st.progress = { ...st.progress, phase, bar: Math.round(100 * ((r.file - 1) + r.pct / 100) / r.files) };
          return true;
        }
        const p = parseProgress(line);
        if (!p) {
          const t = line.trim();
          if (t.endsWith('…')) st.progress = { ...st.progress, phase: t.replace(/…$/, ''), phaseAt: Date.now(), bar: null };
          return false;
        }
        if (p.angle !== lastAngle) { micIdx += 1; lastAngle = p.angle; }
        const before = plan.slice(0, Math.max(0, micIdx)).reduce((a, m) => a + m.totalMin, 0);
        const overall = Math.min(100, Math.round(100 * (before + p.doneMin) / grand));
        st.progress = { ...p, mic: micIdx + 1, mics: plan.length, overall, phase: null, bar: null };
        return true;
      }
    });
    let error = res.error;
    if (!error && res.code !== 0 && !canceled) error = exitError('transcribe', 'transcribe.py', res.code);
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

  // The placer: takes the day + words files (+ Claude's edit and the levels) and writes
  // <run folder>/<LABEL>_plan.json (the build's input).
  const PLANNERS = {
    solo: { script: 'place_cuts.py', args: ({ extra, punch, removalsFile, levelsFile }) => [...(punch ? [`punch=${punch}`] : []), ...(extra ? [`extra=${extra}`] : []),
      ...(removalsFile ? [`removals=${removalsFile}`] : []), ...(levelsFile ? [`levels=${levelsFile}`] : [])] }
  };
  function runPlanner(kind, o) {
    const { script, args } = PLANNERS[kind];
    const f = o.files;
    fs.mkdirSync(path.dirname(f.plan), { recursive: true });
    return runChild('plan', pythonCmd, [path.join(settings().pipelineDir, script), f.words, f.day, f.plan,
      `start=${o.start}`, `end=${o.end}`, ...args(o), ...o.cuts.map((c) => `cut=${c}`)]);
  }

  async function runPlan({ start, end, extra, punch, delivery, direction: note, useMarks = false } = {}) {
    if (!s.day) throw new Error('Run Prep first');
    const kind = planKind(s.day);
    const f = files();
    if (!fs.existsSync(f.words)) throw new Error('Run Transcribe first');
    const total = dayFrames(s.day);
    // a section of the day (to test on a few minutes instead of the whole recording)
    if (useMarks) await readMarks();                 // read them again: Jordan may have moved them
    const fromF = useMarks ? s.marks.from : parseSection(start, s.day);
    const toF = useMarks ? s.marks.to : parseSection(end, s.day);
    const a = fromF === null ? 0 : fromF;
    const b = toF === null ? total : toF;
    if (b <= a) throw new Error('To must be after From');
    const cutList = [];
    const st0 = settings();
    if (!claudeKey() && !claudeClient) throw new Error('Add a Claude API key in Settings below');
    if (note !== undefined) {
      const p = (getPrefs() || {}).cutThrough || {};
      setPrefs({ cutThrough: { ...p, directions: { ...(p.directions || {}), [s.label]: String(note).trim().slice(0, 4000) } } });
    }
    const st = begin('plan');
    st.progress = { phase: 'Getting ready', phaseAt: Date.now(), bar: null };
    emit();
    const started = Date.now();
    const o = { files: f, start: Math.round(a), end: Math.round(b), extra: extra || null, punch: punch || null, cuts: cutList };
    {   // solo and conversations: Claude edits, place_cuts.py places (Z8)
      // Z8 cuts from the waveform: an older transcription has no per-frame levels yet → one
      // levels-only pass over the audio (no Whisper), which also adds the loud-without-words marks
      // a transcript from before WhisperX alignment (2026-11-06): pin its words to the audio
      // once (no Whisper, minutes on the GPU) — Whisper's own word times cut words in half
      if (!fs.existsSync(f.align)) {
        st.progress = { phase: 'Aligning words to the audio', phaseAt: Date.now(), bar: null };
        emit();
        const al = await runChild('plan', st0.wxPython, [path.join(st0.pipelineDir, 'transcribe.py'), s.label, `dir=${runDir()}`, 'align_only=1'], {
          onLine: (line) => {
            const r = parseRead(line);
            if (r) {
              st.progress = { ...st.progress, phase: `Aligning words · reading ${r.name} · ${Math.round(r.mb)} MB`, bar: r.pct };
              return true;
            }
            const m = /^Aligning words to the audio (\d+)%/.exec(line.trim());
            if (m) {
              st.progress = { ...st.progress, phase: 'Aligning words to the audio', bar: Number(m[1]) };
              return true;
            }
            return false;
          }
        });
        if (canceled) {
          finish('plan', { error: null, report: st.log.slice(), reportFile: saveLog('plan') });
          return snapshot();
        }
        // unaligned word times cut words in half (Elevate, 2026-11-06: LP1 had no WhisperX and
        // Plan carried on quietly) — stop instead, and say why
        if (al.error || al.code !== 0 || !fs.existsSync(f.align)) {
          finish('plan', { error: 'Words not aligned to the audio, so cuts would clip words. WhisperX is missing or failed in the Whisper Python (see report).',
            report: st.log.slice(), reportFile: saveLog('plan') });
          return snapshot();
        }
      }
      if (!fs.existsSync(f.levels)) {
        st.progress = { phase: 'Measuring the audio (levels for cut placement)', phaseAt: Date.now(), bar: null };
        emit();
        const lv = await runChild('plan', st0.wxPython, [path.join(st0.pipelineDir, 'transcribe.py'), s.label, `dir=${runDir()}`, 'levels_only=1'], {
          onLine: (line) => {
            const r = parseRead(line);
            if (!r) return false;
            st.progress = { ...st.progress, phase: `Measuring the audio · ${r.name} · ${Math.round(r.mb)} MB`, bar: r.pct };
            return true;
          }
        });
        if (lv.error || lv.code !== 0 || !fs.existsSync(f.levels)) {
          const why = lv.error || exitError('plan', 'transcribe.py levels_only', lv.code);
          finish('plan', { error: why, report: st.log.slice(), reportFile: saveLog('plan') });
          return snapshot();
        }
      }
      o.levelsFile = f.levels;
      // Claude edits like Z8 — every removal and every shot; place_cuts.py places the cuts
      st.progress = { phase: 'Claude is reading the transcript', phaseAt: Date.now(), bar: null };
      emit();
      try {
        const out = await claude.planWithClaude({
          label: s.label, wordsPath: f.words, dayPath: f.day, outDir: f.dir, costsDir: settings().filesDir,
          promptPath: path.join(st0.pipelineDir, 'editor_briefs', kind === 'convo' ? 'conversation.md' : 'solo.md'),
          start: o.start, end: o.end, apiKey: claudeKey(), model: st0.claudeModel, effort: st0.claudeEffort,
          delivery: claude.DELIVERY[delivery] ? delivery : (kind === 'convo' ? 'convo' : 'scripted'),
          roles: { punch: o.punch || undefined, extra: o.extra ? [o.extra] : [] },
          direction: direction(),
          client: claudeClient,
          log: (line) => { pushLog('plan', line); emit(); },
          onEvent: (ev) => {
            if (ev.type === 'writing' && !String(st.progress.phase).startsWith('Claude is writing')) {
              st.progress = { phase: 'Claude is writing the edit', phaseAt: Date.now(), bar: null };
              emit();
            }
          }
        });
        out.lines.forEach((line) => pushLog('plan', line));
        o.removalsFile = out.removalsFile;
      } catch (err) {
        const msg = err instanceof Error ? err.message : errMsg(err);   // SDK errors carry status + message
        pushLog('plan', `✗ ${msg}`);
        finish('plan', { error: `Claude: ${msg}`, report: st.log.slice(), reportFile: saveLog('plan') });
        return snapshot();
      }
      st.progress = { phase: 'Placing the cuts on the waveform', phaseAt: Date.now(), bar: null };
      emit();
    }
    const res = await runPlanner('solo', o);   // the Claude edit's placer, solo or conversation
    let error = res.error;
    if (!error && res.code !== 0) error = exitError('plan', PLANNERS.solo.script, res.code);
    if (!error && !(mtime(f.plan) >= started - 2000)) error = `${s.label}_plan.json was not written`;
    finish('plan', { error, report: st.log.slice(), reportFile: error ? saveLog('plan') : f.claudeEdit,
      data: error ? null : planSummary(readJson(f.plan)) });
    return snapshot();
  }

  /** Accept <run folder>/<LABEL>_plan.json as-is (solo days, hand-made plans). */
  function useExistingPlan() {
    if (s.busy) throw new Error(`${s.busy} is still running`);
    const f = files();
    const plan = readJson(f.plan);
    if (!plan) throw new Error(`No readable ${s.label}_plan.json in ${f.dir}`);
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
    s.project = last.lastProject || null;
    show(last.lastMc, last.lastLabel);
  }

  return {
    snapshot,
    listMulticams,
    select,
    onProject,
    updateSettings,
    runPrep,
    runTranscribe,
    cancel,
    runPlan,
    useExistingPlan,
    readMarks,
    runBuild,
    runScore,
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
  parseRead,
  sanitizeLabel,
  micAngles,
  planKind,
  dayFrames,
  parseSection,
  frameToTc,
  defaultPipelineDir,
  DEFAULT_SEQ_BIN
};
