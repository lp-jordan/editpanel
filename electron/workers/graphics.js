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

  const prefs = () => (getPrefs() || {}).graphics || {};
  const savePrefs = (patch) => setPrefs({ graphics: { ...prefs(), ...patch } });
  const libraryDir = () => prefs().libraryDir || path.join(userData, 'graphics');
  const dirs = () => {
    const base = libraryDir();
    return { base, templates: path.join(base, 'templates'), brands: path.join(base, 'brands'), work: path.join(base, 'work') };
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
      editStatus
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

  async function proof(a) {
    needIdle();
    const t = loadTemplate(a.templateId);
    const brand = brandForRender(a.brandId, a.accent);
    const { fps, durationInFrames } = batchTiming(a);
    const rows = a.rows || [];
    const outDir = path.join(dirs().work, 'proof');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    job = { kind: 'proof', status: 'running', done: 0, total: rows.length, items: [] };
    emit();
    let stop = false;
    cancelFn = () => { stop = true; };
    const frame = Math.min(durationInFrames - 1, Math.round(fps * 3));
    for (let i = 0; i < rows.length && !stop; i += 1) {
      const output = path.join(outDir, `${String(i + 1).padStart(4, '0')}.png`);
      const item = { name: rows[i].name };
      try {
        await still({ code: t.code, fields: rows[i].fields, brand, fps, durationInFrames, frame, output });
        item.url = `${assetUrl(output)}?${Date.now()}`;
      } catch (err) {
        item.error = errText(err);
      }
      job = { ...job, done: i + 1, items: [...job.items, item] };
      emit();
    }
    job = { ...job, status: stop ? 'canceled' : 'done' };
    cancelFn = null;
    emit();
    return snapshot();
  }

  async function render(a) {
    needIdle();
    if (!a.outDir) throw new Error('Choose an output folder');
    const { renderMedia, selectComposition, makeCancelSignal } = require('@remotion/renderer');
    const base = renderBase();
    const t = loadTemplate(a.templateId);
    const brand = brandForRender(a.brandId, a.accent);
    const { fps, durationInFrames } = batchTiming(a);
    const rows = a.rows || [];
    fs.mkdirSync(a.outDir, { recursive: true });
    job = { kind: 'render', status: 'running', done: 0, total: rows.length, outputs: [], failures: [], current: 0 };
    emit();
    let stop = false;
    let cancelNow = null;
    cancelFn = () => { stop = true; if (cancelNow) cancelNow(); };
    for (let i = 0; i < rows.length && !stop; i += 1) {
      const stem = `${String(i + 1).padStart(3, '0')}_${fileSafe(rows[i].name)}`;
      let outputLocation = path.join(a.outDir, `${stem}.mov`);
      for (let n = 2; fs.existsSync(outputLocation); n += 1) outputLocation = path.join(a.outDir, `${stem}_v${n}.mov`);
      const inputProps = { code: t.code, fields: rows[i].fields, brand, fps, durationInFrames };
      const signal = makeCancelSignal();
      cancelNow = signal.cancel;
      try {
        const composition = await selectComposition({ ...base, id: 'Host', inputProps });
        await renderMedia({
          ...base, composition, inputProps, outputLocation, cancelSignal: signal.cancelSignal,
          codec: 'prores', proResProfile: '4444', imageFormat: 'png', pixelFormat: 'yuva444p10le',
          onProgress: ({ progress }) => {
            const pct = Math.round(progress * 100);
            if (pct !== job.current) { job = { ...job, current: pct }; emit(); }
          }
        });
        job = { ...job, done: i + 1, current: 0, outputs: [...job.outputs, outputLocation] };
      } catch (err) {
        if (stop) break;
        job = { ...job, done: i + 1, current: 0, failures: [...job.failures, { name: rows[i].name, error: errText(err) }] };
      }
      emit();
    }
    job = { ...job, status: stop ? 'canceled' : 'done' };
    cancelFn = null;
    cancelNow = null;
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

  async function editTemplate(a) {
    if (editStatus) throw new Error('Still working on the last change');
    const request = String(a.request || '').trim();
    if (!request) throw new Error('Describe a change');
    const t = loadTemplate(a.templateId);
    const model = a.harder ? MODELS.harder : MODELS.default;
    const brand = brandForRender(a.brandId, a.accent);
    const modelName = a.harder ? 'Opus' : 'Haiku';
    const startedAt = Date.now();
    const stage = (text) => { editStatus = { stage: text, request, templateId: t.id, model: modelName, startedAt }; emit(); };
    stage(`${modelName} is working on it`);
    let spent = 0;
    const chat = [...(t.chat || []), { who: 'me', text: request }];
    const finish = (extra, assistant) => {
      const saved = {
        ...t, ...extra,
        chat: [...chat, { ...assistant, usd: spent, model: model.id }].slice(-40),
        costUsd: (t.costUsd || 0) + spent
      };
      saveTemplate(saved);
      editStatus = null;
      emit();
      return snapshot();
    };
    try {
      let failure = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt > 1) stage(`Fixing a problem (${modelName})`);
        const msg = await callClaude(model, requestText(t, brand, a.values || {}, request, failure));
        const usd = costOf(model.id, msg.usage || {});
        spent += usd;
        logCost(t.id, model.id, msg.usage || {}, usd);
        if (msg.stop_reason === 'refusal') return finish({}, { who: 'ai', error: true, text: 'Claude declined this request.' });
        if (msg.stop_reason === 'max_tokens') { failure = 'The response was cut off. Use small edits.'; continue; }
        const call = msg.content.find((b) => b.type === 'tool_use' && b.name === TOOL.name);
        if (!call) {
          const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
          return finish({}, { who: 'ai', text: text || 'No change made.' });
        }
        try {
          const next = applyChange(t, call.input || {});
          stage('Testing the change');
          const { fps, durationInFrames } = batchTiming({ fps: a.fps, durationSec: a.durationSec });
          await still({
            code: next.code, fields: valuesFor(next.fields, a.values), brand, fps, durationInFrames,
            frame: Math.min(durationInFrames - 1, Math.round(fps * 3)), output: path.join(dirs().work, 'check.png')
          });
          const history = [...(readJson(templatePath(t.id)).history || []), { code: t.code, fields: t.fields }].slice(-30);
          return finish({ ...next, history }, { who: 'ai', text: call.input.summary || 'Done.' });
        } catch (err) {
          failure = errText(err);
        }
      }
      return finish({}, { who: 'ai', error: true, text: `Couldn't apply that: ${failure}` });
    } catch (err) {
      return finish({}, { who: 'ai', error: true, text: errText(err) });
    }
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
    proof, render, cancel
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
