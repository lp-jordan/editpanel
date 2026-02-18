const { randomUUID } = require('crypto');

const WORKERS = {
  resolve: 'resolve',
  media: 'media',
  platform: 'platform'
};

const COMMAND_OWNER = Object.freeze({
  connect: WORKERS.resolve,
  context: WORKERS.resolve,
  add_marker: WORKERS.resolve,
  start_render: WORKERS.resolve,
  stop_render: WORKERS.resolve,
  create_project_bins: WORKERS.resolve,
  update_text: WORKERS.resolve,
  goto: WORKERS.resolve,

  transcribe: WORKERS.media,
  transcribe_folder: WORKERS.media,
  test_cuda: WORKERS.media,

  spellcheck: WORKERS.resolve,
  lp_base_export: WORKERS.resolve,
  shutdown: WORKERS.resolve,

  leaderpass_auth: WORKERS.platform,
  leaderpass_upload: WORKERS.platform
});

const COMMAND_SCHEMAS = Object.freeze({
  connect: { required: [] },
  context: { required: [] },
  add_marker: { required: [] },
  start_render: { required: [] },
  stop_render: { required: [] },
  create_project_bins: { required: [] },
  update_text: { required: [] },
  goto: { required: [] },
  transcribe: { required: [] },
  transcribe_folder: { required: ['folder_path'], types: { folder_path: 'string', use_gpu: 'boolean', engine: 'string' } },
  test_cuda: { required: [] },
  spellcheck: { required: [] },
  lp_base_export: { required: [] },
  shutdown: { required: [] },
  leaderpass_auth: { required: [], types: { force: 'boolean', force_refresh: 'boolean' } },
  leaderpass_upload: { required: ['file_path'], types: { file_path: 'string', chunk_size: 'number' } }
});

class UserError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'UserError';
    this.details = details;
  }
}

class RetryableError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'RetryableError';
    this.details = details;
  }
}

class FatalError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'FatalError';
    this.details = details;
  }
}

function normalizeCategory(error) {
  if (error instanceof UserError) return 'UserError';
  if (error instanceof RetryableError) return 'RetryableError';
  return 'FatalError';
}

function normalizeError(error) {
  const message = typeof error === 'string' ? error : (error && error.message) || 'unknown error';
  const category = normalizeCategory(error);
  return {
    category,
    message,
    details: error && typeof error === 'object' && 'details' in error ? error.details : undefined
  };
}

function commandOwner(cmd) {
  return COMMAND_OWNER[cmd] || null;
}

function toRequestEnvelope(rawRequest = {}, explicitWorker = undefined) {
  const request = typeof rawRequest === 'string' ? { cmd: rawRequest } : { ...rawRequest };
  const worker = explicitWorker || request.worker || commandOwner(request.cmd);
  const payload = request.payload && typeof request.payload === 'object' ? { ...request.payload } : {};

  Object.keys(request).forEach(key => {
    if (!['id', 'worker', 'cmd', 'payload', 'trace_id'].includes(key)) {
      payload[key] = request[key];
    }
  });

  return {
    id: request.id || randomUUID(),
    worker,
    cmd: request.cmd,
    payload,
    trace_id: request.trace_id || randomUUID()
  };
}

function validateRequestEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new UserError('request envelope must be an object');
  }
  const requiredKeys = ['id', 'worker', 'cmd', 'payload', 'trace_id'];
  for (const key of requiredKeys) {
    if (!(key in envelope)) {
      throw new UserError(`request envelope missing required field: ${key}`);
    }
  }

  if (!Object.values(WORKERS).includes(envelope.worker)) {
    throw new UserError(`unknown worker: ${envelope.worker}`);
  }
  if (!envelope.cmd || typeof envelope.cmd !== 'string') {
    throw new UserError('cmd must be a non-empty string');
  }
  const owner = commandOwner(envelope.cmd);
  if (!owner) {
    throw new UserError(`unknown command: ${envelope.cmd}`);
  }
  if (owner !== envelope.worker) {
    throw new UserError(`misrouted command ${envelope.cmd}: expected worker=${owner}, got worker=${envelope.worker}`);
  }
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    throw new UserError('payload must be an object');
  }

  const schema = COMMAND_SCHEMAS[envelope.cmd];
  if (schema) {
    for (const field of schema.required || []) {
      if (!(field in envelope.payload)) {
        throw new UserError(`command ${envelope.cmd} missing required payload field: ${field}`);
      }
    }
    const types = schema.types || {};
    Object.entries(types).forEach(([field, type]) => {
      if (!(field in envelope.payload)) return;
      if (typeof envelope.payload[field] !== type) {
        throw new UserError(`command ${envelope.cmd} payload field ${field} must be ${type}`);
      }
    });
  }
}

function toWorkerWireMessage(envelope) {
  return JSON.stringify({
    id: envelope.id,
    cmd: envelope.cmd,
    trace_id: envelope.trace_id,
    ...envelope.payload
  });
}

function normalizeResponseEnvelope(message = {}, defaultId = undefined, startedAt = undefined) {
  const metrics = {
    latency_ms: startedAt ? Date.now() - startedAt : undefined,
    worker_trace_id: message.trace_id || undefined
  };

  if (message && message.event) {
    return {
      kind: 'event',
      envelope: {
        event: message.event,
        trace_id: message.trace_id || defaultId || randomUUID(),
        data: message.data || null,
        error: message.error || null,
        code: message.code || null,
        message: message.message || null,
        metrics
      }
    };
  }

  if (message && message.ok === false) {
    return {
      kind: 'response',
      envelope: {
        id: message.id || defaultId || null,
        ok: false,
        data: null,
        error: normalizeError(new UserError(message.error || 'worker error')),
        metrics
      }
    };
  }

  return {
    kind: 'response',
    envelope: {
      id: message.id || defaultId || null,
      ok: true,
      data: message.data === undefined ? message : message.data,
      error: null,
      metrics
    }
  };
}

module.exports = {
  WORKERS,
  COMMAND_OWNER,
  COMMAND_SCHEMAS,
  UserError,
  RetryableError,
  FatalError,
  normalizeError,
  commandOwner,
  toRequestEnvelope,
  validateRequestEnvelope,
  toWorkerWireMessage,
  normalizeResponseEnvelope
};
