'use strict';
/**
 * Cut-through: find the videos in a day multicam (pure functions, no I/O).
 *
 *   day_<LABEL>.json recordings (Prep: where the cameras rolled, from every angle's clips)
 *   + LPOS slate notes (J-codes typed live, on the LPOS server's clock)
 *   + words_<LABEL>.json (to put a split in a pause, and to say who talks)
 *   → videos: [{ id, name, code, from, to, gaps, kind, talker, flags, ... }] in multicam frames.
 *
 * Rules (Jordan 2026-11-05/06):
 *   - Recording starts and stops come from the footage (frame-exact). A J-code change inside a
 *     recording also starts a new video, at the longest pause just before the note (codes are
 *     typed late).
 *   - The same J-code across a stop = one video with a restart (the gap is cut out); flagged.
 *   - The slate is a hint: flags only (no J-code, short, few words, J-code again later = an
 *     earlier take). Nothing is ever unticked by default.
 *   - Solo vs conversation per video, from who talks in it.
 */

const SPLIT_LOOKBACK_SEC = 45;      // a code typed up to this long after the video began
const SPLIT_LOOKAHEAD_SEC = 5;
const START_GRACE_SEC = 20;         // a code typed this soon after rolling names the recording
const SHORT_SEC = 20;
const FEW_WORDS = 25;
const SPEAKER_SHARE = 0.15;         // a mic with this share of the words is a speaker in the video
const SPEAKER_MIN_WORDS = 20;

function frameSec(day) {
  return Array.isArray(day.frame_sec) && day.frame_sec[1] ? day.frame_sec[0] / day.frame_sec[1] : 1 / (day.fps || 24);
}

function totalFrames(day) {
  return day && day.length_sec ? Math.floor(day.length_sec / frameSec(day)) : 0;
}

/** Prep's recordings in frames; a day prepped before recordings existed = one recording. */
function recordingsOf(day) {
  const fs_ = frameSec(day);
  const recs = (day.recordings || []).map((r) => [Math.round(r.from_sec / fs_), Math.round(r.to_sec / fs_)]).filter(([a, b]) => b > a);
  return recs.length ? recs : [[0, totalFrames(day)]];
}

/** "HH:MM:SS:FF" (LPOS slate, frames counted from milliseconds) → seconds of the day. */
function slateSeconds(ts) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?::(\d{1,2}))?$/.exec(String(ts || '').trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) / 24 : 0);
}

/** Multicam frame ↔ its timecode in seconds (the label time Resolve shows; TOD on an ATEM day). */
function tcSecOfFrame(day, f) {
  const fs_ = frameSec(day);
  const nominal = Math.round(1 / fs_);
  const first = Math.round((day.tc_start_sec || 0) / fs_);
  return (first + f) / nominal;
}

function frameOfTcSec(day, sec) {
  const fs_ = frameSec(day);
  const nominal = Math.round(1 / fs_);
  const first = Math.round((day.tc_start_sec || 0) / fs_);
  return Math.round(sec * nominal) - first;
}

const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};

/**
 * The slate's clock vs the multicam's timecode. The LPOS server may run on another time zone and
 * its clock sits a couple of seconds off the cameras', so: whole hours = the shift that puts the
 * most J-codes inside a recording; seconds = the median distance from an "ATEM" note to the
 * recording start (or stop) it logged. Returns { offsetSec, hours, seconds, matched }.
 */
function slateOffset(day, notes) {
  const recs = recordingsOf(day).map(([a, b]) => [tcSecOfFrame(day, a), tcSecOfFrame(day, b)]);
  const codes = notes.filter((n) => n.code && n.code !== 'ATEM').map((n) => slateSeconds(n.timestamp)).filter((x) => x !== null);
  const atem = notes.filter((n) => n.code === 'ATEM').map((n) => ({ t: slateSeconds(n.timestamp), text: String(n.note || '') })).filter((x) => x.t !== null);
  const wrap = (x) => ((x % 86400) + 86400) % 86400;
  const inside = (t) => recs.some(([a, b]) => t >= a - 60 && t <= b + 60);
  let best = { hours: 0, hits: -1 };
  for (let h = -14; h <= 14; h += 1) {
    const hits = codes.filter((t) => inside(wrap(t + h * 3600))).length + atem.filter((x) => inside(wrap(x.t + h * 3600))).length;
    if (hits > best.hits || (hits === best.hits && Math.abs(h) < Math.abs(best.hours))) best = { hours: h, hits };
  }
  const diffs = [];
  for (const x of atem) {
    const t = wrap(x.t + best.hours * 3600);
    const stop = /stop/i.test(x.text);
    const edges = recs.map(([a, b]) => (stop ? b : a));
    const near = edges.map((e) => e - t).filter((d) => Math.abs(d) <= 30).sort((p, q) => Math.abs(p) - Math.abs(q))[0];
    if (near !== undefined) diffs.push(near);
  }
  const seconds = diffs.length ? Math.round(median(diffs) * 10) / 10 : 0;
  return { offsetSec: best.hours * 3600 + seconds, hours: best.hours, seconds, matched: diffs.length, codesInside: Math.max(0, best.hits) };
}

