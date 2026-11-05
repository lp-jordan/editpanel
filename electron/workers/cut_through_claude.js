'use strict';
/**
 * Cut-through (beta): Claude as the solo editor — the Z8 method, in the app.
 *
 *   words_<LABEL>.json (+ unheard stretches) → numbered transcript
 *   → Claude (spikes/prompts/solo_editor.md) decides every removal, by token number
 *   → frame-exact removal spans (same edge rule as plan_solo.py: ~6 fr after the
 *     word before, ~5 fr before the word after)
 *   → plan_solo.py removals=<file> does pause trims, picture (wide ↔ punch-in,
 *     an angle change at every removal) and audio, as for the rule-based draft.
 *
 * Client words go to Claude and to Desktop files only, never into git. The
 * prompt lives in the spikes folder so it can be tuned with a git pull.
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
const KINDS = ['retake', 'false_start', 'self_correction', 'flub', 'chatter', 'pre_roll', 'post_roll', 'filler', 'other'];
const LINE_GAP_SEC = 0.6;
const SHOW_PAUSE_SEC = 1.5;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['removals', 'notes'],
  properties: {
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
    notes: { type: 'array', items: { type: 'string' } }
  }
};

/** One talker's words + unheard stretches in [start, end), in time order. */
function buildTokens(wordsFile, { start = 0, end = Infinity } = {}) {
  const talker = (wordsFile.mics || [])[0] || null;
  const mine = (x) => talker === null || x.mic === talker;
  const toks = [];
  for (const w of wordsFile.words || []) {
    if (w.own !== false && mine(w) && w.s >= start && w.s < end) toks.push({ kind: 'w', s: w.s, e: w.e, text: String(w.w).trim() });
  }
  for (const u of wordsFile.unheard || []) {
    if (mine(u) && u.s >= start && u.s < end) toks.push({ kind: 'u', s: u.s, e: u.e, text: '' });
  }
  toks.sort((a, b) => a.s - b.s);
  return { talker, tokens: toks };
}

