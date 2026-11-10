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
 * Videos (2026-11-07): Plan can also work per video. findVideos splits the day into videos from
 * Prep's recordings + the LPOS slate's J-codes (cut_through_videos.js) → videos_<LABEL>.json; each
 * included video gets its own Claude edit and plan (<LABEL>__<id>_plan.json), live one after the
 * other or as one Message Batch (half price: review → submit → status / cancel → collect); Build
 * then makes one timeline per video, named by its J-code, from one import.
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
const motion = require('./cut_through_motion');
const angleRulesLib = require('../shared/angle_rules');
const videosLib = require('./cut_through_videos');
const { checkTimeline, planTimeline, TAG: CHECK_TAG } = require('./cut_through_check');
const compare = require('./cut_through_compare');

const STEP_KEYS = ['prep', 'transcribe', 'plan', 'build', 'check', 'compare'];
const DEFAULT_SEQ_BIN = 'MASTER / SEQUENCES';
const DEFAULT_WX_PYTHON = 'C:\\wxbench\\Scripts\\python.exe';
const MAX_LOG_LINES = 400;
const BATCH_POLL_MS = 60 * 1000;
const LIST_MULTICAMS_TIMEOUT_MS = 2 * 60 * 1000;
const BATCH_LIVE = ['in_progress', 'canceling'];

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

// What each angle of the multicam is (Jordan 2026-11-06): Claude is told the role and the habits
// measured from Jordan's edits for it; placement uses wide / close-up / inserts; `skip` is never used.
const ANGLE_ROLES = ['wide', 'closeup', 'slider', 'side', 'other', 'skip'];
const angleNumber = (a) => Number((/(\d+)\s*$/.exec(a) || [])[1] || 999);

/** The usual LeaderPass setup: Camera 1 wide, 2 close-up, 3 side, 4 slider; Slate never. */
function defaultAngleRoles(angles = []) {
  const out = {};
  for (const a of angles) {
    if (/slate/i.test(a)) out[a] = 'skip';
    else out[a] = { 1: 'wide', 2: 'closeup', 3: 'side', 4: 'slider' }[angleNumber(a)] || 'other';
  }
  if (angles.length && !Object.values(out).includes('wide')) {
    const first = [...angles].filter((a) => out[a] !== 'skip').sort((x, y) => angleNumber(x) - angleNumber(y))[0];
    if (first) out[first] = 'wide';
  }
  return out;
}

