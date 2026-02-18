const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
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
const { JobEngine } = require('./orchestrator/job_engine');
const { RecipeCatalog } = require('./orchestrator/recipes');
const { ControlPlane } = require('./orchestrator/control_plane');

let ffmpegPath = '';
try {
  ffmpegPath = require('ffmpeg-static') || '';
} catch (_error) {
  ffmpegPath = '';
}

const HEALTH_INTERVAL_MS = 10000;
const PING_TIMEOUT_MS = 3000;
const RESTART_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];

let win;
let transcribeInProgress = false;
let healthTimer = null;
let jobEngine = null;
let recipeCatalog = null;
let controlPlane = null;

const workers = {
  [WORKERS.resolve]: createWorkerState(WORKERS.resolve, {
    command: 'python',
    args: ['-m', 'helper.resolve_worker'],
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {})
    }
  }),
  [WORKERS.media]: createWorkerState(WORKERS.media, {
    command: 'python',
    args: ['-m', 'helper.media_worker'],
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {})
    }
  }),
  [WORKERS.platform]: createWorkerState(WORKERS.platform, {
    command: process.execPath,
    args: [path.join(__dirname, 'workers', 'platform_worker.js')],
    cwd: path.join(__dirname, '..'),
    env: process.env
  })
};

function createWorkerState(name, spawnConfig) {
  return {
    name,
    spawnConfig,
    proc: null,
    reader: null,
    pending: new Map(),
    healthy: false,
    crashCount: 0,
    restartTimer: null,
    startedAt: 0,
    stopping: false
  };
}

function broadcastWorkerStatus(workerName, status) {
  const payload = {
    event: 'status',
    worker: workerName,
    ok: status === 'available',
    code: status === 'available' ? 'WORKER_AVAILABLE' : 'WORKER_UNAVAILABLE',
    data: { worker: workerName },
    error: status === 'available' ? null : `${workerName} worker unavailable`
  };

  BrowserWindow.getAllWindows().forEach(w => {
    w.webContents.send('worker-event', {
      type: 'status',
      worker: workerName,
      code: payload.code,
      data: payload.data,
      error: payload.error,
      metrics: {}
    });
    w.webContents.send(workerName === WORKERS.media ? 'transcribe-status' : 'resolve-status', payload);
    w.webContents.send('helper-status', payload);
    if (status === 'unavailable') {
      w.webContents.send('helper-message', `${workerName} worker unavailable`);
    }
  });
}

function flushPendingWithError(state, message) {
  for (const [id, request] of state.pending.entries()) {
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
    state.pending.delete(id);
  }
}

function markUnavailable(state, reason) {
  state.healthy = false;
  flushPendingWithError(state, reason);
  broadcastWorkerStatus(state.name, 'unavailable');
}

function handleWorkerLine(state, line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (_error) {
    parsed = { ok: false, error: 'invalid response' };
  }

  const requestId = parsed && parsed.id ? parsed.id : null;
  const pendingRequest = requestId ? state.pending.get(requestId) : null;
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
        worker: state.name,
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

    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('worker-event', {
        type: eventName === 'status' ? 'status' : 'progress',
        worker: state.name,
        trace_id: normalized.envelope.trace_id,
        code: normalized.envelope.code,
        data: normalized.envelope.data,
        error: normalized.envelope.error,
        metrics: normalized.envelope.metrics
      });
      w.webContents.send('helper-status', {
        event: 'status',
        worker: state.name,
        ok: !normalized.envelope.error,
        code: normalized.envelope.code,
        data: normalized.envelope.data,
        error: normalized.envelope.error
      });
      if (state.name === WORKERS.media) {
        w.webContents.send('transcribe-status', normalized.envelope);
      } else {
        w.webContents.send('resolve-status', normalized.envelope);
      }
    });
    return;
  }

  const request = normalized.envelope.id ? state.pending.get(normalized.envelope.id) : null;
  if (!request) {
    return;
  }
  state.pending.delete(normalized.envelope.id);

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

function scheduleWorkerRestart(state, reason) {
  if (state.restartTimer) {
    return;
  }
  const idx = Math.min(state.crashCount, RESTART_BACKOFF_MS.length - 1);
  const delay = RESTART_BACKOFF_MS[idx];
  state.crashCount += 1;
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    startWorker(state);
  }, delay);
  console.warn(`${state.name} worker restart in ${delay}ms (${reason})`);
}