function clock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Numbered transcript: `[12:41] 412 the 413 best … ⟨pause 2.4 s⟩` */
function renderTranscript(tokens, frameSec) {
  const lines = [];
  let cur = null;
  let prevEnd = null;
  tokens.forEach((t, i) => {
    const gap = prevEnd === null ? 0 : (t.s - prevEnd) * frameSec;
    if (!cur || gap > LINE_GAP_SEC) {
      if (cur) lines.push(cur);
      cur = `[${clock(t.s * frameSec)}]`;
      if (gap > SHOW_PAUSE_SEC) cur = `⟨pause ${gap.toFixed(1)} s⟩\n${cur}`;
    }
    cur += t.kind === 'u' ? ` ${i} ⟨unheard speech ${((t.e - t.s) * frameSec).toFixed(1)} s⟩` : ` ${i} ${t.text}`;
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
 * Token ranges → frame spans, keeping ~6 fr of air after the kept token before
 * and ~5 fr before the kept token after (≈11 fr across the join), tighter when
 * the tokens themselves sit closer. Same rule as plan_solo.py's cut_span.
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
    return { from: a, to: Math.max(a, b), why: r.kind };
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
async function askClaude({ apiKey, model = DEFAULT_MODEL, effort = 'high', system, transcript, meta, client = null, onEvent = () => {} }) {
  const anthropic = client || new Anthropic(apiKey ? { apiKey } : {});
  const params = {
    model,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema: SCHEMA } },
    system,
    messages: [{ role: 'user', content: `${meta}\n\n<transcript>\n${transcript}\n</transcript>\n\nReturn the removals.` }]
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
 * (frame spans for plan_solo.py), appends Desktop/cut_through_costs.csv.
 * Returns { removalsFile, lines, cost, problems }.
 */
async function planWithClaude({ label, wordsPath, dayPath, desktopDir, promptPath, start, end, apiKey, model, effort, client, log = () => {}, onEvent }) {
  const words = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
  const day = JSON.parse(fs.readFileSync(dayPath, 'utf8'));
  const frameSec = day.frame_sec[0] / day.frame_sec[1];
  const { talker, tokens } = buildTokens(words, { start, end });
  if (!tokens.length) throw new Error('No words in that range');
  const s0 = Math.max(start, Math.floor(tokens[0].s) - 18);
  const e0 = Math.min(end, Math.ceil(tokens[tokens.length - 1].e) + 24);
  const transcript = renderTranscript(tokens, frameSec);
  const system = fs.readFileSync(promptPath, 'utf8');
  const nWords = tokens.filter((t) => t.kind === 'w').length;
  const nUnheard = tokens.length - nWords;
  const meta = `Recording: ${label}, ${((e0 - s0) * frameSec / 60).toFixed(1)} min, one speaker (${talker || 'mic'}), ` +
    `${nWords} words, ${nUnheard} unheard-speech marks${words.unheard ? '' : ' (this transcript predates unheard-speech detection)'}.`;
  log(`Asking ${model || DEFAULT_MODEL} to edit the ${((e0 - s0) * frameSec / 60).toFixed(1)}-minute recording (${nWords} words)…`);
  const t0 = Date.now();
  const res = await askClaude({ apiKey, model, effort, system, transcript, meta, client, onEvent });
  const seconds = Math.round((Date.now() - t0) / 1000);
  const { ok, problems } = validateRemovals(res.parsed.removals, tokens.length);
  const spans = toFrameSpans(tokens, ok, { start: s0, end: e0 });
  const cost = costOf(res.model, res.usage);

  const claudeFile = path.join(desktopDir, `claude_edit_${label}.json`);
  const removalsFile = path.join(desktopDir, `removals_${label}.json`);
  fs.writeFileSync(claudeFile, JSON.stringify({
    label, model: res.model, effort, seconds, usage: res.usage, cost_usd: cost, range: [s0, e0],
    removals: ok.map((r) => ({ ...r, words: tokens.slice(r.from, r.to + 1).map((t) => (t.kind === 'u' ? '⟨unheard⟩' : t.text)).join(' '),
      at: clock(tokens[r.from].s * frameSec) })),
    notes: res.parsed.notes || [], problems
  }, null, 1));
  fs.writeFileSync(removalsFile, JSON.stringify({ start: s0, end: e0, removals: spans }, null, 1));
  const csv = path.join(desktopDir, 'cut_through_costs.csv');
  const u = res.usage || {};
  if (!fs.existsSync(csv)) fs.writeFileSync(csv, 'when,label,step,model,effort,input_tokens,output_tokens,cache_read,cache_write,usd,seconds\n');
  fs.appendFileSync(csv, `${new Date().toISOString()},${label},solo_plan,${res.model},${effort},${u.input_tokens || 0},${u.output_tokens || 0},` +
    `${u.cache_read_input_tokens || 0},${u.cache_creation_input_tokens || 0},${cost},${seconds}\n`);

  const byKind = {};
  ok.forEach((r) => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; });
  const removedSec = spans.reduce((a, x) => a + (x.to - x.from), 0) * frameSec;
  const lines = [
    `Claude (${res.model}, effort ${effort}): ${ok.length} removals (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}), ` +
      `${removedSec.toFixed(0)} s removed — ${seconds}s, $${cost.toFixed(3)} (${u.input_tokens || 0} in / ${u.output_tokens || 0} out tokens)`,
    ...ok.map((r) => `  ${r.from}–${r.to} [${clock(tokens[r.from].s * frameSec)}] ${r.kind}: ${r.reason}`),
    ...(res.parsed.notes || []).map((n) => `  note: ${n}`),
    ...problems.map((p) => `  ⚠ ${p}`)
  ];
  return { removalsFile, claudeFile, lines, cost, problems };
}

module.exports = { planWithClaude, buildTokens, renderTranscript, validateRemovals, toFrameSpans, costOf, askClaude, SCHEMA, DEFAULT_MODEL };
