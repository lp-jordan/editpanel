const { app, BrowserWindow, Menu, dialog, ipcMain, screen, Tray, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { misspellings, suggestions } = require('./spellcheck');
const { LposClient } = require('./workers/lpos_client');
const { JobsDb } = require('./store/jobs-db');
const { listSessions: atemListSessions, ingestSessions: atemIngestSessions } = require('./workers/atem_ftp');
const r2 = require('./workers/b2_client');
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
const LPOS_DEFAULT_BASE_URL = 'https://lpos.tail856ed3.ts.net';
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

let win;
let tray = null;
let isQuitting = false;
let healthTimer = null;
let jobEngine = null;
let recipeCatalog = null;
let controlPlane = null;
let lposClient = null;
let lposHeartbeatTimer = null;
let jobsDb = null;
let atemCancelToken = null; // { canceled: boolean }
let resolveAutoConnectDone = false; // attempt auto-connect once per app session only

// Resolve connection state — updated by worker events, read by heartbeat
let resolveConnected = false;
let resolveProject = '';
let resolveTimeline = '';

const workers = {
  [WORKERS.resolve]: createWorkerState(WORKERS.resolve, {
    command: PYTHON_CMD,
    args: ['-m', 'helper.resolve_worker'],
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {})
    }
  }),
  [WORKERS.media]: createWorkerState(WORKERS.media, {
    command: PYTHON_CMD,
    args: ['-m', 'helper.media_worker'],
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {})
    }
  }),
  // platform worker removed — editpanel uploads only to LPOS, never Frame.io directly
};

