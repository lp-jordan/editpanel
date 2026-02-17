const { app, BrowserWindow, Menu, dialog } = require('electron');
const { ipcMain } = require('electron');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { misspellings, suggestions } = require('./spellcheck');

let ffmpegPath = '';
try {
  ffmpegPath = require('ffmpeg-static') || '';
} catch (_error) {
  ffmpegPath = '';
}

const resolvePending = [];
const transcribePending = [];

let resolveHelperProc;
let resolveHelperReader;
let transcribeWorkerProc;
let transcribeWorkerReader;
let win;
let transcribeInProgress = false;

function flushPendingWithError(queue, message) {
  while (queue.length) {
    const request = queue.shift();
    if (request.event) {
      request.event.reply('helper-response', { ok: false, error: message });
      continue;
    }
    if (request.reject) {
      request.reject(new Error(message));
    }
  }
}

function spawnWorker() {
  return spawn('python', ['-m', 'helper.resolve_helper'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {})
    }
  });
}

function startResolveHelper() {
  resolveHelperProc = spawnWorker();
  resolveHelperReader = readline.createInterface({ input: resolveHelperProc.stdout });

  resolveHelperReader.on('line', line => {
    try {
      let message;
      try {
        message = JSON.parse(line);
      } catch (e) {
        message = { ok: false, error: 'invalid response' };
      }

      if (message.event === 'status') {
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('resolve-status', message)
        );
        return;
      }

      if (message.event === 'message') {
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('helper-message', message.message || message.data)
        );
        return;
      }

      if (resolvePending.length) {
        const request = resolvePending.shift();
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
      console.error('Error processing resolve helper output:', err);
      BrowserWindow.getAllWindows().forEach(w =>
        w.webContents.send('helper-error', { error: err.message })
      );
    }
  });

  resolveHelperProc.on('exit', () => {
    flushPendingWithError(resolvePending, 'resolve helper process exited');
    resolveHelperProc = null;
    if (resolveHelperReader) {
      resolveHelperReader.close();
      resolveHelperReader = null;
    }
  });
}

function startTranscribeWorker() {
  transcribeWorkerProc = spawnWorker();
  transcribeWorkerReader = readline.createInterface({ input: transcribeWorkerProc.stdout });

  transcribeWorkerReader.on('line', line => {
    try {
      let message;
      try {
        message = JSON.parse(line);
      } catch (e) {
        message = { ok: false, error: 'invalid response' };
      }

      if (message.event === 'status') {
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('transcribe-status', message)
        );
        return;
      }

      if (message.event === 'message') {
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('helper-message', message.message || message.data)
        );
        return;
      }

      if (transcribePending.length) {
        const request = transcribePending.shift();
        message = Object.assign({ ok: !message.error }, message);
        if (message.ok) {
          request.resolve(message);
        } else {
          request.reject(message);
        }
      }
    } catch (err) {
      console.error('Error processing transcribe worker output:', err);
      BrowserWindow.getAllWindows().forEach(w =>
        w.webContents.send('helper-error', { error: err.message })
      );
    }
  });

  transcribeWorkerProc.on('exit', () => {
    flushPendingWithError(transcribePending, 'transcribe worker process exited');
    transcribeInProgress = false;
    transcribeWorkerProc = null;
    if (transcribeWorkerReader) {
      transcribeWorkerReader.close();
      transcribeWorkerReader = null;
    }
  });
}

function restartTranscribeWorker(reason = 'transcribe worker restart requested') {
  if (transcribeWorkerProc) {
    transcribeWorkerProc.kill('SIGTERM');
  }
  flushPendingWithError(transcribePending, reason);
  startTranscribeWorker();
}

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

function queueResolveRequest(payload) {
  return new Promise((resolve, reject) => {
    if (!resolveHelperProc) {
      reject(new Error('resolve helper not running'));
      return;
    }

    const request = typeof payload === 'string' ? payload : JSON.stringify(payload);
    resolveHelperProc.stdin.write(`${request}\n`);
    resolvePending.push({ resolve, reject });
  });
}

function queueTranscribeRequest(payload) {
  return new Promise((resolve, reject) => {
    if (!transcribeWorkerProc) {
      reject(new Error('transcribe worker not running'));
      return;
    }

    const request = typeof payload === 'string' ? payload : JSON.stringify(payload);
    transcribeWorkerProc.stdin.write(`${request}\n`);
    transcribePending.push({ resolve, reject });
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

  startResolveHelper();
  startTranscribeWorker();

  ipcMain.on('helper-request', (event, payload) => {
    if (!resolveHelperProc) {
      event.reply('helper-response', { ok: false, error: 'resolve helper not running' });
      return;
    }
    const request = typeof payload === 'string' ? payload : JSON.stringify(payload);
    resolveHelperProc.stdin.write(`${request}\n`);
    resolvePending.push({ event });
  });

  ipcMain.handle('audio:transcribe-folder', async (_, payload = {}) => {
    const folderPath = typeof payload === 'string' ? payload : payload.folderPath;
    const useGpu = Boolean(payload && typeof payload === 'object' ? payload.useGpu : false);
    if (!folderPath) {
      throw new Error('folderPath is required');
    }
    transcribeInProgress = true;
    try {
      return await queueTranscribeRequest({
        cmd: 'transcribe_folder',
        folder_path: folderPath,
        engine: 'local',
        use_gpu: useGpu
      });
    } finally {
      transcribeInProgress = false;
    }
  });

  ipcMain.handle('audio:test-gpu', async () => {
    return queueTranscribeRequest({ cmd: 'test_cuda' });
  });

  ipcMain.handle('audio:cancel-transcribe', async () => {
    if (!transcribeInProgress) {
      return { ok: true, canceled: false, message: 'No transcription in progress' };
    }
    restartTranscribeWorker('transcription canceled');
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('helper-message', 'Transcribe: canceled by user')
    );
    transcribeInProgress = false;
    return { ok: true, canceled: true, message: 'Transcription canceled' };
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });

    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { canceled: true };
    }

    return {
      canceled: false,
      folderPath: result.filePaths[0]
    };
  });

  ipcMain.handle('fs:readFile', (_, p) => fs.promises.readFile(p, 'utf8'));
  ipcMain.handle('fs:writeFile', (_, p, data) =>
    fs.promises.writeFile(p, data, 'utf8')
  );
  ipcMain.handle('fs:stat', (_, p) => fs.promises.stat(p));

  ipcMain.handle('spellcheck:misspellings', misspellings);
  ipcMain.handle('spellcheck:suggestions', suggestions);

  // Handle generic leaderpass actions invoked from the renderer.
  ipcMain.handle('leaderpass-call', async (_, action = {}) => {
    const payload = typeof action === 'string' ? { cmd: action } : action;
    if (!payload || !payload.cmd) {
      throw new Error('leaderpass action must include cmd');
    }
    return queueResolveRequest(payload);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (resolveHelperProc) {
    resolveHelperProc.kill();
    resolveHelperProc = null;
    resolveHelperReader && resolveHelperReader.close();
  }
  if (transcribeWorkerProc) {
    transcribeWorkerProc.kill();
    transcribeWorkerProc = null;
    transcribeWorkerReader && transcribeWorkerReader.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
