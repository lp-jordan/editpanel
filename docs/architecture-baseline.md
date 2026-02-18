# Architecture Baseline: Commands, IPC, Lifecycle, and Acceptance Criteria

## 1) Command inventory and ownership mapping

Single source map of current command ownership:

```yaml
ipc_handlers:
  helper-request: {owner: orchestrator, routes_to: resolve, tag: resolve}
  audio:transcribe-folder: {owner: orchestrator, routes_to: media, tag: media}
  audio:test-gpu: {owner: orchestrator, routes_to: media, tag: media}
  audio:cancel-transcribe: {owner: orchestrator, routes_to: media, tag: media}
  leaderpass-call: {owner: orchestrator, routes_to: resolve, tag: shared}
  dialog:pickFolder: {owner: platform, routes_to: main, tag: platform}
  fs:readFile: {owner: platform, routes_to: main, tag: platform}
  fs:writeFile: {owner: platform, routes_to: main, tag: platform}
  fs:stat: {owner: platform, routes_to: main, tag: platform}
  spellcheck:misspellings: {owner: platform, routes_to: main, tag: platform}
  spellcheck:suggestions: {owner: platform, routes_to: main, tag: platform}

helper_commands:
  connect: {owner: resolve_worker, tag: resolve}
  context: {owner: resolve_worker, tag: resolve}
  add_marker: {owner: resolve_worker, tag: resolve}
  start_render: {owner: resolve_worker, tag: resolve}
  stop_render: {owner: resolve_worker, tag: resolve}
  create_project_bins: {owner: resolve_worker, tag: resolve}
  lp_base_export: {owner: resolve_worker, tag: resolve}
  spellcheck: {owner: resolve_worker, tag: resolve}
  update_text: {owner: resolve_worker, tag: resolve}
  goto: {owner: resolve_worker, tag: resolve}
  transcribe: {owner: media_worker, tag: media}
  transcribe_folder: {owner: media_worker, tag: media}
  test_cuda: {owner: media_worker, tag: media}
  shutdown: {owner: shared_worker_contract, tag: shared}
```

### Current feature-to-command mapping (no-feature-loss scope)

- Connect → `connect`
- Spellcheck → `spellcheck`
- Transcribe Folder → `audio:transcribe-folder` → `transcribe_folder`
- LP Base Export → `lp_base_export`

## 2) Baseline execution paths

### IPC flow (current)

1. Renderer calls bridge methods exposed from preload (`leaderpassAPI`, `electronAPI`, `dialogAPI`, `fsAPI`, `spellcheckAPI`).
2. Preload sends IPC to main (`ipcRenderer.send`/`invoke`).
3. Main dispatches to:
   - resolve worker queue (`resolveHelperProc`) for Resolve commands,
   - media worker queue (`transcribeWorkerProc`) for media commands,
   - local platform handlers (`dialog`, `fs`, spellcheck dictionary utilities).
4. Main returns responses to renderer and forwards worker status/message events.

Canonical path: `renderer → preload bridge → main process → helper process`.

### Worker lifecycle baseline

- **Spawn behavior**
  - Main eagerly starts both worker processes during `app.whenReady()`.
  - Both workers are currently spawned from the same Python module (`python -m helper.resolve_helper`).
- **Steady-state behavior**
  - Requests are newline-delimited JSON written to worker stdin.
  - Responses are matched FIFO against pending request queues (`resolvePending`, `transcribePending`).
  - Async `status` and `message` events are broadcast to renderer windows.
- **Crash/exit behavior**
  - On worker exit, pending queue is flushed with errors (`... process exited`).
  - Process references/readers are nulled/closed.
  - Transcribe worker exit also resets `transcribeInProgress`.
  - On app `window-all-closed`, both workers are killed.

### Cancellation path and kill behavior

- Renderer invokes `audio:cancel-transcribe`.
- Main checks `transcribeInProgress`.
- If active: main kills transcribe worker with `SIGTERM`, flushes pending jobs with cancellation error, then respawns a fresh worker via `restartTranscribeWorker()`.
- Main emits a user-facing helper message (`Transcribe: canceled by user`) and returns canceled status.

## 3) Baseline performance capture

Measured using:

- `npm run baseline:latency`
- probe method: spawn helper process, measure
  - startup latency: process spawn → first JSON line
  - first-command latency: sending `context` → matching response

### Baseline result (2026-02-18, 5 iterations)

- Startup latency:
  - avg: **763.63 ms**
  - p95: **790.43 ms**
  - max: **790.43 ms**
- First-command latency:
  - avg: **49.01 ms**
  - p95: **97.98 ms**
  - max: **97.98 ms**

## 4) Phase acceptance criteria

### Phase A — Architecture lock

- ADR-001 exists and is accepted.
- All new work maps to one of: UI / orchestrator / resolve worker / media worker / platform worker.
- “Never do” constraints are documented and enforced in review.

### Phase B — Command ownership and routing clarity

- Command inventory remains complete and updated when commands change.
- Every command is tagged `resolve | media | platform | shared`.
- No-feature-loss coverage retained for:
  - connect
  - spellcheck
  - transcribe
  - LP export

### Phase C — Lifecycle/cancellation reliability

- Worker startup behavior documented and unchanged (or intentionally migrated with equivalent behavior).
- Crash behavior continues to flush pending requests and surface errors.
- Cancellation still kills in-flight media work and returns deterministic canceled response.

### Phase D — Performance guardrail

- Startup latency must not regress beyond baseline by agreed threshold.
- First-command latency must not regress beyond baseline by agreed threshold.
- Suggested initial threshold (until CI perf harness exists): no worse than **+15% p95** vs baseline.

