'use strict';
/**
 * Cut-through queue (1.2.183): several multicams of one Resolve project, run unattended up to
 * "ready to plan" (Jordan 2026-11-19: "queue them up so I don't have to come back each time").
 *
 * Order: Prep every multicam first (Resolve, a few minutes each; catches angle naming and missing
 * files while the editor is still there), then Transcribe one at a time (GPU), then Read slate
 * (local OCR only, never Claude) or Find videos. Plan stays with the editor.
 *
 * It drives the one-label engine in cut_through.js through `eng` (select → runPrep → runTranscribe →
 * readSlate / findVideos), so every step writes the same run files as when run by hand. A step whose
 * output is already newer than its input is skipped, so Run again resumes. A failed multicam is
 * marked and the queue moves on. Saved in prefs (cutThrough.queue); a run cut short by closing
 * EditPanel shows as stopped.
 */
const fs = require('fs');

const PHASES = ['prep', 'transcribe', 'videos'];

function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return null; }
}

/** Angles Build can't find again by name (same rule as Transcribe's own check). */
function oddAngles(day) {
  return ((day && day.angles) || []).filter((a) => !/^Camera \d+$/.test(a) && !/slate/i.test(a));
}

/**
 * eng: { snapshot, select, runPrep, runTranscribe, readSlate, findVideos, cancel, busy(), project(),
 *        resolveProject(), holdProject(bool), defaultLabel(mc), sanitizeLabel(x) }
 */
