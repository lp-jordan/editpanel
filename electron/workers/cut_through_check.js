'use strict';
/**
 * Cut-through Check: reads a built rough cut back from Resolve and marks what an editor would
 * still fix. Free and local — no Claude, no rendering. Replaces Score (Jordan 2026-11-06: Score
 * "is pointless"; wants cut-off sentences, joins that don't read, missed silences/chatter).
 *
 * Works on the timeline as it is now (Jordan's own trims included): its multicam pieces carry
 * multicam source frames, the same frames the aligned words use.
 *
 *   Red     Word cut off      a word runs across a cut (part of it is missing)
 *           Ends mid-sentence the video's last kept word doesn't end a sentence
 *           Cue kept          "say that again", "from the top", … left in
 *   Yellow  Starts mid-sentence the video opens on a lower-case word after an unfinished sentence
 *           Joins mid-sentence the words before a join stop mid-sentence and ≥ 3 real words were removed
 *           Gap at the cut / Pause kept / Silence at the head or tail
 *           Sound, no words    a loud stretch with no words (mumble, off-camera talk) left in
 *           Flash shot         a shot under half a second
 *   Purple  Repeat at the cut  the same word(s) on both sides of a join
 *           Repeated word      "the the" left in (may be deliberate emphasis; Whisper's own doubles are already ignored)
 */

const { lowerBound, endsSentence, quote, tcPlus, picturePieces, segsOf } = require('./cut_through_util');

