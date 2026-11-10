'use strict';

/**
 * card_ingest.js — camera card (SD / CFexpress) ingest to the NAS.
 *
 * Main-process module (like atem_ftp.js). Spec + verified card layouts:
 * /Users/lpos/lp-app-ecosystem/docs/editpanel-card-ingest-seed.md.
 *
 *   watch  — polls for mounted camera cards every 3 s and broadcasts the list
 *            on 'card-ingest:cards' (App opens the overlay when one appears)
 *   check  — walks a card, keeps only media (.MXF .MP4 .ARW; proxy folders
 *            skipped), flags .RSV (unfinalized recordings), and decides per
 *            file: already on the NAS (ledger or destination folder), copy,
 *            or copy under a suffix because the name is taken
 *   ingest — one copy process per card (card_ingest_copy.js); progress is
 *            broadcast as a run snapshot on 'card-ingest:update'
 *
 * Card layouts (FX3 / FX6, verified 2026-10-30):
 *   PRIVATE/M4ROOT/CLIP/*.MP4    FX3 clips (plain counter names, clash-prone)
 *   PRIVATE/XDROOT/Clip/*.MXF    FX6 clips
 *   PRIVATE/{M4ROOT,XDROOT}/SUB  proxies (.MP4 too) — skipped by folder
 *   DCIM/*\/*.ARW                stills (JPGs skipped)
 * Nothing is ever written to a card.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { sampleHash, resolveTarget, statOrNull } = require('./card_ingest_fs');

const MEDIA_EXT = new Set(['.mxf', '.mp4', '.arw']);
const VIDEO_EXT = new Set(['.mxf', '.mp4']);
const UNFINALIZED_EXT = '.rsv';
const SKIP_DIRS = new Set(['sub', 'thmbnl', 'system volume information', '$recycle.bin']);
const CARD_MARKERS = [['PRIVATE', 'M4ROOT'], ['PRIVATE', 'XDROOT'], ['DCIM']];
const POLL_MS = 3000;
const UPDATE_EVERY_MS = 250;
const SPEED_WINDOW_MS = 5000;

async function exists(p) {
  try { await fsp.access(p); return true; } catch (_) { return false; }
}

/** Mount points that could hold a card. Windows: D:–Z:. macOS: /Volumes/*. */
async function mountRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) roots.push(`${String.fromCharCode(c)}:\\`);
    return roots;
  }
  if (process.platform === 'darwin') {
    let entries = [];
    try { entries = await fsp.readdir('/Volumes', { withFileTypes: true }); } catch (_) { return []; }
    return entries.filter(e => e.isDirectory()).map(e => path.join('/Volumes', e.name));
  }
  return [];
}

async function describeCard(root) {
  const found = await Promise.all(CARD_MARKERS.map(m => exists(path.join(root, ...m))));
  if (!found.some(Boolean)) return null;
  const formats = [];
  if (found[0]) formats.push('XAVC');
  if (found[1]) formats.push('XDCAM');
  if (found[2]) formats.push('Stills');
  let usedBytes = null;
  try {
    const s = await fsp.statfs(root);
    usedBytes = (s.blocks - s.bfree) * s.bsize;
  } catch (_) {}
  const label = process.platform === 'win32' ? root.slice(0, 2) : path.basename(root);
  return { id: root, root, label, formats, usedBytes };
}

async function listCards() {
  const roots = await mountRoots();
  const cards = await Promise.all(roots.map(r => describeCard(r).catch(() => null)));
  return cards.filter(Boolean);
}

/** Every media and .RSV file on a card, relative to its root. */
async function scanCard(root) {
  const out = [];
  async function walk(dir, rel) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) await walk(abs, relPath);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      const kind = MEDIA_EXT.has(ext) ? (VIDEO_EXT.has(ext) ? 'video' : 'still')
        : ext === UNFINALIZED_EXT ? 'unfinalized' : null;
      if (!kind) continue;
      const st = await statOrNull(abs);
      if (!st) continue;
      out.push({ src: abs, relPath, name: e.name, size: st.size, mtimeMs: st.mtimeMs, kind });
    }
  }
  await walk(root, '');
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