/**
 * "This multicam starts at H6": only that shoot day's notes, from H6 on. A day = one slate tab, split
 * again where the row's date changes (rows since 2026-11-10) or the time of day jumps backwards. If
 * the code is on several days, the day that fits the multicam's recordings best; ties = the
 * earliest. The ATEM notes just before the code stay (they set the clock offset). null = not found.
 */
function notesFrom(day, notes, firstCode) {
  const want = String(firstCode || '').trim().toLowerCase();
  if (!want) return null;
  // a shoot day = one slate tab plus the untabbed rows (LPOS's ATEM rows never carry a tab),
  // split again where the time of day jumps backwards (several days in one tab, or no tabs)
  const all = notes || [];
  const tabs = [...new Set(all.map((n) => n.tabId).filter(Boolean))];
  const byTab = new Map(tabs.length ? tabs.map((t) => [t, all.filter((n) => !n.tabId || n.tabId === t)]) : [['', all]]);
  const runs = [];
  for (const list of byTab.values()) {
    let last = null;
    let lastDate = null;
    runs.push([]);
    for (const n of list) {
      const t = slateSeconds(n.timestamp);
      // rows from LPOS since 2026-11-10 carry their shoot day: a new date = a new day
      const newDate = n.date && lastDate && n.date !== lastDate;
      if (newDate || (t !== null && last !== null && t < last - 60)) runs.push([]);
      runs[runs.length - 1].push(n);
      if (t !== null) last = t;
      if (n.date) lastDate = n.date;
    }
  }
  let best = null;
  for (const run of runs) {
    let i = run.findIndex((n) => String(n.code || '').trim().toLowerCase() === want);
    if (i < 0) continue;
    while (i > 0 && run[i - 1].code === 'ATEM') i -= 1;
    const picked = run.slice(i);
    const fit = slateOffset(day, picked);
    if (!best || fit.matched > best.fit.matched || (fit.matched === best.fit.matched && fit.codesInside > best.fit.codesInside)) best = { notes: picked, fit };
  }
  return best ? best.notes : null;
}

/** J-code notes → [{ frame, code }] on the multicam (offset applied), in order. */
function codeEvents(day, notes, offsetSec) {
  const wrap = (x) => ((x % 86400) + 86400) % 86400;
  return notes
    .filter((n) => n.code && n.code !== 'ATEM' && String(n.code).trim())
    .map((n) => ({ t: slateSeconds(n.timestamp), code: String(n.code).trim() }))
    .filter((x) => x.t !== null)
    .map((x) => ({ frame: frameOfTcSec(day, wrap(x.t + offsetSec)), code: x.code }))
    .sort((a, b) => a.frame - b.frame);
}

/**
 * Slate-angle reads (cut_through_slate.js) + slate-note events → one event list. Where the slate
 * screen was readable, what it showed wins; where it wasn't (or there's no slate footage), the
 * notes fill in. A repeat of the code before it is dropped.
 */
function mergeReads(reads, events) {
  const R = (reads || []).filter((r) => r.to > r.from);
  const inRead = (f) => R.find((r) => f >= r.from && f < r.to);
  const all = [];
  for (const r of R) if (r.code) all.push({ frame: r.from, code: r.code, src: 'frame' });
  for (const e of events || []) {
    const r = inRead(e.frame);
    if (!r || !r.code) all.push({ ...e, src: 'slate' });
  }
  all.sort((a, b) => a.frame - b.frame);
  return all.filter((e, i) => i === 0 || e.code !== all[i - 1].code);
}

