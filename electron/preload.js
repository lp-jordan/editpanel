const { contextBridge, ipcRenderer } = require('electron');

// Monotonic per-renderer correlation id. Every helper-request carries a unique
// `id` and the main process echoes it back on the shared `helper-response`
// channel; `call` only settles on the response whose id matches. Without this,
// two concurrent calls (e.g. list_render_presets + list_media_bins fired from
// the same effect) would both latch onto whichever response arrived first —
// the second call resolved with the first call's payload, silently returning
// the wrong shape (the cause of the empty Export-bin dropdown).
let __helperCallSeq = 0;

contextBridge.exposeInMainWorld('leaderpassAPI', {
  call(cmd, params = {}) {
    const callId = `r${++__helperCallSeq}`;
    return new Promise((resolve, reject) => {
      const handler = (_event, result) => {
        // Ignore responses belonging to other in-flight calls.
        if (!result || result.id !== callId) return;
        ipcRenderer.removeListener('helper-response', handler);
        if (result.ok) {
          resolve(result);
        } else {
          reject(result);
        }
      };
      ipcRenderer.on('helper-response', handler);
      // `id` last so it always wins over any stray id in params.
      ipcRenderer.send('helper-request', { cmd, ...params, id: callId });
    });
  }
});

contextBridge.exposeInMainWorld('spellcheckAPI', {
  misspellings: text => ipcRenderer.invoke('spellcheck:misspellings', text),
  suggestions: word => ipcRenderer.invoke('spellcheck:suggestions', word),
  /** Current custom-dictionary allowlist: { ok, words: string[] }. */
  listAllowlist: () => ipcRenderer.invoke('spellcheck:list-allowlist'),
  /** Add a word to the custom dictionary; returns updated { ok, words }. */
  addWord: word => ipcRenderer.invoke('spellcheck:add-word', word),
  /** Remove a word from the custom dictionary; returns updated { ok, words }. */
  removeWord: word => ipcRenderer.invoke('spellcheck:remove-word', word)
});

contextBridge.exposeInMainWorld('electronAPI', {
  onHelperMessage(callback) {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('helper-message', handler);
    return () => ipcRenderer.removeListener('helper-message', handler);
  },

  onHelperStatus(callback) {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('helper-status', handler);
    return () => ipcRenderer.removeListener('helper-status', handler);
  },

  onJobEvent(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('job-event', handler);
    return () => ipcRenderer.removeListener('job-event', handler);
  },

  onWorkerEvent(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('worker-event', handler);
    return () => ipcRenderer.removeListener('worker-event', handler);
  },

  listJobs() {
    return ipcRenderer.invoke('jobs:list');
  },

  getJob(jobId) {
    return ipcRenderer.invoke('jobs:get', jobId);
  },

  cancelJob(jobId) {
    return ipcRenderer.invoke('jobs:cancel', jobId);
  },

  retryJob(jobId) {
    return ipcRenderer.invoke('jobs:retry', jobId);
  },

  deleteJob(jobId) {
    return ipcRenderer.invoke('jobs:delete', jobId);
  },

  pruneJobs(olderThanMs) {
    return ipcRenderer.invoke('jobs:prune', olderThanMs);
  },

  /**
   * Manual Resolve reconnect: respawns the Python worker so the next attach
   * starts from a freshly-loaded DaVinciResolveScript module. Use this when
   * the Offline chip's normal connect doesn't recover (sticky-failure case
   * where the in-process module has cached a bad scriptapp() state).
   */
  reconnectResolve() {
    return ipcRenderer.invoke('resolve:reconnect');
  },

  dashboardSnapshot() {
    return ipcRenderer.invoke('dashboard:snapshot');
  },

  listRecipes() {
    return ipcRenderer.invoke('recipes:list');
  },

  launchRecipe(recipeId, input = {}, options = {}) {
    return ipcRenderer.invoke('recipes:launch', { recipeId, input, options });
  },

  getPreferences() {
    return ipcRenderer.invoke('preferences:get');
  },

  updatePreferences(patch = {}) {
    return ipcRenderer.invoke('preferences:update', patch);
  },

  quit() {
    ipcRenderer.send('app:quit');
  }
});

