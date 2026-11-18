'use strict';

/**
 * card_ingest_copy.js — copies one camera card's files to the NAS, verified.
 *
 * Runs as an Electron utilityProcess (one per card, so two cards copy in
 * parallel and the SHA-1 work stays off the main thread). Also runs under a
 * plain `child_process.fork` for testing outside Electron.
 *
 * Per file:
 *   1. resolveTarget again (the folder may have changed since the check) and
 *      reserve the final name by creating <name>.<runId>.ingesting with 'wx'.
 *      Temp files from any other run are debris from a crash and are removed
 *      when the run starts, so they never push a file onto a _2 name.
 *   2. copy card → temp, hashing the source as it streams
 *   3. re-read the temp file from the NAS and hash it; mismatch = failed
 *   A failed read (card or NAS) is retried from the same byte, reopening the
 *   file, after 1, 3 and 10 s; errors say which side and step failed (a USB
 *   reader dropping out mid-file gave a bare "UNKNOWN: unknown error, read",
 *   Robin 11-3, 2026-11-18).
 *   4. copy the card's mtime, rename temp → final name
 * The card is only ever read.
 *
 * In:  { type: 'start', runId, dest, files: [{ index, dest?, src, name, size, sample, mtimeMs }] }
 *      (a file's own `dest` wins — stills can go to a different folder)
 *      { type: 'cancel' }
 * Out: { type: 'file-start', index, destName }
 *      { type: 'bytes', index, phase: 'copy'|'verify', bytes }
 *      { type: 'file-done', index, status: 'copied'|'on-nas', destName, destPath, hash }
 *      { type: 'file-error', index, error }
 *      { type: 'finished', canceled }
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { TEMP_SUFFIX, statOrNull, resolveTarget } = require('./card_ingest_fs');

const CHUNK = 8 * 1024 * 1024;
const BYTES_EVERY_MS = 200;
const READ_RETRY_MS = [1000, 3000, 10000];

const port = process.parentPort || null;
function send(msg) {
  if (port) port.postMessage(msg);
  else if (process.send) process.send(msg);
}
function onMessage(fn) {
  if (port) port.on('message', (e) => fn(e.data));
  else process.on('message', fn);
}

let canceled = false;
let runId = 'run';
class Canceled extends Error {}

/** Remove temp files left in `dest` by earlier runs that died mid-copy. */
async function clearDebris(dest) {
  let names = [];
  try { names = await fsp.readdir(dest); } catch (_) { return; }
  const mine = `.${runId}${TEMP_SUFFIX}`;
  for (const n of names) {
    if (n.endsWith(TEMP_SUFFIX) && !n.endsWith(mine)) await fsp.unlink(path.join(dest, n)).catch(() => {});
  }
}

