const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell, Tray, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { misspellings, suggestions } = require('./spellcheck');
const { LposClient } = require('./workers/lpos_client');
const { JobsDb } = require('./store/jobs-db');
const { listSessions: atemListSessions, ingestSessions: atemIngestSessions } = require('./workers/atem_ftp');
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

// When packaged, app code runs from inside app.asar. Python cannot import modules
// from inside an asar archive, and ffmpeg-static's binary lives in app.asar.unpacked
// (see "asarUnpack" / "extraResources" in package.json build config). Resolve both
// against their real on-disk locations so the helper workers spawn in a packaged build.
if (ffmpegPath && app.isPackaged) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}
// Directory that contains the `helper/` Python package. In dev it's the project
// root; when packaged, helper/ is shipped unpacked as an extraResource under
// resourcesPath, so `python -m helper.<worker>` resolves with cwd = HELPER_ROOT.
const HELPER_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');

const HEALTH_INTERVAL_MS = 10000;
const PING_TIMEOUT_MS = 3000;
// Consecutive missed health-check pings before an otherwise-idle worker is
// treated as hung and restarted. The Python workers are single-threaded —
// they read one command from stdin, run it to completion, then read the next.
// A slow Resolve op (connect/render/export) or a GIL-holding poll in the
// background _monitor_resolve thread can delay a single ping by >PING_TIMEOUT_MS
// without the worker being dead. SIGTERMing on the first miss was the root
// cause of the constant Resolve disconnect/restart loop; tolerating a few
// consecutive misses (≈MAX_MISSED_PINGS × HEALTH_INTERVAL_MS of true silence)
// only kills a genuinely wedged, idle worker.
const MAX_MISSED_PINGS = 3;
const RESTART_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];
// When the Resolve worker is in a known-bad crash loop (access-violation on
// import, or repeated sub-2s deaths) we still want to keep retrying in case
// the user fixes the underlying issue (toggles external scripting, opens
// Resolve, etc.), but every-10-seconds restart spam drowns out the advisory
// in the console. Slow-poll instead.
const RESOLVE_ADVISORY_RETRY_MS = 30000;
// Windows access-violation exit code = 0xC0000005. python_get_resolve loads
// fusionscript.dll successfully (we see "available (bundled)" in stderr) but
// then segfaults inside the first GetResolve() call — classic signature of
// External Scripting being set to None in Resolve Preferences, or of the
// free (non-Studio) build of Resolve being installed (no scripting endpoint).
const WIN_ACCESS_VIOLATION_EXIT = 3221225477;
// Worker uptime below this is treated as "didn't really start" for crash-loop
// detection. Healthy startup → CONNECTED takes well over a second on a cold
// Resolve, so this only catches the immediate-crash case.
const FAST_CRASH_UPTIME_MS = 2000;
const FAST_CRASH_THRESHOLD = 2;
const LPOS_DEFAULT_BASE_URL = 'https://lpos.tail856ed3.ts.net';
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';
const EP_LINK_SCHEME = 'lpos-editpanel';
const EP_LINK_CALLBACK = `${EP_LINK_SCHEME}://callback`;

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
let pendingEpLinkUrl = null; // captured before whenReady if the OS hands us a callback URL at cold start

// Resolve connection state — updated by worker events, read by heartbeat
let resolveConnected = false;
let resolveProject = '';
let resolveTimeline = '';

const workers = {
  [WORKERS.resolve]: createWorkerState(WORKERS.resolve, {
    command: PYTHON_CMD,
    args: ['-m', 'helper.resolve_worker'],
    cwd: HELPER_ROOT,
    env: {
      ...process.env,
      ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {})
    }
  }),
  [WORKERS.media]: createWorkerState(WORKERS.media, {
    command: PYTHON_CMD,
    args: ['-m', 'helper.media_worker'],
    cwd: HELPER_ROOT,
    env: {
      ...process.env,
      ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {})
    }
  }),
  // platform worker removed — editpanel uploads only to LPOS, never Frame.io directly
};

// ─── Phase 5c.3 helpers: format Frame.io comments for the sync_comment_markers
// helper. Lives at module scope so the IPC handler stays focused on
// orchestration. Schema match: FrameIOComment (lpos-dashboard) → target_comment
// (sync_comment_markers.py).
function _formatHMS(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(total / 60);
  const ss = total % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

function _formatTargetComment(comment) {
  // Frame.io general comments have null timestamp — they can't be anchored to a
  // timeline frame, so skip them entirely (orchestrator counts these separately
  // so the editor sees they exist but weren't placed).
  if (typeof comment?.timestamp !== 'number') return null;
  if (!comment.id) return null;

  const author = comment.authorName || 'Unknown';
  const name = `${author} · ${_formatHMS(comment.timestamp)}`;

  let note = comment.text || '';
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  for (const reply of replies) {
    note += `\n  ↳ ${reply.authorName || 'Unknown'}: ${reply.text || ''}`;
  }

  return {
    commentId: comment.id,
    timestamp_s: comment.timestamp,
    duration_s: typeof comment.duration === 'number' ? comment.duration : null,
    name,
    note,
  };
}

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
    missedPings: 0,
    restartTimer: null,
    startedAt: 0,
    stopping: false,
    // Sticky advisory state (resolve worker only today). When set, the
    // restart scheduler slow-polls and the renderer shows a banner with
    // an actionable fix instead of just logging WORKER_UNAVAILABLE noise.
    advisoryActive: false,
    advisoryCode: null
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
        // Whatever advisory was up (scripting unreachable, crash loop) is
        // by definition resolved — we just got a healthy attach.
        clearResolveAdvisory(state);
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
  // Slow-poll while an actionable advisory is displayed (e.g. Resolve external
  // scripting disabled). The user needs to fix the host-side issue; spamming
  // restart attempts every 10s buries the advisory and burns CPU for nothing.
  const idx = Math.min(state.crashCount, RESTART_BACKOFF_MS.length - 1);
  const delay = state.advisoryActive ? RESOLVE_ADVISORY_RETRY_MS : RESTART_BACKOFF_MS[idx];
  state.crashCount += 1;
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    startWorker(state);
  }, delay);
  console.warn(`${state.name} worker restart in ${delay}ms (${reason})`);
}