/** Every mic's own words, sorted by start (frames). */
function wordList(words) {
  return ((words && words.words) || []).filter((w) => w.own !== false && !w.ghost).sort((a, b) => a.s - b.s);
}

/** The middle of the longest pause in [lo, hi] (frames), or null when nobody talks there. */
function longestPause(W, lo, hi) {
  const inRange = W.filter((w) => w.e > lo && w.s < hi);
  if (!inRange.length) return null;
  let best = null;
  let prevEnd = lo;
  for (const w of inRange) {
    if (w.s > prevEnd && (!best || w.s - prevEnd > best.len)) best = { at: Math.round((prevEnd + w.s) / 2), len: w.s - prevEnd };
    prevEnd = Math.max(prevEnd, w.e);
  }
  if (hi > prevEnd && (!best || hi - prevEnd > best.len)) best = { at: Math.round((prevEnd + hi) / 2), len: hi - prevEnd };
  return best ? best.at : null;
}

/** Who talks in [a, b): mics with a real share of the words. */
function speakersIn(W, a, b) {
  const count = {};
  let n = 0;
  for (const w of W) {
    if (w.s >= a && w.s < b) { count[w.mic] = (count[w.mic] || 0) + 1; n += 1; }
  }
  const ranked = Object.entries(count).sort((x, y) => y[1] - x[1]);
  const speakers = ranked.filter(([, k]) => k >= SPEAKER_MIN_WORDS && k / Math.max(1, n) >= SPEAKER_SHARE).map(([m]) => m);
  return { words: n, speakers, top: ranked.length ? ranked[0][0] : null };
}

