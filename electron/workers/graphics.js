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
const os = require('os');
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
      rebuild: { type: 'boolean' },
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

/** Where the OS keeps installed fonts. Collections (.ttc) can't be loaded by a page, so only single files are read. */
function systemFontDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
  }
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(home, 'Library/Fonts')];
  return ['/usr/share/fonts', path.join(home, '.fonts')];
}

/** Where Creative Cloud keeps activated Adobe Fonts: OpenType files named by number, no extension. */
function adobeFontDirs() {
  const home = os.homedir();
  let base = null;
  if (process.platform === 'win32') base = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Adobe', 'CoreSync', 'plugins', 'livetype');
  else if (process.platform === 'darwin') base = path.join(home, 'Library', 'Application Support', 'Adobe', 'CoreSync', 'plugins', 'livetype');
  return base ? [path.join(base, 'r'), path.join(base, '.r')] : [];
}

/** A .ttf/.otf's own name table: { family, weight, width, italic }, or null if it can't be read. */
function readFontFace(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const at = (pos, len) => { const b = Buffer.alloc(len); return fs.readSync(fd, b, 0, len, pos) === len ? b : null; };
    const head = at(0, 12);
    if (!head) return null;
    const tag = head.toString('latin1', 0, 4);
    if (tag !== 'OTTO' && tag !== 'true' && head.readUInt32BE(0) !== 0x00010000) return null;
    const count = head.readUInt16BE(4);
    const dir = at(12, count * 16);
    if (!dir) return null;
    const tables = {};
    for (let i = 0; i < count; i += 1) tables[dir.toString('latin1', i * 16, i * 16 + 4)] = { offset: dir.readUInt32BE(i * 16 + 8), length: dir.readUInt32BE(i * 16 + 12) };
    if (!tables.name || !tables['OS/2']) return null;
    const os2 = at(tables['OS/2'].offset, 64);
    const nt = at(tables.name.offset, tables.name.length);
    if (!os2 || !nt) return null;
    const stringsAt = nt.readUInt16BE(4);
    const nameOf = (id) => {
      let mac = null;
      for (let i = 0; i < nt.readUInt16BE(2); i += 1) {
        const r = 6 + i * 12;
        if (nt.readUInt16BE(r + 6) !== id) continue;
        const start = stringsAt + nt.readUInt16BE(r + 10);
        const raw = nt.subarray(start, start + nt.readUInt16BE(r + 8));
        if (nt.readUInt16BE(r) === 3 && nt.readUInt16BE(r + 4) === 0x409) return Buffer.from(raw).swap16().toString('utf16le');
        if (nt.readUInt16BE(r) === 1) mac = raw.toString('latin1');
      }
      return mac;
    };
    const family = (nameOf(16) || nameOf(1) || '').trim();
    if (!family || family.startsWith('.')) return null;
    return { family, weight: os2.readUInt16BE(4), width: os2.readUInt16BE(6), italic: Boolean(os2.readUInt16BE(62) & 1) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Installed upright fonts as Map(family → Map(weight → { file, width })). A page has one face per family + weight. */
function scanSystemFonts(dirs = systemFontDirs(), { adobe = false } = {}) {
  const families = new Map();
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (adobe ? name.startsWith('.') : !/\.(ttf|otf)$/i.test(name)) continue;
      const file = path.join(dir, name);
      if (adobe) { try { if (!fs.statSync(file).isFile()) continue; } catch { continue; } }
      const face = readFontFace(file);
      if (!face || face.italic) continue;
      if (!families.has(face.family)) families.set(face.family, new Map());
      const faces = families.get(face.family);
      const had = faces.get(face.weight);
      if (!had || (had.width !== 5 && face.width === 5)) faces.set(face.weight, { file, width: face.width, adobe });
    }
  }
  return families;
}

