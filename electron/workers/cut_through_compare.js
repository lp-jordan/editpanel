'use strict';
/**
 * Cut-through Compare: what the editor changed in a rough cut, against the plan Claude built.
 * Read-only and free: no Claude, no markers, nothing written to Resolve.
 *
 * Everything is compared in multicam source frames (the unit of the plan and the words), so a
 * ripple earlier in the timeline never reads as a change. The plan's kept source and the
 * timeline's kept source are subtracted both ways; each difference is one event:
 *
 *   restored      kept now, removed by the plan, has words
 *   cut           removed now, kept by the plan, has words
 *   air_added     kept now, removed by the plan, no words
 *   air_trimmed   removed now, kept by the plan, no words
 *   angle         same source on both, different camera
 *
 * compare_<label>.json is for reading the patterns; compare_<label>.html is for looking at them.
 */

const { checkTimeline, planTimeline, tcPlus } = require('./cut_through_check');
const { energyModel, rhythmStats, rhythmOf } = require('./cut_through_energy');

const MIN_FRAMES = 2;          // a difference shorter than this is rounding
const SHIFT_FRAMES = 12;       // an angle difference this short is a moved cut, not a new angle
const FLAG_REACH = 24;         // a change this close to a flag counts as acting on it

const endsSentence = (w) => /[.?!…]["'”’)\]]*$/.test(String((w && w.w) || '').trim());
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quote = (ws) => ws.map((w) => String(w.w).trim()).join(' ');
const count = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; return o; };

/** Pieces joined wherever source and record both run on (an angle change is not a join). */
function segsOf(pieces) {
  const segs = [];
  for (const p of pieces) {
    const g = segs[segs.length - 1];
    if (g && Math.abs(p.src_in - g.src_out) <= 1 && Math.abs(p.start - g.end) <= 1) {
      g.src_out = p.src_out;
      g.end = p.end;
    } else {
      segs.push({ src_in: p.src_in, src_out: p.src_out, start: p.start, end: p.end });
    }
  }
  return segs;
}

