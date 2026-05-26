'use strict';

/**
 * b2_client.js — Backblaze B2 direct-access layer for the editpanel media browser.
 *
 * Uses B2's S3-compatible API via @aws-sdk/client-s3.
 * Files are stored as individual S3 objects (NOT Synology HyperBackup format).
 *
 * Supports prefix-based folder navigation with a '/' delimiter, so any
 * key structure (e.g. projects/PROJ-001/footage.mov) is browsable naturally.
 *
 * Required env vars (via Doppler):
 *   B2_MEDIA_ENDPOINT          — full S3-compatible URL, e.g. https://s3.us-west-004.backblazeb2.com
 *   B2_MEDIA_KEY_ID            — Backblaze Application Key ID
 *   B2_MEDIA_APPLICATION_KEY   — Backblaze Application Key
 *   B2_MEDIA_BUCKET            — bucket name
 */

const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

// ── Config ────────────────────────────────────────────────────────────────────

function isConfigured() {
  return !!(
    process.env.B2_MEDIA_ENDPOINT &&
    process.env.B2_MEDIA_KEY_ID &&
    process.env.B2_MEDIA_APPLICATION_KEY &&
    process.env.B2_MEDIA_BUCKET
  );
}

function makeClient() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.B2_MEDIA_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.B2_MEDIA_KEY_ID,
      secretAccessKey: process.env.B2_MEDIA_APPLICATION_KEY,
    },
  });
}

function getBucket() {
  return process.env.B2_MEDIA_BUCKET || '';
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Paginate through all objects under a prefix (no delimiter — flat scan). */
async function listAllObjects(client, bucket, prefix) {
  const objects = [];
  let continuationToken;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket:            bucket,
      Prefix:            prefix,
      ContinuationToken: continuationToken,
    }));
    if (res.Contents) objects.push(...res.Contents);
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List one "directory" level using the '/' delimiter.
 * Returns { ok, data: { folders: [{ prefix, name }], files: [{ key, name, size, lastModified }] } }
 *
 * - folders: S3 CommonPrefixes — virtual folders; navigate into with listDirectory(folder.prefix)
 * - files:   S3 Contents at this level only (direct children, not recursive)
 */
async function listDirectory(prefix = '') {
  if (!isConfigured()) return { ok: false, error: 'B2 credentials not configured' };
  try {
    const client  = makeClient();
    const bucket  = getBucket();
    const folders = [];
    const files   = [];
    let continuationToken;

    do {
      const res = await client.send(new ListObjectsV2Command({
        Bucket:            bucket,
        Prefix:            prefix,
        Delimiter:         '/',
        ContinuationToken: continuationToken,
      }));

      // CommonPrefixes → virtual "folders"
      for (const cp of res.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue;
        const name = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
        folders.push({ prefix: cp.Prefix, name });
      }

      // Contents → files at this level (skip the prefix "folder" placeholder if present)
      for (const obj of res.Contents ?? []) {
        if (!obj.Key || obj.Key === prefix) continue;
        files.push({
          key:          obj.Key,
          name:         obj.Key.slice(prefix.length),
          size:         obj.Size || 0,
          lastModified: obj.LastModified ?? null,
        });
      }

      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return { ok: true, data: { folders, files } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get aggregate stats for the entire bucket (full paginated scan).
 * This can be slow for large buckets — call on demand, not automatically.
 * Returns { ok, data: { fileCount, totalBytes, lastModified } }
 */
async function getBucketStats() {
  if (!isConfigured()) return { ok: false, error: 'B2 credentials not configured' };
  try {
    const client  = makeClient();
    const bucket  = getBucket();
    const objects = await listAllObjects(client, bucket, '');

    let totalBytes   = 0;
    let lastModified = null;
    for (const obj of objects) {
      totalBytes += obj.Size || 0;
      if (!lastModified || obj.LastModified > lastModified) {
        lastModified = obj.LastModified;
      }
    }

    return { ok: true, data: { fileCount: objects.length, totalBytes, lastModified } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Delete a single object by key.
 * Returns { ok }
 */
async function deleteFile(key) {
  if (!isConfigured()) return { ok: false, error: 'B2 credentials not configured' };
  if (!key)            return { ok: false, error: 'No key provided' };
  try {
    const client = makeClient();
    const bucket = getBucket();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Delete all objects under a prefix (folder deletion).
 * Returns { ok, data: { deleted: number } }
 */
async function deleteFolder(prefix) {
  if (!isConfigured()) return { ok: false, error: 'B2 credentials not configured' };
  if (!prefix)         return { ok: false, error: 'Cannot delete root — specify a folder prefix' };
  try {
    const client  = makeClient();
    const bucket  = getBucket();
    const objects = await listAllObjects(client, bucket, prefix);

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

module.exports = { isConfigured, listDirectory, getBucketStats, deleteFile, deleteFolder };
