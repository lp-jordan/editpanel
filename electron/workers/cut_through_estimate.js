'use strict';
/**
 * Cut-through cost and time estimate (2026-11-11).
 *
 * Claude: what an edit costs is learned from <files folder>/cut_through_costs.csv — every plan row
 * (live or batch) with the minutes it covered and its kind (solo / convo). A straight line
 * (fixed $ per video + $ per minute) is fitted per kind at the live price; a batch is half.
 * Rows from before 1.2.144 carry no minutes: they're looked up in the run folders
 * (videos_<RUN>.json, else claude_edit_<LABEL>.json's range). Too few rows for a kind → the
 * starting rates below (Elevate MC_1 + MC_3, 52 solo videos, Opus 5.5 high); a conversation has
 * no runs yet, so its starting rate is a guess (solo + 30 % for the speaker labels).
 *
 * Transcribe (local, time only): seconds per track-minute from earlier transcribe_<LABEL>.txt
 * reports in the same folder, else a starting rate for GPU / CPU.
 */
const fs = require('fs');
const path = require('path');

const PLAN_STEPS = ['solo_plan', 'batch_plan'];
const MIN_ROWS = 5;
const START = {
  solo: { fixed: 0.032, perMin: 0.0197, model: 'claude-opus-5-5', guess: false },
  convo: { fixed: 0.042, perMin: 0.0256, model: 'claude-opus-5-5', guess: true }
};
const START_TRANSCRIBE = { gpu: 12, cpu: 240 };   // seconds per track-minute (LP1 GPU: ELEVATE_MC_3, 99 min in ~1190 s)

/** CSV text → objects by header name (old rows simply lack the newer columns). */
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, c[i] === undefined ? '' : c[i]]));
  });
}

/** Least squares usd = fixed + perMin·minutes; falls back to a plain rate when the line is unusable. */
function fitLine(points) {
  const n = points.length;
  const mx = points.reduce((t, p) => t + p.minutes, 0) / n;
  const my = points.reduce((t, p) => t + p.usd, 0) / n;
  const sxx = points.reduce((t, p) => t + (p.minutes - mx) ** 2, 0);
  const sxy = points.reduce((t, p) => t + (p.minutes - mx) * (p.usd - my), 0);
  if (sxx > 0) {
    const perMin = sxy / sxx;
    const fixed = my - perMin * mx;
    if (perMin > 0 && fixed >= 0) return { fixed, perMin };
  }
  return { fixed: 0, perMin: mx > 0 ? my / mx : 0 };
}

/**
 * Rates per kind from cost rows. rows: parsed CSV; costOf(model, usage) = live dollars;
 * lookup(label) → { minutes, kind } | null for rows without those columns; effort: prefer rows
 * at this effort when there are enough of them.
 */
function learnRates(rows, { costOf, lookup = () => null, effort = null } = {}) {
  const points = { solo: [], convo: [] };
  for (const r of rows) {
    if (!PLAN_STEPS.includes(r.step)) continue;
    let minutes = Number(r.minutes);
    let kind = r.kind;
    if (!(minutes > 0) || !points[kind]) {
      const found = lookup(r.label);
      if (!found) continue;
      minutes = found.minutes;
      kind = found.kind;
    }
    if (!(minutes > 0) || !points[kind]) continue;
    const usage = { input_tokens: Number(r.input_tokens) || 0, output_tokens: Number(r.output_tokens) || 0,
      cache_read_input_tokens: Number(r.cache_read) || 0, cache_creation_input_tokens: Number(r.cache_write) || 0 };
    points[kind].push({ minutes, usd: costOf(r.model, usage), model: r.model, effort: r.effort });
  }
  const out = {};
  for (const kind of Object.keys(points)) {
    let pts = points[kind];
    const same = effort ? pts.filter((p) => p.effort === effort) : pts;
    if (same.length >= MIN_ROWS) pts = same;
    if (pts.length < MIN_ROWS) {
      out[kind] = { ...START[kind], runs: pts.length, learned: false };
      continue;
    }
    // the most common model in the rows (the price ratio moves the line to another model)
    const counts = {};
    pts.forEach((p) => { counts[p.model] = (counts[p.model] || 0) + 1; });
    const model = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    out[kind] = { ...fitLine(pts), model, guess: false, runs: pts.length, learned: true };
  }
  return out;
}