function summarize(files, dest) {
  const media = files.filter(f => f.kind !== 'unfinalized');
  const todo = media.filter(f => f.status === 'copy' || f.status === 'rename');
  return {
    mediaCount: media.length,
    toCopy: todo.length,
    toCopyBytes: todo.reduce((s, f) => s + f.size, 0),
    onNas: media.filter(f => f.status === 'on-nas').length,
    renamed: media.filter(f => f.status === 'rename').length,
    unfinalized: files.filter(f => f.kind === 'unfinalized').length,
    needsDest: !dest && todo.length > 0,
    safeToFormat: media.length > 0 && todo.length === 0
      && files.every(f => f.kind !== 'unfinalized')
  };
}

/**
 * Thumbnail for a card file, as a data URL (null when none can be made).
 *   clips  — the camera's own: <clip folder>/../THMBNL|Thmbnl/<stem>T01.JPG
 *            (512×288, ~28 KB, written by both FX3 and FX6)
 *   stills — the companion <stem>.JPG, shrunk
 *   else   — one frame grabbed with ffmpeg (clips without a camera thumbnail)
 */
async function findCaseInsensitive(dir, name) {
  try {
    const want = name.toLowerCase();
    return (await fsp.readdir(dir)).find(n => n.toLowerCase() === want) || null;
  } catch (_) { return null; }
}

async function cameraThumb(src) {
  const stem = path.basename(src, path.extname(src));
  const parent = path.dirname(path.dirname(src));
  let entries = [];
  try { entries = await fsp.readdir(parent, { withFileTypes: true }); } catch (_) { return null; }
  const thumbDir = entries.find(e => e.isDirectory() && e.name.toLowerCase() === 'thmbnl');
  if (!thumbDir) return null;
  const dir = path.join(parent, thumbDir.name);
  const hit = await findCaseInsensitive(dir, `${stem}T01.JPG`);
  return hit ? fsp.readFile(path.join(dir, hit)) : null;
}

function ffmpegFrame(ffmpegPath, src) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(null);
    execFile(ffmpegPath, ['-v', 'error', '-ss', '1', '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { encoding: 'buffer', timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => resolve(err || !stdout?.length ? null : stdout));
  });
}

