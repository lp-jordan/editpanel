# ATEM Ingest → Resolve Import (Phase 6)

Status: **SHIPPED 2026-07-15** (awaits real-project testing). The FTP ingest half
was already live; the "Import into Resolve" step is now wired end-to-end.

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

The "Import into Resolve" toggle in the configure stage is now real (was a
disabled `Soon` badge). See **What shipped for import** below.

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

## What shipped for import

- **`helper/commands/import_media.py`** (registered in `RESOLVE_HANDLERS` as
  `import_media`). Payload `{ parent_bin, files: [{ local_path, session,
  cam_number }] }`. Resolves the parent via `bin_tree.resolve_folder_by_path`
  (creates the path if absent), groups files by `<session>/CAM <n>`, find-or-
  creates each nested bin (`AddSubFolder`), `SetCurrentFolder`, then
  `MediaPool.ImportMedia`. Returns `{ imported, failed, per_bin }`. Per-bin
  failures are isolated — one bad path doesn't abort the rest.
- **`electron/workers/atem_ftp.js`** — the `file-skipped` event now carries
  `destPath` + `camInfo`, so already-on-disk files are importable too (not just
  freshly-downloaded ones).
- **`AtemIngestOverlay.jsx`** — the configure toggle is live (enabled only when
  `resolveConnected`, subtext shows `resolveProject`). When on, a **bin dropdown**
  (populated by `list_media_bins`, default `FOOTAGE / ATEM`, indented sub-bins)
  chooses the parent. During ingest, each landed file's `{ local_path, session,
  cam_number }` accumulates in a ref; when ingest finishes cleanly an effect
  fires `leaderpassAPI.call('import_media', …)` and the completion card shows
  running / imported-N / failed status.

No dedicated IPC was needed — the renderer calls the worker directly via the
existing generic `leaderpassAPI.call` → `helper-request` → resolve-worker bridge
(same path `list_media_bins` uses).

**Gotcha:** a new worker command must be registered in **three** places or it's
rejected before it runs: the Python `RESOLVE_HANDLERS`/`HANDLERS` map
(`helper/commands/__init__.py`) **and** the JS orchestrator's `COMMAND_OWNER` +
`COMMAND_SCHEMAS` in `electron/orchestrator/contracts.js`. `validateRequestEnvelope`
throws `unknown command: <cmd>` synchronously if `COMMAND_OWNER` is missing the
entry — which is exactly what happened on first test (the Python handler was
present but the JS allowlist wasn't).

## Testing (real project, on the Windows/Resolve machine)

1. Open the target project in Resolve.
2. Prep → ATEM Footage → select sessions → pick a destination.
3. Enable **Import into Resolve**, confirm the dropdown lists the project's bins
   and defaults to `FOOTAGE / ATEM`.
4. Start ingest; on completion the card should report the import count, and the
   footage should appear under `FOOTAGE / ATEM / <Session> / CAM <n>`.

Watch for: whether `ImportMedia` accepts the multicam `.mp4` ISO clips and reads
their time-of-day TC correctly (downstream slate/marker features depend on it),
and whether importing many large clips blocks the worker noticeably (if so, add
progress feedback in a follow-up).
