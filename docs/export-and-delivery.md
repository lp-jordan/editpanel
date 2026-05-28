# Export & Delivery

How EditPanel drives the LP Base Export in DaVinci Resolve, and the planned path
for delivering finished renders into LPOS.

## Overview

The operator drops clips into Resolve's `EXPORT` media-pool bin (names matching
the timelines to render), then opens **Deliver → LP Base Export** in EditPanel.
EditPanel owns the whole queue setup: it matches the bin to timelines, applies
the render preset, sets the destination, queues a job per timeline, and starts
the render. The operator no longer has to set the Deliver-page location by hand.

## Phase 1 — Destination picker + target directory (shipped 2026-05-28)

### What it does
- A destination-picker overlay opens from the Deliver tab. The operator picks a
  target folder (native folder picker), optionally tweaks the preset / bin name,
  and clicks **Queue & Render** (or **Queue only**).
- EditPanel pushes the chosen folder into Resolve's render settings so every
  matched timeline renders there, named after the timeline.

### Key files and entry points
- `electron/renderer/components/ExportDeliverOverlay.jsx` — the picker overlay
  (mirrors `AtemIngestOverlay`'s stage pattern: configure → running → done).
- `electron/renderer/App.jsx` — `deliver-export` task card opens the overlay
  (`setExportOpen`); renders `<ExportDeliverOverlay>`.
- `helper/commands/lp_base_export.py` — accepts `target_dir` (+ `unique_filename`)
  and applies it.
- `electron/orchestrator/contracts.js` — `lp_base_export` payload schema (types).
- `electron/orchestrator/recipes.json` — `lp_base_export_round1` recipe input
  `target_dir` (recipe-engine path; the UI uses the direct `leaderpassAPI.call`).

### Data flow
1. Overlay → `window.leaderpassAPI.call('lp_base_export', { target_dir, preset_name, export_bin_name })`.
2. Helper: find `EXPORT` bin → collect clip names → match to timelines by name.
3. Per matched timeline: `SetCurrentTimeline` → `LoadRenderPreset` →
   `SetRenderSettings({ TargetDir, CustomName: <timeline>, UniqueFilename: true })`
   → `AddRenderJob()`. The order matters: the preset restores its own saved
   TargetDir, then we override it; `AddRenderJob` snapshots the *current*
   settings, so each job carries its own destination.
4. If **Queue & Render**: overlay then calls `start_render` (`StartRendering`).

`target_dir` is optional and back-compatible — omit it and Resolve uses the
preset's saved location. The helper `os.makedirs(target_dir, exist_ok=True)`
defensively (Resolve falls back / fails on a missing TargetDir).

### Current status / known gaps
- No render-**completion** detection yet — `start_render` is fire-and-forget.
- The **Upload to LPOS** toggle is UI-complete (project picker populated from
  `window.lposAPI.listProjects()`, grouped by client) but the actual post-render
  upload is Phase 2. The chosen project is persisted as intent; the summary makes
  the deferred behaviour explicit.
- Last-used target dir / preset / bin / project are persisted in EditPanel
  preferences (`lastExportDir`, `lastExportPreset`, `lastExportBin`,
  `lastExportProjectId`).

## Phase 2 — Upload to LPOS on completion (planned)

Goal: when **Upload to LPOS** is on, the target dir acts as a temporary watch
folder — once the render finishes, EditPanel uploads the rendered files into the
selected LPOS project and registers them as assets.

### What needs building
1. **Render-completion detection** (editpanel + helper): a `render_status`
   command polling `GetRenderJobStatus` for the queued job IDs, driven by a
   main-process interval (like the LPOS heartbeat). Keeps the resolve worker
   free (concurrency is pinned to 1). Emits progress/complete events to the UI.
2. **EP-token chunked upload endpoint** (lpos-dashboard, production): a new
   `POST /api/ep/projects/:projectId/media/upload` (+ chunk `PATCH` + `finalize`)
   authenticated via `requireEpToken`, reusing the existing
   `finalizeUploadedAsset` / ingest-queue internals. The current chunked upload
   (`/api/projects/:id/media/upload`) is **session-cookie auth only**.
3. **EditPanel upload client**: an X-EP-Token chunked uploader (mirror the
   chunking in `leaderpass_client.js`, but target the new EP endpoint), with
   progress events.
4. **Watch/trigger glue**: on completion, upload the *known expected* files
   (we set `TargetDir` + `CustomName`, so we don't blindly sweep the folder) to
   the chosen project; confirm via `LposClient.resolveUpload(uploadId)`.

### Key finding (2026-05-28)
There is **no working upload-into-LPOS path today**:
- The old `leaderpass_upload` command points at a *separate* LeaderPass backend,
  and its platform worker was removed (`electron/main.js`: "platform worker
  removed — editpanel uploads only to LPOS, never Frame.io directly").
- LPOS exposes no EP-token-authenticated ingest endpoint.
- `LposClient.resolveUpload()` exists but is orphaned (built for an export
  registry that was never finished).

The *read* side is done: `GET /api/ep/projects` and `LposClient.listProjects()`
both exist, which is why the Phase-1 project picker already works.

See also: `lpos-contract.md` (EditPanel ↔ LPOS ownership boundaries).