/** Roles → the placer's / Claude's terms: one wide, one close-up (punch-in), inserts, skipped. */
function rolesOf(map = {}, angles = []) {
  const sorted = [...angles].sort((x, y) => angleNumber(x) - angleNumber(y));
  const by = (r) => sorted.filter((a) => map[a] === r);
  const wide = by('wide')[0] || sorted.find((a) => map[a] !== 'skip') || null;
  const punch = by('closeup').find((a) => a !== wide) || null;
  return { wide, punch, slider: by('slider'), side: by('side'), other: [...by('other'), ...by('closeup').filter((a) => a !== punch), ...by('wide').filter((a) => a !== wide)],
    skip: by('skip') };
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
    getLpos = () => null,          // the LPOS client (slate notes, projects); main replaces it on reconnect
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
    videos: null,                   // videos_<LABEL>.json: the day's videos, their plans, the batch
    lposProjects: [],
    lposError: null,
    lposLoading: false,
    busy: null,                     // step key currently running
    steps: Object.fromEntries(STEP_KEYS.map((k) => [k, emptyStep()]))
  };
  let child = null;                 // transcribe / plan child process
  let canceled = false;

  function settings() {
    const p = (getPrefs() || {}).cutThrough || {};
    const runFolder = (s.project && (p.runFolders || {})[s.project]) || null;
    return {
      pipelineDir: pipelineDirFrom(p.pipelineDir || p.spikesDir, defaultPipelineDir({ isPackaged, appDir })),
      wxPython: p.wxPython || (process.platform === 'win32' ? DEFAULT_WX_PYTHON : 'python3'),
      seqBin: p.seqBin === undefined ? DEFAULT_SEQ_BIN : p.seqBin,
      claudeModel: p.claudeModel || claude.DEFAULT_MODEL,
      claudeEffort: p.claudeEffort || 'high',
      energyHints: p.energyHints !== false,
      sliderMotion: p.sliderMotion !== false,    // slider shots only while the slider moves (on trial 2026-11-10)      // pace / loudness hints in Claude's transcript (on trial 2026-11-10)
      // this Resolve project's data folder (chosen on the page, no default: see needRunFolder);
      // until it's chosen, earlier runs are still read from the old shared location
      runFolder,
      filesDir: runFolder || p.filesDir || filesDir,
      // the key itself never goes to the renderer
      claudeKey: claudeKey() ? (p.anthropicKey ? `saved …${p.anthropicKey.slice(-4)}` : 'from ANTHROPIC_API_KEY') : null,
      lposProject: (s.project && (p.lposProjects || {})[s.project]) || null
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
      motion: path.join(dir, `motion_${label}.json`),
      align: path.join(dir, `align_${label}.txt`),
      transcript: path.join(dir, `transcript_${label}.txt`),
      transcribeReport: path.join(dir, `transcribe_${label}.txt`),
      plan: path.join(dir, `${label}_plan.json`),
      buildReport: path.join(dir, `cut_through_${label}.txt`),
      checkReport: path.join(dir, `check_${label}.txt`),
      compareJson: path.join(dir, `compare_${label}.json`),
      compareHtml: path.join(dir, `compare_${label}.html`),
      videos: path.join(dir, `videos_${label}.json`),
      batchDraft: path.join(dir, `batch_${label}.json`)
    };
  }

  /** One video's files: its own Claude edit, removals, review markers and plan. */
  function videoFiles(id, label = s.label) {
    const dir = runDir(label);
    const tag = `${label}__${id}`;
    return { tag, plan: path.join(dir, `${tag}_plan.json`), review: path.join(dir, `review_${tag}.json`),
      removals: path.join(dir, `removals_${tag}.json`), claudeEdit: path.join(dir, `claude_edit_${tag}.json`) };
  }

  function writeVideos(m) {
    fs.mkdirSync(files().dir, { recursive: true });
    fs.writeFileSync(files().videos, JSON.stringify(m, null, 1), 'utf8');
    s.videos = m;
  }

  /** Videos mode is on (the last Plan was per video) and these are ready to build. */
  function videosToBuild() {
    const m = s.videos;
    if (!m || !m.active) return [];
    return (m.videos || []).filter((v) => v.include && v.plan && v.plan.status === 'planned' && fs.existsSync(videoFiles(v.id).plan));
  }

  /** Jordan's plain-language direction for Claude, saved per label on this machine. */
  function direction(label = s.label) {
    const p = (getPrefs() || {}).cutThrough || {};
    return (label && (p.directions || {})[label]) || '';
  }

  /** This project's angle roles (else the last project's, else the usual setup), for the day's angles. */
  function angleRoles() {
    const angles = (s.day && s.day.angles) || [];
    const p = (getPrefs() || {}).cutThrough || {};
    const saved = (s.project && (p.angleRoles || {})[s.project]) || p.lastAngleRoles || {};
    const base = defaultAngleRoles(angles);
    const out = {};
    for (const a of angles) out[a] = ANGLE_ROLES.includes(saved[a]) ? saved[a] : base[a];
    return out;
  }

  function saveAngleRoles(map) {
    const angles = (s.day && s.day.angles) || [];
    const clean = {};
    for (const a of angles) if (ANGLE_ROLES.includes(map[a])) clean[a] = map[a];
    if (!Object.keys(clean).length) return;
    const p = (getPrefs() || {}).cutThrough || {};
    const next = { ...p, lastAngleRoles: { ...(p.lastAngleRoles || {}), ...clean } };
    if (s.project) next.angleRoles = { ...(p.angleRoles || {}), [s.project]: { ...((p.angleRoles || {})[s.project] || {}), ...clean } };
    setPrefs({ cutThrough: next });
  }

  /** "Never cut from X to Y" rules for this project's multicam (Jordan 2026-11-10). */
  function angleRules() {
    const p = (getPrefs() || {}).cutThrough || {};
    const saved = (s.project && s.mc && ((p.angleRules || {})[s.project] || {})[s.mc]) || [];
    return angleRulesLib.clean(saved, (s.day && s.day.angles) || []);
  }

  /** The angles a cut can use (not "Don't use") and their roles, for checking rules. */
  function usableAngles() {
    const roles = angleRoles();
    return { angles: ((s.day && s.day.angles) || []).filter((a) => roles[a] !== 'skip'), roles };
  }

  function saveAngleRules({ rules, roles: roleMap } = {}) {
    if (!s.project || !s.mc || !s.day) throw new Error('Pick a multicam and run Prep first');
    if (roleMap && typeof roleMap === 'object') saveAngleRoles(roleMap);
    const list = angleRulesLib.clean(rules, s.day.angles || []);
    const { angles, roles } = usableAngles();
    const { errors } = angleRulesLib.check(angles, list, roles);
    if (errors.length) throw new Error(errors[0]);
    const p = (getPrefs() || {}).cutThrough || {};
    const all = { ...(p.angleRules || {}) };
    all[s.project] = { ...(all[s.project] || {}), [s.mc]: list };
    setPrefs({ cutThrough: { ...p, angleRules: all } });
    emit();
    return snapshot();
  }

  /** The rules a Plan uses: only between usable angles; a set that no longer checks out (roles
   *  changed since) is reported and left out rather than trap the placer. */
  function planRules() {
    const { angles, roles } = usableAngles();
    const list = angleRulesLib.clean(angleRules(), angles);
    if (!list.length) return [];
    const { errors } = angleRulesLib.check(angles, list, roles);
    if (errors.length) { pushLog('plan', `Angle rules not used: ${errors[0]}`); return []; }
    return list;
  }

  function snapshot() {
    return { ...s, direction: direction(), angleRoles: angleRoles(), angleRules: angleRules(), settings: settings(), files: s.label ? files() : null,
      videosReady: videosToBuild().length, now: Date.now() };
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

  /** Nothing is written until this project has its run folder, and the folder can be reached. */
  function needRunFolder() {
    const { runFolder } = settings();
    if (!runFolder) throw new Error('Choose a run folder for this project first');
    if (!fs.existsSync(runFolder)) throw new Error(`Run folder not reachable: ${runFolder}`);
  }

  function begin(step) {
    if (s.busy) throw new Error(`${s.busy} is still running`);
    if (!s.label) throw new Error('Pick a multicam and label first');
    needRunFolder();
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
    maybeCollect();
  }

  /** An ended batch that wasn't read yet (something else was running, or EditPanel was closed). */
  function maybeCollect() {
    const b = s.videos && s.videos.batch;
    if (!s.busy && b && b.id && b.status === 'ended' && !b.collected && !b.collectError) {
      setTimeout(() => { if (!s.busy) collectBatch().catch(() => {}); }, 0);
    }
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
    s.videos = readJson(f.videos);
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
      plan: [readJson(f.videos)?.active ? f.videos : f.plan, null],
      build: [f.buildReport, f.buildReport],
      check: [f.checkReport, f.checkReport],
      compare: [f.compareHtml, null]
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
    // A worker request has no timeout of its own: a hung Resolve would leave "Loading…" up forever.
    let timer = null;
    try {
      const res = await Promise.race([
        sendWorkerRequest({ cmd: 'ct_list_multicams' }, 'resolve'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Resolve did not answer. If it stays stuck, quit Resolve, end any leftover Resolve process and relaunch.')), LIST_MULTICAMS_TIMEOUT_MS);
        })
      ]);
      s.multicams = res?.data?.multicams || [];
      applyProject(res?.data?.project || null);
    } catch (err) {
      s.multicams = [];
      s.multicamsError = errMsg(err);
    } finally {
      clearTimeout(timer);
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
      `transcript_${label}.txt`, `transcribe_${label}.txt`, `cut_through_${label}.txt`, `check_${label}.txt`, `check_${label}.json`,
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
    pollBatch();
    if (batchLive() && (claudeKey() || claudeClient)) refreshBatch().catch(() => {});
    else maybeCollect();
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
    for (const k of ['pipelineDir', 'wxPython', 'seqBin', 'anthropicKey', 'claudeModel', 'claudeEffort']) {
      if (patch[k] !== undefined) next[k] = String(patch[k]).trim();
    }
    if (patch.energyHints !== undefined) next.energyHints = !!patch.energyHints;
    if (patch.sliderMotion !== undefined) next.sliderMotion = !!patch.sliderMotion;
    // the LPOS project whose slate names this Resolve project's videos
    if (patch.lposProject !== undefined && s.project) {
      const lp = patch.lposProject && patch.lposProject.id ? { id: String(patch.lposProject.id), name: String(patch.lposProject.name || '') } : null;
      next.lposProjects = { ...(p.lposProjects || {}), [s.project]: lp };
    }
    setPrefs({ cutThrough: next });
    refreshFiles();
    emit();
    return snapshot();
  }

  /** A plan names its review file by full path: follow the run to its new folder. */
  function repointPlans(fromDir, toDir) {
    let labels = [];
    try { labels = fs.readdirSync(toDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { return; }
    for (const label of labels) {
      const dir = path.join(toDir, label);
      for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('_plan.json'))) {
        const file = path.join(dir, n);
        const plan = readJson(file);
        if (!plan || typeof plan.review_file !== 'string' || !plan.review_file.startsWith(fromDir + path.sep)) continue;
        try {
          fs.writeFileSync(file, JSON.stringify({ ...plan, review_file: path.join(toDir, path.relative(fromDir, plan.review_file)) }, null, 1), 'utf8');
        } catch (_) { /* the old copy is still there */ }
      }
    }
  }

  /**
   * Set this Resolve project's run folder. Its earlier runs are copied across (the originals stay,
   * and nothing already in the new folder is overwritten) so a finished Transcribe isn't lost.
   * The folder is only saved once the copy has worked.
   */
  async function setRunFolder({ folder } = {}) {
    if (s.busy) throw new Error(`${s.busy} is still running`);
    if (!s.project) throw new Error('Open a Resolve project first');
    const target = String(folder || '').trim();
    if (!target || !path.isAbsolute(target)) throw new Error('Choose a full folder path');
    const from = path.join(settings().filesDir, folderName(s.project));
    const to = path.join(target, folderName(s.project));
    s.busy = 'Copying runs';
    emit();
    try {
      fs.mkdirSync(target, { recursive: true });
      if (path.resolve(from) !== path.resolve(to) && fs.existsSync(from)) {
        await fs.promises.cp(from, to, { recursive: true, force: false, errorOnExist: false });
        repointPlans(from, to);
      }
      const p = (getPrefs() || {}).cutThrough || {};
      setPrefs({ cutThrough: { ...p, runFolders: { ...(p.runFolders || {}), [s.project]: target } } });
    } finally {
      s.busy = null;
    }
    show(s.mc, s.label);
    if (pendingProject) { const n = pendingProject; pendingProject = null; onProject(n); }
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
    const vids = videosToBuild();
    if (s.videos && s.videos.active && !vids.length) throw new Error('No planned videos to build');
    if (!vids.length && !fs.existsSync(files().plan)) throw new Error('No plan for this label yet');
    const bin = settings().seqBin;
    const which = vids.length
      ? { PLAN_FILES: vids.map((v) => [videoFiles(v.id).plan, v.name]) }
      : { PLAN_FILE: files().plan };
    const out = await runStep('build', 'build_rough_cut.py', { LABEL: s.label, OUT_DIR: runDir(), ...which, ...(bin ? { SEQ_BIN: bin } : {}) });
    finish('build', { error: out.error, report: out.lines, reportFile: files().buildReport });
    // mark what's left on the new rough cuts straight away (Jordan looks once, after this)
    if (!out.error && fs.existsSync(files().words)) await runCheck({});
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

  /** The rough cuts Build made for this label ("<LABEL> rough cut", one per video). */
  async function roughCuts() {
    const res = await sendWorkerRequest({ cmd: 'list_timelines' }, 'resolve');
    const names = (res?.data?.timelines || []).map((t) => t.name).filter(Boolean);
    const vids = videosToBuild();
    if (vids.length) return vids.map((v) => v.name).filter((n) => names.includes(n));
    const base = `${s.label} rough cut`;
    return names.filter((n) => n.startsWith(base)).sort();
  }

  /** What Check needs to know about one rough cut: its video's kind and Claude's pauses / beats. */
  function checkContext(name) {
    const v = videosToBuild().find((x) => x.name === name);
    if (v) {
      const given = readJson(videoFiles(v.id).removals) || {};
      return { kind: v.kind === 'convo' ? 'convo' : 'solo', pauses: given.pauses || null, beats: given.beats || [], multicam: s.videos.multicam };
    }
    const given = readJson(path.join(files().dir, `removals_${s.label}.json`)) || {};
    return { kind: s.day ? planKind(s.day) : 'solo', pauses: given.pauses || null, beats: given.beats || [], multicam: null };
  }

  /** Check: read each rough cut back from Resolve as it is now, mark what an editor would fix
   *  (red: word cut off, ends mid-sentence, cue kept; yellow: joins mid-sentence, gaps, repeats,
   *  sound with no words, flash shots). Free — no Claude. A re-run replaces its own markers. */
  async function runCheck({ timeline } = {}) {
    const f = files();
    const words = readJson(f.words);
    if (!words) throw new Error('Run Transcribe first');
    const st = begin('check');
    st.traceId = randomUUID();
    st.progress = { phase: 'Finding the rough cuts', phaseAt: Date.now(), bar: null };
    emit();
    let error = null;
    const report = [];
    const results = [];
    try {
      const names = timeline ? [String(timeline)] : await roughCuts();
      if (!names.length) throw new Error(`No "${s.label} rough cut" timeline in this project — Build first`);
      if (!words.aligned) report.push('Words NOT aligned to the audio — "Word cut off" is approximate. Re-run Plan to align them.');
      for (const [k, name] of names.entries()) {
        const cx = checkContext(name);
        const multicam = cx.multicam || (readJson(f.plan) || {}).multicam || s.mc || words.multicam || null;
        const { kind, pauses, beats } = cx;
        st.progress = { phase: `Checking ${name}`, phaseAt: Date.now(), bar: names.length > 1 ? Math.round((k / names.length) * 100) : null };
        emit();
        const tl = (await sendWorkerRequest({ cmd: 'ct_read_timeline', name, trace_id: st.traceId }, 'resolve')).data;
        const out = checkTimeline({ timeline: tl, words, kind, multicam, pauses, beats });
        const placed = (await sendWorkerRequest({ cmd: 'ct_set_markers', name, tag: CHECK_TAG,
          markers: out.markers.map(({ frame, color, name: n, note }) => ({ frame, color, name: n, note })), trace_id: st.traceId }, 'resolve')).data || {};
        report.push(...out.lines);
        if (placed.failed) report.push(`  (${placed.failed} marker(s) couldn't be placed)`);
        report.push('');
        results.push({ ...out.data, markers: out.markers, placed: placed.placed ?? null });
      }
      const red = results.reduce((n, r) => n + r.red, 0);
      const yellow = results.reduce((n, r) => n + r.yellow, 0);
      const kinds = {};
      for (const r of results) for (const [k, n] of Object.entries(r.kinds)) kinds[k] = (kinds[k] || 0) + n;
      const repeats = results.reduce((n, r) => n + r.repeats, 0);
      st.data = { timelines: results.length, red, yellow, repeats, kinds };
      report.unshift(`Checked ${results.length} timeline(s): ${red} red, ${yellow} yellow, ${repeats} repeat`, '');
      fs.mkdirSync(f.dir, { recursive: true });
      fs.writeFileSync(f.checkReport, report.join('\n') + '\n', 'utf8');
      fs.writeFileSync(f.checkReport.replace(/\.txt$/, '.json'), JSON.stringify({ ...st.data, results }, null, 1), 'utf8');
    } catch (err) {
      error = err instanceof Error ? err.message : errMsg(err);
    }
    finish('check', { error, report, reportFile: error ? null : f.checkReport, data: error ? null : st.data });
    return snapshot();
  }

  /** Every plan this run has, each with the files that explain it. */
  function comparablePlans() {
    const f = files();
    const vids = (s.videos && s.videos.active && s.videos.videos) || [];
    const out = vids.map((v) => ({ id: v.id, kind: v.kind === 'convo' ? 'convo' : 'solo', ...videoFiles(v.id) }));
    if (!out.length) {
      out.push({ id: null, kind: s.day ? planKind(s.day) : 'solo', plan: f.plan,
        removals: path.join(f.dir, `removals_${s.label}.json`), review: path.join(f.dir, `review_${s.label}.json`) });
    }
    return out.map((p) => ({ ...p, data: readJson(p.plan) })).filter((p) => p.data && (p.data.video || []).length);
  }

  /** Compare: each rough cut as it is now in Resolve against the plan it was built from. Read-only
   *  and free. Writes compare_<label>.json (for reading patterns) and .html (for looking). */
  async function runCompare({ timeline } = {}) {
    const f = files();
    const words = readJson(f.words);
    if (!words) throw new Error('Run Transcribe first');
    const st = begin('compare');
    st.traceId = randomUUID();
    st.progress = { phase: 'Finding the rough cuts', phaseAt: Date.now(), bar: null };
    emit();
    let error = null;
    let report = [];
    try {
      const plans = comparablePlans();
      if (!plans.length) throw new Error('No plan in this run to compare against');
      const names = timeline ? [String(timeline)] : await roughCuts();
      if (!names.length) throw new Error('No rough cut timeline in this project');
      const levels = readJson(f.levels);
      const results = [];
      const used = {};
      const skipped = [];
      for (const [k, name] of names.entries()) {
        st.progress = { phase: `Comparing ${name}`, phaseAt: Date.now(), bar: names.length > 1 ? Math.round((k / names.length) * 100) : null };
        emit();
        const tl = (await sendWorkerRequest({ cmd: 'ct_read_timeline', name, audio: true, trace_id: st.traceId }, 'resolve')).data;
        const best = plans.map((p) => ({ p, score: compare.planMatch(tl, p.data) })).sort((a, b) => b.score - a.score)[0];
        if (!best || best.score < 0.5) { skipped.push(name); continue; }
        const removals = readJson(best.p.removals);
        results.push(compare.compareTimeline({ timeline: tl, plan: best.p.data, words, removals, review: readJson(best.p.review), levels,
          kind: best.p.kind, pauses: (removals && removals.pauses) || null, beats: (removals && removals.beats) || [], motion: readJson(f.motion) }));
        used[name] = best.p.data;
      }
      if (!results.length) throw new Error(`No plan matches ${names.join(', ')}`);
      const sum = compare.totals(results);
      report = compare.reportLines(results, sum);
      if (skipped.length) report.push(`No matching plan: ${skipped.join(', ')}`);
      st.data = { timelines: sum.timelines, changed: sum.changed, restored: sum.words.restored, cut: sum.words.cut, byType: sum.byType };
      fs.mkdirSync(f.dir, { recursive: true });
      fs.writeFileSync(f.compareJson, JSON.stringify({ label: s.label, madeAt: Date.now(), totals: sum, results }, null, 1), 'utf8');
      fs.writeFileSync(f.compareHtml, compare.reportHtml({ label: s.label, results, sum, levels, plans: used }), 'utf8');
    } catch (err) {
      error = err instanceof Error ? err.message : errMsg(err);
    }
    finish('compare', { error, report, reportFile: error ? null : f.compareHtml, data: error ? null : st.data });
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
    solo: { script: 'place_cuts.py', args: ({ wide, extra, punch, skip, removalsFile, levelsFile, motionFile, nocut, talker, reviewFile }) => [...(motionFile ? [`motion=${motionFile}`] : []),
      ...(nocut || []).map((r) => `nocut=${r}`),...(wide ? [`wide=${wide}`] : []),
      ...(punch ? [`punch=${punch}`] : []), ...[].concat(extra || []).map((x) => `extra=${x}`), ...(skip || []).map((x) => `skip=${x}`),
      ...(removalsFile ? [`removals=${removalsFile}`] : []), ...(levelsFile ? [`levels=${levelsFile}`] : []),
      ...(talker ? [`talker=${talker}`] : []), ...(reviewFile ? [`review=${reviewFile}`] : [])] }
  };
  function runPlanner(kind, o) {
    const { script, args } = PLANNERS[kind];
    const f = o.files;
    const planFile = o.planFile || f.plan;
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    return runChild('plan', pythonCmd, [path.join(settings().pipelineDir, script), f.words, f.day, planFile,
      `start=${o.start}`, `end=${o.end}`, ...args(o), ...o.cuts.map((c) => `cut=${c}`),
      ...(o.trims || []).map(([a, b]) => `trim=${a}-${b}`), ...(o.keeps || []).map(([a, b]) => `keep=${a}-${b}`)]);
  }

  /** Before any Claude edit: words pinned to the audio (WhisperX) and per-frame levels (cut
   *  placement). Each runs once per label. Returns an error message, or null. */
  async function ensureAudioPrep(st, f, st0) {
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
      if (canceled) return null;
      // unaligned word times cut words in half (Elevate, 2026-11-06: LP1 had no WhisperX and
      // Plan carried on quietly) — stop instead, and say why
      if (al.error || al.code !== 0 || !fs.existsSync(f.align)) {
        return 'Words not aligned to the audio, so cuts would clip words. WhisperX is missing or failed in the Whisper Python (see report).';
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
        return lv.error || exitError('plan', 'transcribe.py levels_only', lv.code);
      }
    }
    await ensureSliderMotion(st, f, st0);
    return null;
  }

  /** When each slider angle is actually moving (Jordan 2026-11-10, on trial): read once per angle
   *  per label from the slider's own video. A failure only logs — Plan carries on without it. */
  async function ensureSliderMotion(st, f, st0) {
    if (!st0.sliderMotion || !s.day) return;
    const sliders = rolesOf(angleRoles(), s.day.angles || []).slider;
    if (!sliders.length) return;
    const have = readJson(f.motion) || {};
    const ff = ffmpegPath || 'ffmpeg';
    const frameSec = s.day.frame_sec[0] / s.day.frame_sec[1];
    for (const angle of sliders) {
      if (have[angle] || canceled) continue;
      // the angle's picture clips (Prep from 1.2.126); an older day: its camera clips with sound
      const clips = (s.day.picture_clips || s.day.camera_audio || []).filter((c) => c.angle === angle && c.path && c.to_sec > c.from_sec);
      if (!clips.length) { pushLog('plan', `Slider motion: no clips found for ${angle} (run Prep again)`); continue; }
      st.progress = { phase: `Reading when the slider moves (${angle})`, phaseAt: Date.now(), bar: 0 };
      emit();
      try {
        const r = await motion.sliderMotion({ ffmpeg: ff, clips, frameSec,
          onProgress: (k, n) => { st.progress = { ...st.progress, bar: Math.round((k / n) * 100) }; emit(); },
          onProc: (p) => { child = p; } });
        have[angle] = r;
        fs.writeFileSync(f.motion, JSON.stringify(have, null, 1), 'utf8');
        pushLog('plan', `Slider motion (${angle}): ${r.report}`);
      } catch (err) {
        if (!canceled) pushLog('plan', `Slider motion (${angle}) not read: ${err.message} — Plan carries on without it`);
      }
    }
  }

  async function runPlan({ start, end, extra, punch, roles: roleMap, delivery, direction: note, useMarks = false } = {}) {
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
    // what each angle is: the page's roles (saved for this project), else the saved/usual ones;
    // an explicit punch / extra (older callers) still wins for those two
    if (roleMap && typeof roleMap === 'object') saveAngleRoles(roleMap);
    const R = rolesOf(angleRoles(), (s.day && s.day.angles) || []);
    const extras = [...new Set([...(extra ? [extra] : []), ...R.slider, ...R.side, ...R.other])].filter((x) => x !== (punch || R.punch) && x !== R.wide);
    const o = { files: f, start: Math.round(a), end: Math.round(b), wide: R.wide, punch: punch || R.punch || null, extra: extras, skip: R.skip,
      roles: R, cuts: cutList };
    {   // solo and conversations: Claude edits, place_cuts.py places (Z8)
      // Z8 cuts from the waveform: an older transcription has no per-frame levels yet → one
      // levels-only pass over the audio (no Whisper), which also adds the loud-without-words marks
      // a transcript from before WhisperX alignment (2026-11-06): pin its words to the audio
      // once (no Whisper, minutes on the GPU) — Whisper's own word times cut words in half
      const prepErr = await ensureAudioPrep(st, f, st0);
      if (canceled) {
        finish('plan', { error: null, report: st.log.slice(), reportFile: saveLog('plan') });
        return snapshot();
      }
      if (prepErr) {
        finish('plan', { error: prepErr, report: st.log.slice(), reportFile: saveLog('plan') });
        return snapshot();
      }
      o.levelsFile = f.levels;
      if (st0.sliderMotion && fs.existsSync(f.motion)) o.motionFile = f.motion;
      o.nocut = planRules();
      // Claude edits like Z8 — every removal and every shot; place_cuts.py places the cuts
      st.progress = { phase: 'Claude is reading the transcript', phaseAt: Date.now(), bar: null };
      emit();
      try {
        const out = await claude.planWithClaude({
          label: s.label, wordsPath: f.words, dayPath: f.day, outDir: f.dir, costsDir: settings().filesDir,
          promptPath: path.join(st0.pipelineDir, 'editor_briefs', kind === 'convo' ? 'conversation.md' : 'solo.md'),
          start: o.start, end: o.end, apiKey: claudeKey(), model: st0.claudeModel, effort: st0.claudeEffort, energy: st0.energyHints, sliderMoving: !!o.motionFile, noCut: o.nocut,
          delivery: claude.DELIVERY[delivery] ? delivery : (kind === 'convo' ? 'convo' : 'scripted'),
          roles: { wide: o.wide || undefined, punch: o.punch || undefined, extra: o.extra, slider: o.roles.slider, side: o.roles.side,
            other: o.roles.other, skip: o.skip },
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
    if (!error) error = await secondPass(o, kind);
    // a section plan replaces a per-video one: Build makes the one "<LABEL> rough cut" again
    if (!error && s.videos && s.videos.active) writeVideos({ ...s.videos, active: false });
    finish('plan', { error, report: st.log.slice(), reportFile: error ? saveLog('plan') : f.claudeEdit,
      data: error ? null : planSummary(readJson(f.plan)) });
    return snapshot();
  }

  /** Second pass (Jordan 2026-11-06): Check the plan before anything is built and fix the easy,
   *  mechanical things — gaps left at joins, pauses over the rule, dead air at the head/tail,
   *  wordless slivers, words a cut went through — by placing the cuts once more with those
   *  trims/keeps. One build afterwards, so no extra timelines or multicam copies. No Claude. */
  async function secondPass(o, kind) {
    const f = o.files;
    const planFile = o.planFile || f.plan;
    const words = readJson(f.words);
    const plan = readJson(planFile);
    if (!words || !plan) return null;
    const given = readJson(o.removalsFile) || {};
    const pauses = given.pauses || null;
    const beats = given.beats || [];
    const first = checkTimeline({ timeline: planTimeline(plan), words, kind, multicam: plan.multicam, pauses, beats });
    const { trims, keeps, fixed } = first.fixes;
    if (!trims.length && !keeps.length) {
      pushLog('plan', 'Second pass: nothing to fix');
      return null;
    }
    st0Progress('Second pass: fixing gaps, pauses and cut words');
    const res = await runPlanner('solo', { ...o, trims, keeps });
    if (res.error || res.code !== 0) return res.error || exitError('plan', `${PLANNERS.solo.script} (second pass)`, res.code);
    const after = checkTimeline({ timeline: planTimeline(readJson(planFile) || plan), words, kind, multicam: plan.multicam, pauses, beats });
    const what = Object.entries(fixed).map(([k, n]) => `${k.toLowerCase()} × ${n}`).join(', ');
    pushLog('plan', `Second pass fixed ${what}; left for you: ${after.data.red} red, ${after.data.yellow} yellow (marked after Build)`);
    o.checked = after.data;
    return null;
  }

  function st0Progress(phase) {
    const st = s.steps.plan;
    st.progress = { phase, phaseAt: Date.now(), bar: null };
    emit();
  }

  // ── videos: one plan per video, live or as a Message Batch ────
  function lposClient() {
    const c = getLpos();
    return c && (typeof c.isConfigured !== 'function' || c.isConfigured()) ? c : null;
  }

  async function listLposProjects() {
    const c = lposClient();
    s.lposLoading = true;
    s.lposError = null;
    emit();
    try {
      if (!c) throw new Error('LPOS not connected');
      const data = await c.listProjects();
      s.lposProjects = (data?.projects || []).map((p) => ({ id: p.projectId || p.id, name: p.name || p.projectId, client: p.clientName || '' }))
        .filter((p) => p.id).sort((a, b) => `${a.client} ${a.name}`.localeCompare(`${b.client} ${b.name}`));
    } catch (err) {
      s.lposProjects = [];
      s.lposError = errMsg(err);
    } finally {
      s.lposLoading = false;
      emit();
    }
    return snapshot();
  }

  function batchLive() {
    return Boolean(s.videos && s.videos.batch && BATCH_LIVE.includes(s.videos.batch.status));
  }

  /**
   * Split the day into videos: Prep's recordings + the LPOS slate's J-codes (+ the words, to cut in
   * a pause and to tell solo from conversation). offsetSec: '' = work it out from the slate.
   * Earlier choices (tick, type, name) and plans stay with a video that comes back unchanged.
   */
  async function findVideos({ offsetSec, firstCode } = {}) {
    if (s.busy) throw new Error(`${s.busy} is still running`);
    needRunFolder();
    if (!s.day) throw new Error('Run Prep first');
    const f = files();
    const words = readJson(f.words);
    if (!words) throw new Error('Run Transcribe first');
    if (batchLive()) throw new Error('A batch is still running for these videos — cancel it or wait');
    const lp = settings().lposProject;
    let notes = [];
    if (lp) {
      const c = lposClient();
      if (!c) throw new Error('LPOS not connected — pick "No slate" to split by recordings only');
      const data = await c.getSlateNotes(lp.id);
      notes = Array.isArray(data?.notes) ? data.notes : [];
    }
    const first = lp ? String(firstCode || '').trim() : '';
    if (first) {
      notes = videosLib.notesFrom(s.day, notes, first);
      if (!notes) throw new Error(`${first} isn't on this slate`);
    }
    const auto = videosLib.slateOffset(s.day, notes);
    const manual = offsetSec !== undefined && offsetSec !== null && String(offsetSec).trim() !== '' && Number.isFinite(Number(offsetSec));
    const used = manual ? Number(offsetSec) : auto.offsetSec;
    const found = videosLib.findVideos({ day: s.day, words, notes, offsetSec: used, label: s.label, firstCode: first });
    const old = new Map(((s.videos && s.videos.videos) || []).map((v) => [v.id, v]));
    const videos = found.map((v) => {
      const o = old.get(v.id);
      if (!o || o.from !== v.from || o.to !== v.to) return { ...v, plan: { status: 'none' } };
      const kept = { ...v, include: o.include, delivery: o.delivery, name: o.name, kind: o.kind, talker: o.talker };
      return { ...kept, plan: o.plan && o.plan.status === 'planned' && fs.existsSync(videoFiles(v.id).plan) ? o.plan : { status: 'none' } };
    });
    const codes = notes.filter((n) => n.code && n.code !== 'ATEM').length;
    writeVideos({
      label: s.label, multicam: s.day.multicam, madeAt: Date.now(), lpos: lp, notes: codes, firstCode: first,
      offset: { used, auto: auto.offsetSec, manual, hours: auto.hours, seconds: auto.seconds, matched: auto.matched },
      active: Boolean(s.videos && s.videos.active), batch: null, videos
    });
    emit();
    return snapshot();
  }

  /** Create multicam: name its timelines from the slate. No projectId = one per recording, unnamed. */
  async function nameMulticamTimelines({ day, label, projectId, firstCode } = {}) {
    if (!day) throw new Error('No multicam details');
    let notes = [];
    if (projectId) {
      const c = lposClient();
      if (!c) throw new Error('LPOS not connected');
      const data = await c.getSlateNotes(projectId);
      notes = Array.isArray(data?.notes) ? data.notes : [];
    }
    const first = projectId ? String(firstCode || '').trim() : '';
    if (first) {
      notes = videosLib.notesFrom(day, notes, first);
      if (!notes) throw new Error(`${first} isn't on this slate`);
    }
    return { timelines: videosLib.spanTimelines({ day, notes, offsetSec: videosLib.slateOffset(day, notes).offsetSec, label }) };
  }

  function updateVideo(id, patch = {}) {
    if (!s.videos) throw new Error('Find the videos first');
    if (batchLive() || (s.videos.batch && s.videos.batch.status === 'draft')) throw new Error('Discard or finish the batch first');
    const videos = s.videos.videos.map((v) => {
      if (v.id !== id) return v;
      const next = { ...v };
      if (patch.include !== undefined) next.include = Boolean(patch.include);
      if (patch.name !== undefined) next.name = videosLib.cleanName(patch.name) || v.name;
      if (patch.delivery !== undefined && claude.DELIVERY[patch.delivery]) {
        next.delivery = patch.delivery;
        next.kind = patch.delivery === 'convo' ? 'convo' : 'solo';
        if (next.kind === 'solo' && !next.talker) next.talker = (readJson(files().words)?.mics || [])[0] || null;
      }
      return next;
    });
    writeVideos({ ...s.videos, videos });
    emit();
    return snapshot();
  }

  /** The options every video's edit shares (roles, direction) + this video's own. */
  function videoArgs(v, { roles: R, defaultDelivery }) {
    const st0 = settings();
    const f = files();
    const kind = v.kind === 'convo' ? 'convo' : 'solo';
    const delivery = claude.DELIVERY[v.delivery] ? v.delivery : kind === 'convo' ? 'convo' : (claude.DELIVERY[defaultDelivery] && defaultDelivery !== 'convo' ? defaultDelivery : 'scripted');
    const vf = videoFiles(v.id);
    return {
      label: vf.tag, wordsPath: f.words, dayPath: f.day, outDir: f.dir, costsDir: st0.filesDir,
      promptPath: path.join(st0.pipelineDir, 'editor_briefs', kind === 'convo' ? 'conversation.md' : 'solo.md'),
      start: v.from, end: v.to, model: st0.claudeModel, effort: st0.claudeEffort, energy: st0.energyHints, sliderMoving: st0.sliderMotion, noCut: planRules(), delivery,
      talker: kind === 'solo' ? v.talker || null : null,
      roles: { wide: R.wide || undefined, punch: R.punch || undefined, extra: R.extra, slider: R.slider, side: R.side, other: R.other, skip: R.skip },
      direction: direction(), kind
    };
  }

  function setVideoPlan(id, plan) {
    const videos = s.videos.videos.map((v) => (v.id === id ? { ...v, plan: { ...plan, at: Date.now() } } : v));
    writeVideos({ ...s.videos, videos });
  }

  /** Claude's edit for one video is in (removals file written): place the cuts, second pass. */
  async function placeVideo(v, args, removalsFile, R) {
    const vf = videoFiles(v.id);
    const extras = [...new Set([...R.slider, ...R.side, ...R.other])].filter((x) => x !== R.punch && x !== R.wide);
    const o = { files: files(), planFile: vf.plan, reviewFile: vf.review, start: v.from, end: v.to, wide: R.wide, punch: R.punch || null,
      extra: extras, skip: R.skip, roles: R, cuts: (v.gaps || []).map(([a, b]) => `${a}-${b}`), talker: args.talker,
      levelsFile: files().levels, removalsFile, motionFile: settings().sliderMotion && fs.existsSync(files().motion) ? files().motion : null,
      nocut: planRules() };
    const started = Date.now();
    const res = await runPlanner('solo', o);
    let error = res.error;
    if (!error && res.code !== 0) error = exitError('plan', PLANNERS.solo.script, res.code);
    if (!error && !(mtime(vf.plan) >= started - 2000)) error = `${path.basename(vf.plan)} was not written`;
    if (!error) error = await secondPass(o, args.kind);
    return { error, summary: error ? null : planSummary(readJson(vf.plan)) };
  }

  /** Shared start of a videos Plan: roles + direction saved, Claude key, videos chosen. */
  function videosPlanSetup({ ids, roles: roleMap, direction: note }) {
    if (!s.day) throw new Error('Run Prep first');
    if (!fs.existsSync(files().words)) throw new Error('Run Transcribe first');
    if (!s.videos || !s.videos.videos.length) throw new Error('Find the videos first');
    if (batchLive()) throw new Error('A batch is still running for these videos');
    if (!claudeKey() && !claudeClient) throw new Error('Add a Claude API key in Settings below');
    if (note !== undefined) {
      const p = (getPrefs() || {}).cutThrough || {};
      setPrefs({ cutThrough: { ...p, directions: { ...(p.directions || {}), [s.label]: String(note).trim().slice(0, 4000) } } });
    }
    if (roleMap && typeof roleMap === 'object') saveAngleRoles(roleMap);
    const want = ids && ids.length ? new Set(ids) : null;
    const list = s.videos.videos.filter((v) => (want ? want.has(v.id) : v.include));
    if (!list.length) throw new Error('No videos ticked');
    return { list, R: rolesOf(angleRoles(), s.day.angles || []) };
  }

  function claudeApi() {
    return claudeClient || claude.makeClient(claudeKey());
  }

  /** Plan the ticked videos now, one Claude call after another (ids: just those, e.g. a re-send). */
  async function planVideos({ ids, roles, direction: note, delivery } = {}) {
    const { list, R } = videosPlanSetup({ ids, roles, direction: note });
    const st = begin('plan');
    st.progress = { phase: 'Getting ready', phaseAt: Date.now(), bar: null };
    emit();
    const f = files();
    const st0 = settings();
    const prepErr = await ensureAudioPrep(st, f, st0);
    if (canceled || prepErr) {
      finish('plan', { error: canceled ? null : prepErr, report: st.log.slice(), reportFile: saveLog('plan') });
      return snapshot();
    }
    writeVideos({ ...s.videos, active: true });
    const results = [];
    for (const [k, v] of list.entries()) {
      st.progress = { phase: `${v.name} · Claude is reading the transcript`, phaseAt: Date.now(), bar: Math.round((k / list.length) * 100) };
      emit();
      pushLog('plan', `── ${v.name} (${v.fromTc}–${v.toTc}, ${v.kind === 'convo' ? 'conversation' : 'solo'}) ──`);
      const args = videoArgs(v, { roles: R, defaultDelivery: delivery });
      let error = null;
      let summary = null;
      let cost = null;
      try {
        const out = await claude.planWithClaude({ ...args, apiKey: claudeKey(), client: claudeClient,
          log: (line) => { pushLog('plan', line); emit(); },
          onEvent: (ev) => {
            if (ev.type === 'writing' && !String(st.progress.phase).endsWith('writing the edit')) {
              st.progress = { ...st.progress, phase: `${v.name} · Claude is writing the edit`, phaseAt: Date.now() };
              emit();
            }
          } });
        out.lines.forEach((line) => pushLog('plan', line));
        cost = out.cost;
        st.progress = { ...st.progress, phase: `${v.name} · placing the cuts`, phaseAt: Date.now() };
        emit();
        ({ error, summary } = await placeVideo(v, args, out.removalsFile, R));
      } catch (err) {
        error = `Claude: ${err instanceof Error ? err.message : errMsg(err)}`;
      }
      if (error) pushLog('plan', `✗ ${v.name}: ${error}`);
      setVideoPlan(v.id, error ? { status: 'failed', error, via: 'now' } : { status: 'planned', via: 'now', cost, summary });
      results.push({ v, error });
    }
    const failed = results.filter((r) => r.error);
    pushLog('plan', `Planned ${results.length - failed.length} of ${results.length} video(s)${failed.length ? `; failed: ${failed.map((r) => r.v.name).join(', ')}` : ''}`);
    finish('plan', { error: failed.length === results.length ? `No video was planned (${failed[0].error})` : null,
      report: st.log.slice(), reportFile: saveLog('plan'), data: videosSummary() });
    return snapshot();
  }

  function videosSummary() {
    const vids = (s.videos && s.videos.videos) || [];
    const by = (k) => vids.filter((v) => v.include && v.plan && v.plan.status === k).length;
    return { videos: vids.filter((v) => v.include).length, planned: by('planned'), failed: by('failed'), queued: by('queued') };
  }

  /** Output tokens per input token on this machine's earlier edits (cut_through_costs.csv), for the estimate. */
  function outputRatio() {
    const rows = readLines(path.join(settings().filesDir, 'cut_through_costs.csv')) || [];
    const ratios = rows.slice(1).map((l) => l.split(',')).filter((c) => /plan$/.test(c[2] || '') && Number(c[5]) > 0)
      .map((c) => Number(c[6]) / Number(c[5])).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return ratios.length >= 3 ? ratios[Math.floor(ratios.length / 2)] : 1;
  }

  /**
   * Batch, step 1: prepare every ticked video's request and price it (token count; output from
   * earlier runs). Nothing is sent: the page shows the list and the estimate → Submit or Discard.
   */
  async function prepareBatch({ ids, roles, direction: note, delivery } = {}) {
    const { list, R } = videosPlanSetup({ ids, roles, direction: note });
    const st = begin('plan');
    st.progress = { phase: 'Getting ready', phaseAt: Date.now(), bar: null };
    emit();
    const f = files();
    const st0 = settings();
    const prepErr = await ensureAudioPrep(st, f, st0);
    if (canceled || prepErr) {
      finish('plan', { error: canceled ? null : prepErr, report: st.log.slice(), reportFile: saveLog('plan') });
      return snapshot();
    }
    const api = claudeApi();
    const ratio = outputRatio();
    const requests = [];
    const items = {};
    const skipped = [];
    for (const [k, v] of list.entries()) {
      st.progress = { phase: `Pricing ${v.name}`, phaseAt: Date.now(), bar: Math.round((k / list.length) * 100) };
      emit();
      const args = videoArgs(v, { roles: R, defaultDelivery: delivery });
      let ctx;
      try {
        ctx = claude.preparePlan(args);
      } catch (err) {
        skipped.push(`${v.name}: ${err.message}`);
        continue;
      }
      let input = null;
      try {
        const counted = await api.messages.countTokens({ model: ctx.params.model, system: ctx.params.system, messages: ctx.params.messages });
        input = counted && Number(counted.input_tokens);
      } catch (_) { /* estimate below */ }
      if (!Number.isFinite(input) || input <= 0) input = Math.round((ctx.system.length + ctx.params.messages[0].content.length) / 3.5);
      const output = Math.round(input * ratio);
      const usd = claude.costOf(ctx.model, { input_tokens: input, output_tokens: output }, 0.5);
      const { label: _l, wordsPath: _w, dayPath: _d, outDir: _o, costsDir: _c, promptPath: _p, ...keep } = args;
      requests.push({ custom_id: v.id, params: ctx.params });
      items[v.id] = { name: v.name, input, output, usd, args: keep };
    }
    if (!requests.length) {
      finish('plan', { error: `Nothing to send: ${skipped.join('; ')}`, report: st.log.slice() });
      return snapshot();
    }
    // the requests quote client words: they stay in the run folder until sent
    fs.writeFileSync(f.batchDraft, JSON.stringify({ requests }), 'utf8');
    const total = Object.values(items).reduce((t, x) => t + x.usd, 0);
    writeVideos({ ...s.videos, batch: { status: 'draft', preparedAt: Date.now(), model: st0.claudeModel, effort: st0.claudeEffort,
      items, skipped, estimate: Math.round(total * 100) / 100, liveEstimate: Math.round(total * 200) / 100 } });
    pushLog('plan', `Batch ready: ${requests.length} video(s), about $${total.toFixed(2)} at the batch price` +
      (skipped.length ? `; left out: ${skipped.join('; ')}` : '') + '. Submit or discard.');
    finish('plan', { report: st.log.slice(), data: videosSummary() });
    return snapshot();
  }

  function discardBatch() {
    if (!s.videos || !s.videos.batch || s.videos.batch.status !== 'draft') throw new Error('No batch waiting to be sent');
    try { fs.rmSync(files().batchDraft, { force: true }); } catch (_) { /* gone */ }
    writeVideos({ ...s.videos, batch: null });
    emit();
    return snapshot();
  }

  /** Batch, step 2: send it. The id is saved with the videos, so a restart keeps track of it. */
  async function submitBatch() {
    if (s.busy) throw new Error(`${s.busy} is still running`);
    const b = s.videos && s.videos.batch;
    if (!b || b.status !== 'draft') throw new Error('Prepare a batch first');
    const draft = readJson(files().batchDraft);
    if (!draft || !Array.isArray(draft.requests) || !draft.requests.length) throw new Error('The prepared batch is missing — prepare it again');
    const created = await claudeApi().messages.batches.create({ requests: draft.requests });
    try { fs.rmSync(files().batchDraft, { force: true }); } catch (_) { /* sent */ }
    const videos = s.videos.videos.map((v) => (b.items[v.id] ? { ...v, plan: { status: 'queued', via: 'batch', at: Date.now() } } : v));
    writeVideos({ ...s.videos, active: true, videos, batch: { ...b, status: created.processing_status || 'in_progress', id: created.id,
      submittedAt: Date.now(), counts: created.request_counts || null, endedAt: null, collected: false } });
    pushLog('plan', `Batch sent: ${created.id} (${draft.requests.length} video(s))`);
    pollBatch();
    emit();
    return snapshot();
  }

  /** Status from Anthropic; an ended batch is collected straight away when nothing else runs. */
  async function refreshBatch() {
    const b = s.videos && s.videos.batch;
    if (!b || !b.id) return snapshot();
    const label = s.label;
    const got = await claudeApi().messages.batches.retrieve(b.id);
    if (s.label !== label || !s.videos || !s.videos.batch || s.videos.batch.id !== b.id) return snapshot();   // switched away meanwhile
    writeVideos({ ...s.videos, batch: { ...s.videos.batch, status: got.processing_status, counts: got.request_counts || null,
      endedAt: got.ended_at ? Date.parse(got.ended_at) : null, checkedAt: Date.now() } });
    if (got.processing_status === 'ended' && !s.videos.batch.collected && !s.busy) await collectBatch();
    pollBatch();
    emit();
    return snapshot();
  }

  async function cancelBatch() {
    const b = s.videos && s.videos.batch;
    if (!b || !b.id || !BATCH_LIVE.includes(b.status)) throw new Error('No batch running');
    await claudeApi().messages.batches.cancel(b.id);
    return refreshBatch();
  }

  /** Batch, step 3: read every answer back and place its cuts (same as a live edit, at half price). */
  async function collectBatch() {
    const b = s.videos && s.videos.batch;
    if (!b || !b.id) throw new Error('No batch to collect');
    const st = begin('plan');
    st.progress = { phase: 'Reading the batch results', phaseAt: Date.now(), bar: null };
    emit();
    const R = rolesOf(angleRoles(), s.day.angles || []);
    const f = files();
    const st0 = settings();
    const got = {};
    try {
      for await (const r of await claudeApi().messages.batches.results(b.id)) got[r.custom_id] = r.result;
    } catch (err) {
      writeVideos({ ...s.videos, batch: { ...s.videos.batch, collectError: errMsg(err) } });
      finish('plan', { error: `Couldn't read the batch results: ${errMsg(err)}`, report: st.log.slice() });
      return snapshot();
    }
    const ids = Object.keys(b.items || {});
    let n = 0;
    let spent = 0;
    for (const [k, id] of ids.entries()) {
      const v = s.videos.videos.find((x) => x.id === id);
      const item = b.items[id];
      if (!v) continue;
      st.progress = { phase: `${v.name} · placing the cuts`, phaseAt: Date.now(), bar: Math.round((k / ids.length) * 100) };
      emit();
      pushLog('plan', `── ${v.name} ──`);
      const result = got[id];
      let error = null;
      let summary = null;
      let cost = null;
      if (!result) error = 'No answer in the batch';
      else if (result.type === 'errored') error = `Batch error: ${result.error?.error?.message || result.error?.type || 'unknown'}`;
      else if (result.type === 'canceled') error = 'Canceled before it ran';
      else if (result.type === 'expired') error = 'Expired (not run within 24 h)';
      else {
        const args = { ...item.args, label: videoFiles(id).tag, wordsPath: f.words, dayPath: f.day, outDir: f.dir, costsDir: st0.filesDir,
          promptPath: path.join(st0.pipelineDir, 'editor_briefs', item.args.kind === 'convo' ? 'conversation.md' : 'solo.md') };
        const msg = result.message;
        try {
          const res = claude.readMessage(msg, b.model);
          claude.logCost({ costsDir: st0.filesDir, outDir: f.dir, label: args.label, step: 'batch_plan', model: res.model, effort: args.effort, usage: res.usage, factor: 0.5 });
          cost = claude.costOf(res.model, res.usage, 0.5);
          spent += cost;
          const ctx = claude.preparePlan(args);
          const out = claude.finishPlan(ctx, res, { outDir: f.dir, factor: 0.5, via: 'batch' });
          out.lines.forEach((line) => pushLog('plan', line));
          ({ error, summary } = await placeVideo(v, args, out.removalsFile, R));
        } catch (err) {
          if (err.usage) {
            const c = claude.costOf(err.model || b.model, err.usage, 0.5);
            claude.logCost({ costsDir: st0.filesDir, outDir: f.dir, label: args.label, step: 'batch_plan_failed', model: err.model || b.model, effort: args.effort, usage: err.usage, factor: 0.5 });
            spent += c;
            err.message += ` (billed $${c})`;
          }
          error = `Claude: ${err.message}`;
        }
      }
      if (error) pushLog('plan', `✗ ${v.name}: ${error}`);
      else n += 1;
      setVideoPlan(id, error ? { status: 'failed', error, via: 'batch' } : { status: 'planned', via: 'batch', cost, summary });
    }
    writeVideos({ ...s.videos, active: true, batch: { ...s.videos.batch, collected: true, collectError: null, collectedAt: Date.now(), spent: Math.round(spent * 1000) / 1000 } });
    pushLog('plan', `Batch collected: ${n} of ${ids.length} video(s) planned, $${spent.toFixed(2)}`);
    finish('plan', { error: n ? null : 'No video in the batch was planned', report: st.log.slice(), reportFile: saveLog('plan'), data: videosSummary() });
    return snapshot();
  }

  // An unfinished batch is checked every minute while EditPanel runs (and once when its label opens).
  let batchTimer = null;
  function pollBatch() {
    if (batchLive() && !batchTimer && (claudeKey() || claudeClient)) {
      batchTimer = setInterval(() => { refreshBatch().catch(() => {}); }, BATCH_POLL_MS);
      if (batchTimer.unref) batchTimer.unref();
    } else if (!batchLive() && batchTimer) {
      clearInterval(batchTimer);
      batchTimer = null;
    }
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
    setRunFolder,
    updateSettings,
    saveAngleRules,
    runPrep,
    runTranscribe,
    cancel,
    runPlan,
    useExistingPlan,
    readMarks,
    listLposProjects,
    nameMulticamTimelines,
    findVideos,
    updateVideo,
    planVideos,
    prepareBatch,
    discardBatch,
    submitBatch,
    refreshBatch,
    cancelBatch,
    collectBatch,
    runBuild,
    runCheck,
    runCompare,
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
  defaultAngleRoles,
  rolesOf,
  DEFAULT_SEQ_BIN
};