contextBridge.exposeInMainWorld('lposAPI', {
  health() {
    return ipcRenderer.invoke('lpos:health');
  },
  listProjects() {
    return ipcRenderer.invoke('lpos:projects');
  },
  getProject(projectId) {
    return ipcRenderer.invoke('lpos:project', projectId);
  },
  listProjectAssets(projectId) {
    return ipcRenderer.invoke('lpos:project-assets', projectId);
  },
  getProjectNotes(projectId) {
    return ipcRenderer.invoke('lpos:project-notes', projectId);
  },
  getAssetComments(projectId, assetId) {
    return ipcRenderer.invoke('lpos:asset-comments', projectId, assetId);
  },
  /**
   * Phase 5c.3+5c.4 (2026-06-02): pull LPOS comments → Resolve markers.
   * Fans across every editpanel-rendered timeline in the project (latest upload
   * wins per timelineUid), fetches unresolved comments, formats name/note
   * (replies inlined), and calls sync_comment_markers per timeline. Returns
   * per-timeline outcomes plus an aggregate count.
   * @param {string} projectId
   * @param {{projectName?: string}} [options]
   * @returns {Promise<{ok: boolean, data?: {jobId, timelines, totalPlaced, totalRemoved, totalKept, message?: string}, error?: string}>}
   */
  pullComments(projectId, options = {}) {
    return ipcRenderer.invoke('lpos:pull-comments', projectId, options);
  },
  /**
   * Phase 5c.10 (2026-06-03): jump Resolve to a specific comment's timeline +
   * marker frame. Used by the "Jump" button on each comment row in the
   * CommentPullReport.
   * @param {{timelineUid: string, frame: number}} payload
   */
  focusComment(payload) {
    return ipcRenderer.invoke('comments:focus', payload);
  },
  /**
   * Phase 5c.10 (2026-06-03): toggle an LPOS comment's done state, and (when
   * completing) delete the corresponding local marker. The CommentPullReport's
   * "Mark done" button funnels through here.
   * @param {{projectId: string, assetId: string, commentId: string, completed: boolean, timelineUid?: string}} payload
   */
  setCommentCompleted(payload) {
    return ipcRenderer.invoke('comments:set-completed', payload);
  },
  /** Open the user's default browser to /ep/link for approval. */
  signinStart() {
    return ipcRenderer.invoke('lpos:signin-start');
  },
  /** Clear the locally-stored ep_token (does not revoke server-side). */
  signout() {
    return ipcRenderer.invoke('lpos:signout');
  },
  /** Subscribe to ep-link callback results (token saved / denied / errored). */
  onLinkResult(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('ep-link-result', handler);
    return () => ipcRenderer.removeListener('ep-link-result', handler);
  },
  /** List all feature requests / wishes (shared across every EditPanel instance). */
  listWishes() {
    return ipcRenderer.invoke('lpos:wishes-list');
  },
  /** Submit a feature request. @param {{title: string, description?: string}} payload */
  createWish(payload) {
    return ipcRenderer.invoke('lpos:wishes-create', payload);
  },
});

