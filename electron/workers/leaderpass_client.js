const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const DEFAULT_RETRY_LIMIT = 4;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_REFRESH_SKEW_MS = 60_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowMs() {
  return Date.now();
}

class CheckpointStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return {};
      }
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (_error) {
      return {};
    }
  }

  _persist() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  get(key) {
    return this.state[key] || null;
  }

  set(key, value) {
    this.state[key] = {
      ...value,
      updated_at: new Date().toISOString()
    };
    this._persist();
  }

  delete(key) {
    delete this.state[key];
    this._persist();
  }
}

class LeaderPassClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.LEADERPASS_BASE_URL || 'http://127.0.0.1:8787';
    this.clientId = options.clientId || process.env.LEADERPASS_CLIENT_ID || '';
    this.clientSecret = options.clientSecret || process.env.LEADERPASS_CLIENT_SECRET || '';
    this.sessionSecret = options.sessionSecret || process.env.LEADERPASS_SESSION_SECRET || '';
    this.retryLimit = Number(options.retryLimit || process.env.LEADERPASS_RETRY_LIMIT || DEFAULT_RETRY_LIMIT);
    this.retryBaseMs = Number(options.retryBaseMs || process.env.LEADERPASS_RETRY_BASE_MS || DEFAULT_RETRY_BASE_MS);
    this.refreshSkewMs = Number(options.refreshSkewMs || process.env.LEADERPASS_REFRESH_SKEW_MS || DEFAULT_REFRESH_SKEW_MS);
    this.maxBytesPerSecond = Number(options.maxBytesPerSecond || process.env.LEADERPASS_MAX_BPS || 0);
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.token = null;
    this.tokenExpiresAt = 0;
    this.checkpoints = new CheckpointStore(
      options.checkpointPath || process.env.LEADERPASS_CHECKPOINT_PATH || path.join(process.cwd(), '.leaderpass', 'upload-checkpoints.json')
    );
  }

  _emit(code, data = {}, error = null) {
    this.onEvent({ event: 'progress', code, data, error, trace_id: crypto.randomUUID() });
  }

  _signPayload(payload, timestampIso) {
    if (!this.sessionSecret) {
      return null;
    }
    const hmac = crypto.createHmac('sha256', this.sessionSecret);
    hmac.update(`${timestampIso}.${payload}`);
    return hmac.digest('hex');
  }

  async _request(method, endpoint, options = {}) {
    const start = nowMs();
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    const bodyText = options.body == null ? undefined : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const headers = {
      ...(options.headers || {})
    };

    if (bodyText && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }

    if (options.useAuth) {
      const token = await this.getAccessToken();
      headers.authorization = `Bearer ${token}`;
    }

    if (options.signRequest) {
      const ts = new Date().toISOString();
      const payloadForSig = bodyText || '';
      const signature = this._signPayload(payloadForSig, ts);
      if (signature) {
        headers['x-leaderpass-ts'] = ts;
        headers['x-leaderpass-signature'] = signature;
      }
    }

    let attempt = 0;
    let lastError = null;

    while (attempt <= this.retryLimit) {
      const reqStart = nowMs();
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: bodyText
        });
        const latencyMs = nowMs() - reqStart;
        this._emit('LEADERPASS_API_LATENCY', {
          method,
          endpoint,
          latency_ms: latencyMs,
          status: response.status,
          attempt
        });

        if (response.status === 401 && options.useAuth && attempt < this.retryLimit) {
          this.token = null;
          this.tokenExpiresAt = 0;
          attempt += 1;
          this._emit('LEADERPASS_RETRY', { endpoint, attempt, reason: 'auth_expired' });
          await sleep(this.retryBaseMs * attempt);
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          const error = new Error(`LeaderPass API ${response.status}: ${text}`);
          if (response.status >= 500 && attempt < this.retryLimit) {
            attempt += 1;
            this._emit('LEADERPASS_RETRY', { endpoint, attempt, reason: `http_${response.status}` });
            await sleep(this.retryBaseMs * (2 ** attempt));
            continue;
          }
          throw error;
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return await response.json();
        }
        return await response.text();
      } catch (error) {
        lastError = error;
        if (attempt >= this.retryLimit) {
          break;
        }
        attempt += 1;
        this._emit('LEADERPASS_RETRY', { endpoint, attempt, reason: error.message });
        await sleep(this.retryBaseMs * (2 ** attempt));
      }
    }

    const elapsed = nowMs() - start;
    throw new Error(`LeaderPass API request failed after retries (${method} ${endpoint}, ${elapsed}ms): ${lastError?.message || 'unknown error'}`);
  }

  async authenticate(force = false) {
    if (!force && this.token && this.tokenExpiresAt > nowMs() + this.refreshSkewMs) {
      return { token_cached: true, expires_at: this.tokenExpiresAt };
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error('LeaderPass auth not configured: set LEADERPASS_CLIENT_ID and LEADERPASS_CLIENT_SECRET');
    }

    const resp = await this._request('POST', '/oauth/token', {
      body: {
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret
      },
      signRequest: true
    });

    if (!resp || !resp.access_token) {
      throw new Error('LeaderPass auth response missing access_token');
    }

    const expiresIn = Number(resp.expires_in || 3600);
    this.token = resp.access_token;
    this.tokenExpiresAt = nowMs() + expiresIn * 1000;
    return { token_cached: false, expires_at: this.tokenExpiresAt, expires_in: expiresIn };
  }

  async getAccessToken() {
    if (!this.token || this.tokenExpiresAt <= nowMs() + this.refreshSkewMs) {
      await this.authenticate();
    }
    return this.token;
  }

  async _throttleBytes(bytesSent, startedAtMs) {
    if (!this.maxBytesPerSecond || this.maxBytesPerSecond <= 0) {
      return;
    }
    const elapsed = Math.max(1, nowMs() - startedAtMs);
    const targetElapsed = (bytesSent / this.maxBytesPerSecond) * 1000;
    if (targetElapsed > elapsed) {
      await sleep(targetElapsed - elapsed);
    }
  }

  async uploadFile(params = {}) {
    const filePath = params.file_path || params.filePath;
    if (!filePath) {
      throw new Error('leaderpass_upload requires file_path');
    }

    const metadata = params.metadata && typeof params.metadata === 'object' ? params.metadata : {};
    const chunkSize = Number(params.chunk_size || DEFAULT_CHUNK_SIZE);
    const stat = fs.statSync(filePath);
    const checkpointKey = params.checkpoint_key || filePath;
    const existing = this.checkpoints.get(checkpointKey) || {};

    const session = existing.upload_id
      ? { upload_id: existing.upload_id, chunk_size: existing.chunk_size || chunkSize }
      : await this._request('POST', '/uploads/sessions', {
          useAuth: true,
          signRequest: true,
          body: {
            filename: path.basename(filePath),
            size_bytes: stat.size,
            chunk_size: chunkSize,
            metadata
          }
        });

    if (!session || !session.upload_id) {
      throw new Error('upload session did not return upload_id');
    }

    const uploadId = session.upload_id;
    const effectiveChunkSize = Number(session.chunk_size || chunkSize);
    let chunkIndex = Number(existing.next_chunk_index || 0);
    let offset = chunkIndex * effectiveChunkSize;
    const totalChunks = Math.ceil(stat.size / effectiveChunkSize);
    const startedAt = nowMs();

    this.checkpoints.set(checkpointKey, {
      upload_id: uploadId,
      file_path: filePath,
      chunk_size: effectiveChunkSize,
      next_chunk_index: chunkIndex,
      total_chunks: totalChunks,
      metadata
    });

    const fd = fs.openSync(filePath, 'r');
    try {
      while (offset < stat.size) {
        const remaining = stat.size - offset;
        const len = Math.min(effectiveChunkSize, remaining);
        const buffer = Buffer.allocUnsafe(len);
        fs.readSync(fd, buffer, 0, len, offset);

        await this._request('PUT', `/uploads/${encodeURIComponent(uploadId)}/chunks`, {
          useAuth: true,
          signRequest: true,
          headers: {
            'content-type': 'application/octet-stream',
            'x-chunk-index': String(chunkIndex),
            'x-chunk-size': String(len),
            'content-range': `bytes ${offset}-${offset + len - 1}/${stat.size}`
          },
          body: buffer.toString('base64')
        });

        chunkIndex += 1;
        offset += len;
        this.checkpoints.set(checkpointKey, {
          upload_id: uploadId,
          file_path: filePath,
          chunk_size: effectiveChunkSize,
          next_chunk_index: chunkIndex,
          total_chunks: totalChunks,
          metadata
        });

        const progress = Math.min(100, Number(((offset / stat.size) * 100).toFixed(2)));
        this._emit('LEADERPASS_UPLOAD_PROGRESS', {
          upload_id: uploadId,
          file_path: filePath,
          bytes_uploaded: offset,
          bytes_total: stat.size,
          chunk_index: chunkIndex,
          total_chunks: totalChunks,
          progress_pct: progress
        });
        await this._throttleBytes(offset, startedAt);
      }
    } finally {
      fs.closeSync(fd);
    }

    const finalized = await this._request('POST', `/uploads/${encodeURIComponent(uploadId)}/complete`, {
      useAuth: true,
      signRequest: true,
      body: {
        size_bytes: stat.size,
        total_chunks: totalChunks
      }
    });

    const metadataResult = await this._assignAndVerifyMetadata(uploadId, metadata);

    this.checkpoints.delete(checkpointKey);

    return {
      upload_id: uploadId,
      complete: true,
      finalized,
      metadata: metadataResult
    };
  }

  async _assignAndVerifyMetadata(uploadId, metadata = {}) {
    const assignResult = await this._request('POST', `/uploads/${encodeURIComponent(uploadId)}/metadata`, {
      useAuth: true,
      signRequest: true,
      body: { metadata }
    });

    const verification = await this._request('GET', `/uploads/${encodeURIComponent(uploadId)}/verify`, {
      useAuth: true,
      signRequest: true
    });

    if (verification && verification.complete === false) {
      const missing = Array.isArray(verification.missing_fields) ? verification.missing_fields : [];
      const patch = {};
      missing.forEach(field => {
        if (field in metadata) {
          patch[field] = metadata[field];
        }
      });
      if (Object.keys(patch).length > 0) {
        await this._request('PATCH', `/uploads/${encodeURIComponent(uploadId)}/metadata`, {
          useAuth: true,
          signRequest: true,
          body: { metadata: patch }
        });
      }
      const reconciled = await this._request('GET', `/uploads/${encodeURIComponent(uploadId)}/verify`, {
        useAuth: true,
        signRequest: true
      });
      return {
        assign_result: assignResult,
        verification,
        reconciled
      };
    }

    return {
      assign_result: assignResult,
      verification,
      reconciled: null
    };
  }
}

module.exports = {
  LeaderPassClient,
  CheckpointStore
};
