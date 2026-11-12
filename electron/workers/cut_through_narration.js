'use strict';
/**
 * Cut-through narration (audiobook, 2026-11-12): the manuscript and the chapters.
 *
 *   readManuscript(file)      .txt / .md / .docx → plain text, read on this machine (a PDF is
 *                             refused: save it as Word or text — sending a PDF to Claude costs more)
 *   splitChapters(text)       → [{ title, text }] at heading lines (Chapter …, Prologue, Part …);
 *                             no headings = one "Full read"
 *   findChapters(...)         each chapter's first words found in the transcript → one "video"
 *                             per chapter (the Videos machinery plans and builds them one by one),
 *                             each carrying its manuscript slice by chapter index
 *
 * Pure functions; the engine (cut_through.js) owns the files. Client text stays in the run folder.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HEADING_RE = /^\s*(chapter|prologue|epilogue|introduction|intro|foreword|preface|afterword|part|book|conclusion|acknowledg(e)?ments|interlude)\b[^\n]{0,80}$/i;
const MATCH_WORDS = 12;            // how many of a chapter's first words are looked for
const MATCH_MIN = 0.5;             // share of them that must be found, in order

// ── manuscript ────────────────────────────────────────────────────
/** One file out of a zip (a .docx), with Node's own inflate: no zip dependency. */
function unzipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a Word file (no zip directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entry === name) {
      const lNameLen = buf.readUInt16LE(local + 26);
      const lExtraLen = buf.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Word file uses an unknown compression (${method})`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`Not a Word file (no ${name})`);
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** word/document.xml → text, one line per paragraph. */
function docxText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml').toString('utf8');
  const paras = xml.split(/<\/w:p>/);
  return paras.map((p) => decodeXml(p
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g, '\u0000$1\u0000')
    .split('\u0000').filter((_, i) => i % 2 === 1).join('')))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function readManuscript(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (ext === '.pdf') throw new Error('PDF isn\'t supported: save the manuscript as Word (.docx) or text (.txt)');
  if (ext === '.doc') throw new Error('Old Word (.doc) isn\'t supported: save it as .docx');
  const buf = fs.readFileSync(file);
  const text = ext === '.docx' ? docxText(buf) : buf.toString('utf8').replace(/^﻿/, '');
  if (!text.trim()) throw new Error('The manuscript is empty');
  return text.replace(/\r\n?/g, '\n');
}

/** Heading lines split the text into chapters; text before the first heading (title page, a
 *  dedication) rides with the first chapter. */
function splitChapters(text) {
  const lines = String(text || '').split('\n');
  const heads = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t && HEADING_RE.test(t) && t.split(/\s+/).length <= 12) heads.push(i);
  })
  if (!heads.length) return [{ title: 'Full read', text: String(text || '').trim() }];
  return heads.map((h, k) => {
    const from = k === 0 ? 0 : h;
    const to = k + 1 < heads.length ? heads[k + 1] : lines.length;
    return { title: lines[h].trim().replace(/\s+/g, ' ').slice(0, 80), text: lines.slice(from, to).join('\n').trim() };
  });
}

// ── matching chapters to the transcript ──────────────────────────
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberWords(n) {
  if (n < 20) return [ONES[n]];
  if (n < 100) return [TENS[Math.floor(n / 10)], ...(n % 10 ? [ONES[n % 10]] : [])];
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? numberWords(n % 100) : [])];
  return [String(n)];
}

function romanValue(s) {
  const v = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let total = 0;
  for (let i = 0; i < s.length; i += 1) {
    const a = v[s[i]];
    const b = v[s[i + 1]] || 0;
    total += a < b ? -a : a;
  }
  return total;
}

/** Text → comparable words: lower case, no punctuation, digits (and a heading's roman numerals) as words. */
function normWords(text, { roman = false } = {}) {
  const out = [];
  const raw = String(text || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  raw.forEach((w, i) => {
    if (/^\d+$/.test(w) && Number(w) < 1000) out.push(...numberWords(Number(w)));
    else if (roman && i > 0 && /^[ivxlc]+$/.test(w) && w !== 'i' && romanValue(w) > 0 && romanValue(w) < 200) out.push(...numberWords(romanValue(w)));
    else out.push(w);
  });
  return out;
}

/** The transcript's own words, in time order (what Plan's tokens are built from). */
function transcriptWords(words) {
  return ((words && words.words) || []).filter((w) => w.own !== false && !w.ghost).sort((a, b) => a.s - b.s)
    .map((w) => ({ s: w.s, e: w.e, n: normWords(w.w) })).filter((w) => w.n.length);
}

/** First token index at or after `from` where the target words are found in order (most of
 *  them), or -1. The earliest hit wins, so an earlier take of a chapter's opening stays in it. */
function locate(seq, target, from) {
  const need = Math.max(2, Math.ceil(target.length * MATCH_MIN));
  const span = Math.ceil(target.length * 2);
  for (let i = from; i < seq.length; i += 1) {
    if (!target.slice(0, 3).includes(seq[i])) continue;
    let k = target.indexOf(seq[i]) + 1;
    let hit = 1;
    let lastJ = i;
    // in order and close together: a stray word or two (a breath "uh", a restart) is fine, a run is not
    for (let j = i + 1; j < Math.min(seq.length, i + span) && k < target.length && j - lastJ <= 4; j += 1) {
      const at = target.indexOf(seq[j], k);
      if (at >= 0 && at - k <= 2) { hit += 1; k = at + 1; lastJ = j; }
    }
    if (hit >= need) return i;
  }
  return -1;
}

/**
 * Chapters → videos (cut_through_videos.js shape, kind 'narration'). A chapter not found in the
 * recording joins the one before it (its text with it) and is flagged.
 */
function findChapters({ day, words, chapters, label = 'narration', tcLabel = (f) => String(f) }) {
  const W = transcriptWords(words);
  const flat = [];                                   // [{ n: word, k: index into W }]
  W.forEach((w, k) => w.n.forEach((n) => flat.push({ n, k })));
  const seq = flat.map((x) => x.n);
  const fsec = day.frame_sec[0] / day.frame_sec[1];
  const total = Math.round(day.length_sec / fsec);
  const starts = [];
  let from = 0;
  chapters.forEach((c, i) => {
    if (i === 0) { starts.push({ i, at: 0 }); return; }
    const target = normWords(`${c.title} ${c.text.slice(c.title.length, c.title.length + 400)}`, { roman: true }).slice(0, MATCH_WORDS);
    const at = locate(seq, target, from);
    if (at < 0) return;
    starts.push({ i, at });
    from = at + 1;
  });
  const found = new Set(starts.map((x) => x.i));
  return starts.map((st, k) => {
    const nextSt = starts[k + 1];
    const w0 = W[flat[st.at] ? flat[st.at].k : 0];
    const prev = st.at > 0 ? W[flat[st.at].k - 1] : null;
    // the cut between chapters sits in the pause before the chapter's first word
    const a = k === 0 ? 0 : Math.round(prev ? (prev.e + w0.s) / 2 : w0.s);
    const nextW = nextSt ? W[flat[nextSt.at].k] : null;
    const nextPrev = nextSt ? W[flat[nextSt.at].k - 1] : null;
    const b = nextSt ? Math.round(nextPrev ? (nextPrev.e + nextW.s) / 2 : nextW.s) : total;
    const lastIdx = nextSt ? nextSt.i - 1 : chapters.length - 1;
    const missing = [];
    for (let j = st.i + 1; j <= lastIdx; j += 1) if (!found.has(j)) missing.push(chapters[j].title);
    const n = k + 1;
    const nWords = W.filter((w) => w.s >= a && w.s < b).length;
    const flags = missing.length ? [`Not found: ${missing.join(', ')}`] : [];
    if (!nWords) flags.push('Few words');
    return {
      id: `c${String(n).padStart(2, '0')}`, n, name: cleanTitle(chapters[st.i].title) || `${label} part ${n}`, code: null,
      from: a, to: b, gaps: [], fromTc: tcLabel(a), toTc: tcLabel(b), minutes: (b - a) * fsec / 60, words: nWords,
      kind: 'narration', talker: (words && words.mics && words.mics[0]) || 'Narrator', delivery: 'narration', flags, include: true,
      chapters: [st.i, lastIdx]
    };
  });
}

/** A Resolve timeline name from a heading. */
function cleanTitle(t) {
  return String(t || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** The manuscript text for a chapter range [i, j]. */
function sliceText(manuscript, range) {
  const ch = (manuscript && manuscript.chapters) || [];
  if (!ch.length) return '';
  const [i, j] = Array.isArray(range) ? range : [0, ch.length - 1];
  return ch.slice(i, j + 1).map((c) => c.text).join('\n\n');
}

module.exports = { readManuscript, splitChapters, findChapters, sliceText, normWords, docxText, unzipEntry, locate };