/** Reserve a final name: resolveTarget, then claim <name>.<runId>.ingesting with 'wx'. */
async function reserve(dest, file) {
  const skip = new Set();
  for (let tries = 0; tries < 50; tries++) {
    const target = await resolveTarget(dest, file.name, file.size, file.sample, skip);
    if (target.status === 'on-nas') return { onNas: true, destName: target.destName };
    const tempPath = path.join(dest, `${target.destName}.${runId}${TEMP_SUFFIX}`);
    try {
      const fh = await fsp.open(tempPath, 'wx');
      return { onNas: false, destName: target.destName, tempPath, fh };
    } catch (err) {
      // Another card in this run took the name first: try the next one.
      if (err.code !== 'EEXIST') throw err;
      skip.add(target.destName.toLowerCase());
    }
  }
  throw new Error(`Could not reserve a name for ${file.name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gb = (n) => `${(n / 1e9).toFixed(1)} GB`;

/** Where a failure happened, in words: "Reading the card at 12.3 of 45.3 GB: …". */
function located(what, done, size, err) {
  const e = new Error(`${what} at ${(done / 1e9).toFixed(1)} of ${gb(size)}: ${err.message || err}`);
  e.code = err.code;
  return e;
}

async function hashThrough(readPath, size, index, phase, writeFh, test = {}) {
  const hash = crypto.createHash('sha1');
  const buf = Buffer.allocUnsafe(CHUNK);
  const side = phase === 'copy' ? 'Reading the card' : 'Checking: reading the NAS copy back';
  const open = test.open || ((p) => fsp.open(p, 'r'));
  let rfh;
  try { rfh = await open(readPath); } catch (err) { throw located(side, 0, size, err); }
  let done = 0;
  let lastSent = 0;
  let tries = 0;
  try {
    while (done < size) {
      if (canceled) throw new Canceled();
      let bytesRead;
      try {
        ({ bytesRead } = await rfh.read(buf, 0, Math.min(CHUNK, size - done), done));
      } catch (err) {
        if (tries >= READ_RETRY_MS.length) {
          throw located(side, done, size, new Error(`${err.message || err} (tried ${tries + 1} times)`));
        }
        await rfh.close().catch(() => {});
        rfh = null;
        await sleep((test.retryMs || READ_RETRY_MS)[tries++]);
        if (canceled) throw new Canceled();
        try { rfh = await open(readPath); } catch (_) { /* still gone: the next read fails and counts */ rfh = { read: () => Promise.reject(_), close: async () => {} }; }
        continue;
      }
      if (bytesRead === 0) throw located(side, done, size, new Error(`${path.basename(readPath)} ended early`));
      tries = 0;
      const chunk = buf.subarray(0, bytesRead);
      hash.update(chunk);
      if (writeFh) {
        let off = 0;
        try {
          while (off < bytesRead) {
            const { bytesWritten } = await writeFh.write(chunk, off, bytesRead - off, done + off);
            off += bytesWritten;
          }
        } catch (err) {
          throw located('Writing to the NAS', done + off, size, err);
        }
      }
      done += bytesRead;
      const now = Date.now();
      if (now - lastSent >= BYTES_EVERY_MS || done === size) {
        lastSent = now;
        send({ type: 'bytes', index, phase, bytes: done });
      }
    }
  } finally {
    if (rfh) await rfh.close().catch(() => {});
  }
  return hash.digest('hex');
}

async function copyOne(dest, file) {
  const r = await reserve(dest, file);
  send({ type: 'file-start', index: file.index, destName: r.destName });
  const finalPath = path.join(dest, r.destName);
  if (r.onNas) {
    send({ type: 'file-done', index: file.index, status: 'on-nas', destName: r.destName, destPath: finalPath, hash: null });
    return;
  }

  let fh = r.fh;
  try {
    const srcHash = await hashThrough(file.src, file.size, file.index, 'copy', fh);
    await fh.close();
    fh = null;
    const destHash = await hashThrough(r.tempPath, file.size, file.index, 'verify', null);
    if (destHash !== srcHash) throw new Error('Checksum mismatch after copy: the NAS copy differs from the card');
    if (file.mtimeMs) {
      const t = new Date(file.mtimeMs);
      await fsp.utimes(r.tempPath, t, t).catch(() => {});
    }
    if (await statOrNull(finalPath)) throw new Error(`${r.destName} appeared in the folder during the copy`);
    await fsp.rename(r.tempPath, finalPath);
    send({ type: 'file-done', index: file.index, status: 'copied', destName: r.destName, destPath: finalPath, hash: srcHash });
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fsp.unlink(r.tempPath).catch(() => {});
    throw err;
  }
}

async function run({ runId: id, dest, files }) {
  if (id) runId = String(id);
  // Prepare every folder this card writes to; a folder that can't be made
  // fails only its own files.
  const destError = new Map();
  for (const dir of new Set(files.map(f => f.dest || dest))) {
    try {
      await fsp.mkdir(dir, { recursive: true });
      await clearDebris(dir);
    } catch (err) {
      destError.set(dir, err.message);
    }
  }
  for (const file of files) {
    if (canceled) break;
    const dir = file.dest || dest;
    if (destError.has(dir)) {
      send({ type: 'file-error', index: file.index, error: `Destination: ${destError.get(dir)}` });
      continue;
    }
    try {
      await copyOne(dir, file);
    } catch (err) {
      if (err instanceof Canceled) break;
      send({ type: 'file-error', index: file.index, error: err.message || String(err) });
    }
  }
  send({ type: 'finished', canceled });
}

module.exports = { hashThrough };            // for scripts/test-card-ingest-retry.js

onMessage((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'cancel') canceled = true;
  if (msg.type === 'start') {
    run(msg).catch((err) => {
      send({ type: 'fatal', error: err.message || String(err) });
      send({ type: 'finished', canceled });
    });
  }
});
