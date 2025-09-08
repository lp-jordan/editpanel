const { contextBridge, ipcRenderer } = require('electron');

// Expose leaderpassAPI for invoking backend actions.
contextBridge.exposeInMainWorld('leaderpassAPI', {
  /**
   * Call an action on the backend via IPC.
   * @param {string} action - Action name to invoke.
   * @returns {Promise<any>} Promise resolving with the response.
   */
  call(action) {
    return ipcRenderer.invoke('leaderpass-call', action);
  }
});

// Expose helper message subscription API.
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Subscribe to helper messages.
   * @param {(payload: any) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onHelperMessage(callback) {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('helper-message', handler);
    return () => ipcRenderer.removeListener('helper-message', handler);
  }
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
