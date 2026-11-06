'use strict';
/**
 * Cut-through (beta): Claude as the solo editor — the Z8 method, in the app.
 *
 *   words_<LABEL>.json (+ unheard stretches) → numbered transcript
 *   → Claude (cut_through/editor_briefs/solo.md) edits it like Z8: every removal AND every
 *     shot (which angle, where the cut lands), by token number, per the delivery type
 *     (scripted with retakes / free talk / live stage)
 *   → token anchors in frames (word edges around each removal and shot)
 *   → place_cuts.py removals=<file> levels=<file> places every cut from the waveform
 *     (Z8: 3 fr clear of sound), trims pauses, keeps the hard rules (angle change at
 *     every removal, no blink shots) and builds the audio.
 *
 * Client words go to Claude and to Desktop files only, never into git. The
 * brief lives in cut_through/editor_briefs/ so it can be tuned with a git pull.
 */
const fs = require('fs');
const path = require('path');
const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default || AnthropicModule;

const DEFAULT_MODEL = 'claude-opus-5-5';
// $ per million tokens (Claude Opus 5.5; cache write = 1.25× input)
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
};
const KINDS = ['retake', 'false_start', 'self_correction', 'flub', 'chatter', 'pre_roll', 'post_roll', 'filler', 'interruption', 'other'];
const DELIVERY = {
  scripted: 'Scripted, with retakes — the talent reads or recites prepared lines and redoes them until they are right.',
  free: 'Free talk — one person speaking unscripted to camera; no planned retakes.',
  stage: 'Live on stage with an audience — a real event, one continuous performance, no retakes.',
  convo: 'A recorded conversation (interview / podcast) — unscripted, seated, made for an episode; no planned retakes.'
};
// stage talks mostly lose dead air: pauses longer than 1.5 s go down to ~0.75 s (else > 30 fr → 11 fr)
// conversations: pauses are mostly turn-taking — only over 2 s, down to ~0.75 s
// min_save: a pause trim costs an angle change, so on stage / in conversation only trim when it saves
// that much (or a shot change already sits in the pause) — Bill Smith 2026-11-05: 0.5 s trims forced 8 extra cuts
// scripted: gaps over ~0.8 s go down to ~0.45 s (Elevate, Jordan 2026-11-06: 19–26 fr gaps after a line read long)
const PAUSES = { scripted: { max: 20, left: 11, min_save: 0 }, stage: { max: 36, left: 18, min_save: 36 }, convo: { max: 48, left: 18, min_save: 24 } };
const LINE_GAP_SEC = 0.6;
const SHOW_PAUSE_SEC = 1.5;

function buildSchema(angles) {
  return {
  type: 'object',
  additionalProperties: false,
  required: ['removals', 'shots', 'notes'],
  properties: {
    shots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'angle', 'why'],
        properties: {
          from: { type: 'integer' },
          angle: { type: 'string', enum: angles },
          why: { type: 'string' }
        }
      }
    },
    removals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'kind', 'reason'],
        properties: {
          from: { type: 'integer' },
          to: { type: 'integer' },
          kind: { type: 'string', enum: KINDS },
          reason: { type: 'string' }
        }
      }
    },
    // "check here" spots: each becomes a red marker on the finished timeline
    notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['at', 'note'],
        properties: { at: { type: 'integer' }, note: { type: 'string' } }
      }
    }
  }
  };
}
const SCHEMA = buildSchema(['Camera 1', 'Camera 2']);   // shape reference for tests

/** One talker's words + unheard stretches in [start, end), in time order. */
/**
 * Words + unheard stretches in [start, end), in time order. One mic = one talker (solo); several
 * mics = a conversation: each word is said by the owner of the mic it's loudest on (`own`), and
 * every token carries who (`who` = that mic's angle).
 */
