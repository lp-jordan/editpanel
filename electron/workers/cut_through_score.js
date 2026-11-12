'use strict';
/**
 * Cut-through Score (test, 2026-11-12): would a round-2 pass have caught what the editor fixed?
 *
 * Before review, the rough cuts are duplicated into the media pool bin "CT SNAPSHOT" (as built).
 * After review, one button runs:
 *   1. Compare: every reviewed rough cut against its plan (what the editor changed, in source frames)
 *   2. the snapshots read back and paired with the reviewed cuts by plan
 *   3. an audio-only render of every snapshot (what the project played before review)
 *   4. join_check.py on the renders: forced alignment + loudness at every join (no Claude)
 *   5. a read-through of each snapshot's kept words by Claude Haiku: suspected leftover flubs (markers only)
 *   6. the score: for each tool (today's Check, the join check, the read-through) flags that led to a
 *      change (caught), flags with no change near them (false alarms), and changes no flag was near (missed)
 * Writes score_<label>.json / .html into the run folder; the renders live in a temp folder and are
 * deleted at the end. Nothing is written to Resolve but the render jobs, which are removed again.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const compare = require('./cut_through_compare');
const claude = require('./cut_through_claude');
const { picturePieces, segsOf, readJson, tcPlus } = require('./cut_through_util');

const SNAPSHOT_BIN = 'CT SNAPSHOT';
const READ_MODEL = 'claude-haiku-5-5';
const READ_CONCURRENCY = 4;
const REACH = 24;                 // frames: a flag this close to a change counts as catching it (as Compare)
const LINE_WORDS = 14;

// Each change gets a group from Compare's type. Compare names a change from the words in it, and
// the words come from the transcript: a word Whisper never wrote down makes a word-end fix look
// like a pause, so a pause change right at a cut also counts as a join-check target. The editor's
// own label (changes sheet, `your_label`) replaces the group: edge / words / pause / other.
const LABELS = ['edge', 'words', 'pause', 'other'];
function autoGroup(e) {
  if (['word_finished', 'word_scrap', 'word_clipped'].includes(e.type)) return 'edge';
  if (e.type === 'cut' || e.type === 'restored') return 'words';
  if (e.type === 'air_added' || e.type === 'air_trimmed') return e.position === 'join' ? 'pause_at_cut' : 'pause';
  return 'other';
}
const groupOf = (e) => e.label || e.group;
// what each tool is meant to catch, by group (a labelled pause is a pause: not the join check's)
const TARGETS = {
  join: (e) => (e.label ? e.label === 'edge' : ['edge', 'pause_at_cut'].includes(e.group)),
  read: (e) => groupOf(e) === 'words',
  check: () => true
};
const GROUP_NAMES = ['edge', 'words', 'pause_at_cut', 'pause', 'other'];

const READ_BRIEF = `You check a rough cut of a talking-head video before a human editor reviews it.
You see only the words still in the cut, in order. A line that starts with ‖ comes right after a cut where something was removed.
Find what a professional editor would still take out or fix:
- flub: a word or phrase said wrong and then corrected, both still in
- repeat: the same sentence or phrase said twice (two takes), both still in
- restart: a sentence begun, dropped, and begun again
- fragment: a broken-off word or half sentence left dangling by a cut
- doesnt_follow: a line that no longer makes sense because of a cut
Do not flag normal speech, natural filler, style, or content. Be conservative: only what an editor would actually cut.
For each, give the line number, the exact words from the transcript (2 to 15 words, copied exactly), the kind, and a short reason.
Return an empty list when the cut is clean.`;

const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['flags'],
  properties: {
    flags: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'quote', 'kind', 'why'],
        properties: {
          line: { type: 'integer' },
          quote: { type: 'string' },
          kind: { type: 'string', enum: ['flub', 'repeat', 'restart', 'fragment', 'doesnt_follow', 'other'] },
          why: { type: 'string' }
        }
      }
    }
  }
};

const norm = (w) => String(w || '').toLowerCase().replace(/[^a-z0-9']+/g, '');

/** The words a timeline plays, in record order, each with its source frames and the join before it. */
function keptTokens(timeline, words, multicam) {
  const segs = segsOf(picturePieces(timeline, multicam));
  const all = (words.words || []).filter((w) => w.own !== false && !w.ghost && Number.isFinite(w.s) && Number.isFinite(w.e))
    .sort((a, b) => a.s - b.s);
  const out = [];
  segs.forEach((g, k) => {
    let first = true;
    for (const w of all) {
      const mid = (w.s + w.e) / 2;
      if (mid < g.src_in || mid >= g.src_out) continue;
      out.push({ w: String(w.w).trim(), s: w.s, e: w.e, rec: g.start + (w.s - g.src_in), afterCut: first && k > 0 });
      first = false;
    }
  });
  return out;
}

