'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── Chunked-upload resilience ────────────────────────────────────────────────
//
// A render push is a long-running background transfer aimed at a server that
// legitimately goes away for short stretches: the LPOS nightly restart, a
// deploy, a Tailscale reconnect, a NAS hiccup behind the API. Until this was
// added, any one of those turned into a terminal uploadStatus='failed' on the
// very first throw — stranding an export that had nothing wrong with it, on a
// row the Exports UI could no longer offer a push for.
//
// Retrying is cheap only because the transfer is genuinely resumable: LPOS
// keeps the partial temp file keyed by `uploadId` and reports its own
// authoritative byte count (the 409 `offset_mismatch` payload), so a retry
// against the SAME session picks up where the wire died instead of re-sending
// the file. The budget is therefore per-chunk and resets on every byte of
// forward progress — a 40-minute upload can absorb several outages, while a
// server that is genuinely gone still fails inside one window.
const UPLOAD_RETRY_WINDOW_MS = 5 * 60_000;  // per-chunk budget, reset on progress
const UPLOAD_RETRY_BASE_MS   = 2_000;       // 2s, 4s, 8s, 16s, 30s, 30s…
const UPLOAD_RETRY_MAX_MS    = 30_000;

// HTTP statuses worth waiting out. Everything else — 400/401/403/404/410/415,
// and 507 (storage drive disconnected) — is a verdict LPOS has already reached
// and would reach again, so we fail fast and surface it. 503 is in the set
// because that is what the init route returns while the ingest queue is still
// coming up, which is precisely the tail of a restart we want to ride out.
const TRANSIENT_UPLOAD_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * True when a failed upload request is worth retrying against the same session.
 * An error carrying no `status` came from fetch itself (ECONNREFUSED,
 * ENOTFOUND, ECONNRESET, socket hang up) or from our own AbortController
 * timeout — i.e. LPOS never rendered a verdict at all, which is exactly the
 * "LPOS is down" case this policy exists for.
 */
function isTransientUploadError(err) {
  if (!err) return false;
  if (err.status === undefined || err.status === null) return true;
  return TRANSIENT_UPLOAD_STATUSES.has(err.status);
}