// Emit a user-facing advisory describing a known Resolve-worker failure mode
// and a concrete fix. Goes to both the slideout console (helper-message) and
// a dedicated channel the renderer uses to render a persistent banner.
// Idempotent per advisory.code so we don't spam during the slow-poll retry.
function emitResolveAdvisory(state, advisory) {
  if (state.advisoryActive && state.advisoryCode === advisory.code) {
    return;
  }
  state.advisoryActive = true;
  state.advisoryCode = advisory.code;
  const payload = {
    code: advisory.code,
    title: advisory.title,
    body: advisory.body,
    hint: advisory.hint || null,
    at: Date.now()
  };
  BrowserWindow.getAllWindows().forEach(w => {
    w.webContents.send('resolve-advisory', payload);
    w.webContents.send('helper-message', `[resolve] ⚠ ${advisory.title} — ${advisory.body}`);
    if (advisory.hint) {
      w.webContents.send('helper-message', `[resolve] → ${advisory.hint}`);
    }
  });
}

function clearResolveAdvisory(state) {
  if (!state.advisoryActive) return;
  state.advisoryActive = false;
  state.advisoryCode = null;
  BrowserWindow.getAllWindows().forEach(w => {
    w.webContents.send('resolve-advisory', null);
  });
}

// Inspect a resolve-worker exit and surface a targeted advisory when the
// signature matches a known failure mode. Returns true if an advisory was
// emitted (caller can use it to know it's already explained the problem).
function checkResolveWorkerExitForAdvisory(state, code, uptimeMs) {
  if (state.name !== WORKERS.resolve) return false;

  // 1) Windows access-violation during GetResolve(). On a Studio host where
  //    external scripting is *enabled* and Resolve is open, GetResolve()
  //    returns a handle without crashing. A segfault here means the scripting
  //    endpoint isn't reachable — either the prefs flag is off, or the host
  //    is the free build (which lacks the endpoint entirely).
  if (process.platform === 'win32' && code === WIN_ACCESS_VIOLATION_EXIT) {
    emitResolveAdvisory(state, {
      code: 'RESOLVE_SCRIPTING_UNREACHABLE',
      title: "Can't reach DaVinci Resolve's scripting endpoint",
      body: "The Resolve helper crashed on startup (Windows access violation). This usually means external scripting is disabled in Resolve, or the installed build is Resolve free (Studio is required).",
      hint: "In Resolve: Preferences → System → General → \"External scripting using\" → set to Local, then click Reconnect. Confirm Help → About says \"DaVinci Resolve Studio\"."
    });
    return true;
  }

  // 2) Repeated immediate crashes without a clean exit code we recognise.
  //    Catches Mac/Linux variants of the same problem and any non-AV crash
  //    pattern we haven't classified yet.
  if (uptimeMs < FAST_CRASH_UPTIME_MS && state.crashCount >= FAST_CRASH_THRESHOLD) {
    emitResolveAdvisory(state, {
      code: 'RESOLVE_WORKER_CRASH_LOOP',
      title: 'Resolve helper keeps crashing on startup',
      body: `The helper has died ${state.crashCount} times in under ${Math.round(FAST_CRASH_UPTIME_MS / 1000)}s. The scripting bridge to Resolve isn't responding.`,
      hint: "Check that DaVinci Resolve Studio is open, and Preferences → System → General → \"External scripting using\" is set to Local. Then click Reconnect."
    });
    return true;
  }

  return false;
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
    state.missedPings = 0;
    broadcastWorkerStatus(state.name, 'available');
    // Auto-connect Resolve once per app session (not on every worker restart).
    // The manual reconnect path (Offline chip → resolve:reconnect IPC) resets
    // resolveAutoConnectDone before killing the worker, so the next spawn
    // re-triggers this auto-connect against a fresh Python process. That's
    // intentional — DaVinciResolveScript's native module can cache a failed
    // attach in-process, so retrying connect in the same worker is useless.
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
    const uptimeMs = state.startedAt ? Date.now() - state.startedAt : 0;
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
      // Classify the exit before scheduling a restart so the advisory flag
      // is set in time for scheduleWorkerRestart to pick the slow-poll delay.
      checkResolveWorkerExitForAdvisory(state, code, uptimeMs);
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
      cmd: envelope.cmd,
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
    state.missedPings = 0;
  } catch (_error) {
    if (!state.proc) {
      markUnavailable(state, `${state.name} worker health check failed`);
      return;
    }

    // A real command (connect/render/export/bins) blocks the worker's
    // single-threaded stdin loop, so the queued ping legitimately can't be
    // answered until that work finishes. That's a busy worker, not a dead
    // one — don't accrue a strike. The queued ping resolves harmlessly once
    // the command completes. Long-running jobs are independently watched by
    // the JobEngine's forceKillWorker path.
    const hasInflightCommand = [...state.pending.values()].some(p => p.cmd && p.cmd !== 'ping');
    if (hasInflightCommand) {
      state.missedPings = 0;
      return;
    }

    // Idle worker that won't answer ping — likely a transient GIL stall in
    // the background monitor poll. Tolerate a few in a row before restarting.
    state.missedPings += 1;
    if (state.missedPings < MAX_MISSED_PINGS) {
      return;
    }
    state.missedPings = 0;
    console.warn(`${state.name} worker unresponsive after ${MAX_MISSED_PINGS} consecutive pings — restarting`);
    state.proc.kill('SIGTERM');
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

// ── Export / render tracking ───────────────────────────────────────────────
//
// EditPanel queues the render (lp_base_export), optionally starts it
// (start_render), then this main-process tracker polls render_status every few
// seconds and reports progress to the Jobs panel. Polling (rather than a
// blocking "wait for render" worker command) keeps the single resolve worker —
// shared with every direct renderer call — responsive during a long render.

const EXPORT_POLL_INTERVAL_MS = 2500;
const EXPORT_POLL_MAX_FAILURES = 8; // ~20s of lost contact before giving up

let activeExport = null;
let exportPollTimer = null;
let exportPollFailures = 0;
let exportSawRendering = false; // becomes true once Resolve reports active rendering
let exportIdlePolls = 0;        // consecutive polls where Resolve isn't rendering
let uploadQueue = [];           // job refs waiting to upload (serial)
let uploadWorkerActive = false; // true while the serial upload worker is draining the queue

// How we decide a render's output file is safe to read before uploading:
// JobStatus === 'Complete' is the primary signal (Resolve finalises the
// container before flipping to Complete); then we confirm the size is stable
// for a few consecutive reads to ride out NAS/OS write-cache lag.
const FILE_STABLE_CHECKS = 3;
const FILE_STABLE_INTERVAL_MS = 1000;
const FILE_STABLE_TIMEOUT_MS = 60_000;

function broadcastExport(channel, payload) {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send(channel, payload));
}

