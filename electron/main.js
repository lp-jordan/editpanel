const { app, BrowserWindow, Menu } = require('electron');
const { ipcMain } = require('electron');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { misspellings, suggestions } = require('./spellcheck');

const pending = [];

let helperProc;
let helperReader;
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function queueHelperRequest(payload) {
  return new Promise((resolve, reject) => {
    if (!helperProc) {
      reject(new Error('helper not running'));
      return;
    }

    const request = typeof payload === 'string' ? payload : JSON.stringify(payload);
    helperProc.stdin.write(`${request}\n`);
    pending.push({ resolve, reject });
  });
}

app.whenReady().then(() => {
  const template = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  helperProc = spawn('python', ['-m', 'helper.resolve_helper'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: path.join(__dirname, '..')
  });
  helperReader = readline.createInterface({ input: helperProc.stdout });

  helperReader.on('line', line => {
    try {
      let message;
      try {
        message = JSON.parse(line);
      } catch (e) {
        message = { ok: false, error: 'invalid response' };
      }

      if (message.event === 'status') {
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('helper-status', message)
        );
        return;
      }

      if (message.event === 'message') {
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('helper-message', message.message || message.data)
        );
        return;
      }

      if (pending.length) {
        const request = pending.shift();
        message = Object.assign({ ok: !message.error }, message);
        if (request.event) {
          request.event.reply('helper-response', message);
        } else if (message.ok) {
          request.resolve(message);
        } else {
          request.reject(message);
        }
      }
    } catch (err) {
      console.error('Error processing helper output:', err);
      BrowserWindow.getAllWindows().forEach(w =>
        w.webContents.send('helper-error', { error: err.message })
      );
    }
  });

  ipcMain.on('helper-request', (event, payload) => {
    if (!helperProc) {
      event.reply('helper-response', { ok: false, error: 'helper not running' });
      return;
    }
    const request = typeof payload === 'string' ? payload : JSON.stringify(payload);
    helperProc.stdin.write(`${request}\n`);
    pending.push({ event });
  });

  ipcMain.handle('audio:transcribe-folder', async (_, folderPath) => {
    if (!folderPath) {
      throw new Error('folderPath is required');
    }
    return queueHelperRequest({ cmd: 'transcribe_folder', folder_path: folderPath });
  });

  ipcMain.handle('fs:readFile', (_, p) => fs.promises.readFile(p, 'utf8'));
  ipcMain.handle('fs:writeFile', (_, p, data) =>
    fs.promises.writeFile(p, data, 'utf8')
  );
  ipcMain.handle('fs:stat', (_, p) => fs.promises.stat(p));

  ipcMain.handle('spellcheck:misspellings', misspellings);
  ipcMain.handle('spellcheck:suggestions', suggestions);

  // Handle generic leaderpass actions invoked from the renderer.
  ipcMain.handle('leaderpass-call', async (event, action) => {
    const msg = `Action ${action} invoked`;
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('helper-message', msg)
    );
    return { status: 'ok' };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (helperProc) {
    helperProc.kill();
    helperProc = null;
    helperReader && helperReader.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
