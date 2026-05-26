'use strict';

/**
 * LposClient — lightweight read client for the lpos-dashboard /api/ep/ namespace.
 *
 * Auth: shared secret sent as X-EP-Secret header (set in Doppler as EP_SHARED_SECRET
 * on both the editpanel machine and the lpos-dashboard server).
 *
 * Config: baseUrl comes from preferences (Settings page → LPOS Base URL).
 *         secret comes from EP_SHARED_SECRET env var.
 */
class LposClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || '').replace(/\/$/, '');
    this.secret = options.secret || process.env.EP_SHARED_SECRET || '';
    this.timeout = Number(options.timeout || 10_000);
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.secret);
  }

  async _request(method, endpoint, options = {}) {
    if (!this.baseUrl) {
      throw new Error('LPOS base URL not configured — set it in EditPanel Settings');
    }
    if (!this.secret) {
      throw new Error('EP_SHARED_SECRET not set — configure it in Doppler');
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'x-ep-secret': this.secret,
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

  /** Lightweight ping — confirms connectivity and auth. */
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

  /** Get the current B2 media sync status from LPOS. */
  async getB2SyncStatus() {
    return this._request('GET', '/api/ep/b2-sync');
  }

  /** Trigger a manual B2 media sync run on LPOS. */
  async triggerB2Sync() {
    return this._request('POST', '/api/ep/b2-sync');
  }
}

module.exports = { LposClient };
