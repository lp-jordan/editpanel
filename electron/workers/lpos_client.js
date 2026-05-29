'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * LposClient — read/write client for the lpos-dashboard /api/ep/ namespace.
 *
 * Auth: per-machine opaque token in the X-EP-Token header. The token is minted
 * by the LPOS /ep/link approval flow and delivered to editpanel via the
 * lpos-editpanel:// URL scheme callback. It is persisted in the editpanel
 * preferences file (see ControlPlane).
 *
 * Config: baseUrl + token come from preferences. No env fallback — if either
 * is missing, the user must complete Sign in to LPOS in Settings.
 */
class LposClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || '').replace(/\/$/, '');
    this.token   = options.token || '';
    this.timeout = Number(options.timeout || 10_000);
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.token);
  }

  async _request(method, endpoint, options = {}) {
    if (!this.baseUrl) {
      throw new Error('LPOS base URL not configured — set it in EditPanel Settings');
    }
    if (!this.token) {
      throw new Error('Not signed in to LPOS — open Settings and click Sign in to LPOS');
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'x-ep-token': this.token,
      'content-type': 'application/json'
    };

    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`LPOS API ${response.status} ${method} ${endpoint}: ${text}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return await response.json();
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Lightweight ping — confirms connectivity and auth. Also returns the user payload. */
  async checkHealth() {
    return this._request('GET', '/api/ep/health');
  }

  /**
   * Send a heartbeat with the current machine state.
   * @param {object} payload
   * @param {string} payload.instance_id
   * @param {string} [payload.display_name]
   * @param {boolean} [payload.resolve_connected]
   * @param {string|null} [payload.resolve_project]
   * @param {string|null} [payload.resolve_timeline]
   * @param {number} [payload.jobs_queued]
   * @param {number} [payload.jobs_running]
   */
  async pushStatus(payload) {
    return this._request('POST', '/api/ep/status', { body: payload });
  }

  /** List all LPOS projects. */
  async listProjects() {
    return this._request('GET', '/api/ep/projects');
  }

  /** Get a single project by ID. */
  async getProject(projectId) {
    return this._request('GET', `/api/ep/projects/${encodeURIComponent(projectId)}`);
  }

  /** List a project's media assets (id + names) — used for the pre-export version check. */
  async listProjectAssets(projectId) {
    return this._request('GET', `/api/ep/projects/${encodeURIComponent(projectId)}/media/assets`);
  }

  /** Get production notes for a project (for note markers). */
  async getProjectNotes(projectId) {
    return this._request('GET', `/api/ep/projects/${encodeURIComponent(projectId)}/notes`);
  }

  /**
   * Get Frame.io comments for an asset (for comment markers).
   * @param {string} projectId
   * @param {string} assetId
   */
  async getAssetComments(projectId, assetId) {
    return this._request(
      'GET',
      `/api/ep/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/comments`
    );
  }

  /**
   * Resolve an upload session ID to a LPOS asset ID.
   * Used by the export registry after a render upload completes.
   * @param {string} uploadId
   */
  async resolveUpload(uploadId) {
    return this._request('GET', `/api/ep/uploads/${encodeURIComponent(uploadId)}/asset`);
  }

  // ─── Chunked media upload (X-EP-Token) ────────────────────────────────────

  /**
   * Lower-level request used by the chunked uploader. Unlike _request it can
   * send a binary body + custom headers, and on a non-2xx response it throws an
   * Error carrying `.status` and `.data` so callers can branch on error codes
   * (e.g. offset_mismatch, version_confirmation_required) instead of just a string.
   */
  async _uploadRequest(method, endpoint, { json, body, headers, timeout } = {}) {
    if (!this.baseUrl) throw new Error('LPOS base URL not configured — set it in EditPanel Settings');
    if (!this.token)   throw new Error('Not signed in to LPOS — open Settings and click Sign in to LPOS');

    const url = `${this.baseUrl}${endpoint}`;
    const h = { 'x-ep-token': this.token, ...(headers || {}) };
    let reqBody;
    if (json !== undefined) { h['content-type'] = 'application/json'; reqBody = JSON.stringify(json); }
    else if (body !== undefined) { reqBody = body; }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || 120_000);
    try {
      const response = await fetch(url, { method, headers: h, body: reqBody, signal: controller.signal });
      const ct = response.headers.get('content-type') || '';
      const payload = ct.includes('application/json')
        ? await response.json().catch(() => null)
        : await response.text().catch(() => null);
      if (!response.ok) {
        const err = new Error(
          (payload && payload.error) || `LPOS API ${response.status} ${method} ${endpoint}`
        );
        err.status = response.status;
        err.data = payload;
        throw err;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Upload a local file into an LPOS project as a media asset, chunked +
   * resumable. Returns the finalize payload ({ asset }) on success; throws on
   * failure (err.data.code carries duplicate_version / version_confirmation_required).
   *
   * @param {string} projectId
   * @param {string} filePath  absolute path to the file on this machine
   * @param {object} [opts]
   * @param {string} [opts.fileName]   override the upload filename (default basename)
   * @param {number} [opts.chunkSize]  bytes per chunk (default 8 MiB)
   * @param {(p: {bytesUploaded:number, fileSize:number, pct:number}) => void} [opts.onProgress]
   * @param {() => boolean} [opts.isCancelled]  abort the upload if this returns true
   */
  async uploadFileToProject(projectId, filePath, opts = {}) {
    const fileName  = opts.fileName || path.basename(filePath);
    const chunkSize = opts.chunkSize || 8 * 1024 * 1024;
    const pid = encodeURIComponent(projectId);

    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;
    if (fileSize <= 0) throw new Error(`File is empty or missing: ${filePath}`);

    const init = await this._uploadRequest('POST', `/api/ep/projects/${pid}/media/upload`, {
      json: { filename: fileName, fileSize }
    });
    const uploadId = init.uploadId;
    let offset = init.bytesReceived || 0;

    const handle = await fs.promises.open(filePath, 'r');
    try {
      while (offset < fileSize) {
        if (opts.isCancelled && opts.isCancelled()) {
          // Best-effort abort so the server releases the temp file + ingest job.
          try {
            await this._uploadRequest('DELETE', `/api/ep/projects/${pid}/media/upload/${uploadId}`, {});
          } catch (_) { /* ignore */ }
          throw new Error('Upload cancelled');
        }

        const end = Math.min(offset + chunkSize, fileSize);
        const len = end - offset;
        const buf = Buffer.allocUnsafe(len);
        await handle.read(buf, 0, len, offset);

        let res;
        try {
          res = await this._uploadRequest('PATCH', `/api/ep/projects/${pid}/media/upload/${uploadId}`, {
            body: buf,
            headers: { 'upload-offset': String(offset), 'content-type': 'application/octet-stream' }
          });
        } catch (err) {
          // Server and client disagree on the resume point — realign and retry.
          if (err.status === 409 && err.data && err.data.code === 'offset_mismatch'
              && Number.isFinite(err.data.expected)) {
            offset = err.data.expected;
            continue;
          }
          throw err;
        }

        offset = res.bytesReceived;
        if (opts.onProgress) {
          opts.onProgress({ bytesUploaded: offset, fileSize, pct: Math.round((offset / fileSize) * 100) });
        }
      }
    } finally {
      await handle.close();
    }

    return this._uploadRequest('POST', `/api/ep/projects/${pid}/media/upload/${uploadId}/finalize`, {});
  }

  // B2-related methods removed 2026-05-27. Cold-storage monitoring &
  // bucket management moved entirely LPOS-side — see lpos-dashboard
  // /settings/storage. EditPanel no longer touches B2.
}

module.exports = { LposClient };
