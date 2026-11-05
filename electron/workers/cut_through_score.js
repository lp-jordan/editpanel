'use strict';
/**
 * Cut-through (beta): score a cut plan against Jordan's finished edit — the Z8 comparison.
 *
 * Both sides are in multicam source frames: the plan's video pieces (in/out) and the finished
 * timeline's multicam pieces (src_in/src_out, read in Resolve by ct_read_timeline). Compared
 * only over the stretch the finished edit covers.
 *
 *   removals   Jordan removed X s; we removed Y s; overlap = how much of his we also removed
 *              (Z8: 100%); what we removed that he kept
 *   cuts       ours vs his; how many of ours sit within 1 s of one of his (and his of ours)
 *   angles     on frames both keep, how often the same angle is on screen
 *   pacing     shot length median / 10–90% for both
 *   lists      the biggest disagreements, by time, with the words (Desktop report only)
 */

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function clock(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

/** Runs of true in a boolean array → [[from, to)] (offset added). */
function runs(mask, offset) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= mask.length; i++) {
    if (i < mask.length && mask[i]) {
      if (s < 0) s = i;
    } else if (s >= 0) {
      out.push([s + offset, i + offset]);
      s = -1;
    }
  }
  return out;
}

/**
 * plan: the cut plan (video [{in, out, angle}], multicam, fps)
 * finished: ct_read_timeline output ({name, fps, pieces [{mc, angle, src_in, src_out, start, end}]})
 * words: optional words file (for quoting what was said in each disagreement)
 */
function scorePlan({ plan, finished, words = null }) {
  const fps = plan.fps || finished.fps || 24;
  const ref = (finished.pieces || []).filter((p) => (!plan.multicam || p.mc === plan.multicam) && p.src_out > p.src_in);
  if (!ref.length) throw new Error(`No pieces of multicam ${plan.multicam} in ${finished.name}`);
  const ours = plan.video || [];
  const lo = Math.min(...ref.map((p) => p.src_in));
  const hi = Math.max(...ref.map((p) => p.src_out));
  const n = hi - lo;
  const keptRef = new Array(n).fill(false);
  const keptOurs = new Array(n).fill(false);
  const angRef = new Array(n).fill(null);
  const angOurs = new Array(n).fill(null);
  for (const p of ref) for (let f = Math.max(lo, p.src_in); f < Math.min(hi, p.src_out); f++) { keptRef[f - lo] = true; angRef[f - lo] = p.angle; }
  for (const p of ours) for (let f = Math.max(lo, p.in); f < Math.min(hi, p.out); f++) { keptOurs[f - lo] = true; angOurs[f - lo] = p.angle; }

  let remRef = 0; let remOurs = 0; let both = 0; let oursOnly = 0; let keptBoth = 0; let sameAngle = 0;
  for (let i = 0; i < n; i++) {
    if (!keptRef[i]) remRef += 1;
    if (!keptOurs[i]) remOurs += 1;
    if (!keptRef[i] && !keptOurs[i]) both += 1;
    if (keptRef[i] && !keptOurs[i]) oursOnly += 1;
    if (keptRef[i] && keptOurs[i]) { keptBoth += 1; if (angRef[i] === angOurs[i]) sameAngle += 1; }
  }
  const refCuts = ref.slice(0, -1).map((p) => p.src_out);
  const ourCuts = ours.slice(0, -1).map((p) => p.out).filter((c) => c > lo && c < hi);   // every cut but the end, inside his stretch
  const near = (c, list) => list.some((x) => Math.abs(c - x) <= Math.round(fps));
  const oursNear = ourCuts.filter((c) => near(c, refCuts)).length;
  const refNear = refCuts.filter((c) => near(c, ourCuts)).length;
  const lens = (xs, a, b) => xs.map((p) => (p[b] - p[a]) / fps);
  const refLens = lens(ref, 'src_in', 'src_out');
  const ourLens = lens(ours.filter((p) => p.out > lo && p.in < hi), 'in', 'out');

  const said = (a, b) => {
    if (!words) return '';
    const ws = (words.words || []).filter((w) => w.own !== false && w.s >= a && w.s < b).map((w) => w.w);
    const t = ws.join(' ');
    return t.length > 140 ? `${t.slice(0, 140)}…` : t;
  };
  const list = (mask, label) => runs(mask, lo)
    .filter(([a, b]) => b - a >= fps / 2)
    .sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]))
    .slice(0, 15)
    .sort((x, y) => x[0] - y[0])
    .map(([a, b]) => ({ from: a, to: b, at: clock(a / fps), seconds: +((b - a) / fps).toFixed(1), label, words: said(a, b) }));
  const missed = list(keptRef.map((k, i) => !k && keptOurs[i]), 'Jordan removed, we kept');
  const extra = list(keptRef.map((k, i) => k && !keptOurs[i]), 'we removed, Jordan kept');

  const s = (fr) => (fr / fps).toFixed(1);
  const data = {
    finished: finished.name,
    range: [lo, hi],
    length_s: { ours: +s(keptOurs.filter(Boolean).length), jordan: +s(keptRef.filter(Boolean).length) },
    removed_s: { jordan: +s(remRef), ours: +s(remOurs), overlap: +s(both), ours_only: +s(oursOnly) },
    removal_coverage_pct: remRef ? Math.round((100 * both) / remRef) : null,
    cuts: { ours: ourCuts.length, jordan: refCuts.length, ours_within_1s: oursNear, jordan_within_1s: refNear },
    same_angle_pct: keptBoth ? Math.round((100 * sameAngle) / keptBoth) : null,
    shot_s: {
      ours: { median: median(ourLens), p10: pct(ourLens, 0.1), p90: pct(ourLens, 0.9) },
      jordan: { median: median(refLens), p10: pct(refLens, 0.1), p90: pct(refLens, 0.9) }
    },
    missed,
    extra
  };
  const r1 = (x) => (x === null ? '–' : x.toFixed(1));
  const lines = [
    `Compared with '${finished.name}' over ${clock(lo / fps)}–${clock(hi / fps)} of the multicam`,
    `Length: ours ${s(keptOurs.filter(Boolean).length)} s vs Jordan ${s(keptRef.filter(Boolean).length)} s`,
    `Removals: Jordan ${s(remRef)} s, ours ${s(remOurs)} s — we also removed ${s(both)} s of his` +
      (remRef ? ` (${data.removal_coverage_pct}%)` : '') + `; we removed ${s(oursOnly)} s he kept`,
    `Cuts: ours ${ourCuts.length}, Jordan ${refCuts.length}; ${oursNear} of ours within 1 s of his, ${refNear} of his within 1 s of ours`,
    `Same angle on screen: ${data.same_angle_pct === null ? '–' : `${data.same_angle_pct}%`} of the time both keep`,
    `Shot length: ours median ${r1(data.shot_s.ours.median)} s (${r1(data.shot_s.ours.p10)}–${r1(data.shot_s.ours.p90)}), ` +
      `Jordan ${r1(data.shot_s.jordan.median)} s (${r1(data.shot_s.jordan.p10)}–${r1(data.shot_s.jordan.p90)})`,
    ...(missed.length ? ['Jordan removed, we kept (biggest):', ...missed.map((x) => `  ${x.at} ${x.seconds} s  ${x.words}`)] : []),
    ...(extra.length ? ['We removed, Jordan kept (biggest):', ...extra.map((x) => `  ${x.at} ${x.seconds} s  ${x.words}`)] : [])
  ];
  return { lines, data };
}

module.exports = { scorePlan };