function createCardIngest({ broadcast, jobsDb, utilityProcess, log = () => {}, onCardsAdded = () => {}, nativeImage = null, ffmpegPath = '' }) {
  let cards = [];
  let firstPoll = true;
  let pollTimer = null;
  let polling = false;
  let run = null;          // current/last run snapshot (see startIngest)
  let children = [];
  let lastUpdateAt = 0;
  let updateTimer = null;
  let speedSamples = [];

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const next = await listCards();
      const before = new Set(cards.map(c => c.id));
      const added = next.filter(c => !before.has(c.id)).map(c => c.id);
      const changed = added.length > 0 || next.length !== cards.length;
      cards = next;
      if (changed) broadcast('card-ingest:cards', { cards, added: firstPoll ? [] : added });
      if (added.length && !firstPoll) onCardsAdded(next.filter(c => added.includes(c.id)));
      firstPoll = false;
    } catch (err) {
      log(`[Cards] poll failed: ${err.message}`);
    } finally {
      polling = false;
    }
  }

  function startWatching() {
    if (pollTimer || !['win32', 'darwin'].includes(process.platform)) return;
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  function stopWatching() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /** Ledger hit whose file still exists, or null. */
  async function ledgerHit(size, sample) {
    if (!jobsDb) return null;
    for (const row of jobsDb.findCardIngestFiles(size, sample)) {
      const st = await statOrNull(row.dest_path);
      if (st && st.size === size) return row.dest_path;
    }
    return null;
  }

  /**
   * Check cards against the ledger and their destinations.
   * targets: [{ root, dest|null }] — checked together so two cards headed for
   * one folder never plan the same name.
   */
  async function check(targets = []) {
    const reservedByDest = new Map();
    const results = [];
    for (const { root, dest } of targets) {
      const card = cards.find(c => c.root === root) || (await describeCard(root));
      if (!card) { results.push({ root, error: 'Card not found' }); continue; }
      const files = await scanCard(root);
      const destKey = dest ? path.resolve(dest).toLowerCase() : null;
      const reserved = destKey ? (reservedByDest.get(destKey) || new Set()) : new Set();
      if (destKey) reservedByDest.set(destKey, reserved);
      for (const f of files) {
        if (f.kind === 'unfinalized') { f.status = 'unfinalized'; continue; }
        try {
          f.sample = await sampleHash(f.src, f.size);
          const where = await ledgerHit(f.size, f.sample);
          if (where) {
            f.status = 'on-nas'; f.where = where; f.destName = path.basename(where);
          } else if (dest) {
            const t = await resolveTarget(dest, f.name, f.size, f.sample, reserved);
            f.status = t.status; f.destName = t.destName;
            if (t.status === 'on-nas') f.where = path.join(dest, t.destName);
            else reserved.add(t.destName.toLowerCase());
          } else {
            f.status = 'copy'; f.destName = f.name;
          }
        } catch (err) {
          f.status = 'error'; f.error = err.message;
        }
      }
      results.push({ ...card, dest: dest || null, files, summary: summarize(files, dest) });
    }
    return results;
  }

  // ── Deep scan ───────────────────────────────────────────
  // On demand, for files copied outside EditPanel (by hand, another machine,
  // before this tool): walk a whole folder tree (the client assets root),
  // match card files by size, confirm by sample hash, and add every hit to the
  // ledger so normal checks see it from then on. Names don't need to match.

  let deepScanToken = null;

  async function deepScan({ footageRoot, cardRoots = [] } = {}) {
    if (!footageRoot) throw new Error('No folder to scan');
    if (deepScanToken) deepScanToken.canceled = true;
    const token = { canceled: false };
    deepScanToken = token;
    const progress = { state: 'running', root: footageRoot, dirs: 0, files: 0, found: 0 };
    let lastSent = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (force || now - lastSent > 250) { lastSent = now; broadcast('card-ingest:deep-scan', { ...progress }); }
    };
    report(true);

    try {
      // What we're looking for: card media not already in the ledger.
      const wanted = new Map();   // size → [{ card, f }]
      for (const root of cardRoots) {
        const card = cards.find(c => c.root === root);
        if (!card) continue;
        for (const f of await scanCard(root)) {
          if (f.kind === 'unfinalized') continue;
          f.sample = await sampleHash(f.src, f.size);
          if (await ledgerHit(f.size, f.sample)) continue;
          if (!wanted.has(f.size)) wanted.set(f.size, []);
          wanted.get(f.size).push({ card, f });
        }
      }
      if (token.canceled) throw new Error('canceled');

      // Walk the tree (8 folders at a time); stat only media files.
      const candidates = [];   // { path, size }
      const queue = [footageRoot];
      async function worker() {
        while (queue.length && !token.canceled) {
          const dir = queue.shift();
          let entries;
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
          progress.dirs++;
          for (const e of entries) {
            if (e.name.startsWith('.') || e.name.startsWith('#') || e.name.startsWith('@')) continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) { queue.push(abs); continue; }
            if (!e.isFile() || !MEDIA_EXT.has(path.extname(e.name).toLowerCase())) continue;
            progress.files++;
            const st = await statOrNull(abs);
            if (st && wanted.has(st.size)) candidates.push({ path: abs, size: st.size });
          }
          report();
        }
      }
      // Workers stop when the queue is momentarily empty, so keep starting
      // rounds until nothing is left.
      while (queue.length && !token.canceled) await Promise.all(Array.from({ length: 8 }, worker));
      if (token.canceled) throw new Error('canceled');

      // Confirm by sample hash; first match wins for each card file.
      const matched = new Set();
      for (const c of candidates) {
        if (token.canceled) throw new Error('canceled');
        let sample = null;
        for (const { card, f } of wanted.get(c.size) || []) {
          if (matched.has(f)) continue;
          if (sample === null) { try { sample = await sampleHash(c.path, c.size); } catch (_) { sample = ''; } }
          if (sample !== f.sample) continue;
          matched.add(f);
          progress.found++;
          try {
            jobsDb?.addCardIngestFile({
              runId: 'deep-scan', cardLabel: card.label, originalName: f.name, srcRelPath: f.relPath,
              destName: path.basename(c.path), destPath: c.path, sizeBytes: f.size, sampleHash: f.sample, fullHash: null
            });
          } catch (err) { log(`[Cards] ledger write failed for ${f.name}: ${err.message}`); }
          break;
        }
      }
      progress.state = 'done';
      log(`[Cards] deep scan of ${footageRoot}: ${progress.dirs} folders, ${progress.files} media files, ${progress.found} card file(s) found`);
    } catch (err) {
      progress.state = token.canceled ? 'canceled' : 'failed';
      progress.error = token.canceled ? null : err.message;
      if (!token.canceled) log(`[Cards] deep scan failed: ${err.message}`);
    } finally {
      if (deepScanToken === token) deepScanToken = null;
    }
    report(true);
    return { ...progress };
  }

  function cancelDeepScan() {
    if (deepScanToken) deepScanToken.canceled = true;
    return { ok: true };
  }

  // ── Thumbnails ──────────────────────────────────────────

  const thumbCache = new Map();   // root|relPath → data URL or null
  let ffmpegBusy = 0;
  const ffmpegWaiters = [];

  async function withFfmpegSlot(fn) {
    if (ffmpegBusy >= 2) await new Promise(r => ffmpegWaiters.push(r));
    ffmpegBusy++;
    try { return await fn(); } finally { ffmpegBusy--; ffmpegWaiters.shift()?.(); }
  }

  function shrink(buf) {
    if (!nativeImage || !buf) return buf;
    try {
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return null;
      return img.getSize().width > 360 ? img.resize({ width: 320 }).toJPEG(80) : buf;
    } catch (_) { return null; }
  }

  /** { root, relPath } of a file on a mounted card → data URL or null. */
  async function thumbnail({ root, relPath } = {}) {
    const key = `${root}|${relPath}`;
    if (thumbCache.has(key)) return thumbCache.get(key);
    // Only files on a card we detected, and never outside its root.
    if (!cards.some(c => c.root === root) || typeof relPath !== 'string') return null;
    const src = path.resolve(root, relPath);
    if (!src.startsWith(path.resolve(root))) return null;
    const ext = path.extname(src).toLowerCase();
    let buf = null;
    try {
      if (VIDEO_EXT.has(ext)) {
        buf = await cameraThumb(src);
        if (!buf) buf = await withFfmpegSlot(() => ffmpegFrame(ffmpegPath, src));
      } else if (ext === '.arw') {
        const jpg = await findCaseInsensitive(path.dirname(src), `${path.basename(src, path.extname(src))}.JPG`);
        if (jpg) buf = shrink(await fsp.readFile(path.join(path.dirname(src), jpg)));
        if (!buf && nativeImage?.createThumbnailFromPath) {
          buf = await nativeImage.createThumbnailFromPath(src, { width: 320, height: 214 }).then(i => i.toJPEG(80)).catch(() => null);
        }
      }
    } catch (_) { buf = null; }
    const url = buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : null;
    if (thumbCache.size > 2000) thumbCache.clear();
    thumbCache.set(key, url);
    return url;
  }

  // ── Ingest run ──────────────────────────────────────────

  function snapshot() {
    if (!run) return null;
    const now = Date.now();
    speedSamples = speedSamples.filter(s => now - s.t <= SPEED_WINDOW_MS);
    let speed = 0;
    if (speedSamples.length > 1) {
      const a = speedSamples[0], b = speedSamples[speedSamples.length - 1];
      speed = b.t > a.t ? ((b.work - a.work) / (b.t - a.t)) * 1000 : 0;
    }
    return { ...run, speed };
  }

  function totals() {
    let copyBytes = 0, verifyBytes = 0;
    for (const c of run.cards) for (const f of c.files) { copyBytes += f.copyBytes || 0; verifyBytes += f.verifyBytes || 0; }
    run.copyBytes = copyBytes;
    run.workDone = copyBytes + verifyBytes;
  }

  function pushUpdate(force = false) {
    if (!run) return;
    totals();
    const now = Date.now();
    speedSamples.push({ t: now, work: run.workDone });
    if (!force && now - lastUpdateAt < UPDATE_EVERY_MS) {
      if (!updateTimer) updateTimer = setTimeout(() => { updateTimer = null; pushUpdate(true); }, UPDATE_EVERY_MS);
      return;
    }
    lastUpdateAt = now;
    broadcast('card-ingest:update', snapshot());
  }

  function finishCard(card, wasCanceled) {
    card.state = wasCanceled ? 'canceled' : 'done';
    for (const f of card.files) {
      if (f.state === 'waiting' || f.state === 'copying' || f.state === 'verifying') f.state = wasCanceled ? 'canceled' : 'failed';
    }
    const media = card.files.filter(f => f.kind !== 'unfinalized');
    // Files found already sitting in a folder (copied by hand, or by another
    // machine) join the ledger too, so later checks know them anywhere.
    for (const f of media) {
      if (f.state !== 'on-nas' || !f.where || !f.sample || !jobsDb) continue;
      try {
        if (!jobsDb.findCardIngestFiles(f.size, f.sample).some(r => r.dest_path === f.where)) {
          jobsDb.addCardIngestFile({
            runId: run.id, cardLabel: card.label, originalName: f.name, srcRelPath: f.relPath,
            destName: f.destName, destPath: f.where, sizeBytes: f.size, sampleHash: f.sample, fullHash: null
          });
        }
      } catch (err) { log(`[Cards] ledger write failed for ${f.name}: ${err.message}`); }
    }
    card.report = {
      copied: media.filter(f => f.state === 'copied').length,
      copiedBytes: media.filter(f => f.state === 'copied').reduce((s, f) => s + f.size, 0),
      onNas: media.filter(f => f.state === 'on-nas').length,
      renamed: media.filter(f => f.state === 'copied' && f.destName !== f.name).length,
      failed: media.filter(f => f.state === 'failed').length,
      unfinalized: card.files.filter(f => f.kind === 'unfinalized').length,
      safeToFormat: media.length > 0
        && media.every(f => f.state === 'copied' || f.state === 'on-nas')
        && card.files.every(f => f.kind !== 'unfinalized')
    };
    if (run.cards.every(c => c.state !== 'running')) {
      run.state = run.cards.some(c => c.state === 'canceled') ? 'canceled' : 'done';
      run.finishedAt = Date.now();
      try { jobsDb?.finishCardIngestRun(run.id, run.state, run); } catch (err) { log(`[Cards] report save failed: ${err.message}`); }
      children = [];
      log(`[Cards] ingest ${run.state}`);
    }
    pushUpdate(true);
  }

  function onChildMessage(card, msg) {
    const f = msg && typeof msg.index === 'number' ? card.files[msg.index] : null;
    switch (msg?.type) {
      case 'file-start':
        if (f) { f.state = 'copying'; f.destName = msg.destName; }
        break;
      case 'bytes':
        if (f) {
          if (msg.phase === 'copy') { f.copyBytes = msg.bytes; f.state = 'copying'; }
          else { f.copyBytes = f.size; f.verifyBytes = msg.bytes; f.state = 'verifying'; }
        }
        break;
      case 'file-done':
        if (f) {
          f.state = msg.status === 'on-nas' ? 'on-nas' : 'copied';
          f.destName = msg.destName;
          f.where = msg.destPath;
          f.copyBytes = f.size; f.verifyBytes = f.size;
          if (msg.status === 'copied') {
            try {
              jobsDb?.addCardIngestFile({
                runId: run.id, cardLabel: card.label, originalName: f.name, srcRelPath: f.relPath,
                destName: msg.destName, destPath: msg.destPath, sizeBytes: f.size,
                sampleHash: f.sample, fullHash: msg.hash
              });
            } catch (err) { log(`[Cards] ledger write failed for ${f.name}: ${err.message}`); }
          }
        }
        break;
      case 'file-error':
        if (f) { f.state = 'failed'; f.error = msg.error; f.copyBytes = f.size; f.verifyBytes = f.size; }
        log(`[Cards] ${card.label} ${f ? f.name : '?'}: ${msg.error}`);
        break;
      case 'fatal':
        log(`[Cards] ${card.label} copy process error: ${msg.error}`);
        break;
      case 'finished':
        finishCard(card, !!msg.canceled || run.cancelRequested);
        return;
      default:
        return;
    }
    pushUpdate();
  }

  /**
   * targets: [{ root, dest }] — re-checked here (never trusts a stale plan),
   * then one copy process per card.
   */
  async function startIngest(targets = []) {
    if (run && run.state === 'running') return { ok: false, error: 'An ingest is already running' };
    if (!targets.length || targets.some(t => !t.dest)) return { ok: false, error: 'Every card needs a destination' };
    const checked = await check(targets);
    const failedCheck = checked.find(c => c.error);
    if (failedCheck) return { ok: false, error: `${failedCheck.root}: ${failedCheck.error}` };

    const id = `ci-${Date.now()}`;
    run = {
      id, state: 'running', startedAt: Date.now(), finishedAt: null, cancelRequested: false,
      cards: checked.map(c => ({
        root: c.root, label: c.label, formats: c.formats, dest: c.dest, state: 'running',
        files: c.files.map(f => ({
          name: f.name, relPath: f.relPath, size: f.size, kind: f.kind, sample: f.sample,
          destName: f.destName || f.name, where: f.where || null, error: f.error || null,
          state: f.kind === 'unfinalized' ? 'unfinalized'
            : f.status === 'on-nas' ? 'on-nas'
            : f.status === 'error' ? 'failed' : 'waiting',
          copyBytes: 0, verifyBytes: 0, src: f.src, mtimeMs: f.mtimeMs
        }))
      }))
    };
    run.workTotal = 0;
    for (const c of run.cards) {
      c.bytesTotal = c.files.filter(f => f.state === 'waiting').reduce((s, f) => s + f.size, 0);
      run.workTotal += c.bytesTotal * 2;
    }
    run.bytesTotal = run.workTotal / 2;
    speedSamples = [];
    try { jobsDb?.createCardIngestRun(id, run.startedAt); } catch (err) { log(`[Cards] run record failed: ${err.message}`); }
    log(`[Cards] ingest started: ${run.cards.length} card(s), ${(run.bytesTotal / 1e9).toFixed(1)} GB`);

    children = [];
    for (const card of run.cards) {
      const jobs = card.files
        .map((f, index) => ({ f, index }))
        .filter(({ f }) => f.state === 'waiting')
        .map(({ f, index }) => ({ index, src: f.src, name: f.name, size: f.size, sample: f.sample, mtimeMs: f.mtimeMs }));
      if (jobs.length === 0) { finishCard(card, false); continue; }
      const child = utilityProcess.fork(path.join(__dirname, 'card_ingest_copy.js'), [], { serviceName: 'EditPanel card ingest' });
      children.push(child);
      let finished = false;
      child.on('message', (msg) => {
        if (msg?.type === 'finished') { finished = true; setTimeout(() => child.kill(), 100); }
        onChildMessage(card, msg);
      });
      child.on('exit', (code) => {
        if (finished) return;
        log(`[Cards] ${card.label} copy process exited (${code})`);
        onChildMessage(card, { type: 'finished', canceled: run.cancelRequested });
      });
      child.postMessage({ type: 'start', runId: id, dest: card.dest, files: jobs });
    }
    pushUpdate(true);
    return { ok: true, run: snapshot() };
  }

  function cancel() {
    if (!run || run.state !== 'running') return { ok: false };
    run.cancelRequested = true;
    for (const child of children) { try { child.postMessage({ type: 'cancel' }); } catch (_) {} }
    pushUpdate(true);
    return { ok: true };
  }

  /** Clear a finished run so the overlay starts fresh. */
  function dismiss() {
    if (run && run.state !== 'running') run = null;
    return { ok: true };
  }

  return {
    startWatching, stopWatching, poll,
    listCards: () => cards,
    thumbnail, deepScan, cancelDeepScan,
    refresh: async () => { await poll(); return cards; },
    check, startIngest, cancel, dismiss, snapshot
  };
}

module.exports = { createCardIngest, scanCard, listCards, describeCard, summarize };