/** Numbered lines for the read-through: a new line after every cut (marked ‖) and every LINE_WORDS words. */
function readLines(tokens) {
  const lines = [];
  let cur = null;
  tokens.forEach((t, i) => {
    if (!cur || t.afterCut || cur.idx.length >= LINE_WORDS) {
      cur = { cut: t.afterCut, idx: [] };
      lines.push(cur);
    }
    cur.idx.push(i);
  });
  const text = lines.map((l, n) => `${n + 1}: ${l.cut ? '‖ ' : ''}${l.idx.map((i) => tokens[i].w).join(' ')}`).join('\n');
  return { lines, text };
}

/** Where a quoted run of words sits: near its line first, else anywhere. → [firstToken, lastToken] or null. */
function locateQuote(tokens, lines, line, quote) {
  const q = String(quote || '').split(/\s+/).map(norm).filter(Boolean);
  if (!q.length) return null;
  const at = (i) => q.every((x, k) => tokens[i + k] && norm(tokens[i + k].w) === x);
  const l = lines[Math.max(0, Math.min(lines.length - 1, (line || 1) - 1))];
  const near = l ? l.idx[0] : 0;
  const order = tokens.map((_, i) => i).sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
  for (const i of order) if (at(i)) return [i, i + q.length - 1];
  // not word for word: the first quoted word near the line
  for (const i of order.slice(0, LINE_WORDS * 3)) if (norm(tokens[i].w) === q[0]) return [i, Math.min(tokens.length - 1, i + q.length - 1)];
  return l ? [l.idx[0], l.idx[l.idx.length - 1]] : null;
}

/** Claude's answer → flags in source frames. */
function readFlags(parsed, tokens, lines) {
  const out = [];
  for (const f of (parsed && parsed.flags) || []) {
    const r = locateQuote(tokens, lines, f.line, f.quote);
    if (!r) continue;
    const [a, b] = r;
    out.push({ source: 'read', kind: f.kind, why: f.why, quote: f.quote, line: f.line,
      from: Math.round(tokens[a].s), to: Math.round(tokens[b].e), at: Math.round(tokens[a].s), rec: Math.round(tokens[a].rec) });
  }
  return out;
}

const near = (f, e) => {
  const a = Number.isFinite(f.from) ? f.from : f.at;
  const b = Number.isFinite(f.to) ? f.to : f.at;
  return e.from - REACH < b && e.to + REACH > a;
};

/** One reviewed timeline: each tool's flags against the editor's changes. Which changes a tool
 *  was meant to catch is worked out from the groups (targetsOf), so a relabel re-scores without Resolve. */
function scoreTimeline({ result, joinFlags = [], readFlagList = [] }) {
  const events = result.events || [];
  const checkFlags = (result.flags || []).filter((f) => f.source === 'check');
  const tools = { check: checkFlags, join: joinFlags, read: readFlagList };
  const out = { timeline: result.timeline, changes: events.length, byType: {}, tools: {}, events: [] };
  for (const e of events) out.byType[e.type] = (out.byType[e.type] || 0) + 1;
  for (const [tool, flags] of Object.entries(tools)) {
    const hit = flags.filter((f) => events.some((e) => near(f, e)));
    out.tools[tool] = {
      flags: flags.length, caught: hit.length, falseAlarms: flags.length - hit.length,
      falseAlarmList: flags.filter((f) => !events.some((e) => near(f, e))).map((f) => ({ at: f.at, rec: f.rec, kind: f.kind || f.name, why: f.why || f.note || '' }))
    };
  }
  for (const e of events) {
    out.events.push({ type: e.type, group: autoGroup(e), position: e.position || null, from: e.from, to: e.to, tc: e.tc,
      text: e.text || e.partNote || '', by: Object.entries(tools).filter(([, fl]) => fl.some((f) => near(f, e))).map(([t]) => t) });
  }
  return out;
}

