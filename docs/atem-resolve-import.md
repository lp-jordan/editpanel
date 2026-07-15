# ATEM Ingest → Resolve Import (Phase 6)

Status: **spec + spike** (not yet wired). The FTP ingest half is fully shipped;
this doc covers the remaining "Import into Resolve" step.

## What ships today

The ATEM footage ingest is complete end-to-end:

- `electron/workers/atem_ftp.js` — `listSessions` / `ingestSessions` (anonymous
  FTP, session/camera parse, download to `dest/<Session>/CAM <n>/<file>`,
  skip-already-on-disk, per-byte progress, cancel).
- `electron/main.js` — IPC `atem:list-sessions` / `atem:start-ingest` /
  `atem:cancel-ingest` / `atem:ingest-logs`.
- `electron/renderer/components/AtemIngestOverlay.jsx` — 3-stage overlay
  (browse → configure → progress).
- `electron/store/jobs-db.js` — `atem_ingest_log` / `atem_ingest_files` tables + CRUD.

The **only** unbuilt piece is the "Import into Resolve" toggle in the configure
stage (`AtemIngestOverlay.jsx` — `{/* Future: Resolve import toggle */}`,
currently a disabled `Soon` badge with no handler).

## Goal

After (or alongside) pulling footage to disk, optionally import the ingested
clips into the **currently-open Resolve project's** media pool, mirroring the
on-disk folder structure as nested bins under an editor-chosen parent bin.

### Hard constraint: project must be open

The Resolve scripting API only operates on the currently-open project
(`GetProjectManager().GetCurrentProject()`). There is **no import into a closed
or different project** without `LoadProject`, which would yank the editor away
from their work — out of scope. Therefore:

- The toggle is **enabled only when `resolveConnected`** (already tracked in
  `main.js` as `resolveConnected` / `resolveProject`).
- The toggle subtext shows the open project name (`resolveProject`) so the editor
  can see exactly where footage will land.

## UX (configure stage)

1. Toggle **Import into Resolve** — disabled + "open a project in Resolve first"
   when `!resolveConnected`; otherwise shows `Will import into: <resolveProject>`.
2. When enabled, reveal a **parent-bin dropdown**, defaulting to `FOOTAGE / ATEM`.
   Populate it from the existing `list_media_bins` command (same indented
   dropdown already used in `ExportDeliverOverlay` / `OpenSequencesOverlay`).
   Fallback to the literal `FOOTAGE / ATEM` placeholder if the bin list can't be
   fetched (Resolve mid-disconnect, etc.).
3. On completion, imported clips land under
   `<chosenParent> / <Session> / CAM <n>` — an exact mirror of the disk layout.

## Bin structure

Same as ingest: for each file, target bin =
`<parentBin> / <Session> / CAM <n>`, e.g.
`FOOTAGE / ATEM / ACM_Shorts_05-22-26 / CAM 1`.

Session + camera are **already known on the Electron side** — every `file-done`
event carries `session` and `camInfo` (from `atem_ftp.parseCameraInfo`). Keep the
parsing there (single source of truth); the worker just receives resolved paths.

## Data flow

```
overlay (destPaths + camInfo per file, chosen parentBin)
   → IPC atem:import-to-resolve  { parentBin, files: [{ localPath, session, camNumber }] }
      → sendWorkerRequest({ cmd: 'import_media', ... }, WORKERS.resolve)
         → import_media.py:
              resolve parentBin via bin_tree.resolve_folder_by_path
              for each (session, cam) group:
                 find-or-create <parent>/<session>/CAM <n>  (AddSubFolder)
                 SetCurrentFolder(leaf)
                 MediaPool.ImportMedia([paths for that bin])
              return { imported, failed, perBin: [...] }
```

## Work items

| # | Piece | Est | Notes |
|---|-------|-----|-------|
| 1 | `helper/commands/import_media.py` + register in `HANDLERS` | ~2–3h | Reuses `bin_tree.resolve_folder_by_path`; `AddSubFolder` pattern from `create_project_bins.py`; `MediaPool.ImportMedia`. |
| 2 | IPC `atem:import-to-resolve` + `preload.js` bridge | ~1–2h | Forward to `sendWorkerRequest(..., WORKERS.resolve)`. |
| 3 | Wire toggle + bin dropdown in `AtemIngestOverlay.jsx` | ~3–4h | Enable when `resolveConnected`; fetch `list_media_bins`; default `FOOTAGE / ATEM`; gather `destPath`s from `file-done`; fire after `ingest-complete`; result line. |
| 4 | Edge cases / polish | ~½ day | Resolve dropping mid-ingest; partial-failure reporting; empty/failed bin fetch fallback; whether import runs per-session or one batch at the end. |

**Estimate: ~1–1.5 days**, most of it assembling existing parts.

## Open unknown → spike first

`spikes/spike_import_media.py` proves the three uncertain mechanics against a
real open project + real ingested clips **before** wiring:

1. Nested sub-bin creation + `SetCurrentFolder` actually targets the leaf.
2. `MediaPool.ImportMedia` accepts the multicam `.mp4` ISO clips, returns one
   item per file, and how long importing several large clips blocks (decides
   fire-and-forget vs. progress feedback).
3. `Resolution` / `FPS` / `Start TC` / `Duration` read correctly on imported ATEM
   clips (the ATEM jams time-of-day TC — downstream slate/marker features rely on
   this being present and correct).

Run it on the Windows/Resolve machine, paste the report back, then lock the
worker's import path + bin scheme.