// Cut-through (beta): drives the editpanel/cut_through/ pipeline (main: workers/cut_through.js).
contextBridge.exposeInMainWorld('cutThroughAPI', {
  getState: () => ipcRenderer.invoke('cut-through:state'),
  listMulticams: () => ipcRenderer.invoke('cut-through:list-multicams'),
  select: (payload) => ipcRenderer.invoke('cut-through:select', payload),
  updateSettings: (patch) => ipcRenderer.invoke('cut-through:settings', patch),
  checkSetup: () => ipcRenderer.invoke('cut-through:check-setup'),
  installPack: () => ipcRenderer.invoke('cut-through:install-pack'),
  testPack: () => ipcRenderer.invoke('cut-through:test-pack'),
  saveAngleRules: (payload) => ipcRenderer.invoke('cut-through:angle-rules', payload),
  setRunFolder: (payload) => ipcRenderer.invoke('cut-through:run-folder', payload),
  runPrep: (payload) => ipcRenderer.invoke('cut-through:prep', payload),
  runTranscribe: (payload) => ipcRenderer.invoke('cut-through:transcribe', payload),
  cancel: () => ipcRenderer.invoke('cut-through:cancel'),
  runPlan: (payload) => ipcRenderer.invoke('cut-through:plan', payload),
  useExistingPlan: () => ipcRenderer.invoke('cut-through:use-plan'),
  readMarks: () => ipcRenderer.invoke('cut-through:read-marks'),
  runBuild: (payload) => ipcRenderer.invoke('cut-through:build', payload),
  runCheck: (payload) => ipcRenderer.invoke('cut-through:check', payload),
  runScore: () => ipcRenderer.invoke('cut-through:score'),
  runCompare: (payload) => ipcRenderer.invoke('cut-through:compare', payload),
  listLposProjects: () => ipcRenderer.invoke('cut-through:lpos-projects'),
  findVideos: (payload) => ipcRenderer.invoke('cut-through:find-videos', payload),
  readSlate: (opts = {}) => ipcRenderer.invoke('cut-through:read-slate', { useClaude: Boolean(opts.useClaude) }),
  setSlateAngle: (angle) => ipcRenderer.invoke('cut-through:set-slate-angle', { angle }),
  getSlateFrame: (index) => ipcRenderer.invoke('cut-through:slate-frame', { index }),
  setSlateBox: (box) => ipcRenderer.invoke('cut-through:set-slate-box', { box }),
  nameMulticamTimelines: (payload) => ipcRenderer.invoke('cut-through:name-multicam-timelines', payload),
  updateVideo: (id, patch) => ipcRenderer.invoke('cut-through:update-video', { id, patch }),
  joinVideos: (ids) => ipcRenderer.invoke('cut-through:join-videos', { ids }),
  splitVideo: (id) => ipcRenderer.invoke('cut-through:split-video', { id }),
  planVideos: (payload) => ipcRenderer.invoke('cut-through:plan-videos', payload),
  prepareBatch: (payload) => ipcRenderer.invoke('cut-through:batch-prepare', payload),
  discardBatch: () => ipcRenderer.invoke('cut-through:batch-discard'),
  submitBatch: () => ipcRenderer.invoke('cut-through:batch-submit'),
  refreshBatch: () => ipcRenderer.invoke('cut-through:batch-refresh'),
  cancelBatch: () => ipcRenderer.invoke('cut-through:batch-cancel'),
  collectBatch: () => ipcRenderer.invoke('cut-through:batch-collect'),
  openFile: (p) => ipcRenderer.invoke('cut-through:open-file', p),
  onUpdate(callback) {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('cut-through:update', handler);
    return () => ipcRenderer.removeListener('cut-through:update', handler);
  }
});

// Graphics: Remotion overlay templates (main: workers/graphics.js).
contextBridge.exposeInMainWorld('graphicsAPI', {
  call: (method, args) => ipcRenderer.invoke('graphics:call', { method, args }),
  onUpdate(callback) {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('graphics:update', handler);
    return () => ipcRenderer.removeListener('graphics:update', handler);
  }
});

contextBridge.exposeInMainWorld('atemAPI', {
  listSessions(host) {
    return ipcRenderer.invoke('atem:list-sessions', host);
  },
  startIngest(payload) {
    return ipcRenderer.invoke('atem:start-ingest', payload);
  },
  cancelIngest() {
    return ipcRenderer.invoke('atem:cancel-ingest');
  },
  getIngestLogs(limit = 30) {
    return ipcRenderer.invoke('atem:ingest-logs', limit);
  },
  onProgress(callback) {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('atem-progress', handler);
    return () => ipcRenderer.removeListener('atem-progress', handler);
  }
});

contextBridge.exposeInMainWorld('cardIngestAPI', {
  listCards() { return ipcRenderer.invoke('card-ingest:list'); },
  /** targets: [{ root, dest|null }] */
  check(targets) { return ipcRenderer.invoke('card-ingest:check', targets); },
  /** Data URL of a card file's thumbnail, or null. */
  thumbnail(root, relPath) { return ipcRenderer.invoke('card-ingest:thumbnail', { root, relPath }); },
  /** Search the remembered footage root (pick: choose a new one first) for these cards' files. */
  deepScan(cardRoots, pick = false) { return ipcRenderer.invoke('card-ingest:deep-scan', { cardRoots, pick }); },
  cancelDeepScan() { return ipcRenderer.invoke('card-ingest:cancel-deep-scan'); },
  footageRoot() { return ipcRenderer.invoke('card-ingest:footage-root'); },
  onDeepScan(callback) {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('card-ingest:deep-scan', handler);
    return () => ipcRenderer.removeListener('card-ingest:deep-scan', handler);
  },
  start(targets) { return ipcRenderer.invoke('card-ingest:start', targets); },
  cancel() { return ipcRenderer.invoke('card-ingest:cancel'); },
  snapshot() { return ipcRenderer.invoke('card-ingest:snapshot'); },
  dismiss() { return ipcRenderer.invoke('card-ingest:dismiss'); },
  lastDest() { return ipcRenderer.invoke('card-ingest:last-dest'); },
  openFolder(p) { return ipcRenderer.invoke('card-ingest:open-folder', p); },
  onCards(callback) {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('card-ingest:cards', handler);
    return () => ipcRenderer.removeListener('card-ingest:cards', handler);
  },
  onUpdate(callback) {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('card-ingest:update', handler);
    return () => ipcRenderer.removeListener('card-ingest:update', handler);
  }
});

