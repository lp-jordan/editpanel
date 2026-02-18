const { app, BrowserWindow, Menu, dialog } = require('electron');
const { ipcMain } = require('electron');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { misspellings, suggestions } = require('./spellcheck');
const {
  WORKERS,
  RetryableError,
  normalizeError,
  toRequestEnvelope,
  validateRequestEnvelope,
  toWorkerWireMessage,
  normalizeResponseEnvelope
} = require('./orchestrator/contracts');

let ffmpegPath = '';
try {
  ffmpegPath = require('ffmpeg-static') || '';
} catch (_error) {
  ffmpegPath = '';
}

const resolvePending = new Map();
const transcribePending = new Map();

let resolveHelperProc;
let resolveHelperReader;
let transcribeWorkerProc;
let transcribeWorkerReader;
let win;
let transcribeInProgress = false;

function flushPendingWithError(queue, message) {
  for (const [id, request] of queue.entries()) {
    const payload = {
      id,
      ok: false,
      data: null,
      error: normalizeError(new RetryableError(message)),
      metrics: {}
    };
    if (request.event) {
      request.event.reply('helper-response', payload);
    } else if (request.reject) {
      request.reject(payload);
    }
    queue.delete(id);
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

function handleWorkerLine(worker, queue, line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (_error) {
    parsed = { ok: false, error: 'invalid response' };
  }

  const requestId = parsed && parsed.id ? parsed.id : null;
  const pendingRequest = requestId ? queue.get(requestId) : null;
  const normalized = normalizeResponseEnvelope(
    parsed,
    requestId || undefined,
    pendingRequest ? pendingRequest.startedAt : undefined
  );
  if (normalized.kind === 'event') {
    const eventName = normalized.envelope.event;
    if (eventName === 'message') {
      const logEvent = {
        type: 'log',
        worker,
        trace_id: normalized.envelope.trace_id,
        message: normalized.envelope.message,
        metrics: normalized.envelope.metrics
      };
      BrowserWindow.getAllWindows().forEach(w => {
        w.webContents.send('worker-event', logEvent);
        w.webContents.send('helper-message', normalized.envelope.message || normalized.envelope.data);
      });
      return;
    }

    const structuredEvent = {
      type: eventName === 'status' ? 'status' : 'progress',
      worker,
      trace_id: normalized.envelope.trace_id,
      code: normalized.envelope.code,
      data: normalized.envelope.data,
      error: normalized.envelope.error,
      metrics: normalized.envelope.metrics
    };

    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('worker-event', structuredEvent);
      if (eventName === 'status') {
        w.webContents.send(worker === WORKERS.media ? 'transcribe-status' : 'resolve-status', {
          event: 'status',
          ok: !normalized.envelope.error,
          code: normalized.envelope.code,
          data: normalized.envelope.data,
          error: normalized.envelope.error
        });
        w.webContents.send('helper-status', {
          event: 'status',
          ok: !normalized.envelope.error,
          code: normalized.envelope.code,
          data: normalized.envelope.data,
          error: normalized.envelope.error
        });
      }
    });
    return;
  }

  const request = normalized.envelope.id ? queue.get(normalized.envelope.id) : null;
  if (!request) {
    return;
  }
  queue.delete(normalized.envelope.id);

  const response = {
    ok: normalized.envelope.ok,
    data: normalized.envelope.data,
    error: normalized.envelope.error,
    metrics: normalized.envelope.metrics
  };

  if (request.event) {
    request.event.reply('helper-response', response);
    return;
  }

  if (response.ok) {
    request.resolve(response);
  } else {
    request.reject(response);
  }
}

function startResolveHelper() {
  resolveHelperProc = spawnWorker();
  resolveHelperReader = readline.createInterface({ input: resolveHelperProc.stdout });

  resolveHelperReader.on('line', line => {
    try {
      handleWorkerLine(WORKERS.resolve, resolvePending, line);
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
      handleWorkerLine(WORKERS.media, transcribePending, line);
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

function dispatchWorkerRequest(rawPayload, expectedWorker, queue, processRef) {
  const envelope = toRequestEnvelope(rawPayload, expectedWorker);
  validateRequestEnvelope(envelope);

  if (!processRef()) {
    throw new RetryableError(`${expectedWorker} worker not running`);
  }

  const wireMessage = toWorkerWireMessage(envelope);

  return new Promise((resolve, reject) => {
    queue.set(envelope.id, {
      resolve,
      reject,
      startedAt: Date.now(),
      traceId: envelope.trace_id
    });
    processRef().stdin.write(`${wireMessage}\n`);
  });
}

function queueResolveRequest(payload) {
  return new Promise((resolve, reject) => {
    dispatchWorkerRequest(payload, WORKERS.resolve, resolvePending, () => resolveHelperProc)
      .then(resolve)
      .catch(error => reject({ ok: false, error: normalizeError(error), data: null, metrics: {} }));
  });
}

function queueTranscribeRequest(payload) {
  return new Promise((resolve, reject) => {
    dispatchWorkerRequest(payload, WORKERS.media, transcribePending, () => transcribeWorkerProc)
      .then(resolve)
      .catch(error => reject({ ok: false, error: normalizeError(error), data: null, metrics: {} }));
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
    try {
      const envelope = toRequestEnvelope(payload, WORKERS.resolve);
      validateRequestEnvelope(envelope);
      if (!resolveHelperProc) {
        throw new RetryableError('resolve worker not running');
      }
      resolvePending.set(envelope.id, { event, startedAt: Date.now(), traceId: envelope.trace_id });
      resolveHelperProc.stdin.write(`${toWorkerWireMessage(envelope)}\n`);
    } catch (error) {
      event.reply('helper-response', {
        ok: false,
        data: null,
        error: normalizeError(error),
        metrics: {}
      });
    }
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