function createQueue({ eng, getPrefs, setPrefs, emit, onEnded = null }) {
  let running = false;
  let stopping = false;
  let current = null;                              // { label, phase } while a step runs

  function load() {
    const q = ((getPrefs() || {}).cutThrough || {}).queue;
    return q && Array.isArray(q.items) ? q : { project: null, items: [] };
  }
  let q = load();
  // a run cut short by closing EditPanel
  if (q.items.some((it) => it.status === 'running')) {
    q.items = q.items.map((it) => (it.status === 'running' ? { ...it, status: 'stopped', error: 'EditPanel closed during this step' } : it));
    save();
  }

  function save() {
    const p = (getPrefs() || {}).cutThrough || {};
    setPrefs({ cutThrough: { ...p, queue: q } });
  }

  function changed() { save(); emit(); }

  function state() {
    return { project: q.project, items: q.items, running, stopping, current, error: q.error || null, endedAt: q.endedAt || null };
  }

  function guardIdle() {
    if (running) throw new Error('The queue is running — stop it first');
  }

  /** Add multicams of the open Resolve project. Labels as a fresh pick would get them. */
  function add({ mcs } = {}) {
    guardIdle();
    const project = eng.project();
    if (!project) throw new Error('Open the Resolve project first');
    const list = [].concat(mcs || []).map((x) => String(x || '').trim()).filter(Boolean);
    if (!list.length) throw new Error('Pick at least one multicam');
    if (q.project && q.project !== project && q.items.length) {
      throw new Error(`The queue holds ${q.project}'s multicams — clear it first`);
    }
    q.project = project;
    q.error = null;
    for (const mc of list) {
      if (q.items.some((it) => it.mc === mc)) continue;
      let label = eng.defaultLabel(mc) || eng.sanitizeLabel(mc);
      for (let k = 2; q.items.some((it) => it.label === label); k += 1) label = `${eng.defaultLabel(mc)}_${k}`;
      q.items.push({ mc, label, status: 'queued', phase: null, done: {}, error: null, result: null });
    }
    changed();
    return state();
  }

  function remove({ label } = {}) {
    guardIdle();
    q.items = q.items.filter((it) => it.label !== label);
    if (!q.items.length) { q.project = null; q.error = null; }
    changed();
    return state();
  }

  function clear() {
    guardIdle();
    q = { project: null, items: [] };
    changed();
    return state();
  }

  /** Is this step's output already newer than its input (so the run can skip it)? */
  function fresh(phase, f) {
    const day = mtime(f.day);
    if (phase === 'prep') return Boolean(day);
    const words = mtime(f.words);
    if (phase === 'transcribe') return Boolean(day && words && words >= day);
    const vids = mtime(f.videos);
    return Boolean(words && vids && vids >= words && (!mtime(f.slate) || vids >= mtime(f.slate)));
  }

  function summary(snap) {
    const v = snap.videos || {};
    const list = v.videos || [];
    return {
      videos: list.length,
      flagged: list.filter((x) => (x.flags || []).length).length,
      shootDay: (v.shootDay && v.shootDay.date) || null,
      shootDaySure: v.firstCode ? true : (v.shootDay ? v.shootDay.sure !== false : null),
      firstCode: v.firstCode || '',
      lpos: Boolean(v.lpos),
      slateNeedsClaude: (snap.slateInfo && snap.slateInfo.needsClaude) || 0
    };
  }

  async function runPhase(it, phase) {
    if (phase === 'prep' && eng.resolveProject() !== q.project) {
      throw Object.assign(new Error(`Open ${q.project} in Resolve, then Run queue again`), { stopQueue: true });
    }
    eng.select({ mc: it.mc, label: it.label, source: 'multicam' });
    let snap = eng.snapshot();
    if (fresh(phase, snap.files)) {
      it.done = { ...it.done, [phase]: true };
      if (phase === 'videos') it.result = summary(snap);
      return;
    }
    it.status = 'running';
    it.phase = phase;
    current = { label: it.label, phase };
    changed();
    if (phase === 'prep') {
      snap = await eng.runPrep({});
      if (snap.steps.prep.status !== 'done') throw new Error(snap.steps.prep.error || `Prep ${snap.steps.prep.status}`);
      const odd = oddAngles(snap.day);
      if (odd.length) throw new Error(`Rename ${odd.join(', ')} to "Camera N" in Resolve, then Run queue again`);
    } else if (phase === 'transcribe') {
      snap = await eng.runTranscribe({});
      if (snap.steps.transcribe.status !== 'done') throw new Error(snap.steps.transcribe.error || `Transcribe ${snap.steps.transcribe.status}`);
    } else {
      // the slate read finds the videos again itself; without a slate angle, Find videos alone
      snap = snap.slateAngle ? await eng.readSlate({ useClaude: false }) : await eng.findVideos({});
      it.result = summary(snap);
    }
    it.done = { ...it.done, [phase]: true };
  }

  let runPromise = null;
  /** Checks, then starts the run in the background (the page gets the state at once); whenIdle() waits for it. */
  function run() {
    guardIdle();
    if (!q.items.length) throw new Error('Add multicams first');
    if (eng.busy()) throw new Error(`${eng.busy()} is still running`);
    if (eng.resolveProject() !== q.project) throw new Error(`Open ${q.project} in Resolve first`);
    const snap0 = eng.snapshot();
    if (!snap0.settings.runFolder) throw new Error('Choose a run folder for this project first');
    running = true;
    stopping = false;
    q.error = null;
    q.endedAt = null;
    // a rerun starts every unfinished multicam again (done steps are skipped by their files)
    q.items = q.items.map((it) => (it.status === 'ready' ? it : { ...it, status: 'queued', phase: null, error: null }));
    eng.holdProject(true);
    changed();
    runPromise = loop();
    return state();
  }

  async function loop() {
    try {
      for (const phase of PHASES) {
        for (const it of q.items) {
          if (stopping) break;
          if (it.status === 'failed' || it.status === 'ready') continue;
          try {
            await runPhase(it, phase);
            it.status = phase === 'videos' ? 'ready' : 'waiting';
            it.phase = phase;
          } catch (err) {
            if (stopping) { it.status = 'stopped'; it.error = null; break; }
            if (err && err.stopQueue) { q.error = err.message; stopping = true; break; }
            it.status = 'failed';
            it.phase = phase;
            it.error = (err && err.message) || String(err);
          } finally {
            current = null;
            changed();
          }
        }
        if (stopping) break;
      }
    } finally {
      const wasStopped = stopping;
      running = false;
      stopping = false;
      current = null;
      if (wasStopped) q.items = q.items.map((it) => (['queued', 'waiting', 'running'].includes(it.status) ? { ...it, status: 'stopped' } : it));
      else q.endedAt = Date.now();
      eng.holdProject(false);
      changed();
      if (!wasStopped && onEnded) {
        const ready = q.items.filter((it) => it.status === 'ready').length;
        const failed = q.items.filter((it) => it.status === 'failed').length;
        try { onEnded({ project: q.project, total: q.items.length, ready, failed }); } catch (_) { /* never stops the queue */ }
      }
    }
  }

  function stop() {
    if (!running) return state();
    stopping = true;
    eng.cancel();                                   // Transcribe / slate read stop now; Prep (Resolve) finishes its step
    emit();
    return state();
  }

  return { state, add, remove, clear, run, stop, isRunning: () => running, whenIdle: () => runPromise || Promise.resolve() };
}

module.exports = { createQueue, PHASES };