/** Live and batch dollars for these videos (each { minutes, kind }) at `model`'s prices. */
function estimateCost(videos, rates, { model, prices }) {
  let live = 0;
  let guess = false;
  let runs = 0;
  for (const v of videos) {
    const r = rates[v.kind === 'convo' ? 'convo' : 'solo'];
    if (!r || !(v.minutes > 0)) continue;
    const from = prices[r.model];
    const to = prices[model];
    const scale = from && to ? to.output / from.output : 1;
    live += (r.fixed + r.perMin * v.minutes) * scale;
    if (r.guess) guess = true;
    runs = Math.max(runs, r.runs || 0);
  }
  return { live: Math.round(live * 100) / 100, batch: Math.round(live * 50) / 100, guess, runs };
}

/** One transcribe report → { seconds, trackMin } (null when it isn't a finished WhisperX run). */
function transcribeTiming(text) {
  const t = String(text || '');
  let seconds = 0;
  let trackMin = 0;
  const read = /Read audio in (\d+)s/.exec(t);
  if (read) seconds += Number(read[1]);
  for (const m of t.matchAll(/^\s*(.+?): \d+ words, ([\d.]+) min in (\d+)s/gm)) {
    seconds += Number(m[3]);
    if (!/\(verbatim\)\s*$/.test(m[1])) trackMin += Number(m[2]);
  }
  const align = /Aligned .*? in (\d+)s/.exec(t);
  if (align) seconds += Number(align[1]);
  return trackMin > 0 && seconds > 0 ? { seconds, trackMin } : null;
}

/** Seconds per track-minute: earlier reports when there are any, else the GPU / CPU start. */
function transcribeRate(reports, { gpu }) {
  const ok = reports.map(transcribeTiming).filter(Boolean);
  if (ok.length) {
    const sec = ok.reduce((t, r) => t + r.seconds, 0);
    const min = ok.reduce((t, r) => t + r.trackMin, 0);
    return { secPerTrackMin: sec / min, learned: true, runs: ok.length };
  }
  return { secPerTrackMin: gpu ? START_TRANSCRIBE.gpu : START_TRANSCRIBE.cpu, learned: false, runs: 0 };
}

/**
 * Minutes + kind of an old cost row, from the run folders under costsDir
 * (<costsDir>/<project>/<RUN>/…, RUN = the label before "__").
 */
function makeLookup(costsDir) {
  const cache = new Map();
  let runDirs = null;
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
  function dirsFor(run) {
    if (!runDirs) {
      runDirs = new Map();
      let projects = [];
      try { projects = fs.readdirSync(costsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { /* none */ }
      for (const p of projects) {
        let runs = [];
        try { runs = fs.readdirSync(path.join(costsDir, p.name), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { /* none */ }
        for (const r of runs) {
          if (!runDirs.has(r.name)) runDirs.set(r.name, []);
          runDirs.get(r.name).push(path.join(costsDir, p.name, r.name));
        }
      }
    }
    return runDirs.get(run) || [];
  }
  return function lookup(label) {
    if (cache.has(label)) return cache.get(label);
    const [run, id] = String(label).split('__');
    let found = null;
    for (const dir of dirsFor(run)) {
      if (id) {
        const m = readJson(path.join(dir, `videos_${run}.json`));
        const v = m && Array.isArray(m.videos) ? m.videos.find((x) => x.id === id) : null;
        if (v && v.minutes > 0) { found = { minutes: v.minutes, kind: v.kind === 'convo' ? 'convo' : 'solo' }; break; }
      }
      const edit = readJson(path.join(dir, `claude_edit_${label}.json`));
      const day = readJson(path.join(dir, `day_${run}.json`));
      if (edit && Array.isArray(edit.range) && day && Array.isArray(day.frame_sec) && day.frame_sec[1]) {
        const minutes = (edit.range[1] - edit.range[0]) * day.frame_sec[0] / day.frame_sec[1] / 60;
        if (minutes > 0) { found = { minutes, kind: edit.delivery === 'convo' ? 'convo' : 'solo' }; break; }
      }
    }
    cache.set(label, found);
    return found;
  };
}

/** Every transcribe_<LABEL>.txt under costsDir/<project>/<RUN>/. */
function transcribeReports(costsDir) {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(costsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { return out; }
  for (const p of projects) {
    let runs = [];
    try { runs = fs.readdirSync(path.join(costsDir, p.name), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { continue; }
    for (const r of runs) {
      try { out.push(fs.readFileSync(path.join(costsDir, p.name, r.name, `transcribe_${r.name}.txt`), 'utf8')); } catch (_) { /* none */ }
    }
  }
  return out;
}

module.exports = { parseCsv, learnRates, estimateCost, transcribeTiming, transcribeRate, makeLookup, transcribeReports, START, START_TRANSCRIBE };
