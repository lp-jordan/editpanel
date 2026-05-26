'use strict';

/**
 * b2_client.js — Backblaze B2 access layer for the editpanel backup manager.
 *
 * Uses B2's S3-compatible API via @aws-sdk/client-s3.
 * Runs in the Electron main process only (not a worker subprocess).
 *
 * Expected object key structure:
 *   backups/YYYY-MM-DD/<dbname>.gz          — SQLite snapshots
 *   backups/YYYY-MM-DD/state/<file>.gz      — top-level JSON config files
 *   backups/YYYY-MM-DD/projects/<id>/<path>.gz — per-project JSON state
 *
 * Required env vars (via Doppler):
 *   B2_ENDPOINT          — full S3-compatible URL, e.g. https://s3.us-west-004.backblazeb2.com
 *   B2_KEY_ID            — Backblaze Application Key ID
 *   B2_APPLICATION_KEY   — Backblaze Application Key
 *   B2_BUCKET            — bucket name
 */

const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const BACKUP_PREFIX = 'backups/';
const MAX_PREVIEW_BYTES = 512 * 1024; // 512 KB — refuse to load larger files for preview

function isConfigured() {
  return !!(
    process.env.B2_ENDPOINT &&
    process.env.B2_KEY_ID &&
    process.env.B2_APPLICATION_KEY &&
    process.env.B2_BUCKET
  );
}

function makeClient() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.B2_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APPLICATION_KEY
    }
  });
}

function getBucket() {
  return process.env.B2_BUCKET || '';
}

/** Paginated list of all objects under a given prefix. */
async function listAllObjects(client, bucket, prefix) {
  const objects = [];
  let continuationToken;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket:            bucket,
      Prefix:            prefix,
      ContinuationToken: continuationToken
    }));
    if (res.Contents) objects.push(...res.Contents);
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

/**
 * List unique backup dates, newest first.
 * Returns { ok, data: Array<{ date, fileCount, totalBytes, lastModified }> }
 */
async function listDates() {
  if (!isConfigured()) return { ok: false, error: 'B2 credentials not configured' };
  try {
    const client = makeClient();
    const bucket = getBucket();
    const objects = await listAllObjects(client, bucket, BACKUP_PREFIX);

    const dateMap = new Map();
    for (const obj of objects) {
      const match = obj.Key?.match(/^backups\/(\d{4}-\d{2}-\d{2})\//);
      if (!match) continue;
      const date = match[1];
      if (!dateMap.has(date)) {
        dateMap.set(date, { date, fileCount: 0, totalBytes: 0, lastModified: null });
      }
      const entry = dateMap.get(date);
      entry.fileCount++;
      entry.totalBytes += obj.Size || 0;
      if (!entry.lastModified || obj.LastModified > entry.lastModified) {
        entry.lastModified = obj.LastModified;
      }
    }

    const dates = Array.from(dateMap.values())
      .sort((a, b) => b.date.localeCompare(a.date));
    return { ok: true, data: dates };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * List all files for a specific date, grouped with metadata.
 * Returns { ok, data: Array<{ key, name, size, lastModified, previewable, isSqlite }> }
 */
async function listDateFiles(date) {
  if (!isConfigured()) return { ok: false, error: 'B2 credentials not configured' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid date format' };
  try {
    const client = makeClient();
    const bucket = getBucket();
    const prefix = `${BACKUP_PREFIX}${date}/`;
    const objects = await listAllObjects(client, bucket, prefix);

    const files = objects.map(obj => {
      const name = obj.Key.slice(prefix.length);
      const isSqlite = name.includes('.sqlite');
      const isJson = name.endsWith('.json.gz');
      return {
        key:          obj.Key,
        name,
        size:         obj.Size || 0,
        lastModified: obj.LastModified,
        previewable:  isJson && (obj.Size || 0) <= MAX_PREVIEW_BYTES,
        tooBig:       isJson && (obj.Size || 0) > MAX_PREVIEW_BYTES,
        isSqlite,
        isJson
      };
    });

    return { ok: true, data: files };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Download and decompress a .gz file from B2.
 * Returns { ok, data: string } — pretty-printed JSON or raw text.
 */
async function getFileContent(key) {
  if (!isConfigured()) return { ok: false, error: 'B2 credentials not configured' };
  if (!key.endsWith('.gz')) return { ok: false, error: 'Only .gz files are previewable' };

  try {
    const client = makeClient();
    const bucket = getBucket();
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of res.Body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_PREVIEW_BYTES * 3) {
        return { ok: false, error: 'File too large to preview' };
      }
      chunks.push(buf);
    }

    const compressed   = Buffer.concat(chunks);
    const decompressed = await gunzip(compressed);
    const text = decompressed.toString('utf8');

    try {
      return { ok: true, data: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      return { ok: true, data: text };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Delete all files under backups/<date>/.
 * Returns { ok, data: { deleted: number } }
 */
async function deleteDate(date) {
  if (!isConfigured()) return { ok: false, error: 'B2 credentials not configured' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid date format' };
  try {
    const client = makeClient();
    const bucket = getBucket();
    const objects = await listAllObjects(client, bucket, `${BACKUP_PREFIX}${date}/`);

    let deleted = 0;
    for (const obj of objects) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
      deleted++;
    }
    return { ok: true, data: { deleted } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Delete a single B2 object by key.
 * Returns { ok }
 */
async function deleteFile(key) {
  if (!isConfigured()) return { ok: false, error: 'B2 credentials not configured' };
  try {
    const client = makeClient();
    const bucket = getBucket();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { isConfigured, listDates, listDateFiles, getFileContent, deleteDate, deleteFile };