function createGraphics({ broadcast, getPrefs, setPrefs, isPackaged, appDir, userData, dialog, nativeImage }) {
  const token = crypto.randomBytes(12).toString('hex');
  const allowedRoots = new Set();
  let serverPort = null;
  let serverReady = null;
  let job = null;
  let editStatus = null; // { stage, request, model, startedAt } while Claude is working
  let cancelFn = null;
  let currentProject = null;

  const prefs = () => (getPrefs() || {}).graphics || {};
  const savePrefs = (patch) => setPrefs({ graphics: { ...prefs(), ...patch } });
  const libraryDir = () => prefs().libraryDir || path.join(userData, 'graphics');
  const dirs = () => {
    const base = libraryDir();
    return { base, templates: path.join(base, 'templates'), brands: path.join(base, 'brands'), projects: path.join(base, 'projects'), work: path.join(base, 'work') };
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
    fs.mkdirSync(d.projects, { recursive: true });
    allowedRoots.add(path.resolve(d.base));
    for (const dir of adobeFontDirs()) allowedRoots.add(path.resolve(dir));
    for (const s of STARTERS) {
      const f = path.join(d.templates, `${s.id}.json`);
      const had = readJson(f);
      if (!had) writeJson(f, { ...s, chat: [], history: [], costUsd: 0 });
      else if ((had.version || 1) < (s.version || 1)) writeJson(f, { ...had, ...s, history: [] });
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
    const missingFonts = [];
    const fonts = (b.fonts || []).filter((f) => {
      if (!f.adobe || adobeFontFile(f)) return true;
      if (!missingFonts.includes(f.family)) missingFonts.push(f.family);
      return false;
    });
    const roleFonts = (family) => { const own = fonts.filter((f) => f.family === family); return own.length ? own : fonts; };
    const headingFonts = roleFonts(b.headingFamily);
    const bodyFonts = roleFonts(b.bodyFamily);
    const heading = headingFonts.find((f) => f.weight >= 600) || headingFonts[0];
    const body = bodyFonts.find((f) => f.weight < 600) || bodyFonts[0];
    const logos = {};
    for (const l of b.logos || []) logos[l.name] = assetUrl(path.join(dir, l.file));
    return {
      name: b.name,
      colors: b.colors || [],
      accent: (b.colors || [])[0] || '#ffffff',
      headingFont: heading ? heading.family : null,
      bodyFont: body ? body.family : null,
      fontFaces: fonts.map((f) => ({ family: f.family, weight: f.weight, url: assetUrl(f.adobe ? adobeFontFile(f) : path.join(dir, f.file)) })),
      logos,
      missingFonts
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
      workspace: workspaceView()
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

  // ── Project workspace ─────────────────────────────────────────────────────
  // One per Resolve project. Each item keeps its own working copy, plus the saved copy that went
  // to review. Stored values use asset: paths, because server URLs last only for this session.

  const ASSET = 'asset:';
  const hashOf = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
  const mapValues = (obj, fn) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, fn(v)]));

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

  function wsPath() {
    const name = currentProject || 'no-project';
    return path.join(dirs().projects, `${slug(name)}-${hashOf(name).slice(0, 6)}.json`);
  }

  function loadWs(file = wsPath()) {
    return readJson(file) || {
      project: currentProject,
      ui: { page: 'design', kind: 'slide', filter: 'editing', activeByKind: {}, templateByKind: {}, brandId: null, accent: null },
      items: [], fps: FPS_DEFAULT, durationSec: 15, outDir: '', binPath: 'GRAPHICS', nextSeq: 1
    };
  }

  const saveWs = (ws, file = wsPath()) => writeJson(file, ws);

  function commit(ws, file) {
    saveWs(ws, file);
    emit();
    return snapshot();
  }

  function onProject(name) {
    const next = String(name || '').trim() || null;
    if (next === currentProject) return;
    currentProject = next;
    if (serverPort) emit();
  }

  const defaultTemplateId = (ws, kind) => {
    const list = listTemplates().filter((t) => t.kind === kind);
    const wanted = ws.ui.templateByKind[kind];
    return (list.find((t) => t.id === wanted) || list[0] || {}).id;
  };

  const stateOf = (item) => ({ code: item.code, fields: item.fields, values: item.values, mode: item.mode });

  function brandRawOf(ws) {
    return listBrands().find((b) => b.id === ws.ui.brandId) || listBrands()[0];
  }

  function brandOf(ws) {
    const raw = brandRawOf(ws);
    const rt = runtimeBrand(raw);
    return { ...rt, accent: ws.ui.accent && rt.colors.includes(ws.ui.accent) ? ws.ui.accent : rt.accent };
  }

  function renderHash(ws, state) {
    const { code, fields, values } = state;
    return hashOf({ code, fields, values, brand: brandRawOf(ws), accent: ws.ui.accent, fps: ws.fps, durationSec: ws.durationSec });
  }

  function workspaceView() {
    if (!serverPort) return null;
    const ws = loadWs();
    const toImport = [];
    const items = ws.items.map((it) => {
      const saved = it.snapshot;
      const hasFile = Boolean(it.rendered && it.rendered.file && fs.existsSync(it.rendered.file));
      const renderState = !saved || !hasFile ? 'none' : (it.rendered.hash === renderHash(ws, saved) ? 'current' : 'stale');
      if (hasFile && it.stage === 'queue' && !it.imported) toImport.push(it.rendered.file);
      return {
        id: it.id, name: it.name, kind: it.kind, stage: it.stage, mode: it.mode, templateId: it.templateId,
        code: it.code, fieldDefs: it.fields, values: mapValues(it.values, hydrate),
        chat: it.chat || [], costUsd: it.costUsd || 0, canUndo: Boolean(it.history && it.history.length),
        changed: !saved || hashOf(stateOf(it)) !== hashOf(saved), renderState,
        snapshot: saved ? { code: saved.code, fieldDefs: saved.fields, values: mapValues(saved.values, hydrate), mode: saved.mode } : null
      };
    });
    return { project: ws.project, ui: ws.ui, items, toImport, fps: ws.fps, durationSec: ws.durationSec, outDir: ws.outDir, binPath: ws.binPath, brand: brandOf(ws) };
  }

  function setUi(patch) {
    const ws = loadWs();
    const ui = { ...ws.ui, ...patch };
    if (patch.activeByKind) ui.activeByKind = { ...ws.ui.activeByKind, ...patch.activeByKind };
    if (patch.templateByKind) ui.templateByKind = { ...ws.ui.templateByKind, ...patch.templateByKind };
    return commit({ ...ws, ui });
  }

  function updateWorkspace(a) {
    const ws = loadWs();
    const next = { ...ws };
    for (const k of ['outDir', 'binPath']) if (a[k] !== undefined) next[k] = String(a[k]);
    if (a.fps !== undefined) next.fps = batchTiming({ fps: a.fps }).fps;
    if (a.durationSec !== undefined) next.durationSec = Math.max(0.5, Math.min(600, Number(a.durationSec) || 15));
    return commit(next);
  }

  function newItem(ws, kind, name, values, templateId) {
    const t = loadTemplate(templateId || defaultTemplateId(ws, kind));
    const seq = ws.nextSeq || 1;
    ws.nextSeq = seq + 1;
    return {
      id: `i${seq}`, seq, name, kind, stage: 'editing', mode: 'image', templateId: t.id, code: t.code, fields: t.fields,
      values: { ...valuesFor(t.fields, {}), ...values }, originalCode: null, snapshot: null, chat: [], history: [], costUsd: 0
    };
  }

  async function loadSlides() {
    const res = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (res.canceled || !res.filePaths.length) return snapshot();
    const ws = loadWs();
    let active = null;
    for (const file of res.filePaths) {
      const asset = ASSET + file;
      const same = ws.items.find((it) => it.kind === 'slide' && Object.values(it.values).includes(asset));
      if (same) { active = active || same.id; continue; }
      const t = loadTemplate(defaultTemplateId(ws, 'slide'));
      const imageField = t.fields.find((f) => f.type === 'image');
      if (!imageField) throw new Error('This template has no slide image');
      const item = newItem(ws, 'slide', path.basename(file, path.extname(file)), { [imageField.key]: asset });
      ws.items.push(item);
      active = active || item.id;
    }
    ws.ui = { ...ws.ui, kind: 'slide', page: 'design', activeByKind: { ...ws.ui.activeByKind, slide: active } };
    return commit(ws);
  }

  function newCallout() {
    const ws = loadWs();
    // New callouts start blank unless the editor picked one of their own templates.
    const picked = ws.ui.templateByKind.callout;
    const own = picked && !STARTERS.some((s) => s.id === picked) && fs.existsSync(templatePath(picked));
    const item = newItem(ws, 'callout', 'New callout', {}, own ? picked : 'starter-blank');
    item.name = calloutName(item) || 'New callout';
    ws.items.push(item);
    ws.ui = { ...ws.ui, kind: 'callout', page: 'design', activeByKind: { ...ws.ui.activeByKind, callout: item.id } };
    return commit(ws);
  }

  function calloutName(item) {
    const first = item.fields.find((f) => f.type === 'text' || f.type === 'textarea');
    const v = first ? item.values[first.key] : '';
    return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  /** file: a project's workspace, for work that started before Resolve may have switched project. */
  function withItem(itemId, fn, file) {
    const ws = loadWs(file);
    const item = ws.items.find((it) => it.id === itemId);
    if (!item) throw new Error('That item is no longer in the Library');
    fn(item, ws);
    return commit(ws, file);
  }

  function pushHistory(item) {
    item.history = [...(item.history || []), { code: item.code, fields: item.fields, mode: item.mode, originalCode: item.originalCode, templateId: item.templateId }].slice(-30);
  }

  function updateItem({ itemId, values }) {
    return withItem(itemId, (item) => {
      const next = mapValues(values, dehydrate);
      item.values = next;
      if (item.kind === 'callout') item.name = calloutName(item) || item.name;
    });
  }

  const ELEMENTS = {
    text: { label: 'Text', type: 'textarea' },
    list: { label: 'List', type: 'list' },
    image: { label: 'Image', type: 'image' }
  };

  /** The first spot for a new box that overlaps none, left column then right, 96px inside the edges. */
  function freeBox(taken, w, h) {
    const clear = (b) => taken.every((t) => b.x + b.w + 24 <= t.x || t.x + t.w + 24 <= b.x || b.y + b.h + 24 <= t.y || t.y + t.h + 24 <= b.y);
    for (const x of [110, 1010]) {
      const bw = Math.min(w, 1824 - x);
      for (let y = 96; y + h <= 984; y += 12) if (clear({ x, y, w: bw, h })) return { x, y, w: bw, h };
    }
    return { x: 110, y: 96, w, h };
  }

  /** Adds a sidebar element to a callout. The layout is left to the notes box (Claude). */
  function addField({ itemId, type }) {
    const el = ELEMENTS[type];
    if (!el) throw new Error('Unknown element');
    return withItem(itemId, (item) => {
      pushHistory(item);
      const taken = new Set(item.fields.map((f) => f.key));
      const labels = new Set(item.fields.map((f) => f.label));
      let n = 1;
      while (taken.has(n === 1 ? type : `${type}${n}`) || labels.has(n === 1 ? el.label : `${el.label} ${n}`)) n += 1;
      const field = { key: n === 1 ? type : `${type}${n}`, label: n === 1 ? el.label : `${el.label} ${n}`, type: el.type, default: type === 'list' ? [] : '' };
      item.fields = [...item.fields, field];
      item.values = valuesFor(item.fields, item.values);
      const layoutField = item.fields.find((f) => f.type === 'layout');
      if (layoutField) {
        const boxes = { ...(item.values[layoutField.key] || {}) };
        const h = { text: 200, list: 360, image: 400 }[type];
        boxes[field.key] = freeBox(Object.values(boxes), 860, h);
        item.values = { ...item.values, [layoutField.key]: boxes };
      }
    });
  }

  function removeField({ itemId, key }) {
    return withItem(itemId, (item) => {
      const field = item.fields.find((f) => f.key === key);
      if (!field || field.type === 'layout') return;
      pushHistory(item);
      item.fields = item.fields.filter((f) => f.key !== key);
      item.values = valuesFor(item.fields, item.values);
      const layoutField = item.fields.find((f) => f.type === 'layout');
      if (layoutField) {
        const { [key]: _gone, ...boxes } = item.values[layoutField.key] || {};
        item.values = { ...item.values, [layoutField.key]: boxes };
      }
    });
  }

  function useTemplate({ itemId, kind, templateId }) {
    const ws = loadWs();
    loadTemplate(templateId);
    ws.ui = { ...ws.ui, templateByKind: { ...ws.ui.templateByKind, [kind]: templateId } };
    const item = ws.items.find((it) => it.id === itemId);
    if (item) {
      const t = loadTemplate(templateId);
      pushHistory(item);
      item.templateId = t.id;
      item.code = t.code;
      item.fields = t.fields;
      item.mode = 'image';
      item.originalCode = null;
      item.values = valuesFor(t.fields, item.values);
    }
    return commit(ws);
  }

  function saveAsTemplate({ itemId, kind, templateId, name }) {
    const label = String(name || '').trim();
    if (!label) throw new Error('Enter a name');
    const ws = loadWs();
    const item = ws.items.find((it) => it.id === itemId);
    const source = item || loadTemplate(templateId);
    const t = { id: newId(label), name: label, kind: item ? item.kind : kind, code: source.code, fields: source.fields, chat: [], history: [], costUsd: 0 };
    saveTemplate(t);
    ws.ui = { ...ws.ui, templateByKind: { ...ws.ui.templateByKind, [t.kind]: t.id } };
    if (item) item.templateId = t.id;
    return commit(ws);
  }

  function addToReview({ itemId }) {
    return withItem(itemId, (item) => {
      item.snapshot = JSON.parse(JSON.stringify(stateOf(item)));
      if (item.stage === 'editing') item.stage = 'review';
    });
  }

  function setStage({ itemId, stage }) {
    if (!['editing', 'review', 'queue'].includes(stage)) throw new Error('Unknown stage');
    return withItem(itemId, (item, ws) => {
      if (stage !== 'editing' && !item.snapshot) throw new Error('Add it to review first');
      item.stage = stage;
      if (stage === 'editing') ws.ui = { ...ws.ui, page: 'design', kind: item.kind, activeByKind: { ...ws.ui.activeByKind, [item.kind]: item.id } };
    });
  }

  function openItem({ itemId }) {
    return withItem(itemId, (item, ws) => {
      ws.ui = { ...ws.ui, page: 'design', kind: item.kind, activeByKind: { ...ws.ui.activeByKind, [item.kind]: item.id } };
    });
  }

  function removeItem({ itemId }) {
    const ws = loadWs();
    const gone = ws.items.find((it) => it.id === itemId);
    ws.items = ws.items.filter((it) => it.id !== itemId);
    if (gone && ws.ui.activeByKind[gone.kind] === itemId) {
      const next = ws.items.find((it) => it.kind === gone.kind && it.stage === 'editing');
      ws.ui = { ...ws.ui, activeByKind: { ...ws.ui.activeByKind, [gone.kind]: next ? next.id : null } };
    }
    return commit(ws);
  }

  function undoItem({ itemId }) {
    return withItem(itemId, (item) => {
      const history = [...(item.history || [])];
      const last = history.pop();
      if (!last) return;
      Object.assign(item, last, { history, chat: [...(item.chat || []), { who: 'ai', text: 'Undone.' }].slice(-40) });
    });
  }

  function revertToImage({ itemId }) {
    return withItem(itemId, (item) => {
      if (item.mode !== 'rebuilt' || !item.originalCode) return;
      pushHistory(item);
      item.code = item.originalCode;
      item.originalCode = null;
      item.mode = 'image';
      item.chat = [...(item.chat || []), { who: 'ai', text: 'Back to the original image.' }].slice(-40);
    });
  }

  /** The loaded slide as Claude will see it: small enough to stay cheap, large enough to read. */
  function slideImage(item) {
    if (item.kind !== 'slide' || !nativeImage) return null;
    const value = Object.values(item.values).find((v) => typeof v === 'string' && v.startsWith(ASSET));
    if (!value) return null;
    const img = nativeImage.createFromPath(value.slice(ASSET.length));
    if (img.isEmpty()) return null;
    return img.resize({ width: Math.min(1280, img.getSize().width), quality: 'good' }).toJPEG(82).toString('base64');
  }

  async function editItem(a) {
    if (editStatus) throw new Error('Still working on the last change');
    const request = String(a.request || '').trim();
    const wsFile = wsPath();      // the result belongs to this project, even if Resolve switches while Claude works
    const ws = loadWs(wsFile);
    const item = ws.items.find((it) => it.id === a.itemId);
    if (!item) throw new Error('That item is no longer in the Library');
    const note = item.kind === 'slide'
      ? (item.mode === 'rebuilt' ? 'This slide has been rebuilt as editable elements.' : 'This slide is still a flat image, attached here.')
      : '';
    const out = await askForChange({
      base: { id: `${item.id}`, kind: item.kind, code: item.code, fields: item.fields, chat: item.chat },
      target: item.id, brand: brandOf(ws), values: mapValues(item.values, hydrate), request, harder: a.harder,
      fps: ws.fps, durationSec: ws.durationSec, note, image: slideImage(item)
    });
    return withItem(a.itemId, (it) => {
      const chat = [...(it.chat || []), { who: 'me', text: request }, { ...out.reply, usd: out.spent, model: out.model }];
      if (out.change) {
        pushHistory(it);
        if (out.change.rebuild && it.mode !== 'rebuilt') {
          it.originalCode = it.code;
          it.mode = 'rebuilt';
        }
        it.code = out.change.code;
        it.fields = out.change.fields;
        it.values = valuesFor(it.fields, it.values);
      }
      it.chat = chat.slice(-40);
      it.costUsd = (it.costUsd || 0) + out.spent;
    }, wsFile);
  }

  async function renderQueue() {
    needIdle();
    const { renderMedia, selectComposition, makeCancelSignal } = require('@remotion/renderer');
    const base = renderBase();
    const ws = loadWs();
    if (!ws.outDir) throw new Error('Choose an output folder');
    const brand = brandOf(ws);
    needFonts(brand);
    const fps = ws.fps;
    const durationInFrames = Math.max(1, Math.round(ws.durationSec * fps));
    fs.mkdirSync(ws.outDir, { recursive: true });
    const work = [];
    let skipped = 0;
    for (const it of ws.items) {
      if (it.stage !== 'queue' || !it.snapshot) continue;
      const hash = renderHash(ws, it.snapshot);
      const same = it.rendered && it.rendered.file && path.dirname(it.rendered.file) === path.resolve(ws.outDir) && fs.existsSync(it.rendered.file);
      if (same && it.rendered.hash === hash) { skipped += 1; continue; }
      const file = same ? it.rendered.file : path.resolve(ws.outDir, `${String(it.seq).padStart(3, '0')}_${fileSafe(it.name)}.mov`);
      work.push({ it, hash, file, sameFile: Boolean(same) });
    }
    job = { kind: 'render', status: 'running', done: 0, total: work.length, skipped, outputs: [], failures: [], current: 0 };
    emit();
    let stop = false;
    let cancelNow = null;
    cancelFn = () => { stop = true; if (cancelNow) cancelNow(); };
    for (let i = 0; i < work.length && !stop; i += 1) {
      const w = work[i];
      const inputProps = { code: w.it.snapshot.code, fields: mapValues(w.it.snapshot.values, hydrate), brand, fps, durationInFrames };
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
        const latest = loadWs();
        const row = latest.items.find((x) => x.id === w.it.id);
        if (row) {
          row.rendered = { hash: w.hash, file: w.file };
          if (!w.sameFile) row.imported = false;
          saveWs(latest);
        }
        job = { ...job, done: i + 1, current: 0, outputs: [...job.outputs, w.file] };
      } catch (err) {
        if (stop) break;
        job = { ...job, done: i + 1, current: 0, failures: [...job.failures, { name: w.it.name, error: errText(err) }] };
      }
      emit();
    }
    job = { ...job, status: stop ? 'canceled' : 'done' };
    cancelFn = null;
    cancelNow = null;
    emit();
    return snapshot();
  }

  function markImported({ files }) {
    const done = new Set(files || []);
    const ws = loadWs();
    for (const it of ws.items) if (it.rendered && done.has(it.rendered.file)) it.imported = true;
    return commit(ws);
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

  async function callClaude(model, text, image) {
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
      messages: [{ role: 'user', content: image
        ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }, { type: 'text', text }]
        : text }]
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
    return { code, fields, rebuild: Boolean(input.rebuild) };
  }

  function valuesFor(fields, values) {
    const out = {};
    for (const f of fields) {
      out[f.key] = values && values[f.key] !== undefined ? values[f.key] : (f.default !== undefined ? f.default : (f.type === 'list' ? [] : ''));
    }
    return out;
  }

  /** One request against one piece of template code, tested before it is accepted. */
  async function askForChange({ base, target, brand, values, request, harder, fps, durationSec, note, image }) {
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
        const msg = await callClaude(model, text(failure), image);
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
          stage(next.rebuild ? 'Rebuilding this slide so it can be edited' : 'Testing the change');
          const timing = batchTiming({ fps, durationSec });
          await still({
            code: next.code, fields: valuesFor(next.fields, values), brand, fps: timing.fps, durationInFrames: timing.durationInFrames,
            frame: Math.min(timing.durationInFrames - 1, Math.round(timing.fps * 3)), output: path.join(dirs().work, 'check.png')
          });
          return out({ who: 'ai', text: next.rebuild ? `Rebuilt as editable. ${call.input.summary || ''}`.trim() : (call.input.summary || 'Done.') }, next);
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
    const { rebuild: _rebuild, ...applied } = res.change || {};
    saveTemplate({ ...latest, ...applied, history, chat, costUsd: (latest.costUsd || 0) + res.spent });
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

  let systemFontsCache = null;
  let adobeFontsCache = null;
  let adobeScannedAt = 0;
  /** Installed fonts plus Adobe Fonts active right now. Adobe is re-read each time: activations change while the app runs. */
  const systemFontMap = () => {
    systemFontsCache = systemFontsCache || scanSystemFonts();
    adobeFontsCache = scanSystemFonts(adobeFontDirs(), { adobe: true });
    const all = new Map([...systemFontsCache].map(([family, faces]) => [family, new Map(faces)]));
    for (const [family, faces] of adobeFontsCache) {
      if (!all.has(family)) all.set(family, new Map());
      for (const [weight, face] of faces) if (!all.get(family).has(weight)) all.get(family).set(weight, face);
    }
    return all;
  };
  const systemFonts = () => [...systemFontMap().keys()].sort((a, b) => a.localeCompare(b));

  /** An Adobe font is used where Creative Cloud keeps it, never copied. Null while it isn't active. */
  function adobeFontFile(f) {
    if (f.path && fs.existsSync(f.path)) return f.path;
    adobeFontsCache = adobeFontsCache || scanSystemFonts(adobeFontDirs(), { adobe: true });
    const face = (adobeFontsCache.get(f.family) || new Map()).get(f.weight);
    if (face && fs.existsSync(face.file)) return face.file;
    if (Date.now() - adobeScannedAt < 10000) return null;   // inactive: don't re-read the folder on every snapshot
    adobeScannedAt = Date.now();
    adobeFontsCache = scanSystemFonts(adobeFontDirs(), { adobe: true });
    const fresh = (adobeFontsCache.get(f.family) || new Map()).get(f.weight);
    return fresh && fs.existsSync(fresh.file) ? fresh.file : null;
  }

  function needFonts(brand) {
    if (brand.missingFonts && brand.missingFonts.length) throw new Error(`Open Creative Cloud and activate ${brand.missingFonts.join(', ')}`);
  }

  /** Use a font for headings or body. A system font's files are copied in so renders can load them. */
  function setBrandFont({ brandId, role, family }) {
    if (!['heading', 'body'].includes(role)) throw new Error('Unknown font role');
    const b = readJson(brandFile(brandId));
    if (!b) throw new Error('Brand not found');
    b.fonts = b.fonts || [];
    if (!b.fonts.some((f) => f.family === family)) {
      const faces = systemFontMap().get(family);
      if (!faces) throw new Error('Font not found');
      const dest = path.join(path.dirname(brandFile(brandId)), 'fonts');
      fs.mkdirSync(dest, { recursive: true });
      for (const [weight, { file, adobe }] of faces) {
        if (adobe) { b.fonts.push({ path: file, family, weight, style: '', adobe: true }); continue; }
        const name = path.basename(file).toLowerCase();
        fs.copyFileSync(file, path.join(dest, name));
        b.fonts.push({ file: `fonts/${name}`, family, weight, style: '' });
      }
    }
    b[`${role}Family`] = family;
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
    createBrand, updateBrand, addBrandFiles, systemFonts, setBrandFont,
    pickImage, pickFolder, updateSettings,
    setUi, updateWorkspace, loadSlides, newCallout, addField, removeField, updateItem, useTemplate, saveAsTemplate, addToReview, setStage, openItem,
    removeItem, undoItem, revertToImage, editItem, renderQueue, markImported, cancel
  };

  return {
    onProject,
    /** IPC entry: only the methods above are reachable from the page. */
    async call(method, args) {
      if (!Object.prototype.hasOwnProperty.call(api, method)) throw new Error(`Unknown Graphics call: ${method}`);
      await start();
      return api[method](args || {});
    }
  };
}

module.exports = { createGraphics, MODELS, fontInfo, readFontFace, scanSystemFonts };