/** Backoff for attempt N (1-based), capped at UPLOAD_RETRY_MAX_MS. */
function retryBackoffMs(attempt) {
  return Math.min(UPLOAD_RETRY_MAX_MS, UPLOAD_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * Sleep that bails out early when the caller cancels, so a cancelled export
 * doesn't sit through a 30s backoff before noticing. Resolves either way —
 * the caller re-checks isCancelled at the top of its loop and performs the
 * real teardown (session DELETE) there, keeping cancellation in one place.
 */
function sleepUnlessCancelled(ms, isCancelled) {
  return new Promise((resolve) => {
    if (!isCancelled) { setTimeout(resolve, ms); return; }
    const started = Date.now();
    const tick = setInterval(() => {
      if (isCancelled() || Date.now() - started >= ms) { clearInterval(tick); resolve(); }
    }, 250);
  });
}

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
   * Get the production-slate notes + shoot-day tabs for a project. Used by the
   * Timeline Setup task to name per-recording timelines from the video codes and
   * drop code markers. Distinct from getProjectNotes (general ProjectNotes).
   * Returns { notes: [{ timestamp, code, note, tabId }], tabs: [{ id, name }] }.
   * @param {string} projectId
   * @param {string} [tabId] optional shoot-day tab filter
   */
  async getSlateNotes(projectId, tabId) {
    const q = tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
    return this._request('GET', `/api/ep/projects/${encodeURIComponent(projectId)}/slate-notes${q}`);
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
   * Run a one-shot upload request under the transient-failure retry policy.
   * Used for the init and finalize calls, which are single round-trips with
   * nothing to resume; the chunk loop keeps its own inline retry because it
   * must also handle offset realignment on the way through.
   */
  async _retryTransient(phase, fn, opts = {}) {
    const windowMs = Number.isFinite(opts.retryWindowMs) ? opts.retryWindowMs : UPLOAD_RETRY_WINDOW_MS;
    const deadline = Date.now() + windowMs;
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!isTransientUploadError(err)) throw err;
        if (opts.isCancelled && opts.isCancelled()) throw err;
        attempt += 1;
        const waitMs = retryBackoffMs(attempt);
        if (Date.now() + waitMs > deadline) throw err;
        if (opts.onRetry) opts.onRetry({ phase, attempt, waitMs, error: err.message });
        await sleepUnlessCancelled(waitMs, opts.isCancelled);
      }
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
   * @param {number} [opts.retryWindowMs]  per-chunk transient-failure budget
   *   (default UPLOAD_RETRY_WINDOW_MS). Reset on every byte of forward
   *   progress, so this bounds one stall, not the whole transfer.
   * @param {(r: {phase:string, attempt:number, waitMs:number, offset?:number, error:string}) => void} [opts.onRetry]
   *   Called before each backoff sleep so the UI can show "retrying" rather
   *   than a frozen progress bar. phase is 'init' | 'chunk' | 'finalize'.
   * @param {object|null} [opts.renderMeta]  Phase 5c.1 (2026-06-02): editpanel
   *   render provenance — when present, sent on the finalize POST body so LPOS
   *   persists an editorial_links row tying this asset to a Resolve timeline.
   *   Fields: timelineUid, timelineName, timelineStartTimecode, timelineFps,
   *   resolveProjectName, renderedAt, renderedFromMachine. Null/omitted for
   *   non-editpanel uploads.
   */
  async uploadFileToProject(projectId, filePath, opts = {}) {
    const fileName  = opts.fileName || path.basename(filePath);
    const chunkSize = opts.chunkSize || 8 * 1024 * 1024;
    const pid = encodeURIComponent(projectId);

    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;
    if (fileSize <= 0) throw new Error(`File is empty or missing: ${filePath}`);

    // Retry options shared by every phase of this upload.
    const retryOpts = {
      retryWindowMs: opts.retryWindowMs,
      isCancelled:   opts.isCancelled,
      onRetry:       opts.onRetry,
    };

    // Init is retried too, so an export that finishes rendering *during* an
    // LPOS restart doesn't fail before it has sent a single byte. A retried
    // init whose first attempt actually landed (response lost in flight)
    // orphans an empty session server-side; LPOS's own stale-session sweep
    // clears those after an hour, which is the right trade against failing
    // the push outright.
    const init = await this._retryTransient(
      'init',
      () => this._uploadRequest('POST', `/api/ep/projects/${pid}/media/upload`, {
        json: { filename: fileName, fileSize }
      }),
      retryOpts,
    );
    const uploadId = init.uploadId;
    let offset = init.bytesReceived || 0;

    const handle = await fs.promises.open(filePath, 'r');
    // Retry bookkeeping for the chunk currently in flight. Both reset on every
    // successful chunk (and on a realign), so the budget bounds a single stall
    // rather than the whole transfer.
    let chunkAttempt  = 0;
    let chunkDeadline = 0;
    const chunkWindowMs = Number.isFinite(opts.retryWindowMs) ? opts.retryWindowMs : UPLOAD_RETRY_WINDOW_MS;
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
            chunkAttempt = 0;
            chunkDeadline = 0;
            continue;
          }

          // Transient failure (LPOS restarting, network drop, gateway 5xx):
          // wait, then re-send THIS chunk against the SAME uploadId. The server
          // still holds the partial temp file, so this resumes rather than
          // restarts. If the chunk actually landed before the connection died,
          // the re-send comes back as offset_mismatch and realigns above — so
          // the retry is safe against a lost response, not just a lost request.
          if (!isTransientUploadError(err)) throw err;
          if (!chunkDeadline) chunkDeadline = Date.now() + chunkWindowMs;
          chunkAttempt += 1;
          const waitMs = retryBackoffMs(chunkAttempt);
          if (Date.now() + waitMs > chunkDeadline) throw err;
          if (opts.onRetry) {
            opts.onRetry({ phase: 'chunk', attempt: chunkAttempt, waitMs, offset, error: err.message });
          }
          await sleepUnlessCancelled(waitMs, opts.isCancelled);
          continue;
        }

        offset = res.bytesReceived;
        chunkAttempt = 0;
        chunkDeadline = 0;
        if (opts.onProgress) {
          opts.onProgress({ bytesUploaded: offset, fileSize, pct: Math.round((offset / fileSize) * 100) });
        }
      }
    } finally {
      await handle.close();
    }

    // Phase 5c.1 (2026-06-02): on finalize, send the editpanel renderMeta body
    // when the caller provided one. LPOS's parseRenderMeta is lenient on absence
    // (empty/missing body → no editorial_links row written; just a plain asset
    // registration) but strict on shape, so we send the whole object as-is and
    // let the server validate.
    const finalizeOpts = opts.renderMeta
      ? { json: { renderMeta: opts.renderMeta } }
      : {};
    try {
      return await this._retryTransient(
        'finalize',
        () => this._uploadRequest('POST', `/api/ep/projects/${pid}/media/upload/${uploadId}/finalize`, finalizeOpts),
        retryOpts,
      );
    } catch (err) {
      // A finalize whose *response* was lost gets retried, and LPOS answers the
      // second attempt with 409 "Upload session is finalized". The bytes did
      // land and the asset did register — reporting that as a failure would
      // strand (or duplicate) a file that is already in LPOS. Return success
      // with a null asset: we can't recover the assetId here, because
      // GET /api/ep/uploads/:uploadId/asset gates on status === 'complete',
      // a value the finalize route never writes (it writes 'finalized'), so
      // that endpoint always answers null. Callers must therefore treat a
      // missing assetId as "uploaded, id unknown", not as a failure.
      if (err.status === 409 && /is finalized/i.test(err.message || '')) {
        return { asset: null, alreadyFinalized: true };
      }
      throw err;
    }
  }

  /**
   * Phase 5c.10 (2026-06-03): toggle the completed/resolved state of a
   * comment from editpanel.
   *
   * As of 2026-06-09 (local-comments refactor Phase 2, lpos-dashboard
   * commit 02f75f5), the EP-token PATCH endpoint became local-first: LPOS
   * flips the local media_comments row instantly and enqueues a
   * media_comment_mirror_jobs row that the MediaCommentMirrorService
   * worker drains to Frame.io eventually-consistently. The wire shape
   * here is unchanged — the route still returns {ok, completed, commentId}
   * — but the semantics are now "200 = local write committed, mirror
   * pending" rather than "200 = Frame.io PATCH succeeded".
   *
   * The `commentId` may be a Frame.io comment id (what editpanel's
   * Pull Comments report carries today) or a local LPOS comment_id; the
   * server resolves either via getMediaCommentByEitherId.
   *
   * @param {string} projectId
   * @param {string} assetId
   * @param {string} commentId  Frame.io OR local id — server accepts both
   * @param {boolean} completed
   */
  async setCommentCompleted(projectId, assetId, commentId, completed) {
    return this._request(
      'PATCH',
      `/api/ep/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/comments/${encodeURIComponent(commentId)}`,
      { body: { completed: Boolean(completed) } }
    );
  }

  // ── Feature requests / Wish List ─────────────────────────────────────────
  //
  // The shared LPOS Wish List, surfaced in EditPanel as a Feedback button so
  // editors can file feature requests / to-dos that the LPOS owner reviews in
  // the dashboard. Reads return the full list (all instances see the same
  // thing); writes are stamped source='editpanel' server-side and attributed to
  // this machine's linked LPOS user.

  /** List all wishes (feature requests) — shared across every EditPanel instance. */
  async listWishes() {
    return this._request('GET', '/api/ep/wishes');
  }

  /**
   * Submit a feature request from this machine.
   * @param {{ title: string, description?: string, instance?: string }} payload
   */
  async createWish(payload) {
    return this._request('POST', '/api/ep/wishes', { body: payload });
  }

  // B2-related methods removed 2026-05-27. Cold-storage monitoring &
  // bucket management moved entirely LPOS-side — see lpos-dashboard
  // /settings/storage. EditPanel no longer touches B2.
}

module.exports = { LposClient };
