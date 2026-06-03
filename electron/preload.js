const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('leaderpassAPI', {
  call(cmd, params = {}) {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('helper-response', (_event, result) => {
        if (result && result.ok) {
          resolve(result);
        } else {
          reject(result);
        }
      });

      ipcRenderer.send('helper-request', { cmd, ...params });
    });
  }
});

contextBridge.exposeInMainWorld('spellcheckAPI', {
  misspellings: text => ipcRenderer.invoke('spellcheck:misspellings', text),
  suggestions: word => ipcRenderer.invoke('spellcheck:suggestions', word)
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
   * Phase 5c.3+5c.4 (2026-06-02): pull Frame.io comments → Resolve markers.
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
   * Phase 5c.10 (2026-06-03): toggle a Frame.io comment's completed state via
   * LPOS, and (when completing) delete the corresponding local marker. The
   * editor's CommentPullReport's "Mark complete" button funnels through here.
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
  /** Stop the current render / drop a queued export. */
  cancel() {
    return ipcRenderer.invoke('export:cancel');
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
   *  via onReconciled (state: 'uploading' → 'delivered' | 'partial' | 'failed'). */
  pushToLpos({ exportId, projectId, projectName } = {}) {
    return ipcRenderer.invoke('exports:push-to-lpos', { exportId, projectId, projectName });
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