function safeId(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

/** A Resolve timeline name: no characters the build's run line or file names choke on. */
function cleanName(s) {
  return String(s || '').replace(/[=:"\\/<>|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function tcLabel(day, f) {
  const fs_ = frameSec(day);
  const nominal = Math.round(1 / fs_);
  const n = Math.round((day.tc_start_sec || 0) / fs_) + Math.max(0, Math.round(f));
  const pad = (x) => String(x).padStart(2, '0');
  const secs = Math.floor(n / nominal);
  return `${pad(Math.floor(secs / 3600) % 24)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(n % nominal)}`;
}

/**
 * The videos of the day.
 *   day       day_<LABEL>.json
 *   words     words_<LABEL>.json (optional: without it no pause snapping, no solo/convo guess)
 *   notes     LPOS slate notes [{ timestamp, code, note }] (optional: without them, one video per recording)
 *   offsetSec slate clock → multicam timecode (slateOffset's, or the page's override)
 *   label     the run label (names videos that have no J-code)
 *   firstCode the editor says the multicam starts on this code (notes already cut by notesFrom)
 */
function findVideos({ day, words = null, notes = [], offsetSec = 0, label = 'video', firstCode = '', reads = null }) {
  const fs_ = frameSec(day);
  const sec = (x) => Math.round(x / fs_);
  const W = wordList(words);
  const mics = (words && words.mics) || [...new Set(W.map((w) => w.mic))];
  const noteEvents = codeEvents(day, notes || [], offsetSec);
  const events = reads && reads.length ? mergeReads(reads, noteEvents) : noteEvents;
  const recs = recordingsOf(day);

  // 1. pieces: each recording, split where the code changes inside it
  const pieces = [];
  for (const [a, b] of recs) {
    const before = events.filter((e) => e.frame < a);
    const within = events.filter((e) => e.frame >= a && e.frame < b);
    let code = before.length ? before[before.length - 1].code : null;
    if (code === null && firstCode && !pieces.length && events.length) code = events[0].code;   // even if typed late
    let k = 0;
    // a code typed just after rolling names the recording
    while (k < within.length && within[k].frame < a + sec(START_GRACE_SEC)) { code = within[k].code; k += 1; }
    let start = a;
    for (; k < within.length; k += 1) {
      const e = within[k];
      if (e.code === code) continue;
      const lo = Math.max(start + sec(SHORT_SEC / 2), e.frame - sec(SPLIT_LOOKBACK_SEC));
      const hi = Math.min(b - 1, e.frame + sec(SPLIT_LOOKAHEAD_SEC));
      const at = hi > lo ? (longestPause(W, lo, hi) ?? Math.max(lo, e.frame - sec(2))) : null;
      if (at === null || at <= start || at >= b) { code = e.code; continue; }
      pieces.push({ from: start, to: at, code, recStart: start === a, recEnd: false });
      start = at;
      code = e.code;
    }
    pieces.push({ from: start, to: b, code, recStart: start === a, recEnd: true });
  }

  // 2. the same code across a stop = one video with a restart (the gap between recordings is cut)
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && p.code && last.code === p.code && last.recEnd && p.recStart) {
      last.gaps.push([last.to, p.from]);
      last.to = p.to;
      last.restarts += 1;
      last.recEnd = p.recEnd;
    } else {
      merged.push({ ...p, gaps: [], restarts: 0 });
    }
  }

  // 3. names, flags, who talks
  const seen = {};
  const videos = merged.map((v, i) => {
    const n = i + 1;
    const flags = [];
    const span = (v.to - v.from - v.gaps.reduce((t, [g0, g1]) => t + (g1 - g0), 0)) * fs_;
    if (!v.code) flags.push('No J-code');
    if (span < SHORT_SEC) flags.push('Short');
    if (v.restarts) flags.push(v.restarts > 1 ? `${v.restarts} restarts` : 'Restart');
    const who = speakersIn(W, v.from, v.to);
    if (W.length && who.words < FEW_WORDS) flags.push('Few words');
    if (reads && reads.length) {
      const seen_ = reads.filter((r) => r.to > v.from && r.from < v.to);
      if (seen_.length && !seen_.some((r) => r.code)) flags.push('Slate unreadable');
      else if (seen_.some((r) => r.code === v.code && !r.sure)) flags.push('Slate read unsure');
      // a code noted during this video that no video ended up with: the frames and the notes disagree
      const noted = [...new Set(noteEvents.filter((e) => e.frame >= v.from && e.frame < v.to).map((e) => e.code))]
        .filter((c) => c !== v.code && !merged.some((x) => x.code === c));
      if (noted.length) flags.push(`Notes say ${noted.join(', ')}`);
    }
    const later = merged.slice(i + 1).find((x) => x.code && x.code === v.code);
    if (later) flags.push(`${v.code} again at ${tcLabel(day, later.from)}`);
    const kind = mics.length > 1 && who.speakers.length >= 2 ? 'convo' : 'solo';
    const talker = kind === 'solo' ? (who.speakers[0] || who.top || mics[0] || null) : null;
    const base = cleanName(v.code) || `${label} video ${n}`;
    seen[base] = (seen[base] || 0) + 1;
    const name = seen[base] > 1 ? `${base} (${seen[base]})` : base;
    return {
      id: `v${String(n).padStart(2, '0')}${v.code ? `_${safeId(v.code)}` : ''}`,
      n, name, code: v.code || null, from: v.from, to: v.to, gaps: v.gaps,
      fromTc: tcLabel(day, v.from), toTc: tcLabel(day, v.to), minutes: span / 60,
      words: who.words, kind, talker, delivery: kind === 'convo' ? 'convo' : null, flags, include: true
    };
  });
  // a name used twice: the first gets "(1)" too, so neither is a plain J-code
  for (const v of videos) if (seen[v.name] > 1) v.name = `${v.name} (1)`;
  return videos;
}

/**
 * Create multicam: one timeline per recording, named "<J-code>_raw" from the code active at the
 * recording's midpoint (a best guess; codes are typed late, so not its start).
 */
function spanTimelines({ day, notes = [], offsetSec = 0, label = 'video' }) {
  const events = codeEvents(day, notes || [], offsetSec);
  const spans = recordingsOf(day).map(([a, b], i) => {
    const mid = (a + b) / 2;
    const active = events.filter((e) => e.frame <= mid).pop();
    return { n: i + 1, a, b, code: active ? cleanName(active.code) : '' };
  });
  const total = {};
  for (const s of spans) if (s.code) total[s.code] = (total[s.code] || 0) + 1;
  const seen = {};
  return spans.map((s) => {
    seen[s.code] = (seen[s.code] || 0) + 1;
    const name = !s.code ? `${label} video ${s.n}_raw`
      : total[s.code] > 1 ? `${s.code}_raw (${seen[s.code]})` : `${s.code}_raw`;
    return { name, code: s.code || null, segments: [[s.a, s.b]] };
  });
}

module.exports = { spanTimelines, findVideos, mergeReads, notesFrom, slateOffset, codeEvents, recordingsOf, slateSeconds, longestPause, speakersIn, tcSecOfFrame, frameOfTcSec, cleanName, safeId, tcLabel };