function startWorker(state) {
  if (state.proc) {
    return;
  }
  const { command, args, cwd, env } = state.spawnConfig;
  state.stopping = false;
  state.proc = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd,
    env
  });
  state.startedAt = Date.now();

  state.reader = readline.createInterface({ input: state.proc.stdout });
  state.reader.on('line', line => {
    try {
      handleWorkerLine(state, line);
    } catch (err) {
      console.error(`Error processing ${state.name} worker output:`, err);
    }
  });

  state.proc.on('spawn', () => {
    state.healthy = true;
    state.crashCount = 0;
    broadcastWorkerStatus(state.name, 'available');
  });

  state.proc.on('exit', () => {
    const wasStopping = state.stopping;
    state.proc = null;
    if (state.reader) {
      state.reader.close();
      state.reader = null;
    }
    markUnavailable(state, `${state.name} worker process exited`);
    if (state.name === WORKERS.media) {
      transcribeInProgress = false;
    }
    if (!wasStopping) {
      scheduleWorkerRestart(state, 'worker exited');
    }
  });
}

function stopWorker(state) {
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
  if (state.proc) {
    state.stopping = true;
    state.proc.kill('SIGTERM');
    state.proc = null;
  }
  if (state.reader) {
    state.reader.close();
    state.reader = null;
  }
}

function sendWorkerRequest(rawPayload, explicitWorker, event = null) {
  const envelope = toRequestEnvelope(rawPayload, explicitWorker);
  validateRequestEnvelope(envelope);

  const state = workers[envelope.worker];
  if (!state || !state.proc || !state.proc.stdin || state.proc.killed) {
    throw new RetryableError(`${envelope.worker} worker not running`);
  }

  const wireMessage = toWorkerWireMessage(envelope);

  return new Promise((resolve, reject) => {
    state.pending.set(envelope.id, {
      event,
      resolve,
      reject,
      startedAt: Date.now(),
      traceId: envelope.trace_id
    });
    state.proc.stdin.write(`${wireMessage}\n`);
  });
}

async function healthCheckWorker(state) {
  if (!state.proc || !state.healthy) {
    return;
  }

  try {
    await Promise.race([
      sendWorkerRequest({ cmd: 'ping' }, state.name),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS))
    ]);
  } catch (_error) {
    markUnavailable(state, `${state.name} worker health check failed`);
    if (state.proc) {
      state.proc.kill('SIGTERM');
    }
  }
}

function startHealthChecks() {
  if (healthTimer) {
    clearInterval(healthTimer);
  }
  healthTimer = setInterval(() => {
    Object.values(workers).forEach(state => {
      healthCheckWorker(state);
    });
  }, HEALTH_INTERVAL_MS);
}

function spawnResolveWorker() {
  startWorker(workers[WORKERS.resolve]);
}

function spawnMediaWorker() {
  startWorker(workers[WORKERS.media]);
}

function spawnPlatformWorker() {
  startWorker(workers[WORKERS.platform]);
}