function exportSnapshot() {
  if (!activeExport) return null;
  return { ...activeExport, jobs: activeExport.jobs.map(j => ({ ...j })) };
}

function stopExportPoll() {
  if (exportPollTimer) {
    clearInterval(exportPollTimer);
    exportPollTimer = null;
  }
}

function persistActiveExport() {
  if (!jobsDb || !activeExport) return;
  try {
    jobsDb.updateExportRun(activeExport.exportId, {
      state: activeExport.state,
      jobsDone: activeExport.jobsDone,
      percent: activeExport.percent,
      jobs: activeExport.jobs,
      error: activeExport.error || null,
      finishedAt: activeExport.finishedAt || undefined
    });
  } catch (_) { /* non-fatal */ }
}

function finalizeExport(state, error = null) {
  stopExportPoll();
  uploadQueue = [];  // abandon any not-yet-started uploads
  if (!activeExport) return;
  activeExport.state = state;
  activeExport.finishedAt = Date.now();
  if (error) activeExport.error = error;
  persistActiveExport();
  broadcastExport('export-complete', exportSnapshot());
  activeExport = null;
}

async function pollRenderStatus() {
  if (!activeExport) {
    stopExportPoll();
    return;
  }
  const jobIds = activeExport.jobs.map(j => j.job_id);
  let res;
  try {
    res = await sendWorkerRequest({ cmd: 'render_status', job_ids: jobIds }, WORKERS.resolve);
  } catch (_err) {
    exportPollFailures += 1;
    if (exportPollFailures >= EXPORT_POLL_MAX_FAILURES) {
      finalizeExport('interrupted', 'Lost contact with Resolve while rendering');
    }
    return;
  }
  exportPollFailures = 0;

  const data = res?.data || {};
  const byId = new Map((data.jobs || []).map(s => [String(s.job_id), s]));
  let done = 0;
  let sum = 0;
  for (const j of activeExport.jobs) {
    const s = byId.get(String(j.job_id));
    if (s) {
      j.status = s.status;
      j.percent = Number(s.percent) || 0;
      j.terminal = Boolean(s.terminal);
      // Resolve hands us the exact output path once the job is in the queue.
      if (s.target_dir && s.output_filename) {
        j.outputPath = path.join(s.target_dir, s.output_filename);
      }
    }
    if (j.terminal) done += 1;
    sum += (j.terminal && j.status === 'Complete') ? 100 : (Number(j.percent) || 0);
  }
  activeExport.jobsDone = done;
  activeExport.percent = activeExport.jobs.length ? Math.round(sum / activeExport.jobs.length) : 0;
  if (activeExport.state !== 'uploading') activeExport.state = 'rendering';

  // Overlap: kick off the upload for any timeline that just finished rendering,
  // while the remaining timelines keep rendering.
  maybeEnqueueUploads();

  persistActiveExport();
  broadcastExport('export-progress', exportSnapshot());

  if (data.all_terminal) {
    const anyFailed = activeExport.jobs.some(j => j.status === 'Failed');
    const anyCancelled = activeExport.jobs.some(j => j.status === 'Cancelled');
    onRenderFinished(anyFailed ? 'failed' : anyCancelled ? 'canceled' : 'completed');
    return;
  }

  // Safety net for cases all_terminal can't catch: a job removed from the queue
  // (status never resolves) or a render stopped/never-started outside EditPanel.
  // If Resolve reports it isn't rendering for several consecutive polls, stop.
  if (data.rendering) {
    exportSawRendering = true;
    exportIdlePolls = 0;
  } else {
    exportIdlePolls += 1;
    const threshold = exportSawRendering ? 3 : 6; // ~7.5s after a render, ~15s if it never started
    if (exportIdlePolls >= threshold) {
      const allDone = activeExport.jobsDone === activeExport.jobs.length;
      if (allDone) {
        onRenderFinished('completed');
      } else if (exportSawRendering) {
        onRenderFinished('failed');
      } else {
        finalizeExport('interrupted', 'Render did not start');
      }
    }
  }
}

// All renders have reached a terminal state (or the poll gave up). Uploads may
// already be in flight / queued from the overlap path; mark anything that can't
// upload as skipped, reflect the phase, and let the upload worker finalize once
// the queue drains. If uploads aren't enabled, finalize immediately.
function onRenderFinished(renderState) {
  stopExportPoll();
  if (!activeExport) return;
  activeExport.rendersStopped = true;

  // Timelines that didn't render cleanly (or have no output path) won't upload.
  for (const j of activeExport.jobs) {
    if (!j.enqueued && j.uploadStatus === 'pending' && !(j.status === 'Complete' && j.outputPath)) {
      j.uploadStatus = 'skipped';
    }
  }

  if (!activeExport.uploadEnabled) {
    finalizeExport(renderState);
    return;
  }

  if (hasPendingUploads()) {
    activeExport.state = 'uploading';
    persistActiveExport();
    broadcastExport('export-progress', exportSnapshot());
    kickUploadWorker();
  }
  maybeFinalizeExport();
}

function hasPendingUploads() {
  if (!activeExport) return false;
  return uploadWorkerActive
    || uploadQueue.length > 0
    || activeExport.jobs.some(j =>
        j.uploadStatus === 'pending' || j.uploadStatus === 'verifying' || j.uploadStatus === 'uploading');
}

function recomputeUploadPercent() {
  if (!activeExport) return;
  const uploadable = activeExport.jobs.filter(j => j.uploadStatus !== 'skipped');
  const total = uploadable.length || 1;
  const sum = uploadable.reduce((acc, x) => {
    if (x.uploadStatus === 'uploaded') return acc + 100;
    if (x.uploadStatus === 'failed') return acc;
    return acc + (x.uploadPercent || 0);
  }, 0);
  activeExport.uploadPercent = Math.round(sum / total);
}

// Enqueue any just-finished timeline for upload (once). Safe to call every poll.
function maybeEnqueueUploads() {
  if (!activeExport || !activeExport.uploadEnabled) return;
  let added = false;
  for (const j of activeExport.jobs) {
    if (!j.enqueued && j.uploadStatus === 'pending' && j.status === 'Complete' && j.outputPath) {
      j.enqueued = true;
      uploadQueue.push(j);
      added = true;
    }
  }
  if (added) kickUploadWorker();
}

