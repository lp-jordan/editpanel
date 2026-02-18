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
  transcribeFolder(folderPath, options = {}) {
    return ipcRenderer.invoke('audio:transcribe-folder', { folderPath, ...options });
  },

  testGpu() {
    return ipcRenderer.invoke('audio:test-gpu');
  },

  cancelTranscribe() {
    return ipcRenderer.invoke('audio:cancel-transcribe');
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
