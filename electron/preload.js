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
  getProjectNotes(projectId) {
    return ipcRenderer.invoke('lpos:project-notes', projectId);
  },
  getAssetComments(projectId, assetId) {
    return ipcRenderer.invoke('lpos:asset-comments', projectId, assetId);
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
  init(jobId, itemType, label, items) {
    return ipcRenderer.invoke('results:init', jobId, itemType, label, items);
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
  resetRun(jobId) {
    return ipcRenderer.invoke('results:reset-run', jobId);
  }
});

contextBridge.exposeInMainWorld('dialogAPI', {
  pickFolder() {
    return ipcRenderer.invoke('dialog:pickFolder');
  }
});

contextBridge.exposeInMainWorld('fsAPI', {
  readFile: p => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, data) => ipcRenderer.invoke('fs:writeFile', p, data),
  stat: p => ipcRenderer.invoke('fs:stat', p)
});

// r2API and lposAPI.b2Sync* removed 2026-05-27 — B2 cold-storage management is now
// LPOS-side only (see lpos-dashboard /settings/storage). Editpanel doesn't touch B2.
