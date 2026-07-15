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
  render_status: WORKERS.resolve,
  // Phase 3.5 (2026-06-03): enumerate ALL render jobs in the active Resolve
  // project so the main-process reconciliation tick can detect renders queued
  // directly in Resolve (without going through editpanel's overlay) and write
  // them into export_runs as source='reconciled' orphans.
  list_render_jobs: WORKERS.resolve,
  create_project_bins: WORKERS.resolve,
  update_text: WORKERS.resolve,
  goto: WORKERS.resolve,

  spellcheck: WORKERS.resolve,
  lp_base_export: WORKERS.resolve,
  export_preflight: WORKERS.resolve,
  shutdown: WORKERS.resolve,
  // Phase 5c.2 (2026-06-02): Frame.io comment-marker reconciliation per timeline.
  sync_comment_markers: WORKERS.resolve,
  // Phase 5c.5 (2026-06-02): enumerate current Resolve project's timelines for
  // auto-discovering which LPOS project(s) a Pull Comments call should target.
  list_timelines: WORKERS.resolve,
  // Phase 5c.8 (2026-06-02): flag timeline MediaPoolItems with a color after a
  // Pull Comments run so the editor can sort the bin by flag.
  flag_timelines: WORKERS.resolve,
  // Phase 5c.10 (2026-06-03): per-comment Jump and Mark-complete buttons in
  // the CommentPullReport. focus_comment switches timeline + sets playhead;
  // delete_comment_marker removes a single frameio:* marker after the
  // upstream Frame.io completion lands.
  focus_comment: WORKERS.resolve,
  delete_comment_marker: WORKERS.resolve,
  // ExportDeliverOverlay dropdowns (2026-06-08, v1.1.16): enumerate the
  // active project's render presets and top-level media-pool bins so the
  // overlay picker can show real choices instead of free-text. Read-only,
  // no payload — but they still need to be registered here, otherwise
  // validateRequestEnvelope rejects them as "unknown command" before the
  // request ever reaches the Python worker.
  list_render_presets: WORKERS.resolve,
  list_media_bins: WORKERS.resolve,
  // "Open Sequences" edit function (2026-06-24): list_bin_sequences enumerates
  // the timelines in a chosen top-level bin; open_sequence makes one of them
  // current. The renderer fetches the list once, then opens them one at a time
  // with a settle delay so the worker keeps answering health pings between
  // sequences (a single long blocking Python loop would trip the watchdog).
  list_bin_sequences: WORKERS.resolve,
  open_sequence: WORKERS.resolve,
  // Slate auto-sequencing Step 1 (2026-07-08): read-only diagnostic that derives
  // recording spans from the open multicam's clip edges and streams them to the
  // console. Must be registered here or validateRequestEnvelope rejects it as an
  // unknown command before it reaches the Python worker (see note above).
  slate_span_report: WORKERS.resolve,
  // ATEM ingest → Resolve import (2026-07-15): import already-ingested footage
  // into the open project's media pool, nested by session/camera. Must be
  // registered here or validateRequestEnvelope rejects it as an unknown command
  // before the request reaches the Python worker (see note above).
  import_media: WORKERS.resolve,

  leaderpass_auth: WORKERS.platform,
  leaderpass_upload: WORKERS.platform
});

// Meta-commands are universal — every worker handles them in worker_runtime.py
// regardless of MEDIA_HANDLERS/RESOLVE_HANDLERS contents. They bypass owner
// validation in toRequestEnvelope/validateRequestEnvelope so the caller can
// route them to any worker via explicitWorker.
//
// HISTORY: 'ping' was previously missing from COMMAND_OWNER, which caused
// validateRequestEnvelope to throw "unknown command: ping" for every health
// check. That synchronous throw was caught in healthCheckWorker and triggered
// SIGTERM on the healthy worker, producing an endless ~10s SIGTERM/restart
// loop for both the resolve and media workers — manifesting in the UI as
// "constant connection problems with Resolve". Do not remove this set
// without first making healthCheckWorker bypass envelope validation.
const META_COMMANDS = Object.freeze(new Set(['ping']));

const COMMAND_SCHEMAS = Object.freeze({
  connect: { required: [] },
  context: { required: [] },
  add_marker: { required: [] },
  start_render: { required: [] },
  stop_render: { required: [] },
  render_status: { required: [] },
  list_render_jobs: { required: [] },
  create_project_bins: { required: [] },
  update_text: { required: [] },
  goto: { required: [] },
  spellcheck: { required: [] },
  export_preflight: { required: [], types: { export_bin_name: 'string' } },
  lp_base_export: {
    required: [],
    types: {
      preset_name: 'string',
      export_bin_name: 'string',
      target_dir: 'string',
      unique_filename: 'boolean'
    }
  },
  shutdown: { required: [] },
  // Phase 5c.2 (2026-06-02). target_comments is an array of objects; the schema
  // layer only checks top-level scalars, so deep validation lives in the Python
  // handler (handle_sync_comment_markers).
  sync_comment_markers: {
    required: ['timeline_uid', 'fps', 'target_comments'],
    types: { timeline_uid: 'string', fps: 'number' }
  },
  list_timelines: { required: [] },
  // Phase 5c.8 (2026-06-02). timeline_uids deep-validated Python-side.
  flag_timelines: {
    required: ['timeline_uids'],
    types: { color: 'string' }
  },
  // Phase 5c.10 (2026-06-03).
  focus_comment: {
    required: ['timeline_uid', 'frame'],
    types: { timeline_uid: 'string', frame: 'number' }
  },
  delete_comment_marker: {
    required: ['timeline_uid', 'comment_id'],
    types: { timeline_uid: 'string', comment_id: 'string' }
  },
  list_render_presets: { required: [] },
  list_media_bins: { required: [] },
  list_bin_sequences: { required: ['bin_name'], types: { bin_name: 'string' } },
  // uid/name are both optional scalars (at least one required — enforced in the
  // Python handler); only type-check them when present.
  open_sequence: { required: [], types: { uid: 'string', name: 'string' } },
  // Slate auto-sequencing Step 1 (2026-07-08): no payload, operates on the
  // current timeline.
  slate_span_report: { required: [] },
  // ATEM import (2026-07-15). `files` is an array of {local_path, session,
  // cam_number}; the schema layer only checks top-level scalars, so per-item
  // validation lives in the Python handler (handle_import_media).
  import_media: { required: ['files'], types: { parent_bin: 'string' } },
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

function isMetaCommand(cmd) {
  return META_COMMANDS.has(cmd);
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
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    throw new UserError('payload must be an object');
  }

  // Meta-commands (e.g. ping) skip owner/schema checks — any worker handles
  // them. Without this branch, sending ping to a worker would throw
  // "unknown command: ping" synchronously from healthCheckWorker and SIGTERM
  // a healthy worker on every health-check tick.
  if (isMetaCommand(envelope.cmd)) {
    return;
  }

  const owner = commandOwner(envelope.cmd);
  if (!owner) {
    throw new UserError(`unknown command: ${envelope.cmd}`);
  }
  if (owner !== envelope.worker) {
    throw new UserError(`misrouted command ${envelope.cmd}: expected worker=${owner}, got worker=${envelope.worker}`);
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
  META_COMMANDS,
  UserError,
  RetryableError,
  FatalError,
  normalizeError,
  commandOwner,
  isMetaCommand,
  toRequestEnvelope,
  validateRequestEnvelope,
  toWorkerWireMessage,
  normalizeResponseEnvelope
};
