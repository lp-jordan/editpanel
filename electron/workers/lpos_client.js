'use strict';

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

  // B2-related methods removed 2026-05-27. Cold-storage monitoring &
  // bucket management moved entirely LPOS-side — see lpos-dashboard
  // /settings/storage. EditPanel no longer touches B2.
}

module.exports = { LposClient };
