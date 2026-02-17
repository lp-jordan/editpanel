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

  transcribeFolder(folderPath) {
    return ipcRenderer.invoke('audio:transcribe-folder', folderPath);
  },

  cancelTranscribe() {
    return ipcRenderer.invoke('audio:cancel-transcribe');
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