// Serial upload worker — drains the queue one file at a time, concurrently with
// any renders still running. Finalizes the export when it goes idle.
function kickUploadWorker() {
  if (uploadWorkerActive) return;
  uploadWorkerActive = true;
  (async () => {
    try {
      while (activeExport && uploadQueue.length > 0) {
        const job = uploadQueue.shift();
        await uploadOneFile(job);
      }
    } finally {
      uploadWorkerActive = false;
      maybeFinalizeExport();
    }
  })();
}

async function uploadOneFile(job) {
  if (!activeExport) return;

  job.uploadStatus = 'verifying';
  broadcastExport('export-progress', exportSnapshot());

  const ready = await verifyFileReady(job.outputPath);
  if (!activeExport) return;
  if (!ready) {
    job.uploadStatus = 'failed';
    job.uploadError = 'Output file did not stabilise (still being written?)';
    recomputeUploadPercent();
    persistActiveExport();
    broadcastExport('export-progress', exportSnapshot());
    return;
  }

  job.uploadStatus = 'uploading';
  job.uploadPercent = 0;
  broadcastExport('export-progress', exportSnapshot());

  // Phase 5c.1 (2026-06-02): when we captured a Resolve timeline uid + start TC
  // + fps + project name at render dispatch, fold them into a renderMeta payload
  // for the finalize call. LPOS persists this as an editorial_links row tying
  // the asset back to the Resolve timeline so editpanel (any machine) can later
  // pull Frame.io comments onto the correct timeline. A partial tether is worse
  // than none — if any required field is missing we omit renderMeta entirely
  // and the asset uploads as untethered.
  let renderMeta = null;
  if (
    job.timelineUid
    && job.timelineStartTimecode
    && typeof job.timelineFps === 'number'
    && job.resolveProjectName
  ) {
    renderMeta = {
      timelineUid: job.timelineUid,
      timelineName: job.name || '',
      timelineStartTimecode: job.timelineStartTimecode,
      timelineFps: job.timelineFps,
      resolveProjectName: job.resolveProjectName,
      renderedAt: new Date().toISOString(),
      renderedFromMachine: os.hostname() || null,
    };
  }

  try {
    const res = await lposClient.uploadFileToProject(activeExport.projectId, job.outputPath, {
      fileName: path.basename(job.outputPath),
      isCancelled: () => !activeExport,
      renderMeta,
      onProgress: (p) => {
        if (!activeExport) return;
        job.uploadPercent = p.pct;
        recomputeUploadPercent();
        broadcastExport('export-progress', exportSnapshot());
      }
    });
    job.uploadStatus = 'uploaded';
    job.uploadPercent = 100;
    job.assetId = res?.asset?.assetId || null;
  } catch (err) {
    job.uploadStatus = 'failed';
    job.uploadError = err?.data?.error || err?.message || String(err);
  }

  if (!activeExport) return;
  recomputeUploadPercent();
  persistActiveExport();
  broadcastExport('export-progress', exportSnapshot());
}

// Confirm a render output is safe to read: it must exist, be non-empty, and have
// a size that holds steady across a few consecutive reads (rides out write-cache
// / NAS flush lag after Resolve reports the job Complete). Times out → not ready.
async function verifyFileReady(filePath) {
  if (!filePath) return false;
  const start = Date.now();
  let lastSize = -1;
  let stable = 0;
  while (Date.now() - start < FILE_STABLE_TIMEOUT_MS) {
    if (!activeExport) return false;
    let size = -1;
    try { size = (await fs.promises.stat(filePath)).size; } catch { size = -1; }
    if (size > 0 && size === lastSize) {
      stable += 1;
      if (stable >= FILE_STABLE_CHECKS) return true;
    } else {
      stable = 0;
    }
    lastSize = size;
    await new Promise(r => setTimeout(r, FILE_STABLE_INTERVAL_MS));
  }
  return false;
}

// Finalize once renders are done AND no upload work remains. The single authority
// for ending an export (called by the poll, onRenderFinished, and the worker).
function maybeFinalizeExport() {
  if (!activeExport) return;
  if (!activeExport.rendersStopped) return;
  if (hasPendingUploads()) return;

  const completed   = activeExport.jobs.filter(j => j.status === 'Complete');
  const anyRendFail = activeExport.jobs.some(j => j.status === 'Failed');
  const anyCancel   = activeExport.jobs.some(j => j.status === 'Cancelled');
  const anyUpFail   = activeExport.uploadEnabled && activeExport.jobs.some(j => j.uploadStatus === 'failed');

  let outcome;
  if (completed.length === 0) {
    outcome = (anyCancel && !anyRendFail) ? 'canceled' : 'failed';
  } else if (anyRendFail || anyCancel || anyUpFail) {
    outcome = 'partial';
  } else {
    outcome = 'completed';
  }
  finalizeExport(outcome);
}

function startExportTracking({ exportId, jobs, targetDir, projectId, projectName, started }) {
  stopExportPoll();
  activeExport = {
    exportId,
    jobs: jobs.map(j => ({
      job_id: String(j.job_id),
      name: j.name || j.job_id,
      status: started ? 'Ready' : 'Queued',
      percent: 0,
      terminal: false,
      outputPath: null,
      enqueued: false,          // pushed onto the upload queue yet?
      uploadStatus: 'pending',  // pending | verifying | uploading | uploaded | failed | skipped
      uploadPercent: 0,
      assetId: null,
      uploadError: null,
      // Phase 5c.1 tether fields. Null when Resolve couldn't supply a uid (e.g.
      // older builds without Timeline.GetUniqueId), in which case the upload
      // worker omits renderMeta from the finalize call and no editorial_links
      // row is written LPOS-side — the asset still uploads cleanly.
      timelineUid: j.timelineUid || null,
      timelineStartTimecode: j.timelineStartTimecode || null,
      timelineFps: typeof j.timelineFps === 'number' ? j.timelineFps : null,
      resolveProjectName: j.resolveProjectName || null,
    })),
    targetDir: targetDir || null,
    projectId: projectId || null,
    projectName: projectName || null,
    started: Boolean(started),
    startedAt: Date.now(),
    finishedAt: null,
    state: started ? 'rendering' : 'queued',  // queued | rendering | uploading | <terminal>
    percent: 0,
    uploadPercent: 0,
    jobsDone: 0,
    uploadEnabled: false,       // set when rendering begins (project chosen + LPOS reachable)
    rendersStopped: false,      // every render job has reached a terminal state
    error: null
  };
  uploadQueue = [];
  uploadWorkerActive = false;
  if (jobsDb) {
    try {
      jobsDb.createExportRun({ exportId, targetDir, projectId, projectName, jobs: activeExport.jobs });
    } catch (_) { /* non-fatal */ }
  }
  persistActiveExport();  // sync the real state (queued vs rendering) into the row
  broadcastExport('export-progress', exportSnapshot());

  if (started) beginExportPolling();
}

