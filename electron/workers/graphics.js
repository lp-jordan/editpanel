'use strict';
/**
 * Graphics: Remotion overlay templates, designed by chat, rendered in batches.
 *
 * Templates and brand kits live in a library folder (default: userData/graphics).
 * Rendering uses the prebuilt engine in vendor/graphics (scripts/build-graphics.mjs);
 * packaged builds carry it in resources/graphics, outside app.asar.
 *
 * Brand files and slide images reach the Remotion page through a small local server,
 * because the page cannot read file:// URLs.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const claude = require('./cut_through_claude');
const GUIDE = require('../graphics/guide');
const STARTERS = require('../graphics/starters');

const MODELS = {
  default: { id: 'claude-haiku-5-5', effort: 'low' },
  harder: { id: 'claude-opus-5-5', effort: 'medium' }
};
// $ per million tokens. Haiku's cache rates assume the usual 0.1x read, 1.25x write.
const PRICES = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
};
const TOOL = {
  name: 'update_template',
  description: 'Apply a change to the template.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      edits: {
        type: 'array',
        items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] }
      },
      code: { type: 'string' },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
            type: { type: 'string', enum: ['text', 'textarea', 'list', 'image'] },
            default: {}
          },
          required: ['key', 'label', 'type']
        }
      }
    },
    required: ['summary']
  }
};

const FPS_DEFAULT = 24000 / 1001;
const CONTENT_TYPES = {
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp'
};
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const FONT_EXT = ['otf', 'ttf', 'woff', 'woff2'];

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
const newId = (name) => `${slug(name)}-${crypto.randomBytes(3).toString('hex')}`;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const fileSafe = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'overlay';
const errText = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 500);

function fontInfo(file) {
  const stem = path.basename(file, path.extname(file));
  const [family, style = ''] = stem.split(/[-_]/);
  const s = stem.toLowerCase();
  let weight = 400;
  if (/black|heavy/.test(s)) weight = 900;
  else if (/extrabold/.test(s)) weight = 800;
  else if (/semibold|demibold/.test(s)) weight = 600;
  else if (/bold/.test(s)) weight = 700;
  else if (/medium/.test(s)) weight = 500;
  else if (/extralight/.test(s)) weight = 200;
  else if (/light/.test(s)) weight = 300;
  else if (/thin/.test(s)) weight = 100;
  return { family: family || stem, weight, style };
}

function createGraphics({ broadcast, getPrefs, setPrefs, isPackaged, appDir, userData, dialog }) {
  const token = crypto.randomBytes(12).toString('hex');
  const allowedRoots = new Set();
  let serverPort = null;
  let serverReady = null;
  let job = null;
  let editStatus = null; // { stage, request, model, startedAt } while Claude is working
  let cancelFn = null;
  let activeSetId = null;

  const prefs = () => (getPrefs() || {}).graphics || {};
  const savePrefs = (patch) => setPrefs({ graphics: { ...prefs(), ...patch } });
  const libraryDir = () => prefs().libraryDir || path.join(userData, 'graphics');
  const dirs = () => {
    const base = libraryDir();
    return { base, templates: path.join(base, 'templates'), brands: path.join(base, 'brands'), sets: path.join(base, 'sets'), work: path.join(base, 'work') };
  };
  const apiKey = () => prefs().anthropicKey || process.env.ANTHROPIC_API_KEY || null;

  function engine() {
    const base = isPackaged ? path.join(process.resourcesPath, 'graphics') : path.join(appDir, 'vendor', 'graphics');
    const browser = path.join(base, 'browser', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
    const out = { host: path.join(base, 'host'), kit: path.join(base, 'kit.js'), browser, compositor: path.join(base, 'compositor') };
    out.ready = [out.host, out.kit, out.browser, out.compositor].every((p) => fs.existsSync(p));
    return out;
  }

  // ── Local asset server ────────────────────────────────────────────────────

  function startServer() {
    if (serverReady) return serverReady;
    serverReady = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const parts = String(req.url || '').split('?')[0].split('/');
        if (parts[1] !== token || !parts[2]) { res.statusCode = 404; res.end(); return; }
        let file;
        try { file = path.resolve(Buffer.from(parts[2], 'base64url').toString('utf8')); } catch (_) { res.statusCode = 400; res.end(); return; }
        const inside = [...allowedRoots].some((r) => file === r || file.startsWith(r + path.sep));
        if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
        const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
        if (type) res.setHeader('Content-Type', type);
        fs.createReadStream(file).pipe(res);
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { serverPort = server.address().port; resolve(); });
    });
    return serverReady;
  }

  function assetUrl(file) {
    const abs = path.resolve(file);
    const encoded = Buffer.from(abs, 'utf8').toString('base64url');
    return `http://127.0.0.1:${serverPort}/${token}/${encoded}/${encodeURIComponent(path.basename(abs))}`;
  }

  // ── Library ───────────────────────────────────────────────────────────────

  function seed() {
    const d = dirs();
    fs.mkdirSync(d.templates, { recursive: true });
    fs.mkdirSync(d.brands, { recursive: true });
    fs.mkdirSync(d.work, { recursive: true });
    fs.mkdirSync(d.sets, { recursive: true });
    allowedRoots.add(path.resolve(d.base));
    for (const s of STARTERS) {
      const f = path.join(d.templates, `${s.id}.json`);
      if (!fs.existsSync(f)) writeJson(f, { ...s, chat: [], history: [], costUsd: 0 });
    }
    if (!listBrands().length) {
      const id = 'leaderpass';
      const dest = path.join(d.brands, id);
      fs.mkdirSync(path.join(dest, 'fonts'), { recursive: true });
      const fonts = [];
      for (const name of ['Metropolis-Regular.otf', 'Metropolis-Bold.otf']) {
        const from = path.join(appDir, 'electron', 'renderer', 'fonts', name);
        if (!fs.existsSync(from)) continue;
        fs.copyFileSync(from, path.join(dest, 'fonts', name));
        fonts.push({ file: `fonts/${name}`, ...fontInfo(name) });
      }
      writeJson(path.join(dest, 'brand.json'), { id, name: 'LeaderPass', colors: ['#dbaf5f', '#5b9bd5', '#f4eee2'], fonts, logos: [] });
    }
  }

  const templatePath = (id) => path.join(dirs().templates, `${path.basename(String(id))}.json`);
  const loadTemplate = (id) => {
    const t = readJson(templatePath(id));
    if (!t) throw new Error('Template not found');
    return t;
  };
  const saveTemplate = (t) => writeJson(templatePath(t.id), t);

  function listTemplates() {
    const d = dirs().templates;
    let names = [];
    try { names = fs.readdirSync(d).filter((f) => f.endsWith('.json')); } catch (_) { /* first run */ }
    return names.map((f) => readJson(path.join(d, f))).filter(Boolean)
      .map((t) => ({ ...t, history: undefined, canUndo: Boolean(t.history && t.history.length) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function listBrands() {
    const d = dirs().brands;
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (_) { /* first run */ }
    return names.map((n) => readJson(path.join(d, n, 'brand.json'))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** What a template receives as `brand`. */
  function runtimeBrand(b) {
    const dir = path.join(dirs().brands, b.id);
    const fonts = b.fonts || [];
    const heading = fonts.find((f) => f.weight >= 600) || fonts[0];
    const body = fonts.find((f) => f.weight < 600) || fonts[0];
    const logos = {};
    for (const l of b.logos || []) logos[l.name] = assetUrl(path.join(dir, l.file));
    return {
      name: b.name,
      colors: b.colors || [],
      accent: (b.colors || [])[0] || '#ffffff',
      headingFont: heading ? heading.family : null,
      bodyFont: body ? body.family : null,
      fontFaces: fonts.map((f) => ({ family: f.family, weight: f.weight, url: assetUrl(path.join(dir, f.file)) })),
      logos
    };
  }

  function brandForRender(brandId, accent) {
    const b = listBrands().find((x) => x.id === brandId) || listBrands()[0];
    if (!b) throw new Error('Add a brand first');
    const r = runtimeBrand(b);
    return accent ? { ...r, accent } : r;
  }

  function snapshot() {
    const e = engine();
    const key = prefs().anthropicKey;
    return {
      settings: {
        libraryDir: libraryDir(),
        claudeKey: apiKey() ? (key ? `saved …${key.slice(-4)}` : 'from ANTHROPIC_API_KEY') : null
      },
      engineReady: e.ready,
      templates: listTemplates(),
      brands: listBrands().map((b) => ({ ...b, runtime: runtimeBrand(b) })),
      job,
      busyEdit: Boolean(editStatus),
      editStatus,
      sets: listSets(),
      activeSet: activeSetView()
    };
  }

  const emit = () => broadcast('graphics:update', snapshot());

  // ── Rendering ─────────────────────────────────────────────────────────────

  function renderBase() {
    const e = engine();
    if (!e.ready) throw new Error('The Graphics engine is missing. Run npm install on this machine.');
    return { serveUrl: e.host, binariesDirectory: e.compositor, browserExecutable: e.browser, logLevel: 'error' };
  }

  async function still({ code, fields, brand, fps, durationInFrames, frame, output }) {
    const { selectComposition, renderStill } = require('@remotion/renderer');
    const base = renderBase();
    const inputProps = { code, fields, brand, fps, durationInFrames };
    const composition = await selectComposition({ ...base, id: 'Host', inputProps });
    await renderStill({ ...base, composition, inputProps, frame, output, imageFormat: 'png' });
  }

  function batchTiming(a) {
    const fps = Number(a.fps) > 0 ? Number(a.fps) : FPS_DEFAULT;
    const seconds = Math.max(0.5, Math.min(600, Number(a.durationSec) || 15));
    return { fps, durationInFrames: Math.max(1, Math.round(seconds * fps)) };
  }

  function needIdle() {
    if (job && job.status === 'running') throw new Error('A batch is still running');
  }

  // ── Review sets ───────────────────────────────────────────────────────────
  // One foundation template, one row per overlay. A row inherits the foundation until it gets its
  // own override. Stored values use asset: paths, because server URLs last only for this session.

  const ASSET = 'asset:';
  const setPath = (id) => path.join(dirs().sets, `${path.basename(String(id))}.json`);
  const hashOf = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
  const foundationHash = (t) => hashOf({ code: t.code, fields: t.fields });
  const REVIEW = 'review';
  const APPROVED = 'approved';

  function dehydrate(value) {
    if (Array.isArray(value)) return value.map(dehydrate);
    const prefix = `http://127.0.0.1:${serverPort}/${token}/`;
    if (typeof value !== 'string' || !value.startsWith(prefix)) return value;
    const encoded = value.slice(prefix.length).split('/')[0];
    return ASSET + Buffer.from(encoded, 'base64url').toString('utf8');
  }

  function hydrate(value) {
    if (Array.isArray(value)) return value.map(hydrate);
    if (typeof value !== 'string' || !value.startsWith(ASSET)) return value;
    const file = value.slice(ASSET.length);
    allowedRoots.add(path.resolve(path.dirname(file)));
    return assetUrl(file);
  }

  const mapValues = (obj, fn) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, fn(v)]));

  function loadSet(id) {
    const set = readJson(setPath(id));
    if (!set) throw new Error('Review set not found');
    return set;
  }

  const saveSet = (set) => writeJson(setPath(set.id), set);

  /** A changed foundation restyles inheriting rows; overridden rows get flagged instead. */
  function reconcile(set) {
    const t = readJson(templatePath(set.templateId));
    if (!t) return set;
    const hash = foundationHash(t);
    if (set.foundationHash === hash) return set;
    const rows = set.rows.map((r) => (r.override
      ? { ...r, foundationChanged: true }
      : { ...r, status: REVIEW }));
    const next = { ...set, rows, foundationHash: hash };
    saveSet(next);
    return next;
  }

  function effective(set, row, t) {
    return { code: (row.override && row.override.code) || t.code, fields: (row.override && row.override.fields) || t.fields };
  }

  function rowHash(set, row, t, brandRaw) {
    return hashOf({ ...effective(set, row, t), values: row.values, brand: brandRaw, accent: set.accent, fps: set.fps, durationSec: set.durationSec });
  }

  function listSets() {
    const d = dirs().sets;
    let names = [];
    try { names = fs.readdirSync(d).filter((f) => f.endsWith('.json')); } catch (_) { /* first run */ }
    return names.map((f) => readJson(path.join(d, f))).filter(Boolean)
      .map((x) => ({ id: x.id, name: x.name, kind: x.kind, total: x.rows.length, approved: x.rows.filter((r) => r.status === APPROVED).length }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function activeSetView() {
    if (!activeSetId || !fs.existsSync(setPath(activeSetId))) return null;
    const set = reconcile(loadSet(activeSetId));
    const t = readJson(templatePath(set.templateId));
    if (!t) return { id: set.id, name: set.name, missingTemplate: true, rows: [] };
    const brandRaw = listBrands().find((b) => b.id === set.brandId) || listBrands()[0];
    const brand = { ...runtimeBrand(brandRaw), accent: set.accent || runtimeBrand(brandRaw).accent };
    const toImport = [];
    const rows = set.rows.map((r) => {
      const hash = rowHash(set, r, t, brandRaw);
      const hasFile = Boolean(r.rendered && r.rendered.file && fs.existsSync(r.rendered.file));
      const renderState = !hasFile ? 'none' : (r.rendered.hash === hash ? 'current' : 'stale');
      if (hasFile && r.status === APPROVED && !r.imported) toImport.push(r.rendered.file);
      return {
        id: r.id, name: r.name, status: r.status, renderState,
        values: mapValues(r.values, hydrate),
        code: r.override ? r.override.code : null,
        fieldDefs: effective(set, r, t).fields,
        hasOverride: Boolean(r.override),
        foundationChanged: Boolean(r.foundationChanged),
        canUndo: Boolean(r.history && r.history.length),
        chat: r.chat || []
      };
    });
    return {
      id: set.id, name: set.name, kind: set.kind, templateId: set.templateId, templateName: t.name,
      foundationCode: t.code, foundationChat: t.chat || [], foundationCanUndo: Boolean(t.history && t.history.length),
      brandId: brandRaw.id, accent: brand.accent, brand, fps: set.fps, durationSec: set.durationSec,
      outDir: set.outDir || '', binPath: set.binPath || 'GRAPHICS', rows, toImport
    };
  }

  function createSet(a) {
    const name = String(a.name || '').trim();
    if (!name) throw new Error('Enter a name');
    const t = loadTemplate(a.templateId);
    const inputRows = a.rows || [];
    if (!inputRows.length) throw new Error('Add at least one overlay');
    const id = newId(name);
    const { fps } = batchTiming(a);
    saveSet({
      id, name, kind: t.kind, templateId: t.id, brandId: a.brandId, accent: a.accent || null,
      fps, durationSec: Math.max(0.5, Number(a.durationSec) || 15), outDir: '', binPath: `GRAPHICS / ${fileSafe(name)}`,
      foundationHash: foundationHash(t), nextRow: inputRows.length + 1,
      rows: inputRows.map((r, i) => ({ id: `r${i + 1}`, name: r.name, values: mapValues(r.fields, dehydrate), status: REVIEW, override: null, history: [], chat: [] }))
    });
    activeSetId = id;
    emit();
    return snapshot();
  }

  function openSet({ setId }) {
    loadSet(setId);
    activeSetId = setId;
    emit();
    return snapshot();
  }

  function deleteSet({ setId }) {
    fs.rmSync(setPath(setId), { force: true });
    if (activeSetId === setId) activeSetId = null;
    emit();
    return snapshot();
  }

  /** Change a set's settings. Anything affecting the look sends approved rows back to review. */
  function updateSet(a) {
    const set = reconcile(loadSet(a.setId));
    const restyled = (a.brandId !== undefined && a.brandId !== set.brandId) || (a.accent !== undefined && a.accent !== set.accent);
    const next = { ...set };
    for (const k of ['name', 'brandId', 'accent', 'outDir', 'binPath']) if (a[k] !== undefined) next[k] = a[k];
    if (a.fps !== undefined || a.durationSec !== undefined) {
      next.fps = batchTiming({ fps: a.fps !== undefined ? a.fps : set.fps }).fps;
      if (a.durationSec !== undefined) next.durationSec = Math.max(0.5, Math.min(600, Number(a.durationSec) || 15));
    }
    if (restyled) next.rows = next.rows.map((r) => ({ ...r, status: REVIEW }));
    saveSet(next);
    emit();
    return snapshot();
  }

  function changeRow(setId, rowId, fn) {
    const set = reconcile(loadSet(setId));
    const rows = set.rows.map((r) => (r.id === rowId ? fn(r) : r));
    saveSet({ ...set, rows });
    emit();
    return snapshot();
  }

  function updateRow({ setId, rowId, values }) {
    return changeRow(setId, rowId, (r) => {
      const next = mapValues(values, dehydrate);
      if (hashOf(next) === hashOf(r.values)) return r;
      return { ...r, values: next, status: REVIEW };
    });
  }

  function setRowStatus({ setId, rowId, approved }) {
    return changeRow(setId, rowId, (r) => ({ ...r, status: approved ? APPROVED : REVIEW, foundationChanged: approved ? false : r.foundationChanged }));
  }

  function resetRow({ setId, rowId }) {
    return changeRow(setId, rowId, (r) => ({
      ...r, override: null, status: REVIEW, foundationChanged: false,
      history: [...(r.history || []), { override: r.override }].slice(-30),
      chat: [...(r.chat || []), { who: 'ai', text: 'Reset to the foundation.' }].slice(-30)
    }));
  }

  function keepRow({ setId, rowId }) {
    return changeRow(setId, rowId, (r) => ({ ...r, foundationChanged: false }));
  }

  function undoRow({ setId, rowId }) {
    return changeRow(setId, rowId, (r) => {
      const history = [...(r.history || [])];
      const last = history.pop();
      if (!last) return r;
      return { ...r, override: last.override, history, status: REVIEW, chat: [...(r.chat || []), { who: 'ai', text: 'Undone.' }].slice(-30) };
    });
  }

  function removeRow({ setId, rowId }) {
    const set = loadSet(setId);
    saveSet({ ...set, rows: set.rows.filter((r) => r.id !== rowId) });
    emit();
    return snapshot();
  }

  function addRows({ setId, rows: inputRows }) {
    const set = reconcile(loadSet(setId));
    let n = set.nextRow || set.rows.length + 1;
    const added = (inputRows || []).map((r) => {
      const row = { id: `r${n}`, name: r.name, values: mapValues(r.fields, dehydrate), status: REVIEW, override: null, history: [], chat: [] };
      n += 1;
      return row;
    });
    saveSet({ ...set, nextRow: n, rows: [...set.rows, ...added] });
    emit();
    return snapshot();
  }

  async function editSlide(a) {
    if (editStatus) throw new Error('Still working on the last change');
    const set = reconcile(loadSet(a.setId));
    const row = set.rows.find((r) => r.id === a.rowId);
    if (!row) throw new Error('Overlay not found');
    const t = loadTemplate(set.templateId);
    const brand = brandForRender(set.brandId, set.accent);
    const base = { id: `${set.id}/${row.id}`, kind: t.kind, ...effective(set, row, t), chat: row.chat };
    const request = String(a.request || '').trim();
    const chat = [...(row.chat || []), { who: 'me', text: request }];
    const out = await askForChange({
      base, target: row.id, brand, values: mapValues(row.values, hydrate), request, harder: a.harder,
      fps: set.fps, durationSec: set.durationSec, note: 'This change is for this one overlay only.'
    });
    return changeRow(a.setId, a.rowId, (r) => {
      const reply = [...chat, { ...out.reply, usd: out.spent, model: out.model }].slice(-30);
      if (!out.change) return { ...r, chat: reply, costUsd: (r.costUsd || 0) + out.spent };
      return {
        ...r, chat: reply, costUsd: (r.costUsd || 0) + out.spent, status: REVIEW, foundationChanged: false,
        override: out.change, history: [...(r.history || []), { override: r.override }].slice(-30)
      };
    });
  }

  async function renderSet(a) {
    needIdle();
    const { renderMedia, selectComposition, makeCancelSignal } = require('@remotion/renderer');
    const base = renderBase();
    const set = reconcile(loadSet(a.setId));
    if (!set.outDir) throw new Error('Choose an output folder');
    const t = loadTemplate(set.templateId);
    const brandRaw = listBrands().find((b) => b.id === set.brandId) || listBrands()[0];
    const brand = brandForRender(set.brandId, set.accent);
    const fps = set.fps;
    const durationInFrames = Math.max(1, Math.round(set.durationSec * fps));
    fs.mkdirSync(set.outDir, { recursive: true });
    const work = [];
    let skipped = 0;
    set.rows.forEach((r, i) => {
      if (r.status !== APPROVED) return;
      const hash = rowHash(set, r, t, brandRaw);
      const same = r.rendered && r.rendered.file && path.dirname(r.rendered.file) === path.resolve(set.outDir) && fs.existsSync(r.rendered.file);
      if (same && r.rendered.hash === hash) { skipped += 1; return; }
      const file = same ? r.rendered.file : path.resolve(set.outDir, `${String(i + 1).padStart(3, '0')}_${fileSafe(r.name)}.mov`);
      work.push({ row: r, hash, file, sameFile: Boolean(same) });
    });
    job = { kind: 'render', setId: set.id, status: 'running', done: 0, total: work.length, skipped, outputs: [], failures: [], current: 0 };
    emit();
    let stop = false;
    let cancelNow = null;
    cancelFn = () => { stop = true; if (cancelNow) cancelNow(); };
    for (let i = 0; i < work.length && !stop; i += 1) {
      const w = work[i];
      const inputProps = { code: effective(set, w.row, t).code, fields: mapValues(w.row.values, hydrate), brand, fps, durationInFrames };
      const signal = makeCancelSignal();
      cancelNow = signal.cancel;
      try {
        const composition = await selectComposition({ ...base, id: 'Host', inputProps });
        await renderMedia({
          ...base, composition, inputProps, outputLocation: w.file, overwrite: true, cancelSignal: signal.cancelSignal,
          codec: 'prores', proResProfile: '4444', imageFormat: 'png', pixelFormat: 'yuva444p10le',
          onProgress: ({ progress }) => {
            const pct = Math.round(progress * 100);
            if (pct !== job.current) { job = { ...job, current: pct }; emit(); }
          }
        });
        const latest = loadSet(set.id);
        saveSet({ ...latest, rows: latest.rows.map((r) => (r.id === w.row.id ? { ...r, rendered: { hash: w.hash, file: w.file }, imported: w.sameFile ? r.imported : false } : r)) });
        job = { ...job, done: i + 1, current: 0, outputs: [...job.outputs, w.file] };
      } catch (err) {
        if (stop) break;
        job = { ...job, done: i + 1, current: 0, failures: [...job.failures, { name: w.row.name, error: errText(err) }] };
      }
      emit();
    }
    job = { ...job, status: stop ? 'canceled' : 'done' };
    cancelFn = null;
    cancelNow = null;
    emit();
    return snapshot();
  }

  function markImported({ setId, files }) {
    const done = new Set(files || []);
    const set = loadSet(setId);
    saveSet({ ...set, rows: set.rows.map((r) => (r.rendered && done.has(r.rendered.file) ? { ...r, imported: true } : r)) });
    emit();
    return snapshot();
  }

  function cancel() {
    if (cancelFn) cancelFn();
    return snapshot();
  }

  // ── Claude editing ────────────────────────────────────────────────────────

  function costOf(model, u) {
    const p = PRICES[model];
    return ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output
      + (u.cache_read_input_tokens || 0) * p.cacheRead + (u.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
  }

  function logCost(templateId, model, u, usd) {
    const f = path.join(dirs().base, 'costs.csv');
    if (!fs.existsSync(f)) fs.writeFileSync(f, 'when,template,model,input,output,cache_read,cache_write,usd\n');
    fs.appendFileSync(f, `${new Date().toISOString()},${templateId},${model},${u.input_tokens || 0},${u.output_tokens || 0},${u.cache_read_input_tokens || 0},${u.cache_creation_input_tokens || 0},${usd.toFixed(5)}\n`);
  }

  function requestText(t, brand, values, request, failure) {
    const recent = (t.chat || []).filter((m) => m.who === 'me').slice(-4).map((m) => `- ${m.text}`).join('\n');
    const brandLine = `accent ${brand.accent}; colors ${brand.colors.join(', ')}; heading font ${brand.headingFont}; body font ${brand.bodyFont}; logos ${Object.keys(brand.logos).join(', ') || 'none'}`;
    return [
      `Kind: ${t.kind}`,
      `Brand: ${brandLine}`,
      `Fields: ${JSON.stringify(t.fields)}`,
      `Sample values: ${JSON.stringify(values).slice(0, 1500)}`,
      `Current template:\n${t.code}`,
      recent ? `Earlier requests:\n${recent}` : '',
      `Request: ${request}`,
      failure ? `Your previous attempt failed with: ${failure}\nFix that and apply the request to the current template above.` : ''
    ].filter(Boolean).join('\n\n');
  }

  async function callClaude(model, text) {
    const key = apiKey();
    if (!key) throw new Error('Add a Claude API key in Settings below');
    const client = claude.makeClient(key);
    const params = {
      model: model.id,
      max_tokens: 12000,
      output_config: { effort: model.effort },
      system: [{ type: 'text', text: GUIDE, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      tools: [TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: text }]
    };
    if (model.id !== MODELS.harder.id) return client.messages.create(params);
    try {
      return await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (err) {
      if (err && err.status === 400 && /fallback/i.test(err.message || '')) return client.messages.create(params);
      throw err;
    }
  }

  function applyChange(t, input) {
    let code = t.code;
    if (typeof input.code === 'string' && input.code.trim()) {
      code = input.code;
    } else {
      for (const e of input.edits || []) {
        const count = code.split(e.find).length - 1;
        if (count !== 1) throw new Error(`An edit's find text matched ${count} places: ${String(e.find).slice(0, 80)}`);
        code = code.replace(e.find, () => e.replace);
      }
    }
    const fields = Array.isArray(input.fields) && input.fields.length ? input.fields : t.fields;
    return { code, fields };
  }

  function valuesFor(fields, values) {
    const out = {};
    for (const f of fields) {
      out[f.key] = values && values[f.key] !== undefined ? values[f.key] : (f.default !== undefined ? f.default : (f.type === 'list' ? [] : ''));
    }
    return out;
  }

  /** One request against one piece of template code, tested before it is accepted. */
  async function askForChange({ base, target, brand, values, request, harder, fps, durationSec, note }) {
    if (!request) throw new Error('Describe a change');
    const model = harder ? MODELS.harder : MODELS.default;
    const modelName = harder ? 'Opus' : 'Haiku';
    const startedAt = Date.now();
    const stage = (text) => { editStatus = { stage: text, request, target, model: modelName, startedAt }; emit(); };
    let spent = 0;
    const out = (reply, change = null) => ({ reply, change, spent, model: model.id });
    stage(`${modelName} is working on it`);
    try {
      let failure = null;
      const text = (f) => requestText(base, brand, values || {}, note ? `${request}\n(${note})` : request, f);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt > 1) stage(`Fixing a problem (${modelName})`);
        const msg = await callClaude(model, text(failure));
        const usd = costOf(model.id, msg.usage || {});
        spent += usd;
        logCost(base.id, model.id, msg.usage || {}, usd);
        if (msg.stop_reason === 'refusal') return out({ who: 'ai', error: true, text: 'Claude declined this request.' });
        if (msg.stop_reason === 'max_tokens') { failure = 'The response was cut off. Use small edits.'; continue; }
        const call = msg.content.find((b) => b.type === 'tool_use' && b.name === TOOL.name);
        if (!call) {
          const answer = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
          return out({ who: 'ai', text: answer || 'No change made.' });
        }
        try {
          const next = applyChange(base, call.input || {});
          stage('Testing the change');
          const timing = batchTiming({ fps, durationSec });
          await still({
            code: next.code, fields: valuesFor(next.fields, values), brand, fps: timing.fps, durationInFrames: timing.durationInFrames,
            frame: Math.min(timing.durationInFrames - 1, Math.round(timing.fps * 3)), output: path.join(dirs().work, 'check.png')
          });
          return out({ who: 'ai', text: call.input.summary || 'Done.' }, next);
        } catch (err) {
          failure = errText(err);
        }
      }
      return out({ who: 'ai', error: true, text: `Couldn't apply that: ${failure}` });
    } catch (err) {
      return out({ who: 'ai', error: true, text: errText(err) });
    } finally {
      editStatus = null;
    }
  }

  async function editTemplate(a) {
    if (editStatus) throw new Error('Still working on the last change');
    const request = String(a.request || '').trim();
    const t = loadTemplate(a.templateId);
    const brand = brandForRender(a.brandId, a.accent);
    const res = await askForChange({ base: t, target: t.id, brand, values: a.values, request, harder: a.harder, fps: a.fps, durationSec: a.durationSec });
    const latest = loadTemplate(t.id);
    const chat = [...(latest.chat || []), { who: 'me', text: request }, { ...res.reply, usd: res.spent, model: res.model }].slice(-40);
    const history = res.change ? [...(latest.history || []), { code: latest.code, fields: latest.fields }].slice(-30) : latest.history;
    saveTemplate({ ...latest, ...(res.change || {}), history, chat, costUsd: (latest.costUsd || 0) + res.spent });
    emit();
    return snapshot();
  }

  function undo({ templateId }) {
    const t = loadTemplate(templateId);
    const history = [...(t.history || [])];
    const last = history.pop();
    if (!last) return snapshot();
    saveTemplate({ ...t, ...last, history, chat: [...(t.chat || []), { who: 'ai', text: 'Undone.' }].slice(-40) });
    emit();
    return snapshot();
  }

  function createTemplate({ kind, name, fromId }) {
    const base = (fromId && readJson(templatePath(fromId)))
      || STARTERS.find((s) => s.kind === kind);
    if (!base) throw new Error('Unknown graphic type');
    const label = String(name || '').trim() || `${base.name} copy`;
    const t = { id: newId(label), name: label, kind: base.kind, code: base.code, fields: base.fields, chat: [], history: [], costUsd: 0 };
    saveTemplate(t);
    emit();
    return { ...snapshot(), createdId: t.id };
  }

  function renameTemplate({ templateId, name }) {
    const label = String(name || '').trim();
    if (!label) throw new Error('Enter a name');
    saveTemplate({ ...loadTemplate(templateId), name: label });
    emit();
    return snapshot();
  }

  function deleteTemplate({ templateId }) {
    if (STARTERS.some((s) => s.id === templateId)) throw new Error('Starter templates stay in the library');
    fs.rmSync(templatePath(templateId), { force: true });
    emit();
    return snapshot();
  }

  // ── Brands ────────────────────────────────────────────────────────────────

  const brandFile = (id) => path.join(dirs().brands, path.basename(String(id)), 'brand.json');

  function createBrand({ name }) {
    const label = String(name || '').trim();
    if (!label) throw new Error('Enter a brand name');
    const id = newId(label);
    writeJson(brandFile(id), { id, name: label, colors: ['#ffffff'], fonts: [], logos: [] });
    emit();
    return { ...snapshot(), createdId: id };
  }

  function updateBrand({ brandId, name, colors }) {
    const b = readJson(brandFile(brandId));
    if (!b) throw new Error('Brand not found');
    if (name !== undefined && String(name).trim()) b.name = String(name).trim();
    if (Array.isArray(colors)) b.colors = colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c));
    writeJson(brandFile(brandId), b);
    emit();
    return snapshot();
  }

  async function addBrandFiles({ brandId, type }) {
    const b = readJson(brandFile(brandId));
    if (!b) throw new Error('Brand not found');
    const isFont = type === 'font';
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [isFont ? { name: 'Fonts', extensions: FONT_EXT } : { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }]
    });
    if (res.canceled) return snapshot();
    const sub = isFont ? 'fonts' : 'logos';
    const dest = path.join(path.dirname(brandFile(brandId)), sub);
    fs.mkdirSync(dest, { recursive: true });
    for (const file of res.filePaths) {
      const name = path.basename(file);
      fs.copyFileSync(file, path.join(dest, name));
      const rel = `${sub}/${name}`;
      if (isFont) b.fonts = [...(b.fonts || []).filter((f) => f.file !== rel), { file: rel, ...fontInfo(name) }];
      else b.logos = [...(b.logos || []).filter((l) => l.file !== rel), { file: rel, name: path.basename(name, path.extname(name)) }];
    }
    writeJson(brandFile(brandId), b);
    emit();
    return snapshot();
  }

  // ── Files and settings ────────────────────────────────────────────────────

  function naturalImages(dir) {
    const collator = new Intl.Collator(undefined, { numeric: true });
    return fs.readdirSync(dir).filter((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase()) && !f.startsWith('.')).sort(collator.compare);
  }

  async function pickSlides() {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (res.canceled) return null;
    const dir = res.filePaths[0];
    allowedRoots.add(path.resolve(dir));
    return { folder: dir, images: naturalImages(dir).map((f) => ({ name: path.basename(f, path.extname(f)), url: assetUrl(path.join(dir, f)) })) };
  }

  async function pickImage() {
    const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (res.canceled) return null;
    const file = res.filePaths[0];
    allowedRoots.add(path.resolve(path.dirname(file)));
    return { url: assetUrl(file), name: path.basename(file) };
  }

  async function pickFolder() {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  }

  function updateSettings({ anthropicKey, libraryDir: nextDir }) {
    const patch = {};
    if (anthropicKey !== undefined) patch.anthropicKey = String(anthropicKey).trim();
    if (nextDir !== undefined) patch.libraryDir = String(nextDir).trim();
    savePrefs(patch);
    seed();
    emit();
    return snapshot();
  }

  function previewDoc() {
    const e = engine();
    if (!e.ready) throw new Error('The Graphics engine is missing. Run npm install on this machine.');
    const kit = fs.readFileSync(e.kit, 'utf8').replace(/<\/script/gi, '<\\/script');
    const css = 'html,body,#root{margin:0;height:100%;overflow:hidden}'
      + 'body{background-color:#2a2926;background-image:linear-gradient(45deg,#34322e 25%,transparent 25%,transparent 75%,#34322e 75%),linear-gradient(45deg,#34322e 25%,transparent 25%,transparent 75%,#34322e 75%);background-size:32px 32px;background-position:0 0,16px 16px}';
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${kit}</script></body></html>`;
  }

  async function start() {
    await startServer();
    seed();
  }

  const api = {
    state: async () => { await start(); return snapshot(); },
    previewDoc: async () => { await start(); return previewDoc(); },
    editTemplate, undo, createTemplate, renameTemplate, deleteTemplate,
    createBrand, updateBrand, addBrandFiles,
    pickSlides, pickImage, pickFolder, updateSettings,
    createSet, openSet, deleteSet, updateSet, updateRow, setRowStatus, resetRow, keepRow, undoRow, removeRow, addRows,
    editSlide, renderSet, markImported, cancel
  };

  return {
    /** IPC entry: only the methods above are reachable from the page. */
    async call(method, args) {
      if (!Object.prototype.hasOwnProperty.call(api, method)) throw new Error(`Unknown Graphics call: ${method}`);
      await start();
      return api[method](args || {});
    }
  };
}

module.exports = { createGraphics, MODELS, fontInfo };
