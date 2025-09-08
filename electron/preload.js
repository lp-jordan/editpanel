const { contextBridge, ipcRenderer } = require('electron');

// Expose API for invoking helper commands.
contextBridge.exposeInMainWorld('leaderpassAPI', {
  /**
   * Send a command to the Resolve helper.
   * @param {string} cmd - Command name.
   * @param {object} [params] - Optional parameters.
   * @returns {Promise<any>} Resolves with the helper response.
   */
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

// Expose helper message and status subscription API.
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Subscribe to helper messages.
   * @param {(message: string) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onHelperMessage(callback) {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('helper-message', handler);
    return () => ipcRenderer.removeListener('helper-message', handler);
  },

  /**
   * Subscribe to helper status updates.
   * @param {(status: any) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onHelperStatus(callback) {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('helper-status', handler);
    return () => ipcRenderer.removeListener('helper-status', handler);
  }
});