// Other online editpanel machines (pulled from LPOS with each heartbeat).
contextBridge.exposeInMainWorld('peersAPI', {
  list() {
    return ipcRenderer.invoke('peers:list');
  },
  onChange(callback) {
    const handler = (_event, peers) => callback(peers);
    ipcRenderer.on('ep-peers', handler);
    return () => ipcRenderer.removeListener('ep-peers', handler);
  }
});

contextBridge.exposeInMainWorld('resultsAPI', {
  init(jobId, itemType, label, items, scope = {}) {
    return ipcRenderer.invoke('results:init', jobId, itemType, label, items, scope);
  },
  listRuns(limit = 20) {
    return ipcRenderer.invoke('results:list-runs', limit);
  },
  getItems(jobId) {
    return ipcRenderer.invoke('results:get-items', jobId);
  },
  resolveItem(jobId, itemKey, resolution) {
    return ipcRenderer.invoke('results:resolve-item', jobId, itemKey, resolution);
  },
  skipItem(jobId, itemKey) {
    return ipcRenderer.invoke('results:skip-item', jobId, itemKey);
  },
  reopenItem(jobId, itemKey) {
    return ipcRenderer.invoke('results:reopen-item', jobId, itemKey);
  },
  resetRun(jobId) {
    return ipcRenderer.invoke('results:reset-run', jobId);
  },
  deleteRun(jobId) {
    return ipcRenderer.invoke('results:delete-run', jobId);
  },
  pruneRuns(olderThanMs) {
    return ipcRenderer.invoke('results:prune-runs', olderThanMs);
  }
});

contextBridge.exposeInMainWorld('dialogAPI', {
  pickFolder() {
    return ipcRenderer.invoke('dialog:pickFolder');
  }
});