function createWorkerState(name, spawnConfig) {
  return {
    name,
    spawnConfig,
    proc: null,
    reader: null,
    pending: new Map(),
    healthy: false,
    isUnavailableBroadcasted: false,
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
    if (workerName !== WORKERS.media) {
      w.webContents.send('resolve-status', payload);
    }
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
  if (!state.healthy && state.isUnavailableBroadcasted) {
    return;
  }
  state.healthy = false;
  state.isUnavailableBroadcasted = true;
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
      const eventMessage = typeof normalized.envelope.message === 'string'
        ? normalized.envelope.message
        : String(normalized.envelope.message || normalized.envelope.data || '');
      const logEvent = {
        type: 'log',
        worker: state.name,
        trace_id: normalized.envelope.trace_id,
        message: eventMessage,
        metrics: normalized.envelope.metrics
      };
      BrowserWindow.getAllWindows().forEach(w => {
        w.webContents.send('worker-event', logEvent);
        w.webContents.send('helper-message', eventMessage);
      });
      return;
    }

    // Track Resolve connection state so the heartbeat can report it
    if (state.name === WORKERS.resolve) {
      const code = normalized.envelope.code;
      if (code === 'CONNECTED') {
        resolveConnected = true;
        resolveProject = normalized.envelope.data?.project || '';
        resolveTimeline = normalized.envelope.data?.timeline || '';
      } else if (code === 'DISCONNECTED') {
        resolveConnected = false;
        resolveProject = '';
        resolveTimeline = '';
      } else if (code === 'CONTEXT_UPDATE' && normalized.envelope.data) {
        resolveProject = normalized.envelope.data.project || resolveProject;
        resolveTimeline = normalized.envelope.data.timeline || resolveTimeline;
      }
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
      if (state.name !== WORKERS.media) {
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
  // Pipe stderr (was 'inherit') so Python tracebacks, logger output, and
  // any pre-SIGTERM clues are visible inside the app's SlideoutConsole.
  // Without this, workers dying mid-flight produce silence in the UI and
  // diagnostics require tailing the terminal that launched Electron.
  state.proc = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
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

  state.stderrReader = readline.createInterface({ input: state.proc.stderr });
  state.stderrReader.on('line', line => {
    if (!line) return;
    // Mirror to terminal so existing log capture keeps working
    console.error(`[${state.name}:stderr] ${line}`);
    // Surface in the renderer so connection issues are debuggable in-app
    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('helper-message', `[${state.name}:stderr] ${line}`);
    });
  });

  // Suppress stdin write errors. When we try to send a command to a worker that
  // has already exited, stdin.write() fails and Node.js emits an 'error' event
  // on the Writable stream. Without a listener this becomes an uncaught exception
  // in the Electron main process — which breaks ALL child process pipes at once,
  // causing every worker to die and restart in an infinite 500 ms loop.
  state.proc.stdin.on('error', () => {});

  state.proc.on('error', (err) => {
    console.error(`${state.name} worker spawn error:`, err.message);
    markUnavailable(state, `${state.name} worker failed to start: ${err.message}`);
    state.proc = null;
    if (!state.stopping) {
      scheduleWorkerRestart(state, `spawn error: ${err.message}`);
    }
  });

  state.proc.on('spawn', () => {
    state.healthy = true;
    state.isUnavailableBroadcasted = false;
    state.crashCount = 0;
    broadcastWorkerStatus(state.name, 'available');
    // Auto-connect Resolve once per app session (not on every worker restart).
    // sendWorkerRequest can throw synchronously if the proc dies in the 500ms
    // window, so we wrap in try-catch to prevent a main-process crash dialog.
    if (state.name === WORKERS.resolve && !resolveAutoConnectDone) {
      resolveAutoConnectDone = true;
      setTimeout(() => {
        try {
          sendWorkerRequest({ cmd: 'connect' }, WORKERS.resolve).catch(() => {});
        } catch (_) {}
      }, 500);
    }
  });

  state.proc.on('exit', (code, signal) => {
    const exitInfo = signal ? `signal=${signal}` : `code=${code ?? '?'}`;
    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('helper-message', `[${state.name}] process exited (${exitInfo})`);
    });
    const wasStopping = state.stopping;
    state.proc = null;
    if (state.reader) {
      state.reader.close();
      state.reader = null;
    }
    markUnavailable(state, `${state.name} worker process exited`);
    if (state.stderrReader) {
      state.stderrReader.close();
      state.stderrReader = null;
    }
    if (!wasStopping) {
      scheduleWorkerRestart(state, `worker exited (${exitInfo})`);
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
  if (state.stderrReader) {
    state.stderrReader.close();
    state.stderrReader = null;
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
    if (state.proc) {
      state.proc.kill('SIGTERM');
      return;
    }
    markUnavailable(state, `${state.name} worker health check failed`);
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

function restartMediaWorker(reason = 'media worker restart requested') {
  const state = workers[WORKERS.media];
  if (state.proc) {
    state.stopping = true;
    state.proc.kill('SIGTERM');
  }
  flushPendingWithError(state, reason);
  startWorker(state);
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') {
      icon.setTemplateImage(true);
    }
  } catch (_err) {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('EditPanel');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show EditPanel',
      click: () => {
        if (win) {
          win.show();
          win.focus();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit EditPanel',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (win) {
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workAreaSize = primaryDisplay?.workAreaSize || { width: 1440, height: 900 };
  const width = Math.max(1100, Math.min(1440, Math.round(workAreaSize.width * 0.72)));
  const height = Math.max(760, Math.min(960, Math.round(workAreaSize.height * 0.82)));

  win = new BrowserWindow({
    width,
    height,
    minWidth: 980,
    minHeight: 700,
    frame: false,          // remove OS title bar and traffic-light buttons
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
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
  });
  jobEngine.resumeRecoverableJobs();

  // --- Result items DB ---
  try {
    jobsDb = new JobsDb(path.join(app.getPath('userData'), 'jobs-history.db'));
    jobsDb.clearStaleAtemLogs(); // mark any interrupted ingest runs from prior session
  } catch (err) {
    console.error('Failed to open jobs-history.db:', err.message);
  }

  // --- LPOS connectivity ---
  // Initialise client from stored preferences; secret comes from env (Doppler).
  try {
    const prefs = controlPlane.getPreferences();
    lposClient = new LposClient({
      baseUrl: prefs?.lposBaseUrl || LPOS_DEFAULT_BASE_URL,
      secret: process.env.EP_SHARED_SECRET || ''
    });
  } catch (_err) {
    lposClient = new LposClient({ baseUrl: LPOS_DEFAULT_BASE_URL });
  }

  // 10-second heartbeat — pushes current machine state to LPOS.
  // Failures are intentionally silent; LPOS marks us offline after 30s.
  lposHeartbeatTimer = setInterval(async () => {
    if (!lposClient || !lposClient.isConfigured()) return;
    try {
      const prefs = controlPlane ? controlPlane.getPreferences() : {};
      const instanceId = os.hostname();
      const jobs = jobEngine ? jobEngine.listJobs() : [];
      await lposClient.pushStatus({
        instance_id: instanceId,
        display_name: prefs?.displayName || instanceId,
        resolve_connected: resolveConnected,
        resolve_project: resolveProject || null,
        resolve_timeline: resolveTimeline || null,
        jobs_queued: jobs.filter(j => j.state === 'queued').length,
        jobs_running: jobs.filter(j => j.state === 'running').length
      });
    } catch (_err) {
      // silent — transient network failures are expected
    }
  }, 10_000);

  ipcMain.on('helper-request', (event, payload) => {
    // sendWorkerRequest throws synchronously when the worker isn't running,
    // so we need try-catch here — .catch() alone won't cover synchronous throws.
    try {
      sendWorkerRequest(payload, WORKERS.resolve, event).catch(error => {
        event.reply('helper-response', {
          ok: false,
          data: null,
          error: normalizeError(error),
          metrics: {}
        });
      });
    } catch (error) {
      event.reply('helper-response', {
        ok: false,
        data: null,
        error: normalizeError(error),
        metrics: {}
      });
    }
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
  ipcMain.handle('preferences:update', async (_, patch = {}) => {
    const prefs = controlPlane.setPreferences(patch);
    // Reinitialise LPOS client whenever the base URL is changed in Settings
    if (patch.lposBaseUrl !== undefined) {
      lposClient = new LposClient({
        baseUrl: prefs.lposBaseUrl || LPOS_DEFAULT_BASE_URL,
        secret: process.env.EP_SHARED_SECRET || ''
      });
    }
    return { ok: true, data: prefs };
  });

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

  // --- Result items IPC ---
  // Stores per-item reviewable state in SQLite so reviews survive restarts.

  ipcMain.handle('results:init', (_event, jobId, itemType, label, items) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return jobsDb.initRun(jobId, itemType, label, Array.isArray(items) ? items : []);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('results:list-runs', (_event, limit = 20) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return { ok: true, data: jobsDb.listRuns(Number(limit)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('results:get-items', (_event, jobId) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return { ok: true, data: jobsDb.getItems(jobId) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('results:resolve-item', (_event, jobId, itemKey, resolution) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return jobsDb.resolveItem(jobId, itemKey, resolution);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('results:skip-item', (_event, jobId, itemKey) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return jobsDb.skipItem(jobId, itemKey);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('results:reset-run', (_event, jobId) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return jobsDb.resetRun(jobId);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('app:quit', () => {
    isQuitting = true;
    app.quit();
  });

  // --- LPOS IPC handlers ---
  // Used by the renderer to query LPOS data (projects, notes, comments, health).
  // All calls proxy through LposClient which adds the X-EP-Secret header.

  ipcMain.handle('lpos:health', async () => {
    if (!lposClient || !lposClient.isConfigured()) {
      return { ok: false, error: 'LPOS not configured' };
    }
    try {
      const data = await lposClient.checkHealth();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lpos:projects', async () => {
    if (!lposClient || !lposClient.isConfigured()) {
      return { ok: false, error: 'LPOS not configured' };
    }
    try {
      const data = await lposClient.listProjects();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lpos:project', async (_, projectId) => {
    if (!lposClient || !lposClient.isConfigured()) {
      return { ok: false, error: 'LPOS not configured' };
    }
    try {
      const data = await lposClient.getProject(projectId);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lpos:project-notes', async (_, projectId) => {
    if (!lposClient || !lposClient.isConfigured()) {
      return { ok: false, error: 'LPOS not configured' };
    }
    try {
      const data = await lposClient.getProjectNotes(projectId);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lpos:asset-comments', async (_, projectId, assetId) => {
    if (!lposClient || !lposClient.isConfigured()) {
      return { ok: false, error: 'LPOS not configured' };
    }
    try {
      const data = await lposClient.getAssetComments(projectId, assetId);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- ATEM FTP IPC ---

  ipcMain.handle('atem:list-sessions', async (_, host) => {
    const prefs = controlPlane ? controlPlane.getPreferences() : {};
    const ftpHost = host || prefs.atemFtpHost || '172.20.10.241';

    // Mirror ATEM logs to BOTH the launching terminal (console.log) and the
    // in-app SlideoutConsole (helper-message). basic-ftp's own `verbose` mode
    // writes directly to console.log and ignores function callbacks, so the
    // previous "I see FTP output in my terminal" behaviour you may remember
    // was that — not our stage logs. Mirroring both keeps the user covered
    // regardless of which window they're watching.
    function atemLog(msg) {
      const line = `[ATEM] ${msg}`;
      console.log(line);
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send('helper-message', line));
    }

    atemLog(`Connecting to ${ftpHost}:21 (anonymous)…`);
    const result = await atemListSessions(ftpHost, 21, atemLog);
    if (result.ok) {
      atemLog(`FTP OK — ${result.data?.length ?? 0} session(s) found`);
    } else {
      atemLog(`FTP error: ${result.error || 'unknown'}`);
    }
    return result;
  });

  ipcMain.handle('atem:start-ingest', (_, { host, sessions, destination }) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    if (!host || !sessions?.length || !destination) {
      return { ok: false, error: 'host, sessions, and destination are required' };
    }

    // Create DB log entries for each session up-front, then fire ingest async.
    const logIds = {};
    for (const session of sessions) {
      try {
        logIds[session.name] = jobsDb.createAtemLog(session.name, host, destination, session.fileCount);
      } catch (err) {
        console.error('atem:start-ingest createAtemLog error:', err.message);
      }
    }

    // Cancel any prior ingest
    if (atemCancelToken) atemCancelToken.canceled = true;
    atemCancelToken = { canceled: false };
    const token = atemCancelToken;

    function broadcastAtem(event) {
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send('atem-progress', event));
    }

    // Fire and forget — progress arrives via 'atem-progress' events
    atemIngestSessions(
      host,
      21,
      sessions,
      destination,
      logIds,
      (event) => {
        // Mirror DB writes here
        if (event.type === 'file-done' && jobsDb) {
          try {
            jobsDb.markAtemFileDone(
              event.logId, event.file, event.destPath,
              event.camInfo?.camNumber ?? null,
              event.camInfo?.takeNumber ?? null,
              event.size ?? 0
            );
            // Increment files_done on the log
            const log = jobsDb.listAtemLogs(1, event.session)[0];
            if (log) jobsDb.updateAtemLog(event.logId, { filesDone: log.files_done + 1 });
          } catch (_) {}
        }
        if ((event.type === 'file-error' || event.type === 'file-skipped') && jobsDb) {
          try {
            if (event.type === 'file-error') {
              jobsDb.markAtemFileFailed(event.logId, event.file, event.error);
            } else {
              // Skipped = already on disk; count as done
              const log = jobsDb.listAtemLogs(1, event.session)[0];
              if (log) jobsDb.updateAtemLog(event.logId, { filesDone: log.files_done + 1 });
            }
          } catch (_) {}
        }
        broadcastAtem(event);
      },
      token
    ).then(result => {
      // Finalize all log entries
      for (const session of sessions) {
        if (!jobsDb) break;
        try {
          const state = result.ok ? 'completed' : (result.error === 'canceled' ? 'canceled' : 'failed');
          jobsDb.updateAtemLog(logIds[session.name], {
            state,
            finishedAt: Date.now(),
            error: result.error || null
          });
        } catch (_) {}
      }
      broadcastAtem({ type: 'ingest-complete', ok: result.ok, error: result.error });
    }).catch(err => {
      broadcastAtem({ type: 'ingest-error', error: err.message });
    });

    return { ok: true, logIds };
  });

  ipcMain.handle('atem:cancel-ingest', () => {
    if (atemCancelToken) atemCancelToken.canceled = true;
    return { ok: true };
  });

  ipcMain.handle('atem:ingest-logs', async (_, limit = 30) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return { ok: true, data: jobsDb.listAtemLogs(limit) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- R2 Backup Manager IPC ---

  ipcMain.handle('r2:is-configured', () => ({
    ok: true,
    data: r2.isConfigured()
  }));

  ipcMain.handle('r2:list-dates', async () => r2.listDates());

  ipcMain.handle('r2:list-date-files', async (_, date) => r2.listDateFiles(date));

  ipcMain.handle('r2:get-file-content', async (_, key) => r2.getFileContent(key));

  ipcMain.handle('r2:delete-date', async (_, date) => {
    const result = await r2.deleteDate(date);
    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('helper-message', result.ok
        ? `[R2] Deleted ${result.data.deleted} file(s) from ${date}`
        : `[R2] Delete failed: ${result.error}`
      );
    });
    return result;
  });

  ipcMain.handle('r2:delete-file', async (_, key) => {
    const result = await r2.deleteFile(key);
    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('helper-message', result.ok
        ? `[R2] Deleted ${key}`
        : `[R2] Delete failed: ${result.error}`
      );
    });
    return result;
  });

  createTray();
  createWindow();

  app.on('activate', () => {
    if (win) {
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Keep the main process alive in the background.
  // Workers, job engine, and background tasks continue running.
  // User can reopen the window from the tray icon.
});

app.on('before-quit', () => {
  isQuitting = true;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (lposHeartbeatTimer) { clearInterval(lposHeartbeatTimer); lposHeartbeatTimer = null; }
  lposClient = null;
  if (jobsDb) { jobsDb.close(); jobsDb = null; }
  if (controlPlane) { controlPlane.dispose(); controlPlane = null; }
  Object.values(workers).forEach(stopWorker);
  if (tray) { tray.destroy(); tray = null; }
});
