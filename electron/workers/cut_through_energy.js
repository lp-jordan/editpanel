'use strict';
/**
 * Cut-through energy (Jordan 2026-11-10, on trial): how fast and how loud someone is talking at a
 * moment, against their OWN usual, from the words file alone (word timings + each word's dB).
 *
 *   pace   words per second of talk over a ~10 s window (pauses over 1 s don't count as talk)
 *   level  median word dB over the same window
 *
 * Used two ways:
 *   - Plan: hints in Claude's transcript (`⟨energy: fast · loud⟩` when it changes), so the cut can
 *     quicken when energy is up and hold through a slow story — never past the shot-length limits.
 *   - Compare: does the editor's cut actually follow it? (shot length vs pace / level)
 * Remove both if Compare says the cuts don't follow it.
 */

const WIN_SEC = 10;
const TALK_GAP_SEC = 1;          // a gap longer than this between words is a pause, not talk
const FAST = 1.15;               // pace ≥ 1.15× the person's median = fast; ≤ 0.85× = slow
const SLOW = 0.85;
const LOUD_DB = 3;               // level ≥ median + 3 dB = loud; ≤ median − 3 dB = quiet
const MIN_WORDS = 6;             // fewer words than this in the window: no reading

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** First index with ws[i].s >= f. */
function lowerBound(ws, f) {
  let lo = 0;
  let hi = ws.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ws[m].s < f) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * words: the words file's words (multicam frames). frameSec: seconds per frame.
 * Returns { at(frame, who?) → {who, rate, db, pace, level} | null, baseline: {who: {rate, db}} }.
 * Without `who`, the person with the most words in the window is read.
 */
function energyModel(words, frameSec) {
  const half = WIN_SEC / 2 / frameSec;
  const gapF = TALK_GAP_SEC / frameSec;
  const by = {};
  for (const w of words || []) {
    if (w.own === false || w.ghost || !(w.e > w.s)) continue;
    (by[w.mic] || (by[w.mic] = [])).push(w);
  }
  for (const k of Object.keys(by)) by[k].sort((a, b) => a.s - b.s);

  function raw(who, f) {
    const ws = by[who];
    if (!ws) return null;
    const i0 = lowerBound(ws, f - half);
    const i1 = lowerBound(ws, f + half);
    const n = i1 - i0;
    if (n < MIN_WORDS) return null;
    let talk = 0;
    for (let i = i0; i < i1; i++) {
      const next = i + 1 < i1 ? ws[i + 1].s : null;
      talk += next !== null && next - ws[i].e <= gapF ? next - ws[i].s : ws[i].e - ws[i].s;
    }
    const dbs = ws.slice(i0, i1).map((w) => w.db).filter((x) => typeof x === 'number' && x > -90);
    return { n, rate: n / Math.max(talk * frameSec, 1), db: dbs.length ? median(dbs) : null };
  }

  const baseline = {};
  for (const [who, ws] of Object.entries(by)) {
    // sampled over TIME, not per word: a fast stretch has more words and would pull "usual" up
    const span = ws[ws.length - 1].e - ws[0].s;
    const step = Math.max(2 / frameSec, span / 2000);
    const rs = [];
    const ds = [];
    for (let f = ws[0].s; f <= ws[ws.length - 1].e; f += step) {
      const r = raw(who, f);
      if (r) { rs.push(r.rate); if (r.db !== null) ds.push(r.db); }
    }
    baseline[who] = { rate: median(rs), db: median(ds) };
  }

  function at(f, who = null) {
    let pick = who;
    if (!pick) {
      let best = 0;
      for (const [k, ws] of Object.entries(by)) {
        const n = lowerBound(ws, f + half) - lowerBound(ws, f - half);
        if (n > best) { best = n; pick = k; }
      }
    }
    const r = pick ? raw(pick, f) : null;
    const b = pick && baseline[pick];
    if (!r || !b || !b.rate) return null;
    const pace = r.rate >= b.rate * FAST ? 'fast' : r.rate <= b.rate * SLOW ? 'slow' : 'normal';
    const level = r.db === null || b.db === null ? 'normal' : r.db >= b.db + LOUD_DB ? 'loud' : r.db <= b.db - LOUD_DB ? 'quiet' : 'normal';
    return { who: pick, rate: r.rate, db: r.db, relRate: r.rate / b.rate, relDb: r.db === null || b.db === null ? 0 : r.db - b.db, pace, level };
  }

  return { at, baseline };
}

/** "fast · loud", "slow", "normal" … */
function energyLabel(e) {
  if (!e) return null;
  const parts = [e.pace, e.level].filter((x) => x !== 'normal');
  return parts.length ? parts.join(' · ') : 'normal';
}

/** Spearman rank correlation (−1…1), null under 8 pairs. */
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 8) return null;
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const a = rank(xs);
  const b = rank(ys);
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? +(num / Math.sqrt(da * db)).toFixed(2) : null;
}

/**
 * Does a cut follow the energy? pieces: [{src_in, src_out}] in multicam frames (one per shot).
 * Returns shot-length medians by pace / level and the rank correlations (negative = shorter shots
 * when faster / louder, which is what "cut quicker when the energy is up" predicts).
 */
function shotRows(pieces, model, fps) {
  const rows = [];
  for (const p of pieces) {
    const e = model.at((p.src_in + p.src_out) / 2);
    if (e) rows.push({ len: (p.src_out - p.src_in) / fps, relRate: e.relRate, relDb: e.relDb, pace: e.pace, level: e.level });
  }
  return rows;
}

function rhythmStats(pieces, model, fps) {
  return rhythmOf(shotRows(pieces, model, fps));
}

/** rows: shotRows output (several timelines' rows can be pooled). */
function rhythmOf(rows) {
  const by = (k) => {
    const o = {};
    for (const r of rows) (o[r[k]] || (o[r[k]] = [])).push(r.len);
    return Object.fromEntries(Object.entries(o).map(([g, ls]) => [g, { shots: ls.length, medianSec: +median(ls).toFixed(1) }]));
  };
  return { shots: rows.length, byPace: by('pace'), byLevel: by('level'),
    rhoPace: spearman(rows.map((r) => r.len), rows.map((r) => r.relRate)),
    rhoLevel: spearman(rows.map((r) => r.len), rows.map((r) => r.relDb)), rows };
}

module.exports = { energyModel, energyLabel, rhythmStats, rhythmOf, shotRows, spearman, WIN_SEC };