/** Totals over every scored timeline, from the stored rows (also used by the re-score). */
function totals(rows) {
  const sum = { timelines: rows.length, changes: 0, byType: {}, tools: {}, groups: {}, relabeled: 0 };
  for (const r of rows) {
    sum.changes += r.changes;
    for (const [k, n] of Object.entries(r.byType)) sum.byType[k] = (sum.byType[k] || 0) + n;
    for (const [tool, t] of Object.entries(r.tools)) {
      const s = sum.tools[tool] || (sum.tools[tool] = { flags: 0, caught: 0, falseAlarms: 0, targets: 0, targetsCaught: 0 });
      s.flags += t.flags;
      s.caught += t.caught;
      s.falseAlarms += t.falseAlarms;
    }
  }
  const evs = rows.flatMap((r) => r.events);
  sum.relabeled = evs.filter((e) => e.label).length;
  for (const [tool, s] of Object.entries(sum.tools)) {
    const targets = evs.filter(TARGETS[tool]);
    s.targets = targets.length;
    s.targetsCaught = targets.filter((e) => e.by.includes(tool)).length;
  }
  for (const g of GROUP_NAMES) {
    const ge = evs.filter((e) => groupOf(e) === g);
    sum.groups[g] = { changes: ge.length, missedByAll: ge.filter((e) => !e.by.length).length,
      byTool: Object.fromEntries(['check', 'join', 'read'].map((t) => [t, ge.filter((e) => e.by.includes(t)).length])) };
  }
  return sum;
}

const csvCell = (v) => { const x = String(v === null || v === undefined ? '' : v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };

/** The changes sheet: one row per change, for the editor to correct Compare's label. */
function changesCsv(rows) {
  const head = ['timeline', 'tc', 'from', 'to', 'compare_type', 'auto_label', 'words', 'caught_by', 'your_label'];
  const out = [head.join(',')];
  for (const r of rows) {
    for (const e of r.events) {
      out.push([r.timeline, e.tc, e.from, e.to, e.type, e.group, e.text, e.by.join('+') || 'missed', e.label || ''].map(csvCell).join(','));
    }
  }
  return out.join('\r\n') + '\r\n';
}

/** A CSV (Excel / Sheets save, comma or semicolon) → rows of cells. */
function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}

/** The editor's labels from the changes sheet onto a saved score → { score, applied, unknown, unmatched }. */
function rescore(score, csvText) {
  const rows = parseCsv(csvText);
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  const [ti, fi, toi, li] = ['timeline', 'from', 'to', 'your_label'].map(col);
  if ([ti, fi, toi, li].some((i) => i < 0)) throw new Error('The sheet needs the columns timeline, from, to and your_label');
  const byKey = new Map();
  for (const r of score.timelines) for (const e of r.events) { delete e.label; byKey.set(`${r.timeline}|${e.from}|${e.to}`, e); }
  let applied = 0;
  const unknown = [];
  let unmatched = 0;
  for (const r of rows) {
    const label = String(r[li] || '').trim().toLowerCase();
    if (!label) continue;
    const e = byKey.get(`${String(r[ti]).trim()}|${Number(r[fi])}|${Number(r[toi])}`);
    if (!e) { unmatched += 1; continue; }
    if (!LABELS.includes(label)) { unknown.push(label); continue; }
    e.label = label;
    applied += 1;
  }
  const sum = totals(score.timelines);
  sum.readCost = score.totals && score.totals.readCost;
  return { score: { ...score, totals: sum, relabeledAt: Date.now() }, applied, unknown, unmatched };
}

