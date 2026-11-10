'use strict';

/**
 * card_ingest_fs.js — file helpers shared by the card ingest engine (main
 * process) and its copy process (card_ingest_copy.js, a utilityProcess).
 *
 * Identity of a file is its CONTENT, never its card, camera or name (cards get
 * hot-swapped and reformatted; the FX3 and FX6 both reuse clip numbers). The
 * cheap fingerprint is `sampleHash`: SHA-1 over the size plus three 1 MB
 * windows (start, middle, end). Camera files carry a unique UMID and creation
 * time in their header, so two different clips never share a sample hash in
 * practice; the full-file hash is only computed while copying.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const SAMPLE_BYTES = 1024 * 1024;
// Suffix of a file still being copied. Reserves the final name (opened with
// 'wx') so two cards copying into one folder can't pick the same name.
const TEMP_SUFFIX = '.ingesting';

async function statOrNull(p) {
  try { return await fsp.stat(p); } catch (_) { return null; }
}

async function sampleHash(filePath, size) {
  const hash = crypto.createHash('sha1');
  hash.update(String(size));
  const fh = await fsp.open(filePath, 'r');
  try {
    const offsets = size <= SAMPLE_BYTES * 3
      ? [0]
      : [0, Math.floor(size / 2) - SAMPLE_BYTES / 2, size - SAMPLE_BYTES];
    const len = size <= SAMPLE_BYTES * 3 ? size : SAMPLE_BYTES;
    const buf = Buffer.alloc(Math.max(1, len));
    for (const off of offsets) {
      const { bytesRead } = await fh.read(buf, 0, len, off);
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

/** C2961.MP4 → C2961.MP4, C2961_2.MP4, C2961_3.MP4, … */
function candidateName(name, n) {
  if (n <= 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)}_${n}${ext}`;
}

/**
 * Where `name` (size + sample) lands in `dir`.
 *   { status: 'on-nas', destName }  — that name (or a suffixed one) already
 *                                     holds this exact file
 *   { status: 'copy',   destName }  — free under its own name
 *   { status: 'rename', destName }  — its name is taken by different content
 * `reserved` (Set of lower-cased names) holds names other files in the same
 * plan will take, so a plan never puts two files on one name.
 */
async function resolveTarget(dir, name, size, sample, reserved = new Set()) {
  for (let n = 1; n < 1000; n++) {
    const cand = candidateName(name, n);
    if (reserved.has(cand.toLowerCase())) continue;
    const st = await statOrNull(path.join(dir, cand));
    if (!st) return { status: n === 1 ? 'copy' : 'rename', destName: cand };
    if (st.isFile() && st.size === size) {
      try {
        if (await sampleHash(path.join(dir, cand), size) === sample) {
          return { status: 'on-nas', destName: cand };
        }
      } catch (_) { /* unreadable: treat as taken */ }
    }
  }
  throw new Error(`No free name for ${name} in ${dir}`);
}

module.exports = { SAMPLE_BYTES, TEMP_SUFFIX, statOrNull, sampleHash, candidateName, resolveTarget };