function buildTokens(wordsFile, { start = 0, end = Infinity } = {}) {
  const people = wordsFile.mics || [];
  const talker = people[0] || null;
  const multi = people.length > 1;
  const mine = (x) => talker === null || (multi ? people.includes(x.mic) : x.mic === talker);
  const toks = [];
  for (const w of wordsFile.words || []) {
    // ghost: a word Whisper wrote twice that was said once (WhisperX alignment can't find it)
    if (w.own !== false && !w.ghost && mine(w) && w.s >= start && w.s < end) toks.push({ kind: 'w', s: w.s, e: w.e, text: String(w.w).trim(), who: w.mic });
  }
  for (const u of wordsFile.unheard || []) {
    if (mine(u) && u.s >= start && u.s < end) toks.push({ kind: 'u', s: u.s, e: u.e, text: '', who: u.mic });
  }
  toks.sort((a, b) => a.s - b.s);
  return { talker, people, multi, tokens: toks };
}

function angleNo(a) {
  const m = /(\d+)\s*$/.exec(a || '');
  return m ? Number(m[1]) : 999;
}

function clock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Numbered transcript: `[12:41] 412 the 413 best … ⟨pause 2.4 s⟩`. With `speakers` (a map of
 * mic angle → label) every line says who's talking and a new line starts when the talker changes:
 * `[12:41] Camera 2: 412 the …`.
 */
function renderTranscript(tokens, frameSec, speakers = null) {
  const lines = [];
  let cur = null;
  let prevEnd = null;
  let prevWho = null;
  tokens.forEach((t, i) => {
    const gap = prevEnd === null ? 0 : (t.s - prevEnd) * frameSec;
    if (!cur || gap > LINE_GAP_SEC || (speakers && t.who !== prevWho)) {
      if (cur) lines.push(cur);
      cur = `[${clock(t.s * frameSec)}]${speakers ? ` ${speakers[t.who] || t.who}:` : ''}`;
      if (gap > SHOW_PAUSE_SEC) cur = `⟨pause ${gap.toFixed(1)} s⟩\n${cur}`;
      prevWho = t.who;
    }
    cur += t.kind === 'u' ? ` ${i} ⟨unheard sound ${((t.e - t.s) * frameSec).toFixed(1)} s⟩` : ` ${i} ${t.text}`;
    prevEnd = Math.max(prevEnd === null ? t.e : prevEnd, t.e);
  });
  if (cur) lines.push(cur);
  return lines.join('\n');
}

/** Check Claude's ranges; returns {ok:[...], problems:[...]} (sorted, de-overlapped). */
function validateRemovals(removals, nTokens) {
  const ok = [];
  const problems = [];
  for (const r of Array.isArray(removals) ? removals : []) {
    const from = Number(r.from);
    const to = Number(r.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= nTokens || to < from) {
      problems.push(`skipped ${JSON.stringify({ from: r.from, to: r.to })}: not a token range`);
      continue;
    }
    ok.push({ from, to, kind: KINDS.includes(r.kind) ? r.kind : 'other', reason: String(r.reason || '') });
  }
  ok.sort((a, b) => a.from - b.from);
  const merged = [];
  for (const r of ok) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) {
      if (r.from <= last.to) problems.push(`merged overlapping ${last.from}–${last.to} and ${r.from}–${r.to}`);
      last.to = Math.max(last.to, r.to);
      if (!last.kind.split('+').includes(r.kind)) last.kind += `+${r.kind}`;
      last.reason = [last.reason, r.reason].filter(Boolean).join(' / ');
    } else {
      merged.push({ ...r });
    }
  }
  return { ok: merged, problems };
}

/**
 * Claude's shots → in order, valid angles, each starting on a kept token (a shot that starts
 * inside a removal moves to the first token after it). Returns {ok, problems}.
 */
function validateShots(shots, removals, nTokens, angles) {
  const problems = [];
  const isCut = (i) => removals.some((r) => r.from <= i && i <= r.to);
  const out = [];
  for (const x of Array.isArray(shots) ? shots : []) {
    let from = Number(x.from);
    if (!Number.isInteger(from) || from < 0 || from >= nTokens || !angles.includes(x.angle)) {
      problems.push(`skipped shot ${JSON.stringify({ from: x.from, angle: x.angle })}`);
      continue;
    }
    while (from < nTokens && isCut(from)) from += 1;
    if (from >= nTokens) continue;
    out.push({ from, angle: x.angle, why: String(x.why || '') });
  }
  out.sort((a, b) => a.from - b.from);
  const dedup = [];
  out.forEach((x) => {
    if (dedup.length && dedup[dedup.length - 1].from === x.from) dedup[dedup.length - 1] = x;
    else dedup.push(x);
  });
  return { ok: dedup, problems };
}