contextBridge.exposeInMainWorld('exportsAPI', {
  /** Queue + (optionally) start a render, tracked in the background. */
  start(opts = {}) {
    return ipcRenderer.invoke('export:start', opts);
  },
  /** Current in-flight export snapshot, or null. */
  getActive() {
    return ipcRenderer.invoke('export:active');
  },
  /** Recent export runs (newest first). */
  getRecent(limit = 10) {
    return ipcRenderer.invoke('export:recent', limit);
  },
  /** Start rendering a queued export (auto-start toggle was off). */
  startRender() {
    return ipcRenderer.invoke('export:start-render');
  },
  /** Start a sequence of queued batches back-to-back, in the given order.
   *  Resolves { ok, started, count } or { ok:false, error } if something's
   *  already running or nothing is selected. */
  startChain(exportIds = []) {
    return ipcRenderer.invoke('export:start-chain', exportIds);
  },
  /** Stop the current render / drop a queued export. */
  cancel() {
    return ipcRenderer.invoke('export:cancel');
  },
  /** Stop a Resolve-queued (orphan) render from the JobPanel chunky row.
   *  Same Resolve mechanism as cancel() but doesn't touch the in-memory
   *  activeExport — the reconcile tick will write state='failed' once it
   *  sees the Cancelled status (~3s). */
  stopRendering(exportId) {
    return ipcRenderer.invoke('exports:stop-rendering', exportId);
  },
  /** Delete a finished export run from the recent list. */
  deleteRun(exportId) {
    return ipcRenderer.invoke('export:delete-run', exportId);
  },
  /** Soft-delete every terminal export in one call. Mirrors deleteRun's
   *  per-row semantics across the whole list (anything still potentially in
   *  Resolve's queue becomes user_dismissed; only dismissed_in_resolve rows
   *  hard-delete). Resolves with { ok, data: { dismissed, deleted } }. */
  clearTerminal() {
    return ipcRenderer.invoke('exports:clear-terminal');
  },
  /** Progress ticks while an export renders. */
  onProgress(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('export-progress', handler);
    return () => ipcRenderer.removeListener('export-progress', handler);
  },
  /** Fires once when an export reaches a terminal state. */
  onComplete(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('export-complete', handler);
    return () => ipcRenderer.removeListener('export-complete', handler);
  },
  /** Fires when a batch is queued (without auto-starting) or a chain drains,
   *  so the JobPanel can refresh its queued-batch list live. Payload:
   *  { exportId } on queue, { exportId: null, chainDrained: true } when done. */
  onQueued(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('export-queued', handler);
    return () => ipcRenderer.removeListener('export-queued', handler);
  },

  // ── Phase 3.5 — orphan reconciliation + Exports history surface ─────
  /** Filtered listing for the Delivery → Exports page.
   *  filter.kind: 'all' (default) | 'unassigned' | 'delivered' | 'failed'
   *               | 'active' | 'by_project'
   *  filter.projectId (only when kind='by_project'): LPOS project id, or null
   *                                                  for orphan-bucket. */
  list(filter = {}) {
    return ipcRenderer.invoke('exports:list', filter);
  },
  /** Single export row, with parsed jobs/output_paths/lpos_delivery. */
  get(exportId) {
    return ipcRenderer.invoke('exports:get', exportId);
  },
  /** Reveal the export's output file (or its containing folder) in the OS file browser.
   *  Pass { filePath } to select a specific file, or { dirPath } to open the folder. */
  openFolder(payload = {}) {
    return ipcRenderer.invoke('exports:open-folder', payload);
  },
  /** Assign an orphan (state='complete_unassigned') to an LPOS project and
   *  kick the upload. Returns ok immediately; subsequent state changes arrive
   *  via onReconciled (state: 'uploading' → 'delivered' | 'partial', or back to
   *  'complete_unassigned' when nothing landed, so the push can simply be
   *  retried instead of the row becoming un-pushable). */
  pushToLpos({ exportId, projectId, projectName } = {}) {
    return ipcRenderer.invoke('exports:push-to-lpos', { exportId, projectId, projectName });
  },
  /** Hard-delete one or more terminal export_runs rows from the Exports
   *  history (Phase 3.5.1, surfaced via the multi-select action bar). Active
   *  and non-terminal rows are returned in `skipped`. Resolves with
   *  { ok, data: { deleted: N, skipped: [{exportId, reason}, ...] } }. */
  hardDeleteBatch(exportIds) {
    return ipcRenderer.invoke('exports:hard-delete-batch', { exportIds });
  },
  /** Count of orphans currently awaiting assignment (state='complete_unassigned'). */
  unassignedCount() {
    return ipcRenderer.invoke('exports:unassigned-count');
  },
  /** Record the current unassigned count as the dismissal baseline. The pill
   *  re-appears once countUnassignedExports() exceeds this. */
  dismissPill() {
    return ipcRenderer.invoke('exports:dismiss-pill');
  },
  /** { count, dismissedCount, show } — drives the Jobs-tab pill visibility. */
  pillState() {
    return ipcRenderer.invoke('exports:pill-state');
  },
  /** Fires on every reconciler-driven state change: orphan discovered,
   *  orphan progressed, orphan completed, push-to-LPOS phase transitions, etc.
   *  Payload always includes exportId; other fields vary by event. */
  onReconciled(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('export-reconciled', handler);
    return () => ipcRenderer.removeListener('export-reconciled', handler);
  }
});

// Custom window controls for the frameless shell. close() hides to tray (the
// app stays running so background jobs/uploads/reconcile keep going); the user
// reopens via the tray icon. toggleAnchor() flips right-edge always-on-top
// persistent-panel mode; anchor-state event lets the gold button render its
// active style and the shell apply the .is-anchored layout modifier.
contextBridge.exposeInMainWorld('windowAPI', {
  close() { ipcRenderer.send('window:close'); },
  minimize() { ipcRenderer.send('window:minimize'); },
  toggleAnchor() { return ipcRenderer.invoke('window:toggle-anchor'); },
  getAnchorState() { return ipcRenderer.invoke('window:get-anchor-state'); },
  onAnchorState(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('anchor-state', handler);
    return () => ipcRenderer.removeListener('anchor-state', handler);
  }
});

contextBridge.exposeInMainWorld('fsAPI', {
  readFile: p => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, data) => ipcRenderer.invoke('fs:writeFile', p, data),
  stat: p => ipcRenderer.invoke('fs:stat', p)
});

// r2API and lposAPI.b2Sync* removed 2026-05-27 — B2 cold-storage management is now
// LPOS-side only (see lpos-dashboard /settings/storage). Editpanel doesn't touch B2.
