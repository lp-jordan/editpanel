const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Placeholder for future APIs
});

contextBridge.exposeInMainWorld('leaderpassAPI', {
  call(method, params) {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('helper-response', (_event, result) => {
        if (result && result.ok) {
          resolve(result);
        } else {
          reject(result);
        }
      });

      const payload = JSON.stringify({ method, params });
      ipcRenderer.send('helper-request', payload);
    });
  }
});