function reportLines(sum, extra = []) {
  const L = [`Scored ${sum.timelines} timeline(s): ${sum.changes} change(s) by the editor`, ''];
  const name = { check: "Today's Check", join: 'Join check', read: 'Read-through (Haiku)' };
  for (const [tool, t] of Object.entries(sum.tools)) {
    L.push(`${name[tool]}: ${t.flags} flags · ${t.caught} led to a change · ${t.falseAlarms} false alarm(s) · caught ${t.targetsCaught}/${t.targets} of its kind`);
  }
  L.push('');
  for (const [g, x] of Object.entries(sum.groups)) {
    if (!x.changes) continue;
    L.push(`${g}: ${x.changes} change(s) · Check ${x.byTool.check} · join ${x.byTool.join} · read ${x.byTool.read} · missed by all ${x.missedByAll}`);
  }
  if (sum.relabeled) L.push(`(${sum.relabeled} change(s) relabeled by the editor)`);
  return [...L, ...(extra.length ? ['', ...extra] : [])];
}

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function reportHtml({ label, rows, sum, notes = [] }) {
  const name = { check: 'Check', join: 'Join check', read: 'Read-through' };
  const toolRows = Object.entries(sum.tools).map(([t, x]) =>
    `<tr><td>${name[t]}</td><td>${x.flags}</td><td>${x.caught}</td><td>${x.falseAlarms}</td><td>${x.targetsCaught} / ${x.targets}</td></tr>`).join('');
  const groupRows = Object.entries(sum.groups).filter(([, x]) => x.changes).map(([g, x]) =>
    `<tr><td>${g}</td><td>${x.changes}</td><td>${x.byTool.check}</td><td>${x.byTool.join}</td><td>${x.byTool.read}</td><td>${x.missedByAll}</td></tr>`).join('');
  const per = rows.map((r) => {
    const ev = r.events.map((e) => `<tr><td>${esc(e.tc)}</td><td>${esc(e.label ? `${e.label} (yours; Compare: ${e.type})` : `${e.group} (${e.type})`)}</td><td>${esc(e.text)}</td><td>${e.by.map((b) => name[b]).join(', ') || '<b>missed</b>'}</td></tr>`).join('');
    const fa = Object.entries(r.tools).flatMap(([t, x]) => x.falseAlarmList.map((f) => `<li>${name[t]}: ${esc(f.kind)} — ${esc(f.why)}</li>`)).join('');
    return `<h3>${esc(r.timeline)}</h3><table><tr><th>TC</th><th>Change</th><th>Words</th><th>Caught by</th></tr>${ev || '<tr><td colspan="4">No changes</td></tr>'}</table>`
      + (fa ? `<details><summary>False alarms</summary><ul>${fa}</ul></details>` : '');
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Score ${esc(label)}</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#222;background:#fff}table{border-collapse:collapse;margin:8px 0 16px}
td,th{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}th{background:#f4f4f4}h3{margin-top:28px}
</style></head><body><h1>Score — ${esc(label)}</h1>
<table><tr><th>Tool</th><th>Flags</th><th>Led to a change</th><th>False alarms</th><th>Caught (its kind)</th></tr>${toolRows}</table>
<table><tr><th>Changes</th><th>Total</th><th>Check</th><th>Join</th><th>Read</th><th>Missed by all</th></tr>${groupRows}</table>
${notes.length ? `<p>${notes.map(esc).join('<br>')}</p>` : ''}${per}</body></html>`;
}

/** Ask Haiku about one snapshot. → { flags, usage, model } */
async function readThrough({ client, tokens }) {
  const { lines, text } = readLines(tokens);
  if (!tokens.length) return { flags: [], usage: null, model: READ_MODEL };
  const msg = await client.messages.create({
    model: READ_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: READ_SCHEMA } },
    system: READ_BRIEF,
    messages: [{ role: 'user', content: `<cut>\n${text}\n</cut>\n\nReturn the flags.` }]
  });
  const res = claude.readMessage(msg, READ_MODEL);
  return { flags: readFlags(res.parsed, tokens, lines), usage: res.usage, model: res.model };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The whole chain. ctx (from cut_through.js):
 *   label, files, words, plans (comparablePlans()), roughCuts(), ask(payload) → worker data,
 *   phase(text, bar), log(line), markOwned(jobs), runPython(args) → {code, error}, joinScript,
 *   apiKey, client (tests), costsDir, isCanceled(), tmpRoot (tests)
 */
async function runScore(ctx) {
  const { label, files: f, words, plans, ask, phase, log } = ctx;
  const notes = [];

  // 1. Compare: the editor's changes on every reviewed rough cut
  phase('Comparing your edits');
  const reviewed = await ctx.roughCuts();
  if (!reviewed.length) throw new Error('No rough cut timeline in this project');
  if (!plans.length) throw new Error('No plan in this run to compare against');
  const levels = readJson(f.levels);
  const compared = [];
  for (const [k, name] of reviewed.entries()) {
    phase(`Comparing ${name}`, Math.round((k / reviewed.length) * 100));
    const tl = await ask({ cmd: 'ct_read_timeline', name, audio: true });
    const best = plans.map((p) => ({ p, score: compare.planMatch(tl, p.data) })).sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < 0.5) { notes.push(`No plan matches ${name}`); continue; }
    const removals = readJson(best.p.removals);
    const result = compare.compareTimeline({ timeline: tl, plan: best.p.data, words, removals, review: readJson(best.p.review), levels,
      kind: best.p.kind, pauses: (removals && removals.pauses) || null, beats: (removals && removals.beats) || [], motion: readJson(f.motion) });
    compared.push({ name, plan: best.p, result });
  }
  if (!compared.length) throw new Error('No reviewed rough cut matches a plan');
  const csum = compare.totals(compared.map((c) => c.result));
  fs.writeFileSync(f.compareJson, JSON.stringify({ label, madeAt: Date.now(), totals: csum, results: compared.map((c) => c.result) }, null, 1), 'utf8');
  fs.writeFileSync(f.compareHtml, compare.reportHtml({ label, results: compared.map((c) => c.result), sum: csum, levels,
    plans: Object.fromEntries(compared.map((c) => [c.name, c.plan.data])) }), 'utf8');

  // 2. the snapshots, paired with the reviewed cuts by plan
  phase(`Reading the ${SNAPSHOT_BIN} bin`);
  const bin = await ask({ cmd: 'list_bin_sequences', bin_name: SNAPSHOT_BIN });
  if (!bin || !bin.bin_found) throw new Error(`No "${SNAPSHOT_BIN}" bin in the media pool`);
  const snapNames = (bin.sequences || []).map((x) => x.name).filter(Boolean);
  if (!snapNames.length) throw new Error(`The "${SNAPSHOT_BIN}" bin has no timelines`);
  const clash = snapNames.filter((n) => reviewed.includes(n));
  if (clash.length) throw new Error(`Snapshot names match reviewed timelines (rename them): ${clash.join(', ')}`);
  const pairs = [];
  for (const name of snapNames) {
    const tl = await ask({ cmd: 'ct_read_timeline', name, audio: true });
    const best = compared.map((c) => ({ c, score: compare.planMatch(tl, c.plan.data) })).sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < 0.5) { notes.push(`Snapshot ${name}: no reviewed rough cut with the same plan`); continue; }
    if (pairs.some((p) => p.c === best.c)) { notes.push(`Snapshot ${name}: a second snapshot of ${best.c.name}, skipped`); continue; }
    pairs.push({ snap: name, tl, c: best.c });
  }
  if (!pairs.length) throw new Error('No snapshot pairs with a reviewed rough cut');
  for (const c of compared) if (!pairs.some((p) => p.c === c)) notes.push(`${c.name}: no snapshot, not scored`);
  if (ctx.isCanceled()) return null;

  // 3. render each snapshot's audio (what the project played before review)
  const tmp = path.join(ctx.tmpRoot || os.tmpdir(), 'editpanel-ct-score', label.replace(/[^\w.-]+/g, '_'));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  phase('Queueing the audio renders');
  const q = await ask({ cmd: 'ct_render_audio', action: 'queue', names: pairs.map((p) => p.snap), target_dir: tmp });
  const jobs = q.jobs || [];
  ctx.markOwned(jobs);
  for (const x of q.failed || []) notes.push(`Render: ${x}`);
  if (!jobs.length) throw new Error(`No audio render could be queued${(q.failed || []).length ? `: ${q.failed[0]}` : ''}`);
  log(`Rendering ${jobs.length} timeline(s) as ${q.format}${q.codec ? ` / ${q.codec}` : ''}`);
  const ids = jobs.map((j) => j.job_id);
  let outputs = {};
  try {
    await ask({ cmd: 'start_render', job_ids: ids });
    for (;;) {
      if (ctx.isCanceled()) { await ask({ cmd: 'stop_render' }).catch(() => {}); return null; }
      const st = await ask({ cmd: 'render_status', job_ids: ids });
      const list = st.jobs || [];
      const pct = list.length ? Math.round(list.reduce((n, j) => n + (j.terminal ? 100 : j.percent || 0), 0) / list.length) : 0;
      phase(`Rendering audio (${list.filter((j) => j.terminal).length}/${list.length})`, pct);
      if (st.all_terminal) {
        for (const j of list) {
          const job = jobs.find((x) => x.job_id === j.job_id);
          if (j.status !== 'Complete') { notes.push(`Render of ${job.name}: ${j.status}`); continue; }
          let file = j.output_filename ? path.join(j.target_dir || tmp, j.output_filename) : null;
          if (!file || !fs.existsSync(file)) {
            const hit = fs.readdirSync(tmp).find((x) => x.startsWith(job.name));
            file = hit ? path.join(tmp, hit) : null;
          }
          if (file) outputs[job.name] = file;
          else notes.push(`Render of ${job.name}: file not found`);
        }
        break;
      }
      await sleep(ctx.pollMs || 2000);
    }
  } finally {
    await ask({ cmd: 'ct_render_audio', action: 'delete', job_ids: ids }).catch(() => {});
  }
  const ready = pairs.filter((p) => outputs[p.snap]);
  if (!ready.length) throw new Error('No audio render finished');

  // 4. the join check on the renders (the pack's Python, GPU)
  phase('Checking every join on the rendered audio');
  const joinOut = path.join(f.dir, `join_${label}.json`);
  const jobFile = path.join(f.dir, `score_job_${label}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ words: f.words, out: joinOut,
    timelines: ready.map((p) => ({ name: p.snap, audio: outputs[p.snap], fps: p.tl.fps, start_frame: p.tl.start_frame,
      pieces: picturePieces(p.tl, p.c.plan.data.multicam) })) }, null, 1), 'utf8');
  try { fs.unlinkSync(joinOut); } catch (_) { /* first run */ }
  const run = await ctx.runPython([ctx.joinScript, jobFile]);
  if (ctx.isCanceled()) return null;
  const join = readJson(joinOut);
  if (!join) throw new Error(run.error || `join_check.py ended (${run.code}) without writing its file`);
  const joinBy = Object.fromEntries((join.timelines || []).map((t) => [t.name, t]));
  for (const t of join.timelines || []) if (t.error) notes.push(`Join check ${t.name}: ${t.error}`);
  fs.rmSync(tmp, { recursive: true, force: true });

  // 5. the read-through (Haiku), a few at a time
  let client = ctx.client;
  if (!client) {
    if (!ctx.apiKey) throw new Error('No Claude API key (Cut-through settings)');
    client = claude.makeClient(ctx.apiKey);
  }
  let doneRead = 0;
  let readCost = 0;
  const reads = await pool(ready, READ_CONCURRENCY, async (p) => {
    const tokens = keptTokens(p.tl, words, p.c.plan.data.multicam);
    const t0 = Date.now();
    try {
      const r = await readThrough({ client, tokens });
      if (r.usage) {
        claude.logCost({ costsDir: ctx.costsDir, outDir: f.dir, label: `${label}__score`, step: 'score_read', model: r.model,
          effort: 'medium', usage: r.usage, seconds: (Date.now() - t0) / 1000 });
        readCost += claude.costOf(r.model, r.usage);
      }
      return r.flags;
    } catch (err) {
      notes.push(`Read-through ${p.snap}: ${err.message}`);
      return [];
    } finally {
      doneRead += 1;
      phase(`Read-through (${doneRead}/${ready.length})`, Math.round((doneRead / ready.length) * 100));
    }
  });
  if (ctx.isCanceled()) return null;

  // 6. the score
  phase('Scoring');
  const rows = ready.map((p, i) => {
    const jt = joinBy[p.snap] || { flags: [] };
    const joinFlags = (jt.flags || []).map((x) => ({ source: 'join', kind: x.kind, why: x.why, at: x.src, rec: x.rec }));
    const row = scoreTimeline({ result: p.c.result, joinFlags, readFlagList: reads[i] || [] });
    row.snapshot = p.snap;
    row.joins = (jt.joins || []).length;
    row.readFlags = reads[i] || [];
    row.joinFlags = joinFlags.map((x) => ({ ...x, tc: tcPlus(p.tl.start_tc, x.rec, p.tl.fps) }));
    return row;
  });
  const sum = totals(rows);
  sum.readCost = Math.round(readCost * 1000) / 1000;
  const out = { label, madeAt: Date.now(), model: READ_MODEL, reach: REACH, totals: sum, notes, timelines: rows };
  fs.writeFileSync(path.join(f.dir, `score_${label}.json`), JSON.stringify(out, null, 1), 'utf8');
  const html = path.join(f.dir, `score_${label}.html`);
  fs.writeFileSync(html, reportHtml({ label, rows, sum, notes }), 'utf8');
  fs.writeFileSync(path.join(f.dir, `score_${label}_changes.csv`), '\uFEFF' + changesCsv(rows), 'utf8');
  const report = reportLines(sum, [`Read-through cost $${sum.readCost.toFixed(3)}`, ...notes]);
  return { report, reportFile: html, data: {
    timelines: sum.timelines, changes: sum.changes,
    check: sum.tools.check, join: sum.tools.join, read: sum.tools.read, readCost: sum.readCost } };
}

module.exports = { runScore, keptTokens, readLines, locateQuote, readFlags, scoreTimeline, totals, reportLines, reportHtml,
  changesCsv, parseCsv, rescore, autoGroup, LABELS,
  SNAPSHOT_BIN, READ_MODEL, READ_SCHEMA };