// Start (or restart) the render-status poll loop for the active export.
function beginExportPolling() {
  stopExportPoll();
  exportPollFailures = 0;
  exportSawRendering = false;
  exportIdlePolls = 0;
  // Decide once, as rendering begins, whether finished files should auto-upload.
  if (activeExport) {
    activeExport.uploadEnabled = Boolean(
      activeExport.projectId && lposClient && lposClient.isConfigured()
    );
  }
  exportPollTimer = setInterval(() => { pollRenderStatus().catch(() => {}); }, EXPORT_POLL_INTERVAL_MS);
  // First poll shortly after StartRendering so the bar moves off zero quickly.
  setTimeout(() => { pollRenderStatus().catch(() => {}); }, 800);
}

// ── EditPanel ↔ LPOS sign-in (custom URL scheme handling) ──────────────────────
//
// After the user approves on /ep/link in their browser, LPOS redirects to
// `lpos-editpanel://callback#token=...&user=...&machine=...`. The OS routes
// that to this app (we registered the scheme below). The token is delivered
// in the URL hash fragment, not the query string, so it never lands in any
// server access log or browser history.

function handleEpLinkCallback(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    console.error('[ep-link] malformed callback URL:', url);
    return;
  }

  if (parsed.protocol !== `${EP_LINK_SCHEME}:`) return;

  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : '';
  const params   = new URLSearchParams(fragment);

  const error   = params.get('error');
  const token   = params.get('token');
  const user    = params.get('user') || '';
  const machine = params.get('machine') || '';

  // Emit a renderer event regardless of outcome — Settings UI listens for this.
  const notify = (payload) => {
    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('ep-link-result', payload);
    });
    if (win) {
      win.show();
      win.focus();
    }
  };

  if (error) {
    console.log('[ep-link] approval denied:', error);
    notify({ ok: false, error });
    return;
  }
  if (!token) {
    console.warn('[ep-link] callback missing token');
    notify({ ok: false, error: 'no_token' });
    return;
  }

  // Persist + reinitialise the LPOS client with the new token.
  if (controlPlane) {
    controlPlane.setPreferences({ epToken: token, epUserEmail: user, epMachineName: machine });
    const prefs = controlPlane.getPreferences();
    lposClient = new LposClient({
      baseUrl: prefs.lposBaseUrl || LPOS_DEFAULT_BASE_URL,
      token:   prefs.epToken     || '',
    });
    console.log(`[ep-link] signed in as ${user} on ${machine}`);
    notify({ ok: true, user, machine });
  } else {
    // Cold-start path: controlPlane not constructed yet — queue and let
    // whenReady drain it once everything is wired.
    pendingEpLinkUrl = url;
  }
}

// Single-instance lock — required on Windows/Linux to receive callback URLs
// via the `second-instance` argv. A no-op on macOS where open-url is used.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find(a => typeof a === 'string' && a.startsWith(`${EP_LINK_SCHEME}://`));
    if (url) handleEpLinkCallback(url);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// Register the URL scheme. In development under Electron the `defaultApp` arg
// is needed so the OS associates the script path + electron binary correctly.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(EP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(EP_LINK_SCHEME);
}

// macOS: the OS delivers callback URLs via this event whether the app is cold-
// starting or already running.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (controlPlane) {
    handleEpLinkCallback(url);
  } else {
    pendingEpLinkUrl = url;
  }
});

