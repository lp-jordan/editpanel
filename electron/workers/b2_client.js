'use strict';

/**
 * b2_client.js — Backblaze B2 direct-access layer for the editpanel media browser.
 *
 * Uses B2's S3-compatible API via @aws-sdk/client-s3.
 * Files are stored as individual S3 objects (NOT Synology HyperBackup format).
 *
 * Credentials are fetched at runtime from LPOS via /api/ep/b2-creds — LPOS
 * mints a bucket-scoped Backblaze key with a 1h TTL using the master key
 * (which never leaves LPOS Doppler). Editpanel caches the creds in-memory
 * and refreshes them ~5 minutes before they expire.
 *
 * Each exported function accepts the LposClient as its last argument so the
 * caller (IPC handlers in main.js) can wire whichever client is current.
 */

const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

// ── Creds cache ───────────────────────────────────────────────────────────────

const REFRESH_LEAD_MS = 5 * 60 * 1000;  // refresh 5 min before expiresAt

let cached = null;  // { keyId, applicationKey, endpoint, bucket, expiresAt: number }
let cachedClient = null;  // S3Client built from cached
let inflight = null;  // de-dupe concurrent refreshes

function isCachedFresh() {
  return Boolean(cached && cached.expiresAt - REFRESH_LEAD_MS > Date.now());
}

/** Build (or return cached) S3 client. Refreshes creds via LPOS if needed. */
async function getClient(lposClient) {
  if (!lposClient || !lposClient.isConfigured()) {
    throw new Error('Not signed in to LPOS — sign in from Settings to access B2');
  }
  if (cachedClient && isCachedFresh()) return cachedClient;

  if (!inflight) {
    inflight = (async () => {
      const result = await lposClient.getB2Creds();
      if (!result?.ok || !result.data) {
        throw new Error(result?.error || 'LPOS did not return B2 credentials');
      }
      const d = result.data;
      cached = {
        keyId:          d.keyId,
        applicationKey: d.applicationKey,
        endpoint:       d.endpoint,
        bucket:         d.bucket,
        expiresAt:      new Date(d.expiresAt).getTime(),
      };
      cachedClient = new S3Client({
        region: 'auto',
        endpoint: cached.endpoint,
        credentials: {
          accessKeyId:     cached.keyId,
          secretAccessKey: cached.applicationKey,
        },
      });
      return cachedClient;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

function getBucket() {
  return cached?.bucket || '';
}

/** Clear the cache — call after sign-out so a fresh sign-in fetches new creds. */
function invalidateCache() {
  cached = null;
  cachedClient = null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * Whether the LPOS connection is signed in. This is the new "configured" signal —
 * B2 creds themselves are fetched on demand, so the gating question becomes
 * "can we reach LPOS to mint a key?".
 */
function isConfigured(lposClient) {
  return Boolean(lposClient && lposClient.isConfigured());
}

/**
 * List one "directory" level using the '/' delimiter.
 * Returns { ok, data: { folders: [{ prefix, name }], files: [{ key, name, size, lastModified }] } }
 */
async function listDirectory(prefix = '', lposClient) {
  if (!isConfigured(lposClient)) return { ok: false, error: 'Not signed in to LPOS' };
  try {
    const client  = await getClient(lposClient);
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

      for (const cp of res.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue;
        const name = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
        folders.push({ prefix: cp.Prefix, name });
      }

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
 * Call on demand — can be slow for large buckets.
 */
async function getBucketStats(lposClient) {
  if (!isConfigured(lposClient)) return { ok: false, error: 'Not signed in to LPOS' };
  try {
    const client  = await getClient(lposClient);
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

/** Delete a single object by key. */
async function deleteFile(key, lposClient) {
  if (!isConfigured(lposClient)) return { ok: false, error: 'Not signed in to LPOS' };
  if (!key)                     return { ok: false, error: 'No key provided' };
  try {
    const client = await getClient(lposClient);
    const bucket = getBucket();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Delete all objects under a prefix (folder deletion). */
async function deleteFolder(prefix, lposClient) {
  if (!isConfigured(lposClient)) return { ok: false, error: 'Not signed in to LPOS' };
  if (!prefix)                  return { ok: false, error: 'Cannot delete root — specify a folder prefix' };
  try {
    const client  = await getClient(lposClient);
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

module.exports = {
  isConfigured,
  listDirectory,
  getBucketStats,
  deleteFile,
  deleteFolder,
  invalidateCache,
};