/** Shots → frames, with the word anchors place_cuts.py snaps from (the quiet before the word). */
function toFrameShots(tokens, shots, removals) {
  const isCut = (i) => removals.some((r) => r.from <= i && i <= r.to);
  return shots.map((x) => {
    const t = tokens[x.from];
    const p = x.from - 1;
    // the kept word right before (none when a removal sits between: that join is cut anyway)
    const prevEnd = p >= 0 && !isCut(p) ? tokens[p].e : null;
    return { at: Math.floor(t.s), start: t.s, prev_end: prevEnd, angle: x.angle };
  });
}

/**
 * Token ranges → frame spans, keeping ~6 fr of air after the kept token before
 * and ~5 fr before the kept token after (≈11 fr across the join), tighter when
 * the tokens themselves sit closer. Same rule as place_cuts.py's cut_span.
 */
function toFrameSpans(tokens, removals, { start, end }) {
  return removals.map((r) => {
    const prev = tokens[r.from - 1];
    const next = tokens[r.to + 1];
    const first = tokens[r.from];
    let a = prev ? Math.floor(prev.e + Math.min(6, Math.max(0, first.s - prev.e))) : start;
    let b = next ? Math.min(Math.ceil(next.s - Math.min(5, Math.max(0, next.s - tokens[r.to].e))), Math.floor(next.s)) : end;
    a = Math.max(start, a);
    b = Math.min(end, b);
    // anchors for place_cuts.py's waveform placement (Z8): the kept word before, the cut's first
    // and last token, the kept word after
    const said = tokens.slice(r.from, Math.min(r.to + 1, r.from + 10)).map((t) => (t.kind === 'u' ? '⟨sound⟩' : t.text)).join(' ');
    return { from: a, to: Math.max(a, b), why: r.kind, reason: r.reason || '', words: said + (r.to - r.from >= 10 ? ' …' : ''),
      prev_end: prev ? prev.e : null, cut_start: first.s, cut_end: tokens[r.to].e, next_start: next ? next.s : null };
  }).filter((x) => x.to > x.from);
}

function costOf(model, usage) {
  const p = PRICES[model] || PRICES[DEFAULT_MODEL];
  const u = usage || {};
  const dollars = ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output +
    (u.cache_read_input_tokens || 0) * p.cacheRead + (u.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
  return Math.round(dollars * 1000) / 1000;
}

/**
 * Ask Claude for the removals. Streams (long input, adaptive thinking) and
 * returns the final message parsed against SCHEMA.
 */
async function askClaude({ apiKey, model = DEFAULT_MODEL, effort = 'high', system, transcript, meta, angles = ['Camera 1', 'Camera 2'], client = null, onEvent = () => {} }) {
  const anthropic = client || new Anthropic(apiKey ? { apiKey } : {});
  const params = {
    model,
    // a shot list for a long talk is a few hundred entries on top of the removals and thinking
    max_tokens: 128000,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema: buildSchema(angles) } },
    system,
    messages: [{ role: 'user', content: `${meta}\n\n<transcript>\n${transcript}\n</transcript>\n\nReturn the edit: removals, shots, notes.` }]
  };
  const run = async (withFallback) => {
    const stream = withFallback
      // Refusal fallback: if a safety classifier declines, the API re-runs on a
      // fallback model inside the same call (no model list to maintain).
      ? anthropic.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : anthropic.messages.stream(params);
    let chars = 0;
    stream.on('text', (delta) => { chars += delta.length; onEvent({ type: 'writing', chars }); });
    return stream.finalMessage();
  };
  let msg;
  try {
    msg = await run(true);
  } catch (err) {
    // the fallback option is a beta: if this account/API rejects it, ask once without it
    if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message || '')) msg = await run(false);
    else throw err;
  }
  if (msg.stop_reason === 'refusal') {
    const d = msg.stop_details || {};
    throw new Error(`Claude declined (${d.category || 'refusal'}): ${d.explanation || ''}`.trim());
  }
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude ran out of output room (max_tokens) — try a shorter Start/End range');
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error(`Claude's answer wasn't valid JSON (stop: ${msg.stop_reason})`);
  }
  return { parsed, usage: msg.usage, model: msg.model || model, stopReason: msg.stop_reason };
}

