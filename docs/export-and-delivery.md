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
  off) shows a **Start** button and a select checkbox (started via the chain —
  see "Sequential multi-batch chain" below); a **rendering**/**uploading** export
  shows progress + a **Stop** button; plus a list of recent exports. The active/queued row is **collapsible**
  (chevron) — collapsed it shows just the name, progress bar + badge, and the
  Start/Stop button, hiding the per-timeline list; collapse state is per export id
  (`collapsedExports` in `JobPanel.jsx`). The floating Jobs pill shows
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

### Orphan exports & Jobs-panel visibility (updated 2026-06-29)

A reconcile tick (`reconcileTick` in `main.js`, every `RECONCILE_INTERVAL_MS`)
sweeps Resolve's render queue and records any render EditPanel didn't queue
itself as an **orphan** row (`source='reconciled'`). A finished orphan lands in
state `complete_unassigned` — done in Resolve, but not yet assigned to an LPOS
project.

- **Orphans do not appear in the live Jobs panel.** They read as noise there and
  the editor assigns them deliberately. The `export:recent` feed (which drives
  JobPanel) passes `excludeState: ['complete_unassigned', 'dismissed_in_resolve']`.
  Orphans show only in the **Exports tab** (`/deliver`, `ExportsPanel.jsx`, fed by
  `exports:list`), each with a **Push to LPOS…** button.
- A lightweight clearable **pill** ("N exports awaiting assignment → Review") still
  nudges in the Jobs panel. It's driven by `countUnassignedExports()` (a separate
  count query), not by the row list, so excluding the rows doesn't silence it.
- **Dismissed-in-Resolve = forgotten.** If a rendering orphan's JobId vanishes
  from Resolve's queue (the editor pulled it before it finished), reconcile Phase 2
  hard-DELETEs the row after a 3-tick debounce — EditPanel stops tracking it
  entirely. There is no `dismissed_in_resolve` tombstone anymore; a one-time
  migration in `jobs-db.js` deletes any left by older builds. Deleting is safe
  because the JobId is already gone from Resolve's queue, so it can't be
  re-discovered; if Resolve genuinely re-queues it later, it's re-discovered as a
  fresh orphan (the desired behavior).

### Upload-off exports are pushable later (added 2026-06-30)

The Export overlay's **Upload to LPOS** toggle defaults off. When an editor
renders through EditPanel with it off, no project is chosen and the render is
**not** uploaded — the intent is "deliver later." Such an export now finalizes
in state `complete_unassigned` (not `completed`), exactly like a
Resolve-discovered orphan, so it lands in the Exports tab's **Unassigned**
filter with a working **Push to LPOS…** button and bumps the
awaiting-assignment pill.

- The re-label happens in `finalizeExport` (`main.js`): a clean `completed`
  outcome with **no project bound**, **upload disabled**, and **real output
  files** becomes `complete_unassigned`. A project-bound export whose auto-upload
  failed keeps its normal terminal state.
- Before 1.2.23 these landed in `completed` with no project and no
  `lpos_delivery` — a dead zone: the Unassigned filter and its push button gate
  on `complete_unassigned`, and the Delivered filter needs `lpos_delivery`, so
  the row showed only under **All**, mislabeled "Delivered", with no push action.
  A one-time `jobs-db.js` migration flips any such pre-1.2.23 stranded rows
  (editpanel-sourced, completed, no project, no delivery, output files present)
  to `complete_unassigned` so they become pushable.

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
4. **Per-file upload, overlapping renders** (`electron/main.js`): each timeline
   uploads **as soon as it finishes rendering** — the poller enqueues a job the
   moment its `JobStatus` is `Complete`, and a **serial upload worker** (one file
   at a time) drains the queue *concurrently with the renders still running*. So
   early-finishing files land in LPOS while later timelines are still rendering.
   Before each upload, the file is verified ready: `Complete` (primary signal) +
   a **size-stability check** (size > 0 and unchanged for 3 consecutive ~1 s
   reads, 60 s timeout) to ride out NAS/OS write-cache lag. Per-file progress
   flows over the same `export-progress` channel. The export finalizes only when
   **all renders are terminal AND the upload queue is drained** — `completed`
   (all uploaded) or `partial` (a render or upload failed). The Jobs panel shows
   per-timeline marks (render `%` → `↑%` uploading → `✓`); the pill shows
   `Export NN%` while rendering, `Upload NN%` once renders are done.

   Key functions: `maybeEnqueueUploads`, `kickUploadWorker`, `uploadOneFile`,
   `verifyFileReady`, `maybeFinalizeExport`.

### Version handling — pre-export sign-off, no post-ingest prompt (updated 2026-05-29)
The pre-export confirm screen **is** the version sign-off; LPOS never re-prompts.

- **Pre-export check (sign-off):** when **Upload to LPOS** is on, Queue & Render
  first asks Resolve which timelines would export (`export_preflight` — read-only,
  mirrors the EXPORT-bin→timeline match in `lp_base_export`) and lists the chosen
  project's existing assets (`GET /api/ep/projects/:id/media/assets`, X-EP-Token).
  Name matching **mirrors LPOS's canonical key** (`normalizeAssetKey` +
  `stripVersionSuffix`: strip ext, upper-case, collapse `_`/space/`-`, drop
  punctuation, strip trailing `_V<n>`), so it catches the same collisions LPOS
  would version (e.g. "Episode 12" vs "Episode_12"). If any match, a confirm step
  lists them — **Continue is the sign-off**, Back lets you change project / turn
  off upload. Fails open (a flaky pre-check never blocks the export).
- **EP upload never awaits confirmation:** the EP-token finalize route
  (`app/api/ep/.../media/upload/[uploadId]/finalize`) auto-resolves a version
  candidate by **re-finalizing with the candidate's `replaceAssetId`** → registers
  a new version directly (non-destructive; old version retained in the stack). A
  byte-identical file is a clean **no-op** (`no_change_needed`), not a failure.
  So EP uploads only ever end as *registered* (new asset or new version) or
  *no-change* — they never park at `awaiting_confirmation`, and the operator never
  has to confirm in the LPOS IngestTray. LPOS's `findCanonicalVersionCandidate`
  picks which asset to version (authoritative); EditPanel just provides the
  heads-up + sign-off.

Key files: `helper/commands/export_preflight.py`, `LposClient.listProjectAssets`,
`app/api/ep/projects/[projectId]/media/assets/route.ts` + the auto-resolve in
`.../media/upload/[uploadId]/finalize/route.ts` (lpos-dashboard), and the
`preflight`/`confirm` stages + `canonicalKey` in `ExportDeliverOverlay.jsx`.

### Notes / gaps
- The pre-export screen is advisory (catches what it can pre-render); the EP
  finalize auto-resolve is the guarantee that nothing parks. A collision the
  screen misses (e.g. an asset added between check and upload) still auto-versions
  silently rather than prompting — acceptable since versioning is non-destructive
  and the workflow is intentional re-exports.
- Auth attribution: uploads are recorded against the EP token's user.
- If the operator isn't signed in to LPOS at completion time, the render still
  finalizes but nothing uploads.
- `export_runs` still isn't pruned by the 30-day sweep (follow-up).

Key files: `helper/commands/render_status.py` (output paths), the EP routes
under `app/api/ep/projects/[projectId]/media/upload/` (lpos-dashboard),
`LposClient.uploadFileToProject` in `electron/workers/lpos_client.js`, and
`uploadExportFiles`/`onRenderFinished` in `electron/main.js`.

## Burn in subtitles (shipped 2026-06-29)

### What it does
A per-batch "Burn in subtitles" toggle in the configure stage. When on, each
timeline's existing subtitle track is baked into the picture instead of being
delivered clean. There is no separate clean master or sidecar `.srt` — the
burned-in video is the single deliverable.

### How it works
The Resolve scripting API can't toggle the Deliver-page subtitle/burn-in setting
via `SetRenderSettings` (it's not in the settable whitelist), so burn-in is
carried by a **paired render preset**. The editor maintains matching pairs named
`<preset>` and `<preset> - Subtitles`, where the `- Subtitles` variant has
"Burn into video" enabled in its Deliver settings. EditPanel does nothing more
than swap which preset name it queues:

1. `BURN_IN_SUFFIX = ' - Subtitles'` (one constant in `ExportDeliverOverlay.jsx`).
2. The counterpart name (`${selectedPreset}${BURN_IN_SUFFIX}`) is validated
   against the already-fetched `list_render_presets` list. If absent (and the
   list loaded), the toggle is disabled with explanatory copy. If the list
   couldn't load, the toggle fails open — `lp_base_export` logs loudly if the
   name is bad.
3. When on, `doStart` sends the resolved `- Subtitles` preset as `presetName`.
   `main.js` `export:start` and `lp_base_export.py` are unchanged — they just
   `LoadRenderPreset` whichever name they receive.

### Trackless-timeline preflight
Burn-in onto a timeline with **no subtitle track** silently renders uncaptioned
video (no error). So `export_preflight` now also returns `subtitle_tracks`
(timeline name → `GetTrackCount("subtitle")`), and when burn-in is on EditPanel
runs the pre-export check even without an LPOS upload, flagging trackless
timelines in the confirm stage before queuing. The check shares the existing
version-conflict confirm machinery (a second warning section).

### Status / gaps
- **Load-bearing assumption to verify in Resolve:** that `LoadRenderPreset` on a
  burn-in preset actually carries "Burn into video" through `AddRenderJob`. The
  code is safe either way — a misconfigured preset just renders uncaptioned —
  but confirm one burned render before relying on it for a client delivery.
- Assumes exactly one subtitle track per timeline (no multi-language picker).
- `export_runs` does not yet record a `burn_in` flag (no badging in the Exports
  panel) — deferred polish, not required for the feature.

Key files: `ExportDeliverOverlay.jsx` (`BURN_IN_SUFFIX`, `burnIn`/`subtitleGaps`
state, `runPreflight`, confirm stage), `helper/commands/export_preflight.py`
(`subtitle_tracks`).

## Sequential multi-batch chain (shipped 2026-06-29)

### What it does
Lets the editor queue several **independent** batches (each with its own preset,
burn-in choice, destination, and LPOS upload target), then select some of them in
the Jobs panel and run them **back-to-back**: the top selected batch renders, and
when it finishes the next selected batch starts automatically, each with the
settings it was queued with.

### Why it's simple
Settings are **baked into Resolve's render queue at queue time** — `lp_base_export`
runs (LoadRenderPreset + SetRenderSettings + AddRenderJob per timeline) when you
queue, not when you start. So a queued batch's `export_runs` row only needs to
remember its JobIds + upload target; starting it later is just
`StartRendering(its JobIds)`. No settings are replayed.

### How it works
- **Queue without clobbering** — queue-only (and auto-start-while-busy) now call
  `persistQueuedBatch()`: it writes a `queued` `export_runs` row and does **not**
  touch the in-memory `activeExport`. Batches accumulate as rows. (Previously a
  second queue overwrote the single `activeExport` slot and stranded the first.)
- **The chain** — `runChain` (main.js) is an ordered list of `export_id`s waiting
  to run after `activeExport`. `export:start-chain(exportIds)` validates each is
  still `queued`, sets `runChain`, and `advanceChain()` starts the first.
- **Advance on finish** — `finalizeExport` (the single place a batch ends and
  `activeExport` is nulled) calls `advanceChain()`, which rehydrates the next
  queued row into `activeExport` (`activateQueuedRow`) and `StartRendering`s it.
- **Skip & continue on failure** — advance fires for completed AND failed/
  interrupted batches, so one failure doesn't stall the rest. An explicit user
  **Cancel** clears `runChain` first, so cancelling the active batch stops the
  whole chain.
- **One chain at a time** — `export:start-chain` is blocked while anything is in
  flight (`isExportBusy`). Appending to a running chain is a deliberate follow-up.
- **UI** — queued batches render with a select checkbox + per-row **Start**; a
  "Start N selected" / "Select all" bar drives the chain in pipeline (display)
  order. While a chain runs, its pending members show an **"Up next"** badge
  (driven by `chainPending` on the export snapshot) and selection is hidden.

### Status / gaps
- Resolve renders one job at a time regardless, so the chain is "queue all, drain
  back-to-back" — not parallel.
- A queued batch is session-only: an EditPanel restart marks non-terminal rows
  `interrupted` (re-queue to drive them again). The Resolve queue still holds the
  jobs.
- Appending batches to an already-running chain isn't supported yet (blocked with
  a clear error); start the next chain once the current finishes.

Key files: `runChain` / `persistQueuedBatch` / `activateQueuedRow` /
`advanceChain` / `export:start-chain` in `electron/main.js`; `startChain` +
`onQueued` in `electron/preload.js`; the chain bar, queued-row branch, and
`RenderingExportRow` selection/`upNext` props in
`electron/renderer/components/JobPanel.jsx`.

See also: `lpos-contract.md` (EditPanel ↔ LPOS ownership boundaries).