const TAG = 'cut-through-check';
const HEAD = 18;                       // frames kept before the first / after the last word (place_cuts.py)
const TAIL = 24;
const BEAT = 6;                        // extra air after a finished thought (place_cuts.py)
const FILLERS = new Set(['um', 'uh', 'uhm', 'umm', 'ah', 'er', 'erm', 'hmm', 'mm', 'mhm']);
const CUES = [
  /\bsay (that|it) again\b/,
  /\b(let me|lemme|i'll|i will|i'm gonna|i'm going to|can i|could i) (try|do|say|start) (that|it|this)? ?(again|over)\b/,
  /\bstart (that )?over\b/,
  /\bfrom the top\b/,
  /\btake (two|2)\b/
];

const RANK = { Red: 3, Yellow: 2, Purple: 1 };           // one marker per frame: the higher priority colour shows
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9']/g, '');
const startsLower = (w) => /^["'“‘(]*[a-z]/.test(String(w.w || '').trim());
const isFiller = (w) => FILLERS.has(norm(w.w));

/**
 * timeline: ct_read_timeline output ({name, fps, pieces [{mc, angle, start, end, src_in, src_out}],
 *   start_frame, start_tc})
 * words: the words file ({words, unheard, aligned, multicam})
 * kind: 'solo' | 'convo' (conversations keep longer pauses)
 * pauses: the delivery's pause rule {max, left} (stage keeps longer pauses); a pause is flagged
 *   over the larger of it and 1 s (solo) / 2 s (convo), and fixed down to `left` frames
 * beats: end frames of words Claude marked as the end of a thought (removals file `beats`): a fix
 *   after one keeps BEAT more frames of air
 * Returns {markers [{frame, color, name, note, tc}], lines, data, fixes}. `fixes` are the easy,
 * mechanical ones the second pass applies (multicam source frames): trims [from, to) to remove
 * (silence only — never over a word or a loud stretch with no words) and keeps [from, to) to give
 * back (the rest of a word a cut went through).
 */
function checkTimeline({ timeline, words: wordsFile, kind = 'solo', multicam = null, pauses = null, beats = [] }) {
  const fps = timeline.fps || wordsFile.fps || 24;
  const sec = (fr) => (fr / fps).toFixed(1);
  const pieces = picturePieces(timeline, multicam);
  const t0 = timeline.start_frame || (pieces.length ? Math.min(...pieces.map((p) => p.start)) : 0);
  if (!pieces.length) throw new Error(`No multicam pieces in ${timeline.name}`);

  // continuous stretches of source (an angle change is not a join)
  const segs = segsOf(pieces);
  const rec = (g, x) => g.start + (x - g.src_in) - t0;    // source frame → frame from the timeline's start

  const all = (wordsFile.words || []).filter((w) => w.own !== false && !w.ghost && Number.isFinite(w.s) && Number.isFinite(w.e))
    .sort((a, b) => a.s - b.s);
  const keptIn = (g) => {
    const out = [];
    for (let i = lowerBound(all, g.src_in - 60); i < all.length && all[i].s < g.src_out; i++) {
      const mid = (all[i].s + all[i].e) / 2;
      if (mid >= g.src_in && mid < g.src_out) out.push(all[i]);
    }
    return out;
  };
  for (const g of segs) g.words = keptIn(g);

  const pauseMax = Math.max(Math.round((kind === 'convo' ? 2.0 : 1.0) * fps), (pauses && pauses.max) || 0);
  const left = (pauses && pauses.left) || 11;              // air left across a trimmed pause / join
  const airBefore = pauses && Number.isFinite(pauses.before) ? pauses.before : left - Math.floor(left / 2);
  const airAfter = left - airBefore;
  const edgeMax = Math.round(1.5 * fps);
  const found = [];
  const add = (frame, color, name, note, fix = null) => found.push({ frame: Math.max(0, Math.round(frame)), color, name, note, fix });
  // a trim may only take silence: no word and no loud stretch inside it
  const loud = (wordsFile.unheard || []).map((u) => [u.s, u.e]);
  const silent = (a, b) => b - a >= 2 && !loud.some(([x, y]) => x < b && y > a)
    && !all.some((w) => w.s < b && w.e > a);
  const isBeat = (w) => (beats || []).some((x) => Math.abs(w.e - x) < 1.5);
  const trim = (a, b) => (silent(Math.ceil(a), Math.floor(b)) ? { trim: [Math.ceil(a), Math.floor(b)] } : null);

  // ── word cut off at any cut ──
  for (const g of segs) {
    for (const [b, side] of [[g.src_in, 'in'], [g.src_out, 'out']]) {
      for (let i = lowerBound(all, b - 90); i < all.length && all[i].s < b + 1; i++) {
        const w = all[i];
        if (!(w.s < b - 1 && w.e > b + 1)) continue;
        const missing = side === 'in' ? b - w.s : w.e - b;
        // mostly kept → give the rest back (3 fr of air); mostly removed → take the scrap out
        const mid = (w.s + w.e) / 2;
        const prev = all[i - 1];
        const next = all[i + 1];
        let fix = null;
        if (side === 'out') {
          fix = mid < b ? { keep: [b, Math.min(Math.ceil(w.e) + 3, next ? Math.floor(next.s) : Infinity)] }
            : { trim: [Math.max(Math.floor(w.s) - 2, prev ? Math.ceil(prev.e) + 1 : -Infinity), b] };
        } else {
          fix = mid >= b ? { keep: [Math.max(Math.floor(w.s) - 3, prev ? Math.ceil(prev.e) : -Infinity), b] }
            : { trim: [b, Math.min(Math.ceil(w.e) + 2, next ? Math.floor(next.s) - 1 : Infinity)] };
        }
        add(rec(g, b), isFiller(w) ? 'Yellow' : 'Red', 'Word cut off',
          `"${String(w.w).trim()}" — ${side === 'in' ? 'start' : 'end'} cut by ${Math.round(missing)} fr`, fix);
      }
    }
  }

  // ── joins ──
  for (let k = 0; k + 1 < segs.length; k++) {
    const a = segs[k];
    const b = segs[k + 1];
    const left = a.words[a.words.length - 1];
    const right = b.words[0];
    const at = rec(b, b.src_in);
    if (left && right) {
      const removed = b.src_in > a.src_out ? all.slice(lowerBound(all, a.src_out), lowerBound(all, b.src_in)) : [];
      const content = removed.filter((w) => !isFiller(w)).length;
      const before = a.words.slice(-6);
      const after = b.words.slice(0, 6);
      if (!endsSentence(left) && content >= 3) {
        add(at, 'Yellow', 'Joins mid-sentence', `…${quote(before)} ‖ ${quote(after)}… (${content} words removed)`);
      }
      for (let n = 3; n >= 1; n--) {
        const l = a.words.slice(-n).map((w) => norm(w.w));
        const r = b.words.slice(0, n).map((w) => norm(w.w));
        if (l.length === n && r.length === n && l.every((x, i) => x && x === r[i]) && !l.every((x) => FILLERS.has(x))) {
          add(at, 'Purple', 'Repeat at the cut', `"${quote(a.words.slice(-n))}" on both sides`);
          break;
        }
      }
      const gap = (a.src_out - left.e) + (right.s - b.src_in);
      if (gap > pauseMax) {
        // close it from both sides down to the pause rule's air
        const after = airAfter + (isBeat(left) ? BEAT : 0);
        const t1 = a.src_out - left.e > after + 1 ? trim(left.e + after, a.src_out) : null;
        const t2 = right.s - b.src_in > airBefore + 1 ? trim(b.src_in, right.s - airBefore) : null;
        const fix = t1 || t2 ? { trims: [t1, t2].filter(Boolean).map((t) => t.trim) } : null;
        add(at, 'Yellow', 'Gap at the cut', `${sec(gap)} s with no words across the cut`, fix);
      }
    }
  }

  // ── inside each stretch ──
  for (const g of segs) {
    const ws = g.words;
    for (let i = 1; i < ws.length; i++) {
      const p = ws[i - 1];
      const w = ws[i];
      const gap = w.s - p.e;
      if (gap > pauseMax) add(rec(g, p.e), 'Yellow', 'Pause kept', `${sec(gap)} s after "${String(p.w).trim()}"`, trim(p.e + airAfter + (isBeat(p) ? BEAT : 0), w.s - airBefore));
      // one marker per run ("go go go go" is one thing to look at)
      if (norm(p.w) && norm(p.w) === norm(w.w) && !isFiller(w) && gap < fps * 0.6 && !(i >= 2 && norm(ws[i - 2].w) === norm(p.w))) {
        let n = i + 1;
        while (n < ws.length && norm(ws[n].w) === norm(p.w)) n += 1;
        add(rec(g, p.s), 'Purple', 'Repeated word', `"${quote(ws.slice(i - 1, n))}"`);
      }
    }
    // cue phrases: on the stretch's words in order
    const toks = ws.map((w) => norm(w.w));
    const text = toks.join(' ');
    const cues = [];
    for (const re of CUES) {
      const all_ = new RegExp(re.source, 'g');
      for (let m = all_.exec(text); m; m = all_.exec(text)) {
        const at = text.slice(0, m.index).split(' ').filter(Boolean).length;
        const n = m[0].split(' ').length;
        if (cues.some((c) => at < c.at + c.n + 2 && c.at < at + n + 2)) continue;   // the same cue, matched twice
        cues.push({ at, n, text: m[0] });
      }
    }
    for (const c of cues) {
      add(rec(g, ws[Math.min(c.at, ws.length - 1)].s), 'Red', 'Cue kept', `"${c.text}" — a cue to redo, not part of the talk`);
    }
    // loud stretches with no words
    for (const u of wordsFile.unheard || []) {
      const lo = Math.max(u.s, g.src_in);
      const hi = Math.min(u.e, g.src_out);
      if (hi - lo >= 6) add(rec(g, lo), 'Yellow', 'Sound, no words', `${sec(hi - lo)} s of sound with no words (mumble or off-camera talk?)`);
    }
  }

  // ── head and tail ──
  const firstSeg = segs.find((g) => g.words.length);
  const lastSeg = [...segs].reverse().find((g) => g.words.length);
  if (firstSeg) {
    const w = firstSeg.words[0];
    const lead = rec(firstSeg, w.s);
    if (lead > edgeMax) add(0, 'Yellow', 'Silence at the head', `${sec(lead)} s before the first word`, firstSeg === segs[0] ? trim(firstSeg.src_in, w.s - HEAD) : null);
    const prev = all[all.indexOf(w) - 1];
    if (prev && !endsSentence(prev) && startsLower(w)) add(rec(firstSeg, w.s), 'Yellow', 'Starts mid-sentence', `opens on "${quote(firstSeg.words.slice(0, 6))}…"`);
  }
  if (lastSeg) {
    const w = lastSeg.words[lastSeg.words.length - 1];
    const end = Math.max(...pieces.map((p) => p.end)) - t0;
    const tail = end - rec(lastSeg, w.e);
    if (tail > edgeMax) add(rec(lastSeg, w.e), 'Yellow', 'Silence at the tail', `${sec(tail)} s after the last word`, lastSeg === segs[segs.length - 1] ? trim(w.e + TAIL, lastSeg.src_out) : null);
    if (!endsSentence(w)) add(rec(lastSeg, w.s), 'Red', 'Ends mid-sentence', `ends on "…${quote(lastSeg.words.slice(-6))}"`);
  }

  // ── flash shots ── (a sliver of source with no words between two cuts: take it out)
  for (const p of pieces) {
    if (p.end - p.start >= Math.round(fps / 2)) continue;
    const g = segs.find((x) => x.src_in <= p.src_in && p.src_out <= x.src_out);
    const sliver = g && !g.words.length && g.src_out - g.src_in < Math.round(fps / 2);
    add(p.start - t0, 'Yellow', 'Flash shot', `${p.angle} for ${p.end - p.start} fr`, sliver ? trim(g.src_in, g.src_out) : null);
  }

  // one marker per frame: merge, red wins
  const byFrame = new Map();
  for (const f of found.sort((x, y) => x.frame - y.frame)) {
    const m = byFrame.get(f.frame);
    if (!m) { byFrame.set(f.frame, { ...f }); continue; }
    if (RANK[f.color] > RANK[m.color]) m.color = f.color;
    if (!m.name.split(' + ').includes(f.name)) m.name = `${m.name} + ${f.name}`;
    m.note = `${m.note}\n${f.note}`;
  }
  const markers = [...byFrame.values()].map((m) => ({ ...m, tc: tcPlus(timeline.start_tc, m.frame, fps) }));
  const kinds = {};
  for (const f of found) kinds[f.name] = (kinds[f.name] || 0) + 1;
  const red = markers.filter((m) => m.color === 'Red').length;
  const repeats = markers.filter((m) => m.color === 'Purple').length;
  const data = {
    timeline: timeline.name, red, yellow: markers.length - red - repeats, repeats, kinds,
    joins: segs.length - 1, minutes: +((Math.max(...pieces.map((p) => p.end)) - t0) / fps / 60).toFixed(1)
  };
  const lines = [
    `${timeline.name}: ${red} red, ${data.yellow} yellow, ${repeats} repeat · ${data.joins} joins · ${data.minutes} min`,
    ...markers.map((m) => `  ${m.tc}  ${m.color === 'Red' ? 'RED   ' : m.color === 'Purple' ? 'repeat' : 'yellow'}  ${m.name} — ${m.note.replace(/\n/g, ' / ')}`)
  ];
  const fixes = { trims: [], keeps: [], fixed: {} };
  for (const f of found) {
    if (!f.fix) continue;
    const t = [...(f.fix.trims || []), ...(f.fix.trim ? [f.fix.trim] : [])].filter(([x, y]) => y - x >= 2);
    const k = f.fix.keep && f.fix.keep[1] - f.fix.keep[0] >= 1 ? [f.fix.keep] : [];
    if (!t.length && !k.length) continue;
    fixes.trims.push(...t);
    fixes.keeps.push(...k);
    fixes.fixed[f.name] = (fixes.fixed[f.name] || 0) + 1;
  }
  return { markers, lines, data, fixes };
}

/** The plan as the build will lay it out: its pieces back to back from frame 0. */
function planTimeline(plan, name = 'plan') {
  let t = 0;
  const pieces = (plan.video || []).map((v) => {
    const p = { mc: plan.multicam, angle: v.angle, src_in: v.in, src_out: v.out, start: t, end: t + v.out - v.in };
    t = p.end;
    return p;
  });
  return { name, fps: plan.fps, pieces, start_frame: 0, start_tc: '00:00:00:00' };
}

module.exports = { checkTimeline, planTimeline, tcPlus, TAG };