/**
 * The whole Claude planning step. Writes Desktop/claude_edit_<LABEL>.json
 * (token ranges + reasons, client words) and Desktop/removals_<LABEL>.json
 * (frame spans for place_cuts.py), appends <files folder>/cut_through_costs.csv.
 * Returns { removalsFile, lines, cost, problems }.
 */
async function planWithClaude({ label, wordsPath, dayPath, outDir, costsDir, promptPath, start, end, apiKey, model, effort, client,
  delivery = 'scripted', roles = {}, direction = '', log = () => {}, onEvent }) {
  const words = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
  const day = JSON.parse(fs.readFileSync(dayPath, 'utf8'));
  const frameSec = day.frame_sec[0] / day.frame_sec[1];
  const { talker, people, multi, tokens } = buildTokens(words, { start, end });
  if (!tokens.length) throw new Error('No words in that range');
  const s0 = Math.max(start, Math.floor(tokens[0].s) - 18);
  const e0 = Math.min(end, Math.ceil(tokens[tokens.length - 1].e) + 24);
  // a conversation: angle N is the person on camera N (Jordan's rule), so a mic's angle names its talker
  const speakers = multi ? Object.fromEntries(people.map((p, k) => [p, `${p}`])) : null;
  const transcript = renderTranscript(tokens, frameSec, speakers);
  const system = fs.readFileSync(promptPath, 'utf8');
  const nWords = tokens.filter((t) => t.kind === 'w').length;
  const nUnheard = tokens.length - nWords;
  const angles = [...(day.angles || [])].sort((x, y) => angleNo(x) - angleNo(y));
  const wide = roles.wide || (angles.includes('Camera 1') ? 'Camera 1' : angles[0]);
  const punch = roles.punch || angles.find((a) => a !== wide) || wide;
  const roster = multi
    ? angles.map((a) => `${a} = ${a === wide ? 'the wide (everyone in shot)' : people.includes(a) ? `close-up of the person speaking on the ${a} mic` :
      (roles.extra || []).includes(a) ? 'an extra angle (side / slider)' : 'another angle'}`).join('; ')
    : angles.map((a) => `${a} = ${a === wide ? 'the wide' : a === punch ? 'the close-up (punch-in)' :
      (roles.extra || []).includes(a) ? 'an insert angle (side / slider)' : 'another angle'}`).join('; ');
  const meta = [
    `Recording: ${label}, ${((e0 - s0) * frameSec / 60).toFixed(1)} min, ` +
      (multi ? `${people.length} people, each on their own mic (${people.join(', ')}); a line's label says who is talking, ` :
        `one speaker (audio: ${talker || 'mic'}), `) +
      `${nWords} words, ${nUnheard} unheard-sound marks${words.unheard ? '' : ' (this transcript predates unheard-sound detection)'}.`,
    `Delivery: ${DELIVERY[delivery] || DELIVERY.scripted}`,
    `Angles: ${roster}.`,
    // Jordan's own words for this recording — they steer the guidelines, not the hard rules
    ...(String(direction || '').trim() ? ['', `Direction from Jordan for this recording (follow it; where it disagrees with the guidelines in your brief, it wins):`,
      String(direction).trim()] : [])
  ].join('\n');
  log(`Asking ${model || DEFAULT_MODEL} to edit the ${((e0 - s0) * frameSec / 60).toFixed(1)}-minute recording (${nWords} words)…`);
  const t0 = Date.now();
  const res = await askClaude({ apiKey, model, effort, system, transcript, meta, angles, client, onEvent });
  const seconds = Math.round((Date.now() - t0) / 1000);
  const { ok, problems } = validateRemovals(res.parsed.removals, tokens.length);
  const spans = toFrameSpans(tokens, ok, { start: s0, end: e0 });
  const sv = validateShots(res.parsed.shots, ok, tokens.length, angles);
  problems.push(...sv.problems);
  const shots = toFrameShots(tokens, sv.ok, ok);
  const cost = costOf(res.model, res.usage);
  const notes = (res.parsed.notes || []).map((n) => (typeof n === 'string' ? { at: null, note: n } : n));
  const review = notes.filter((n) => Number.isInteger(n.at) && tokens[n.at])
    .map((n) => ({ frame: Math.floor(tokens[n.at].s), note: String(n.note || '').slice(0, 300) }));

  const claudeFile = path.join(outDir, `claude_edit_${label}.json`);
  const removalsFile = path.join(outDir, `removals_${label}.json`);
  fs.writeFileSync(claudeFile, JSON.stringify({
    label, model: res.model, effort, delivery, direction: String(direction || '').trim() || undefined, seconds, usage: res.usage, cost_usd: cost, range: [s0, e0],
    shots: sv.ok.map((x) => ({ ...x, at: clock(tokens[x.from].s * frameSec),
      words: tokens.slice(x.from, x.from + 6).map((t) => t.text || '⟨sound⟩').join(' ') })),
    removals: ok.map((r) => ({ ...r, words: tokens.slice(r.from, r.to + 1).map((t) => (t.kind === 'u' ? '⟨unheard⟩' : t.text)).join(' '),
      at: clock(tokens[r.from].s * frameSec) })),
    notes: notes.map((n) => ({ ...n, time: Number.isInteger(n.at) && tokens[n.at] ? clock(tokens[n.at].s * frameSec) : null })), problems
  }, null, 1));
  fs.writeFileSync(removalsFile, JSON.stringify({ start: s0, end: e0, delivery, removals: spans, shots, review,
    pauses: PAUSES[delivery] || null }, null, 1));
  // a copy per model, so an Opus and a Sonnet edit of the same day can be compared
  fs.copyFileSync(claudeFile, path.join(outDir, `claude_edit_${label}_${String(res.model).replace(/[^A-Za-z0-9_.-]+/g, '_')}.json`));
  fs.mkdirSync(costsDir || outDir, { recursive: true });
  const csv = path.join(costsDir || outDir, 'cut_through_costs.csv');
  const u = res.usage || {};
  if (!fs.existsSync(csv)) fs.writeFileSync(csv, 'when,label,step,model,effort,input_tokens,output_tokens,cache_read,cache_write,usd,seconds\n');
  fs.appendFileSync(csv, `${new Date().toISOString()},${label},solo_plan,${res.model},${effort},${u.input_tokens || 0},${u.output_tokens || 0},` +
    `${u.cache_read_input_tokens || 0},${u.cache_creation_input_tokens || 0},${cost},${seconds}\n`);

  const byKind = {};
  ok.forEach((r) => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; });
  const removedSec = spans.reduce((a, x) => a + (x.to - x.from), 0) * frameSec;
  const lines = [
    `Claude (${res.model}, effort ${effort}, ${delivery}): ${ok.length} removals (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}), ` +
      `${removedSec.toFixed(0)} s removed, ${sv.ok.length} shots — ${seconds}s, $${cost.toFixed(3)} (${u.input_tokens || 0} in / ${u.output_tokens || 0} out tokens)`,
    ...ok.map((r) => `  ${r.from}–${r.to} [${clock(tokens[r.from].s * frameSec)}] ${r.kind}: ${r.reason}`),
    ...notes.map((n) => `  check${Number.isInteger(n.at) && tokens[n.at] ? ` [${clock(tokens[n.at].s * frameSec)}]` : ''}: ${n.note}`),
    ...problems.map((p) => `  ⚠ ${p}`)
  ];
  return { removalsFile, claudeFile, lines, cost, problems };
}

module.exports = { planWithClaude, buildTokens, renderTranscript, validateRemovals, validateShots, toFrameSpans, toFrameShots,
  costOf, askClaude, buildSchema, SCHEMA, DEFAULT_MODEL, DELIVERY, PAUSES };