function restartMediaWorker(reason = 'media worker restart requested') {
  const state = workers[WORKERS.media];
  if (state.proc) {
    state.stopping = true;
    state.proc.kill('SIGTERM');
  }
  flushPendingWithError(state, reason);
  startWorker(state);
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

function broadcastJobEvent(event) {
  BrowserWindow.getAllWindows().forEach(w => {
    w.webContents.send('job-event', event);
  });
}

app.whenReady().then(() => {
  recipeCatalog = new RecipeCatalog();

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

  spawnResolveWorker();
  spawnMediaWorker();
  spawnPlatformWorker();
  startHealthChecks();

  jobEngine = new JobEngine({
    sendStepRequest: payload => sendWorkerRequest(payload),
    forceKillWorker: (worker, reason) => {
      if (worker === WORKERS.media) {
        restartMediaWorker(reason);
      } else {
        const state = workers[worker];
        if (state && state.proc) {
          state.stopping = true;
          state.proc.kill('SIGTERM');
          startWorker(state);
        }
      }
    },
    persistencePath: path.join(app.getPath('userData'), 'jobs.jsonl'),
    mediaConcurrency: Number(process.env.MEDIA_WORKER_CONCURRENCY || 2),
    platformConcurrency: Number(process.env.PLATFORM_WORKER_CONCURRENCY || 2)
  });

  controlPlane = new ControlPlane({
    jobEngine,
    recipeCatalog,
    preferencesPath: path.join(app.getPath('userData'), 'preferences.json'),
    maxEvents: 2000
  });
  jobEngine.subscribe(event => {
    broadcastJobEvent(event);
    if (event.type === 'step_progress' && event.worker === WORKERS.media) {
      BrowserWindow.getAllWindows().forEach(w => {
        w.webContents.send('transcribe-status', {
          event: 'progress',
          code: 'JOB_STEP_PROGRESS',
          data: event,
          error: event.error || null
        });
      });
    }
  });
  jobEngine.resumeRecoverableJobs();

  ipcMain.on('helper-request', (event, payload) => {
    sendWorkerRequest(payload, WORKERS.resolve, event).catch(error => {
      event.reply('helper-response', {
        ok: false,
        data: null,
        error: normalizeError(error),
        metrics: {}
      });
    });
  });

  ipcMain.handle('audio:transcribe-folder', async (_, payload = {}) => {
    const folderPath = typeof payload === 'string' ? payload : payload.folderPath;
    const useGpu = Boolean(payload && typeof payload === 'object' ? payload.useGpu : false);
    if (!folderPath) {
      throw new Error('folderPath is required');
    }
    const plan = recipeCatalog.buildPlan(
      'transcribe_folder',
      {
        folder: folderPath,
        use_gpu: useGpu,
        engine: typeof payload.engine === 'string' ? payload.engine : undefined
      },
      {
        idempotency_key: payload.idempotency_key || `transcribe:${folderPath}:${useGpu}`,
        timeout_ms: payload.timeout_ms,
        retry_policy: payload.retry_policy
      }
    );

    const job = jobEngine.submit(plan);
    transcribeInProgress = true;

    return new Promise((resolve, reject) => {
      const unsubscribe = jobEngine.subscribe(event => {
        if (event.job_id !== job.job_id || event.type !== 'job_state') {
          return;
        }

        if (['succeeded', 'failed', 'canceled'].includes(event.state)) {
          unsubscribe();
          transcribeInProgress = false;
          const completed = jobEngine.getJob(job.job_id);
          if (event.state === 'succeeded') {
            resolve({
              ok: true,
              data: recipeCatalog.materializeOutputs('transcribe_folder', completed),
              job_id: job.job_id
            });
          } else if (event.state === 'canceled') {
            reject({ ok: false, error: { message: 'Transcription canceled' }, job_id: job.job_id });
          } else {
            reject({ ok: false, error: completed?.errors?.[0]?.error || { message: 'Transcription failed' }, job_id: job.job_id });
          }
        }
      });
    });
  });

  ipcMain.handle('audio:test-gpu', async () => sendWorkerRequest({ cmd: 'test_cuda' }, WORKERS.media));

  ipcMain.handle('audio:cancel-transcribe', async () => {
    const transcribeJob = jobEngine
      .listJobs()
      .find(job => job.preset_id === 'transcribe_folder' && ['queued', 'running'].includes(job.state));
    if (!transcribeJob) {
      if (!transcribeInProgress) {
        return { ok: true, canceled: false, message: 'No transcription in progress' };
      }
      return { ok: true, canceled: false, message: 'No active job found' };
    }
    const cancelResult = jobEngine.cancel(transcribeJob.job_id);
    restartMediaWorker('transcription canceled');
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('helper-message', 'Transcribe: canceled by user'));
    transcribeInProgress = false;
    return { ok: true, canceled: true, message: 'Transcription canceled', ...cancelResult };
  });

  ipcMain.handle('jobs:list', async () => ({ ok: true, data: jobEngine.listJobs() }));
  ipcMain.handle('dashboard:snapshot', async () => ({ ok: true, data: controlPlane.buildDashboard() }));
  ipcMain.handle('jobs:get', async (_, jobId) => ({ ok: true, data: jobEngine.getJob(jobId) }));
  ipcMain.handle('jobs:cancel', async (_, jobId) => jobEngine.cancel(jobId));
  ipcMain.handle('jobs:retry', async (_, jobId) => controlPlane.retryJob(jobId));
  ipcMain.handle('recipes:list', async () => ({ ok: true, data: recipeCatalog.list() }));
  ipcMain.handle('recipes:launch', async (_, payload = {}) => {
    const recipeId = payload?.recipeId;
    if (!recipeId) {
      throw new Error('recipeId is required');
    }
    return { ok: true, data: controlPlane.launchRecipe(recipeId, payload.input || {}, payload.options || {}) };
  });

  ipcMain.handle('preferences:get', async () => ({ ok: true, data: controlPlane.getPreferences() }));
  ipcMain.handle('preferences:update', async (_, patch = {}) => ({ ok: true, data: controlPlane.setPreferences(patch) }));

  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return { canceled: false, folderPath: result.filePaths[0] };
  });

  ipcMain.handle('fs:readFile', (_, p) => fs.promises.readFile(p, 'utf8'));
  ipcMain.handle('fs:writeFile', (_, p, data) => fs.promises.writeFile(p, data, 'utf8'));
  ipcMain.handle('fs:stat', (_, p) => fs.promises.stat(p));

  ipcMain.handle('spellcheck:misspellings', misspellings);
  ipcMain.handle('spellcheck:suggestions', suggestions);

  ipcMain.handle('leaderpass-call', async (_, action = {}) => {
    const payload = typeof action === 'string' ? { cmd: action } : action;
    if (!payload || !payload.cmd) {
      throw new Error('leaderpass action must include cmd');
    }
    return sendWorkerRequest(payload);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (controlPlane) {
    controlPlane.dispose();
    controlPlane = null;
  }
  Object.values(workers).forEach(stopWorker);
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
