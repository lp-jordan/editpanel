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
 *   Yellow  Joins mid-sentence the words before a join stop mid-sentence and ≥ 3 real words were removed
 *           Repeat at the cut  the same word(s) on both sides of a join
 *           Gap at the cut / Pause kept / Silence at the head or tail
 *           Repeated word      "the the" left in (Whisper's own doubles are already ignored)
 *           Sound, no words    a loud stretch with no words (mumble, off-camera talk) left in
 *           Flash shot         a shot under half a second
 */

const TAG = 'cut-through-check';
const FILLERS = new Set(['um', 'uh', 'uhm', 'umm', 'ah', 'er', 'erm', 'hmm', 'mm', 'mhm']);
const CUES = [
  /\bsay (that|it) again\b/,
  /\b(let me|lemme|i'll|i will|i'm gonna|i'm going to|can i|could i) (try|do|say|start) (that|it|this)? ?(again|over)\b/,
  /\bstart (that )?over\b/,
  /\bfrom the top\b/,
  /\btake (two|2)\b/
];

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9']/g, '');
const endsSentence = (w) => /[.?!…]["'”’)\]]*$/.test(String(w.w || '').trim());
const startsLower = (w) => /^["'“‘(]*[a-z]/.test(String(w.w || '').trim());
const isFiller = (w) => FILLERS.has(norm(w.w));

/** "01:00:12:03" + frames (nominal rate, non-drop — what Resolve shows for 23.976). */
function tcPlus(startTc, frames, fps) {
  const nom = Math.round(fps) || 24;
  const m = /^(\d+):(\d+):(\d+)[:;](\d+)$/.exec(String(startTc || ''));
  const base = m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * nom + +m[4] : 0;
  const t = base + Math.max(0, Math.round(frames));
  const ff = t % nom;
  const s = Math.floor(t / nom);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

/** Index of the first word with s >= x (words sorted by s). */
function lowerBound(words, x) {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].s < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const quote = (ws) => ws.map((w) => String(w.w).trim()).join(' ');

/**
 * timeline: ct_read_timeline output ({name, fps, pieces [{mc, angle, start, end, src_in, src_out}],
 *   start_frame, start_tc})
 * words: the words file ({words, unheard, aligned, multicam})
 * kind: 'solo' | 'convo' (conversations keep longer pauses)
 * Returns {markers [{frame, color, name, note, tc}], lines, data}.
 */
function checkTimeline({ timeline, words: wordsFile, kind = 'solo', multicam = null }) {
  const fps = timeline.fps || wordsFile.fps || 24;
  const sec = (fr) => (fr / fps).toFixed(1);
  let pieces = (timeline.pieces || []).filter((p) => p.src_out > p.src_in && p.end > p.start);
  if (multicam && pieces.some((p) => p.mc === multicam)) pieces = pieces.filter((p) => p.mc === multicam);
  pieces.sort((a, b) => a.start - b.start);
  const t0 = timeline.start_frame || (pieces.length ? Math.min(...pieces.map((p) => p.start)) : 0);
  if (!pieces.length) throw new Error(`No multicam pieces in ${timeline.name}`);

  // continuous stretches of source (an angle change is not a join)
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

  const pauseMax = Math.round((kind === 'convo' ? 2.0 : 1.0) * fps);
  const edgeMax = Math.round(1.5 * fps);
  const found = [];
  const add = (frame, color, name, note) => found.push({ frame: Math.max(0, Math.round(frame)), color, name, note });

  // ── word cut off at any cut ──
  for (const g of segs) {
    for (const [b, side] of [[g.src_in, 'in'], [g.src_out, 'out']]) {
      for (let i = lowerBound(all, b - 90); i < all.length && all[i].s < b + 1; i++) {
        const w = all[i];
        if (!(w.s < b - 1 && w.e > b + 1)) continue;
        const missing = side === 'in' ? b - w.s : w.e - b;
        add(rec(g, b), isFiller(w) ? 'Yellow' : 'Red', 'Word cut off',
          `"${String(w.w).trim()}" — ${side === 'in' ? 'start' : 'end'} cut by ${Math.round(missing)} fr`);
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
          add(at, 'Yellow', 'Repeat at the cut', `"${quote(a.words.slice(-n))}" on both sides`);
          break;
        }
      }
      const gap = (a.src_out - left.e) + (right.s - b.src_in);
      if (gap > pauseMax) add(at, 'Yellow', 'Gap at the cut', `${sec(gap)} s with no words across the cut`);
    }
  }

  // ── inside each stretch ──
  for (const g of segs) {
    const ws = g.words;
    for (let i = 1; i < ws.length; i++) {
      const p = ws[i - 1];
      const w = ws[i];
      const gap = w.s - p.e;
      if (gap > pauseMax) add(rec(g, p.e), 'Yellow', 'Pause kept', `${sec(gap)} s after "${String(p.w).trim()}"`);
      // one marker per run ("go go go go" is one thing to look at)
      if (norm(p.w) && norm(p.w) === norm(w.w) && !isFiller(w) && gap < fps * 0.6 && !(i >= 2 && norm(ws[i - 2].w) === norm(p.w))) {
        let n = i + 1;
        while (n < ws.length && norm(ws[n].w) === norm(p.w)) n += 1;
        add(rec(g, p.s), 'Yellow', 'Repeated word', `"${quote(ws.slice(i - 1, n))}"`);
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
    if (lead > edgeMax) add(0, 'Yellow', 'Silence at the head', `${sec(lead)} s before the first word`);
    const prev = all[all.indexOf(w) - 1];
    if (prev && !endsSentence(prev) && startsLower(w)) add(rec(firstSeg, w.s), 'Yellow', 'Starts mid-sentence', `opens on "${quote(firstSeg.words.slice(0, 6))}…"`);
  }
  if (lastSeg) {
    const w = lastSeg.words[lastSeg.words.length - 1];
    const end = Math.max(...pieces.map((p) => p.end)) - t0;
    const tail = end - rec(lastSeg, w.e);
    if (tail > edgeMax) add(rec(lastSeg, w.e), 'Yellow', 'Silence at the tail', `${sec(tail)} s after the last word`);
    if (!endsSentence(w)) add(rec(lastSeg, w.s), 'Red', 'Ends mid-sentence', `ends on "…${quote(lastSeg.words.slice(-6))}"`);
  }

  // ── flash shots ──
  for (const p of pieces) {
    if (p.end - p.start < Math.round(fps / 2)) add(p.start - t0, 'Yellow', 'Flash shot', `${p.angle} for ${p.end - p.start} fr`);
  }

  // one marker per frame: merge, red wins
  const byFrame = new Map();
  for (const f of found.sort((x, y) => x.frame - y.frame)) {
    const m = byFrame.get(f.frame);
    if (!m) { byFrame.set(f.frame, { ...f }); continue; }
    if (f.color === 'Red') m.color = 'Red';
    if (!m.name.split(' + ').includes(f.name)) m.name = `${m.name} + ${f.name}`;
    m.note = `${m.note}\n${f.note}`;
  }
  const markers = [...byFrame.values()].map((m) => ({ ...m, tc: tcPlus(timeline.start_tc, m.frame, fps) }));
  const kinds = {};
  for (const f of found) kinds[f.name] = (kinds[f.name] || 0) + 1;
  const red = markers.filter((m) => m.color === 'Red').length;
  const data = {
    timeline: timeline.name, red, yellow: markers.length - red, kinds,
    joins: segs.length - 1, minutes: +((Math.max(...pieces.map((p) => p.end)) - t0) / fps / 60).toFixed(1)
  };
  const lines = [
    `${timeline.name}: ${red} red, ${data.yellow} yellow · ${data.joins} joins · ${data.minutes} min`,
    ...markers.map((m) => `  ${m.tc}  ${m.color === 'Red' ? 'RED   ' : 'yellow'}  ${m.name} — ${m.note.replace(/\n/g, ' / ')}`)
  ];
  return { markers, lines, data };
}

module.exports = { checkTimeline, tcPlus, TAG };
