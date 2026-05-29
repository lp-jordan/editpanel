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
4. The **"Start rendering automatically"** toggle (default off) decides what
   happens next:
   - **On** → the overlay queues *and* starts the render immediately.
   - **Off** → the overlay only queues; the export becomes a **pending job** in
     the Jobs panel with a **Start** button, so the operator renders at will.

`target_dir` is optional and back-compatible — omit it and Resolve uses the
preset's saved location. The helper `os.makedirs(target_dir, exist_ok=True)`
defensively (Resolve falls back / fails on a missing TargetDir).

### Background tracking + progress (added 2026-05-28)
Queue & Render runs as a **background job owned by the main process**, so it keeps
going (and reporting) after the picker overlay is closed.

- `export:start` (main IPC) does `lp_base_export` → `start_render` → registers a
  tracker. The overlay calls it and immediately hands off ("View in Jobs").
- A **main-process poller** calls the new `render_status` resolve command every
  ~2.5s (`GetRenderJobStatus` per queued job ID) and emits `export-progress` /
  `export-complete`. Polling — not a blocking worker step — keeps the single
  resolve worker (shared with every direct renderer call) responsive; the
  health-check forgives missed pings only while a command is *inflight*, and a
  blocking render would have frozen all Resolve interaction for the whole render.
- The **Jobs panel** has an "Exports" section. A **queued** export (auto-start
  off) shows a **Start** button (`export:start-render` → `start_render` + begins
  polling); a **rendering**/**uploading** export shows progress + a **Stop**
  button; plus a list of recent exports. The floating Jobs pill shows
  `Export ready ▶` when queued and `Export NN%` while rendering.
- Export runs persist to the `export_runs` table (jobs-db). On startup any
  non-terminal run (`queued`/`rendering`/`uploading`) from a prior session is
  marked `interrupted` — a queued export is in-session only (not restorable
  across an EditPanel restart; re-queue to get a fresh startable job).
- Poller safety nets: gives up after ~20s of lost contact with Resolve, and
  finalizes if Resolve reports it has stopped rendering for several consecutive
  polls (covers a job deleted from the queue, or a render stopped externally).

Key files: `helper/commands/render_status.py`, the export tracker + `export:*`
IPC in `electron/main.js`, `exportsAPI` in `electron/preload.js`, the Exports
section in `electron/renderer/components/JobPanel.jsx`, `export_runs` in
`electron/store/jobs-db.js`.

### Current status / known gaps
- The **Upload to LPOS** toggle uploads finished renders into the chosen project
  automatically (Phase 2, below).
- A **queued** export (auto-start off) is tracked as a startable pending job, but
  only within the session — an EditPanel restart marks it `interrupted` (the
  Resolve render queue still holds the jobs; re-queue to drive them from EditPanel).
- `export_runs` is not pruned by the "Clear older than 30 days" sweep yet
  (low volume; follow-up).
- Last-used target dir / preset / bin / project are persisted in EditPanel
  preferences (`lastExportDir`, `lastExportPreset`, `lastExportBin`,
  `lastExportProjectId`).

## Phase 2 — Upload to LPOS on completion (shipped 2026-05-28)

When **Upload to LPOS** is on and a project is chosen, a finished render is
uploaded into that LPOS project automatically: the export tracker transitions
`rendering → uploading` and pushes each output file in as a normal media asset.

### How it works
1. **Output paths from Resolve.** `render_status` now also returns each job's
   `target_dir` + `output_filename` (from `GetRenderJobList`), so the tracker
   knows the exact file each timeline produced — no blind directory sweep.
2. **EP-token chunked upload endpoint** (lpos-dashboard): new
   `POST /api/ep/projects/:projectId/media/upload` (+ chunk `PATCH`, `DELETE`,
   and `finalize`) under `requireEpToken`. It mirrors the session-auth browser
   route but creates its own ingest-queue job, so an EditPanel upload shows up in
   the LPOS IngestTray and runs the full pipeline (register → transcode probe →
   thumbnail → Frame.io). The live browser routes are left untouched; only the
   shared service layer (`finalizeUploadedAsset`, ingest queue, stores) is reused.
3. **EditPanel uploader** (`LposClient.uploadFileToProject`): X-EP-Token,
   8 MiB chunks, resume-on-offset-mismatch, per-file progress callbacks.
4. **Glue** (`uploadExportFiles` in `electron/main.js`): on a completed render
   with a chosen `projectId` and a configured LPOS client, upload each finished
   file sequentially, reporting per-file progress over the same `export-progress`
   channel. Final state is `completed` (all uploaded) or `partial` (some failed).
   The Jobs panel shows the `uploading` phase with an upload % bar; the floating
   pill shows `Upload NN%`.

### Pre-export version warning (added 2026-05-29)
When **Upload to LPOS** is on, clicking Queue & Render first runs a name-based
pre-check (before anything renders): EditPanel asks Resolve which timelines would
export (`export_preflight` — read-only, mirrors the EXPORT-bin→timeline match in
`lp_base_export`) and lists the chosen project's existing assets
(`GET /api/ep/projects/:id/media/assets`, X-EP-Token). If any planned output name
matches an existing asset, a confirm step lists them ("these will upload as new
versions — Continue / Back"). It's an advisory heads-up so you don't burn render
time on a known conflict; it's **name-only** (can't detect exact duplicates until
the file exists) and **fails open** (a flaky pre-check never blocks the export).
The authoritative version/duplicate decision still happens at finalize.
Key files: `helper/commands/export_preflight.py`, `LposClient.listProjectAssets`,
`app/api/ep/projects/[projectId]/media/assets/route.ts` (lpos-dashboard), and the
`preflight`/`confirm` stages in `ExportDeliverOverlay.jsx`.

### Notes / gaps
- The pre-export warning is name-based and advisory; the binding check is still
  at finalize. A version conflict that slips through (e.g. a rename) surfaces
  there as a failed file (export → `partial`), resolved in the LPOS IngestTray.
- Auth attribution: uploads are recorded against the EP token's user.
- A render whose canonical name/hash matches an existing asset returns
  `version_confirmation_required` / `duplicate_version`; EditPanel marks that
  file's upload failed (export → `partial`) and the operator resolves the version
  in the LPOS IngestTray. (No EP-side confirm UI.)
- If the operator isn't signed in to LPOS at completion time, the render still
  finalizes but nothing uploads.
- `export_runs` still isn't pruned by the 30-day sweep (follow-up).

Key files: `helper/commands/render_status.py` (output paths), the EP routes
under `app/api/ep/projects/[projectId]/media/upload/` (lpos-dashboard),
`LposClient.uploadFileToProject` in `electron/workers/lpos_client.js`, and
`uploadExportFiles`/`onRenderFinished` in `electron/main.js`.

See also: `lpos-contract.md` (EditPanel ↔ LPOS ownership boundaries).