// Windows/Linux: at cold start the URL is the last argv entry.
{
  const argvUrl = process.argv.find(a => typeof a === 'string' && a.startsWith(`${EP_LINK_SCHEME}://`));
  if (argvUrl) pendingEpLinkUrl = argvUrl;
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
    jobsDb.clearStaleAtemLogs();   // mark any interrupted ingest runs from prior session
    jobsDb.clearStaleExportRuns(); // mark any export still 'rendering' from prior session as interrupted
  } catch (err) {
    console.error('Failed to open jobs-history.db:', err.message);
  }

  // --- LPOS connectivity ---
  // baseUrl + per-machine token both come from stored preferences. The token
  // is delivered via the lpos-editpanel:// URL scheme after the user completes
  // the /ep/link approval flow. If absent, calls fail with a "not signed in"
  // error until the user signs in from Settings.
  try {
    const prefs = controlPlane.getPreferences();
    lposClient = new LposClient({
      baseUrl: prefs?.lposBaseUrl || LPOS_DEFAULT_BASE_URL,
      token:   prefs?.epToken     || ''
    });
  } catch (_err) {
    lposClient = new LposClient({ baseUrl: LPOS_DEFAULT_BASE_URL });
  }

  // Drain any callback URL the OS delivered before controlPlane existed.
  if (pendingEpLinkUrl) {
    const url = pendingEpLinkUrl;
    pendingEpLinkUrl = null;
    handleEpLinkCallback(url);
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
  // Manual reconnect: tear down the resolve worker so the restart logic
  // brings up a fresh Python process. DaVinciResolveScript's native module
  // can cache a bad scriptapp("Resolve") state in-process — re-sending
  // `cmd: connect` to the same worker hits the same cached failure. Killing
  // the worker forces a clean module reload, which is the only thing short
  // of restarting Resolve that recovers from the sticky state.
  // We reset resolveAutoConnectDone first so the spawn handler re-fires the
  // initial connect against the new process.
  ipcMain.handle('resolve:reconnect', async () => {
    const state = workers[WORKERS.resolve];
    if (!state) return { ok: false, error: 'resolve worker not configured' };
    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('helper-message', '[resolve:reconnect] respawning worker');
    });
    // Manual reconnect is the user saying "I fixed it, try again" — drop
    // the sticky advisory (and the slow-poll delay) so the next spawn gets
    // the normal restart cadence.
    clearResolveAdvisory(state);
    state.crashCount = 0;
    resolveAutoConnectDone = false;
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    if (state.proc) {
      // Don't set state.stopping — we WANT the restart machinery to bring
      // it back. The exit handler will call scheduleWorkerRestart for us.
      try { state.proc.kill('SIGTERM'); } catch (_) {}
    } else {
      // Worker isn't running for some reason — start it directly.
      startWorker(state);
    }
    return { ok: true };
  });

  ipcMain.handle('jobs:cancel', async (_, jobId) => jobEngine.cancel(jobId));
  ipcMain.handle('jobs:retry', async (_, jobId) => controlPlane.retryJob(jobId));
  ipcMain.handle('jobs:delete', async (_, jobId) => jobEngine.deleteJob(jobId));
  ipcMain.handle('jobs:prune', async (_, olderThanMs) => jobEngine.pruneOldJobs(olderThanMs));
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
    // Reinitialise LPOS client whenever baseUrl or token changes
    if (patch.lposBaseUrl !== undefined || patch.epToken !== undefined) {
      lposClient = new LposClient({
        baseUrl: prefs.lposBaseUrl || LPOS_DEFAULT_BASE_URL,
        token:   prefs.epToken     || ''
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

  ipcMain.handle('results:init', (_event, jobId, itemType, label, items, scope = {}) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return jobsDb.initRun(jobId, itemType, label, Array.isArray(items) ? items : [], scope || {});
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

  ipcMain.handle('results:reopen-item', (_event, jobId, itemKey) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return jobsDb.reopenItem(jobId, itemKey);
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

  ipcMain.handle('results:delete-run', (_event, jobId) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return jobsDb.deleteRun(jobId);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('results:prune-runs', (_event, olderThanMs) => {
    if (!jobsDb) return { ok: false, error: 'DB not available' };
    try {
      return jobsDb.pruneRuns(olderThanMs);
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
  // All calls proxy through LposClient which adds the X-EP-Token header.

  ipcMain.handle('lpos:signin-start', async () => {
    try {
      const prefs    = controlPlane.getPreferences();
      const baseUrl  = (prefs.lposBaseUrl || LPOS_DEFAULT_BASE_URL).replace(/\/$/, '');
      const machine  = prefs.displayName || os.hostname();
      const url = `${baseUrl}/ep/link`
        + `?machine=${encodeURIComponent(machine)}`
        + `&callback=${encodeURIComponent(EP_LINK_CALLBACK)}`;
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lpos:signout', async () => {
    try {
      controlPlane.setPreferences({ epToken: '', epUserEmail: '', epMachineName: '' });
      const prefs = controlPlane.getPreferences();
      lposClient = new LposClient({
        baseUrl: prefs.lposBaseUrl || LPOS_DEFAULT_BASE_URL,
        token: ''
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

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

  ipcMain.handle('lpos:project-assets', async (_, projectId) => {
    if (!lposClient || !lposClient.isConfigured()) {
      return { ok: false, error: 'LPOS not configured' };
    }
    try {
      const data = await lposClient.listProjectAssets(projectId);
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

  // ─── Phase 5c.3 + 5c.5 (2026-06-02): Pull comments → place markers ────────
  // One-click sync from the Edit tab. Auto-discovers which LPOS projects the
  // current Resolve project's timelines were uploaded to via the editorial_links
  // tether — no name-matching guesswork — and reconciles frameio:* markers per
  // timeline against the unresolved Frame.io comment set.
  //
  // Two modes:
  //   - Scoped:   pullComments(projectId, …)   — restrict to one LPOS project
  //   - Discover: pullComments(null, …)        — fan across all LPOS projects
  //                                              user can see; UI default
  ipcMain.handle('lpos:pull-comments', async (_, projectId, options = {}) => {
    if (!lposClient || !lposClient.isConfigured()) {
      return { ok: false, error: 'LPOS not configured' };
    }

    try {
      // 1. Build the asset pool. Each entry: {asset, projectId, projectName}.
      //    In scoped mode the pool is one LPOS project's assets. In discover
      //    mode we ask Resolve for the current project's timeline uids, then
      //    walk every LPOS project the user can see and keep assets whose
      //    editpanelRender.timelineUid is in the wanted set.
      let pool = [];
      let scopeKind;
      let scopeLabel;
      let scannedCount = null;       // total timelines walked in current Resolve project
      let resolveProjectName = null; // for the summary card

      if (projectId && typeof projectId === 'string') {
        scopeKind = 'scoped';
        scopeLabel = options.projectName || projectId;
        const resp = await lposClient.listProjectAssets(projectId);
        const items = Array.isArray(resp?.assets) ? resp.assets : [];
        pool = items.map(a => ({ asset: a, projectId, projectName: options.projectName || null }));
      } else {
        scopeKind = 'discover';

        // 1a. Ask Resolve for the current project's timelines so we know which
        //     uids to look for in LPOS. No name match anywhere — uids only.
        let timelinesPayload;
        try {
          const res = await sendWorkerRequest({ cmd: 'list_timelines' }, WORKERS.resolve);
          timelinesPayload = (res && res.data) || {};
        } catch (err) {
          return { ok: false, error: `Couldn't read Resolve timelines: ${err?.error?.message || err?.message || err}` };
        }
        resolveProjectName = timelinesPayload.project_name || null;
        scopeLabel = resolveProjectName || 'Current Resolve project';
        const timelines = Array.isArray(timelinesPayload.timelines) ? timelinesPayload.timelines : [];
        scannedCount = timelines.length;
        const wantedUids = new Set(
          timelines.map(t => t && t.uid).filter(uid => typeof uid === 'string' && uid)
        );

        if (wantedUids.size === 0) {
          return {
            ok: true,
            data: {
              jobId: null, timelines: [], totalPlaced: 0, totalRemoved: 0, totalKept: 0,
              message: timelines.length === 0
                ? 'No timelines in the current Resolve project.'
                : 'Timelines have no unique IDs (Resolve build pre-19). Comment markers require GetUniqueId support.',
            }
          };
        }

        // 1b. Fan across LPOS projects. Tolerate the {projects: [...]} /
        //     {data: {projects}} / plain array shapes the existing listProjects
        //     IPC may return.
        let lposProjects;
        try {
          const resp = await lposClient.listProjects();
          const payload = resp?.data ?? resp;
          lposProjects = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.projects) ? payload.projects : [];
        } catch (err) {
          return { ok: false, error: `Couldn't list LPOS projects: ${err?.message || err}` };
        }

        for (const proj of lposProjects) {
          if (!proj || !proj.projectId) continue;
          let items = [];
          try {
            const resp = await lposClient.listProjectAssets(proj.projectId);
            items = Array.isArray(resp?.assets) ? resp.assets : [];
          } catch (_) {
            continue; // one project failing shouldn't kill the whole pull
          }
          for (const asset of items) {
            const er = asset && asset.editpanelRender;
            if (!er || !er.timelineUid) continue;
            if (!wantedUids.has(er.timelineUid)) continue;
            pool.push({ asset, projectId: proj.projectId, projectName: proj.name || null });
          }
        }
      }

      // 2. Group by timelineUid; keep the latest by renderedAt across all
      //    LPOS projects in the pool. Comments live on the current cut.
      const latestByUid = new Map();
      for (const entry of pool) {
        const er = entry.asset.editpanelRender;
        if (!er || !er.timelineUid) continue;
        const existing = latestByUid.get(er.timelineUid);
        if (!existing) { latestByUid.set(er.timelineUid, entry); continue; }
        const a = Date.parse(existing.asset.editpanelRender.renderedAt) || 0;
        const b = Date.parse(er.renderedAt) || 0;
        if (b > a) latestByUid.set(er.timelineUid, entry);
      }

      if (latestByUid.size === 0) {
        return {
          ok: true,
          data: {
            jobId: null, timelines: [], totalPlaced: 0, totalRemoved: 0, totalKept: 0,
            message: scopeKind === 'scoped'
              ? 'No editpanel-rendered assets found in this LPOS project.'
              : "None of this Resolve project's timelines have been uploaded to LPOS yet. Export one from the Deliver tab first.",
          }
        };
      }

      // 3. Per-timeline reconcile. Serial — resolve worker single-threaded.
      const timelineResults = [];
      const involvedProjectNames = new Set();
      for (const [timelineUid, entry] of latestByUid.entries()) {
        const er = entry.asset.editpanelRender;
        if (entry.projectName) involvedProjectNames.add(entry.projectName);

        const result = {
          timelineUid,
          timelineName: er.timelineName || '',
          assetId: entry.asset.assetId,
          lposProjectId: entry.projectId,
          lposProjectName: entry.projectName,
          fps: er.timelineFps,
          timelineStartTimecode: er.timelineStartTimecode || null,
          // 5c.7: placed/removed/kept are now arrays of comment records (not
          // just counts) so the CommentPullReport renderer can show the
          // editor exactly which comments landed where.
          placed: [],
          removed: [],
          kept: [],
          skipped: [],
          unresolvedCount: 0,
          generalCommentsSkipped: 0,
          error: null,
        };

        try {
          const commentsResp = await lposClient.getAssetComments(entry.projectId, entry.asset.assetId);
          const allComments = Array.isArray(commentsResp?.comments) ? commentsResp.comments : [];
          const unresolved = allComments.filter(c => !c.completed);
          const formatted = unresolved.map(_formatTargetComment);
          result.unresolvedCount = unresolved.length;
          result.generalCommentsSkipped = formatted.filter(c => c === null).length;
          const targetComments = formatted.filter(c => c !== null);

          // Index target_comments by commentId so we can decorate placed/kept
          // records returned by the helper with the rich Frame.io comment data
          // (author, full text, replies) for the report UI. Also index the
          // ORIGINAL raw Frame.io comment so the report can show author avatar
          // and the un-mangled text/replies separately.
          const targetByCid = new Map(targetComments.map(t => [t.commentId, t]));
          const rawByCid = new Map(
            unresolved.filter(c => c && c.id).map(c => [c.id, c])
          );

          const syncRes = await sendWorkerRequest({
            cmd: 'sync_comment_markers',
            timeline_uid: timelineUid,
            fps: er.timelineFps,
            target_comments: targetComments,
          }, WORKERS.resolve);
          const syncData = (syncRes && syncRes.data) || {};

          if (syncData.result === false) {
            result.error = syncData.reason || 'sync_failed';
          } else {
            const decorate = (rec) => {
              const cid = rec && rec.commentId;
              const target = cid ? targetByCid.get(cid) : null;
              const raw = cid ? rawByCid.get(cid) : null;
              return {
                commentId: cid || null,
                frame: typeof rec?.frame === 'number' ? rec.frame : null,
                // Target shape carries the marker name/note we computed; raw
                // carries the un-flattened Frame.io fields for richer display.
                timestamp_s: target?.timestamp_s ?? (raw?.timestamp ?? null),
                duration_s:  target?.duration_s  ?? (raw?.duration  ?? null),
                text:        raw?.text ?? '',
                authorName:  raw?.authorName ?? '',
                authorAvatar: raw?.authorAvatar ?? null,
                createdAt:   raw?.createdAt ?? null,
                replies:     Array.isArray(raw?.replies) ? raw.replies : [],
              };
            };
            // 'removed' records have no target/raw data — the comment isn't in
            // the current Frame.io set. Pass through commentId+frame; the
            // report shows "Removed: <commentId> (no longer in LPOS)".
            const passThrough = (rec) => ({
              commentId: rec?.commentId || null,
              frame: typeof rec?.frame === 'number' ? rec.frame : null,
            });

            result.placed  = Array.isArray(syncData.placed)  ? syncData.placed.map(decorate)    : [];
            result.removed = Array.isArray(syncData.removed) ? syncData.removed.map(passThrough): [];
            result.kept    = Array.isArray(syncData.kept)    ? syncData.kept.map(decorate)      : [];
            result.skipped = Array.isArray(syncData.skipped) ? syncData.skipped : [];
            if (typeof syncData.timeline_name === 'string' && syncData.timeline_name) {
              result.timelineName = syncData.timeline_name;
            }
          }
        } catch (err) {
          result.error = (err && (err.error?.message || err.message)) || String(err);
        }

        timelineResults.push(result);
      }

      // 4. Persist a result_run. Label includes the involved LPOS project
      //    name(s) so JobPanel shows where comments came from regardless of
      //    Resolve↔LPOS naming mismatch.
      const jobId = `comments-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const totalPlaced  = timelineResults.reduce((s, r) => s + r.placed.length, 0);
      const totalRemoved = timelineResults.reduce((s, r) => s + r.removed.length, 0);
      const totalKept    = timelineResults.reduce((s, r) => s + r.kept.length, 0);
      const totalSkipped = timelineResults.reduce((s, r) => s + (Array.isArray(r.skipped) ? r.skipped.length : 0), 0);
      const involved = Array.from(involvedProjectNames).filter(Boolean);
      const projectLabel = involved.length === 0
        ? scopeLabel
        : involved.length === 1
          ? involved[0]
          : `${involved.length} LPOS projects`;
      const label = `Comment pull — ${projectLabel} (+${totalPlaced} -${totalRemoved} =${totalKept})`;
      if (jobsDb) {
        try {
          // 5c.7: always write a __summary__ row carrying the aggregate stats
          // (scanned, matched, totals, involved projects) so the
          // CommentPullReport renderer can show the editor a one-page report
          // even when no per-timeline rows landed (e.g. "scanned 14, none had
          // comments"). Per-timeline rows only follow for timelines with any
          // activity or error — empty rows are still pure noise.
          const summaryItem = {
            key: '__summary__',
            data: {
              kind: 'summary',
              scope: scopeKind,
              resolveProject: resolveProjectName,
              scannedCount,                       // null in scoped mode
              matchedCount: latestByUid.size,
              totalPlaced, totalRemoved, totalKept, totalSkipped,
              involvedProjectNames: involved,
              generatedAt: new Date().toISOString(),
            }
          };
          const timelineItems = timelineResults
            .filter(r => r.placed.length > 0 || r.removed.length > 0 || r.kept.length > 0
                      || (Array.isArray(r.skipped) && r.skipped.length > 0)
                      || r.error)
            .map(r => ({ key: r.timelineUid, data: { kind: 'timeline', ...r } }));
          jobsDb.initRun(jobId, 'comment_pull', label, [summaryItem, ...timelineItems], { projectName: projectLabel });
        } catch (_) { /* non-fatal */ }
      }

      return {
        ok: true,
        data: {
          jobId,
          timelines: timelineResults,
          scannedCount,
          matchedCount: latestByUid.size,
          totalPlaced,
          totalRemoved,
          totalKept,
          totalSkipped,
          involvedProjectNames: involved,
          scope: scopeKind,
        }
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // lpos:b2-sync-* IPC handlers removed 2026-05-27 — see LPOS /settings/storage.

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

  // ── Export / render ─────────────────────────────────────────
  // Queue the render (lp_base_export), optionally start it, and hand it to the
  // main-process tracker so it runs in the background and reports progress to
  // the Jobs panel — independent of whether the picker overlay stays open.
  ipcMain.handle('export:start', async (_e, opts = {}) => {
    const { targetDir, presetName, exportBin, startRender = true, projectId, projectName } = opts;
    try {
      const payload = { cmd: 'lp_base_export' };
      if (presetName) payload.preset_name = presetName;
      if (exportBin)  payload.export_bin_name = exportBin;
      if (targetDir)  payload.target_dir = targetDir;

      const res = await sendWorkerRequest(payload, WORKERS.resolve);
      const data = res?.data || {};
      if (data.result === false) return { ok: true, empty: true };

      // Phase 5c.1 (2026-06-02): lp_base_export now returns rich per-job dicts
      // including timeline_uid / start_timecode / fps / project_name captured at
      // SetCurrentTimeline. Legacy tuple shape [name, id] still tolerated for
      // any older Python helper that hasn't been redeployed alongside this main.
      const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
      const jobs = rawJobs.map(j => {
        if (Array.isArray(j)) {
          return { name: j[0], job_id: j[1] };
        }
        return {
          name: j?.name,
          job_id: j?.id,
          timelineUid: j?.timeline_uid || null,
          timelineStartTimecode: j?.start_timecode || null,
          timelineFps: typeof j?.fps === 'number' ? j.fps : null,
          resolveProjectName: j?.project_name || null,
        };
      }).filter(j => j.job_id != null);
      if (jobs.length === 0) return { ok: true, empty: true };

      // Both paths become a tracked export. Auto-start renders immediately and
      // begins polling; queue-only is tracked as a 'queued' pending job the user
      // can start later from the Jobs panel (export:start-render).
      const exportId = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (startRender) {
        // Scope StartRendering to ONLY the IDs lp_base_export just added so
        // any pre-existing entries in the operator's Resolve render queue
        // (completed, aborted, manually queued) aren't re-rendered alongside.
        await sendWorkerRequest(
          { cmd: 'start_render', job_ids: jobs.map(j => j.job_id) },
          WORKERS.resolve
        );
      }
      startExportTracking({
        exportId,
        jobs,
        targetDir: data.target_dir || targetDir,
        projectId,
        projectName,
        started: startRender
      });
      return { ok: true, exportId, jobs, started: startRender };
    } catch (err) {
      const msg = err?.error?.message || err?.error || err?.message || String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('export:active', async () => ({ ok: true, data: exportSnapshot() }));

  ipcMain.handle('export:recent', async (_e, limit = 10) => {
    if (!jobsDb) return { ok: true, data: [] };
    try {
      return { ok: true, data: jobsDb.listExportRuns(Number(limit) || 10) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Begin rendering a queued export (when the auto-start toggle was off).
  ipcMain.handle('export:start-render', async () => {
    if (!activeExport) return { ok: false, error: 'No queued export to start' };
    if (activeExport.state !== 'queued') return { ok: false, error: `Export is already ${activeExport.state}` };
    try {
      // Same scoping as the auto-start path: only the IDs EditPanel queued,
      // never the whole Resolve render queue.
      await sendWorkerRequest(
        { cmd: 'start_render', job_ids: activeExport.jobs.map(j => j.job_id) },
        WORKERS.resolve
      );
    } catch (err) {
      const msg = err?.error?.message || err?.error || err?.message || String(err);
      return { ok: false, error: msg };
    }
    activeExport.started = true;
    activeExport.state = 'rendering';
    for (const j of activeExport.jobs) { j.status = 'Ready'; }
    persistActiveExport();
    broadcastExport('export-progress', exportSnapshot());
    beginExportPolling();
    return { ok: true };
  });

  ipcMain.handle('export:cancel', async () => {
    // For a rendering export stop_render halts Resolve; for a queued one it's a
    // harmless no-op and we just drop the tracked job.
    try { await sendWorkerRequest({ cmd: 'stop_render' }, WORKERS.resolve); } catch (_) { /* best effort */ }
    if (activeExport) finalizeExport('canceled');
    return { ok: true };
  });

  // Delete a single export run from the recent list. Refuses to touch the
  // currently in-flight export — that path is `export:cancel`.
  ipcMain.handle('export:delete-run', async (_e, exportId) => {
    if (!exportId) return { ok: false, error: 'Missing exportId' };
    if (activeExport && activeExport.exportId === exportId) {
      return { ok: false, error: 'Use cancel to stop the active export' };
    }
    if (!jobsDb) return { ok: true };
    try {
      jobsDb.deleteExportRun(exportId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // B2 Media Manager IPC removed 2026-05-27 — cold-storage management is now
  // LPOS-side (see lpos-dashboard /settings/storage). EditPanel no longer
  // ships an S3 SDK or holds B2 credentials.

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