/** Sorted, non-overlapping [from, to) ranges. */
function ranges(segs) {
  const out = [];
  for (const [a, b] of segs.map((g) => [g.src_in, g.src_out]).sort((x, y) => x[0] - y[0])) {
    const l = out[out.length - 1];
    if (l && a <= l[1]) l[1] = Math.max(l[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** a − b, both sorted range lists. */
function subtract(a, b) {
  const out = [];
  for (const [from, to] of a) {
    let x = from;
    for (const [c, d] of b) {
      if (d <= x) continue;
      if (c >= to) break;
      if (c > x) out.push([x, c]);
      x = Math.max(x, d);
      if (x >= to) break;
    }
    if (x < to) out.push([x, to]);
  }
  return out;
}

const overlap = (a, b) => {
  let n = 0;
  for (const [x, y] of a) for (const [c, d] of b) n += Math.max(0, Math.min(y, d) - Math.max(x, c));
  return n;
};

function picturePieces(timeline, multicam) {
  let pieces = (timeline.pieces || []).filter((p) => p.src_out > p.src_in && p.end > p.start);
  if (multicam && pieces.some((p) => p.mc === multicam)) pieces = pieces.filter((p) => p.mc === multicam);
  return pieces.sort((a, b) => a.start - b.start);
}

/** How many of a timeline's source frames this plan covers (0–1): picks the plan for a timeline,
 *  so a renamed or duplicated rough cut still finds its plan. */
function planMatch(timeline, plan) {
  const t = ranges(segsOf(picturePieces(timeline, plan.multicam)));
  const p = ranges(segsOf(planTimeline(plan).pieces));
  const total = t.reduce((n, [a, b]) => n + b - a, 0);
  return total ? overlap(t, p) / total : 0;
}

/** Air between a piece's edges and the nearest kept word, at every join. */
function airAtJoins(segs, wordsIn) {
  const after = [];
  const before = [];
  for (let k = 0; k + 1 < segs.length; k++) {
    const l = wordsIn(segs[k]);
    const r = wordsIn(segs[k + 1]);
    if (l.length) after.push(Math.round(segs[k].src_out - l[l.length - 1].e));
    if (r.length) before.push(Math.round(r[0].s - segs[k + 1].src_in));
  }
  return { after: median(after), before: median(before) };
}

function shotStats(pieces, fps) {
  const lens = pieces.map((p) => (p.end - p.start) / fps);
  const total = lens.reduce((a, b) => a + b, 0);
  const share = {};
  for (const p of pieces) count(share, p.angle, (p.end - p.start) / fps);
  for (const k of Object.keys(share)) share[k] = total ? Math.round((share[k] / total) * 100) : 0;
  return { shots: pieces.length, medianShot: lens.length ? +median(lens).toFixed(1) : null,
    cutsPerMin: total ? +(((pieces.length - 1) / total) * 60).toFixed(1) : 0, angleShare: share };
}

/**
 * timeline: ct_read_timeline output (with audio: true for split edits)
 * plan: the <label>_plan.json the timeline was built from
 * words: the words file
 * removals: the removals file (Claude's reason per removal), optional
 * review: the review file (markers in source frames), optional
 * levels: the levels file, optional
 * kind / pauses / beats: as for Check, to recompute Check's flags on the plan
 */
function compareTimeline({ timeline, plan, words: wordsFile, removals = null, review = null, levels = null, kind = 'solo', pauses = null, beats = [] }) {
  const fps = timeline.fps || plan.fps || 24;
  const pieces = picturePieces(timeline, plan.multicam);
  if (!pieces.length) throw new Error(`No multicam pieces in ${timeline.name}`);
  const t0 = timeline.start_frame || Math.min(...pieces.map((p) => p.start));
  const planned = planTimeline(plan);
  const planSegs = segsOf(planned.pieces);
  const nowSegs = segsOf(pieces);
  const P = ranges(planSegs);
  const N = ranges(nowSegs);
  const lo = Math.min(P[0][0], N[0][0]);
  const hi = Math.max(P[P.length - 1][1], N[N.length - 1][1]);

  const all = (wordsFile.words || []).filter((w) => w.own !== false && !w.ghost && Number.isFinite(w.s) && Number.isFinite(w.e))
    .sort((a, b) => a.s - b.s);
  const mid = (w) => (w.s + w.e) / 2;
  const span = all.filter((w) => mid(w) >= lo - fps * 2 && mid(w) < hi + fps * 2);
  const inR = (R, x) => R.some(([a, b]) => x >= a && x < b);
  const wordsIn = (g) => span.filter((w) => mid(w) >= g.src_in && mid(w) < g.src_out);

  const mic = levels && levels.mics && (levels.mics[(plan.audio && plan.audio.angle) || ''] || Object.values(levels.mics)[0]);
  const dbAt = (f) => (mic && mic.db ? mic.db[Math.round(f) - (mic.start || 0)] : undefined);
  const meanDb = (a, b) => {
    const xs = [];
    for (let f = a; f < b; f++) { const d = dbAt(f); if (Number.isFinite(d)) xs.push(d); }
    return xs.length ? Math.round(xs.reduce((x, y) => x + y, 0) / xs.length) : null;
  };

  // why the plan took a stretch out: Claude's own reason wins over the placer's label
  const why = (a, b) => {
    const best = (list, get) => {
      let top = null;
      let n = 0;
      for (const r of list) {
        const o = Math.min(b, r.to) - Math.max(a, r.from);
        if (o > n) { n = o; top = get(r); }
      }
      return top;
    };
    return { why: best(plan.removals || [], (r) => r.why), reason: removals ? best(removals.removals || [], (r) => r.reason || null) : null };
  };

  const recOf = (x) => {
    const g = nowSegs.find((s) => x >= s.src_in && x < s.src_out) ||
      nowSegs.reduce((b, s) => (Math.min(Math.abs(s.src_in - x), Math.abs(s.src_out - x)) < Math.min(Math.abs(b.src_in - x), Math.abs(b.src_out - x)) ? s : b));
    const clamped = Math.max(g.src_in, Math.min(g.src_out, x));
    return Math.round(g.start + (clamped - g.src_in) - t0);
  };

  const position = (a, b, others) => {
    if (b <= others[0][0] || a === others[0][0]) return 'head';
    if (a >= others[others.length - 1][1] || b === others[others.length - 1][1]) return 'tail';
    return others.some(([x, y]) => a === y || b === x || a === x || b === y) ? 'join' : 'inside';
  };

  const events = [];
  const addEvents = (list, withWords, noWords, others) => {
    for (const [a, b] of list) {
      if (b - a < MIN_FRAMES) continue;
      const ws = span.filter((w) => mid(w) >= a && mid(w) < b);
      const prev = [...span].reverse().find((w) => w.e <= a + 1);
      const next = span.find((w) => w.s >= b - 1);
      const near = span.filter((w) => w.e <= a + 1).slice(-5);
      const follow = span.filter((w) => w.s >= b - 1).slice(0, 5);
      const type = ws.length ? withWords : noWords;
      const db = meanDb(a, b);
      const e = {
        type, from: a, to: b, frames: b - a, sec: +((b - a) / fps).toFixed(2), position: position(a, b, others),
        words: ws.length, text: quote(ws), before: quote(near), after: quote(follow),
        afterSentence: prev ? endsSentence(prev) : null, wordEndGap: prev ? Math.round(a - prev.e) : null, nextWordGap: next ? Math.round(next.s - b) : null,
        db, tc: tcPlus(timeline.start_tc, recOf(a), fps)
      };
      if (type === 'restored' || type === 'air_added') Object.assign(e, why(a, b));
      events.push(e);
    }
  };
  addEvents(subtract(N, P), 'restored', 'air_added', P);
  addEvents(subtract(P, N), 'cut', 'air_trimmed', P);

  // the picture: same source on both, different camera
  const angleRead = pieces.some((p) => p.angle && p.angle !== '?');
  const angles = [];
  if (angleRead) {
    const diff = [];
    for (const n of pieces) {
      for (const p of planned.pieces) {
        const a = Math.max(n.src_in, p.src_in);
        const b = Math.min(n.src_out, p.src_out);
        if (b > a && n.angle !== p.angle) diff.push({ a, b, plan: p.angle, now: n.angle });
      }
    }
    diff.sort((x, y) => x.a - y.a);
    for (const d of diff) {
      const l = angles[angles.length - 1];
      if (l && l.plan === d.plan && l.now === d.now && d.a - l.to <= 1) l.to = d.b;
      else angles.push({ from: d.a, to: d.b, plan: d.plan, now: d.now });
    }
    for (const x of angles) {
      x.type = 'angle';
      x.frames = x.to - x.from;
      x.sec = +(x.frames / fps).toFixed(2);
      x.moved = x.frames <= SHIFT_FRAMES;
      x.text = quote(span.filter((w) => mid(w) >= x.from && mid(w) < x.to));
      x.tc = tcPlus(timeline.start_tc, recOf(x.from), fps);
    }
  }
  const angleEvents = angles.filter((x) => x.frames >= MIN_FRAMES);
  const reorderedAt = nowSegs.findIndex((g, k) => k > 0 && g.src_in < nowSegs[k - 1].src_in);

  // did the flags on the plan lead to a change?
  const toSource = (frame) => {
    const p = planned.pieces.find((x) => frame >= x.start && frame < x.end) || planned.pieces[planned.pieces.length - 1];
    return p.src_in + Math.max(0, Math.min(frame, p.end) - p.start);
  };
  let checkFlags = [];
  try {
    checkFlags = checkTimeline({ timeline: planned, words: wordsFile, kind, multicam: plan.multicam, pauses, beats }).markers
      .map((m) => ({ source: 'check', name: m.name, note: m.note, color: m.color, at: toSource(m.frame) }));
  } catch (_) { /* a plan with nothing Check can read has no flags */ }
  const reviewFlags = ((review && review.markers) || []).map((m) => ({ source: 'review', name: m.name, note: m.note, color: m.color, at: m.frame }));
  const changes = [...events, ...angleEvents.filter((x) => !x.moved)];
  const flags = [...checkFlags, ...reviewFlags].map((f) => ({
    ...f, acted: changes.some((c) => c.from - FLAG_REACH < f.at && c.to + FLAG_REACH > f.at)
  }));
  const flagStats = {};
  for (const f of flags) {
    for (const n of String(f.name).split(' + ')) {
      const s = flagStats[n] || (flagStats[n] = { flagged: 0, acted: 0 });
      s.flagged += 1;
      s.acted += f.acted ? 1 : 0;
    }
  }

  // split edits: picture and sound cut within a second of each other, not on the same frame
  let split = null;
  if (Array.isArray(timeline.audio)) {
    const a1 = timeline.audio.filter((x) => x.track === 1).sort((a, b) => a.start - b.start);
    const cutsA = a1.slice(1).map((x) => x.start);
    const joins = nowSegs.slice(1).map((g) => g.start);
    const offsets = [];
    for (const j of joins) {
      if (cutsA.includes(j)) continue;
      const near = cutsA.filter((c) => Math.abs(c - j) <= fps).sort((x, y) => Math.abs(x - j) - Math.abs(y - j))[0];
      if (near !== undefined) offsets.push(near - j);
    }
    split = { audioClips: a1.length, offsets, medianOffset: median(offsets) };
  }

  // the transcript, word by word
  const transcript = span.filter((w) => inR(P, mid(w)) || inR(N, mid(w)) || (mid(w) > lo && mid(w) < hi)).map((w) => {
    const wasKept = inR(P, mid(w));
    const isKept = inR(N, mid(w));
    return { w: String(w.w).trim(), s: Math.round(w.s), st: wasKept && isKept ? 'kept' : wasKept ? 'cut' : isKept ? 'restored' : 'removed' };
  });
  const words = { planKept: 0, nowKept: 0, restored: 0, cut: 0 };
  for (const w of transcript) {
    if (w.st === 'kept' || w.st === 'cut') words.planKept += 1;
    if (w.st === 'kept' || w.st === 'restored') words.nowKept += 1;
    if (w.st === 'restored') words.restored += 1;
    if (w.st === 'cut') words.cut += 1;
  }

  const lengthOf = (R) => +(R.reduce((n, [a, b]) => n + b - a, 0) * (1 / fps) / 60).toFixed(2);
  const byType = {};
  for (const e of [...events, ...angleEvents]) count(byType, e.type === 'angle' ? (e.moved ? 'cut_moved' : 'angle') : e.type);
  const stats = {
    minutes: { plan: lengthOf(P), now: lengthOf(N) },
    joins: { plan: planSegs.length - 1, now: nowSegs.length - 1 },
    plan: shotStats(planned.pieces, fps), now: shotStats(pieces, fps),
    airAtJoins: { plan: airAtJoins(planSegs, wordsIn), now: airAtJoins(nowSegs, wordsIn) },
    words, byType,
    airTrimmedMedian: median(events.filter((e) => e.type === 'air_trimmed').map((e) => e.frames)),
    airAddedMedian: median(events.filter((e) => e.type === 'air_added').map((e) => e.frames))
  };
  // energy check (on trial, 2026-11-10): do the shots get shorter when the talk is faster / louder?
  try {
    const em = energyModel((wordsFile && wordsFile.words) || [], 1 / fps);
    stats.rhythm = { plan: rhythmStats(planned.pieces, em, fps), now: rhythmStats(pieces, em, fps) };
  } catch (_) { stats.rhythm = null; }
  const changed = events.length + angleEvents.length > 0 || reorderedAt >= 0;
  return { timeline: timeline.name, fps, changed, angleRead, reordered: reorderedAt >= 0, split, stats, events: events.sort((a, b) => a.from - b.from),
    angles: angleEvents, flags, flagStats, transcript, keptPlan: P, keptNow: N, range: [lo, hi] };
}

/** Totals over the timelines the editor actually touched. */
function totals(results) {
  const touched = results.filter((r) => r.changed);
  const out = { timelines: results.length, changed: touched.length, byType: {}, words: { restored: 0, cut: 0 }, flagStats: {},
    restoredWhy: {}, airTrimmedAt: {}, airAddedAt: {}, anglePairs: {}, frames: { airTrimmed: [], airAdded: [] }, minutes: { plan: 0, now: 0 } };
  for (const r of touched) {
    for (const [k, n] of Object.entries(r.stats.byType)) count(out.byType, k, n);
    out.words.restored += r.stats.words.restored;
    out.words.cut += r.stats.words.cut;
    out.minutes.plan += r.stats.minutes.plan;
    out.minutes.now += r.stats.minutes.now;
    for (const e of r.events) {
      if (e.type === 'restored') count(out.restoredWhy, String(e.why || 'unknown').replace(/^claude /, ''));
      if (e.type === 'air_trimmed') { count(out.airTrimmedAt, e.position); out.frames.airTrimmed.push(e.frames); }
      if (e.type === 'air_added') { count(out.airAddedAt, e.position); out.frames.airAdded.push(e.frames); }
    }
    for (const a of r.angles) if (!a.moved) count(out.anglePairs, `${a.plan} → ${a.now}`);
    for (const [k, s] of Object.entries(r.flagStats)) {
      const t = out.flagStats[k] || (out.flagStats[k] = { flagged: 0, acted: 0 });
      t.flagged += s.flagged;
      t.acted += s.acted;
    }
  }
  // energy check pooled over every timeline (touched or not: an untouched cut is the editor's too)
  const pool = (k) => rhythmOf(results.flatMap((r) => (r.stats.rhythm && r.stats.rhythm[k] ? r.stats.rhythm[k].rows : [])));
  out.rhythm = { plan: pool('plan'), now: pool('now') };
  out.airTrimmedMedian = median(out.frames.airTrimmed);
  out.airAddedMedian = median(out.frames.airAdded);
  delete out.frames;
  out.minutes.plan = +out.minutes.plan.toFixed(2);
  out.minutes.now = +out.minutes.now.toFixed(2);
  return out;
}

function reportLines(results, sum) {
  const lines = [`Compared ${sum.timelines} timeline(s): ${sum.changed} changed`, ''];
  const rh = (x) => (x && x.shots ? `${x.shots} shots · shorter when faster ρ ${x.rhoPace ?? '–'} · shorter when louder ρ ${x.rhoLevel ?? '–'} · ` +
    `median s by pace ${['fast', 'normal', 'slow'].map((k) => `${k} ${x.byPace[k] ? x.byPace[k].medianSec : '–'}`).join(' / ')}` : 'not enough words');
  if (sum.rhythm) {
    lines.push('Energy check (negative ρ = the cut gets quicker as the talk gets faster / louder):');
    lines.push(`  editor: ${rh(sum.rhythm.now)}`, `  plan:   ${rh(sum.rhythm.plan)}`, '');
  }
  for (const r of results) {
    if (!r.changed) { lines.push(`${r.timeline}: unchanged`, ''); continue; }
    const s = r.stats;
    lines.push(`${r.timeline}: ${s.minutes.plan} → ${s.minutes.now} min · ${s.joins.plan} → ${s.joins.now} joins · words +${s.words.restored} −${s.words.cut}`);
    lines.push(`  ${Object.entries(s.byType).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
    if (!r.angleRead) lines.push('  (cameras could not be read from this timeline)');
    if (r.reordered) lines.push('  (pieces are out of source order)');
    lines.push('');
  }
  return lines;
}

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function waveSvg(e, r, levels, plan) {
  const mic = levels && levels.mics && (levels.mics[(plan && plan.audio && plan.audio.angle) || ''] || Object.values(levels.mics)[0]);
  const pad = 48;
  const a = e.from - pad;
  const b = e.to + pad;
  const W = 640;
  const x = (f) => ((f - a) / (b - a)) * W;
  const bars = [];
  if (mic && mic.db) {
    const n = Math.min(W / 2, b - a);
    for (let i = 0; i < n; i++) {
      const f = Math.round(a + ((b - a) * i) / n);
      const d = mic.db[f - (mic.start || 0)];
      if (!Number.isFinite(d)) continue;
      const h = Math.max(1, ((Math.max(-60, d) + 60) / 60) * 44);
      bars.push(`<rect x="${x(f).toFixed(1)}" y="${(24 - h / 2).toFixed(1)}" width="1.2" height="${h.toFixed(1)}"/>`);
    }
  }
  const track = (R, y, cls) => R.filter(([p, q]) => q > a && p < b)
    .map(([p, q]) => `<rect class="${cls}" x="${x(Math.max(p, a)).toFixed(1)}" y="${y}" width="${(x(Math.min(q, b)) - x(Math.max(p, a))).toFixed(1)}" height="6"/>`).join('');
  return `<svg viewBox="0 0 ${W} 66" role="img" aria-label="waveform"><rect class="hl" x="${x(e.from).toFixed(1)}" y="0" width="${(x(e.to) - x(e.from)).toFixed(1)}" height="48"/>` +
    `<g class="wave">${bars.join('')}</g>${track(r.keptPlan, 50, 'tp')}${track(r.keptNow, 59, 'tn')}</svg>`;
}

const LABEL = { restored: 'Restored', cut: 'Cut', air_added: 'Air added', air_trimmed: 'Air trimmed' };

function reportHtml({ label, results, sum, levels, plans }) {
  const row = (k, a, b) => `<tr><th>${esc(k)}</th><td>${esc(a)}</td><td>${esc(b)}</td></tr>`;
  const tally = (t, o) => (Object.keys(o).length ? `<p><b>${esc(t)}</b> ${Object.entries(o).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${esc(k)} ${n}`).join(' · ')}</p>` : '');
  const flagRows = Object.entries(sum.flagStats).sort((a, b) => b[1].flagged - a[1].flagged)
    .map(([k, s]) => `<tr><th>${esc(k)}</th><td>${s.acted} of ${s.flagged}</td></tr>`).join('');
  const sections = results.map((r) => {
    if (!r.changed) return `<section><h2>${esc(r.timeline)}</h2><p>Unchanged</p></section>`;
    const s = r.stats;
    const plan = plans[r.timeline];
    const words = r.transcript.map((w) => `<span class="${w.st}">${esc(w.w)}</span>`).join(' ');
    const evs = r.events.map((e) => `<div class="ev ${e.type}"><div class="h"><b>${LABEL[e.type]}</b> <code>${esc(e.tc)}</code> ${e.sec} s · ${esc(e.position)}${e.why ? ` · ${esc(e.why)}` : ''}${e.db !== null ? ` · ${e.db} dB` : ''}</div>` +
      `<div class="t">${esc(e.before)} <mark>${esc(e.text || '·')}</mark> ${esc(e.after)}</div>${e.reason ? `<div class="r">${esc(e.reason)}</div>` : ''}${waveSvg(e, r, levels, plan)}</div>`).join('');
    const angs = r.angles.filter((a) => !a.moved).map((a) => `<tr><td><code>${esc(a.tc)}</code></td><td>${esc(a.plan)} → ${esc(a.now)}</td><td>${a.sec} s</td><td>${esc(a.text)}</td></tr>`).join('');
    return `<section><h2>${esc(r.timeline)}</h2><table class="st"><tr><th></th><th>Plan</th><th>Now</th></tr>` +
      row('Minutes', s.minutes.plan, s.minutes.now) + row('Joins', s.joins.plan, s.joins.now) + row('Words', s.words.planKept, s.words.nowKept) +
      row('Shots', s.plan.shots, s.now.shots) + row('Cuts / min', s.plan.cutsPerMin, s.now.cutsPerMin) + row('Median shot (s)', s.plan.medianShot, s.now.medianShot) +
      row('Air after last word at a join (fr)', s.airAtJoins.plan.after, s.airAtJoins.now.after) + row('Air before first word at a join (fr)', s.airAtJoins.plan.before, s.airAtJoins.now.before) +
      `</table>${r.split && r.split.offsets.length ? `<p><b>Split edits</b> ${r.split.offsets.length}, median ${r.split.medianOffset} fr</p>` : ''}` +
      `<details open><summary>Changes (${r.events.length})</summary>${evs}</details>` +
      (angs ? `<details><summary>Angles (${r.angles.filter((a) => !a.moved).length})</summary><table class="an">${angs}</table></details>` : '') +
      `<details><summary>Transcript</summary><p class="tx">${words}</p></details></section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Compare ${esc(label)}</title><style>
:root{--bg:#fff;--fg:#1c1c1e;--mut:#6b6b70;--line:#e2e2e6;--add:#1f9d55;--cut:#d64545;--air:#3b82f6;--trim:#b7791f}
@media (prefers-color-scheme:dark){:root{--bg:#17181b;--fg:#ececf0;--mut:#9a9aa3;--line:#30323a}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:860px;padding:24px 16px}
h1{font-size:22px}h2{font-size:18px;border-top:1px solid var(--line);padding-top:20px;margin-top:32px}
table{border-collapse:collapse;margin:10px 0}th,td{padding:3px 14px 3px 0;text-align:left;font-weight:400;vertical-align:top}th{color:var(--mut)}
code{font-size:13px}summary{cursor:pointer;margin:12px 0;font-weight:600}
.ev{border-left:3px solid var(--line);padding:6px 0 8px 12px;margin:12px 0}.ev.restored{border-color:var(--add)}.ev.cut{border-color:var(--cut)}.ev.air_added{border-color:var(--air)}.ev.air_trimmed{border-color:var(--trim)}
.h,.r{color:var(--mut);font-size:13px}.h b{color:var(--fg)}.t{margin:4px 0}mark{background:color-mix(in srgb,var(--trim) 30%,transparent);color:inherit}
svg{display:block;width:100%;height:auto;margin-top:6px}.wave rect{fill:var(--mut)}.hl{fill:var(--trim);opacity:.22}.tp{fill:var(--cut);opacity:.75}.tn{fill:var(--add);opacity:.85}
.key span{margin-right:14px;font-size:13px}.key i{display:inline-block;width:18px;height:6px;margin-right:5px;vertical-align:middle}
.tx{line-height:1.9}.tx .removed{color:var(--mut);opacity:.45;text-decoration:line-through}.tx .restored{color:var(--add);font-weight:600}.tx .cut{color:var(--cut);font-weight:600;text-decoration:line-through}
</style></head><body><h1>${esc(label)}</h1><p>${sum.changed} of ${sum.timelines} timelines changed · ${sum.minutes.plan} → ${sum.minutes.now} min · words +${sum.words.restored} −${sum.words.cut}</p>
<p class="key"><span><i style="background:var(--cut)"></i>Plan</span><span><i style="background:var(--add)"></i>Now</span></p>
${tally('Changes', sum.byType)}${tally('Restored from', sum.restoredWhy)}${tally('Air trimmed at', sum.airTrimmedAt)}${tally('Air added at', sum.airAddedAt)}${tally('Angle changes', sum.anglePairs)}
${flagRows ? `<details><summary>Flags acted on</summary><table>${flagRows}</table></details>` : ''}${sections}</body></html>`;
}

module.exports = { compareTimeline, planMatch, totals, reportLines, reportHtml, subtract, ranges, segsOf };
