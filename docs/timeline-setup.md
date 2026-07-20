# Timeline Setup — slate-driven per-recording timelines

Status: **scoped, not built** (2026-07-08). Replaces the read-only "Slate Spans"
diagnostic (`slate_span_report`), whose logic is folded in as the preview step.

## Goal

One task that turns a shoot's **single multicam clip** into a set of named,
per-recording timelines — each the multicam trimmed to one ATEM recording span,
with the slate's video codes as the timeline name and as markers inside it.

Every output timeline references the **one** multicam, so the editor grades /
reframes once (via right-click multicam → *Open in Timeline* → grade the angles at
the source level) and it propagates to all of them. This is the whole reason not
to fragment into one-multicam-per-segment. See the research notes at the bottom.

## The manual / automated split

| Step | Who | Why |
|---|---|---|
| Ingest + import footage | Prep task (exists/building) | — |
| Create the ONE multicam from the synced clips | **You (manual)** | Resolve does not expose multicam-clip creation to the scripting API |
| Detect recording spans + create a named, trimmed timeline per span, referencing the MC, with code markers | **Timeline Setup task** | This doc |
| Grade / reframe once via *Open in Timeline* | **You (manual)** | Source-level grade propagates to every referencing timeline |

## Locked decisions (2026-07-08)

1. **Span boundaries come from the source clips** (frame-exact), not the slate's
   ATEM events. The clips share the multicam's embedded timecode, so the mapping
   is self-consistent and independent of the LPOS system clock. (Slate is used
   only for names + markers, where approximate timing is fine.)
2. **Manual selection** — the editor picks the multicam clip, the LPOS project,
   and the source-clip bin via searchable pickers (no auto-detect).
3. **Tile lives under Edit** (where Slate Spans was).

## Architecture / data flow

```
Renderer (Timeline Setup overlay)
  → main: timeline_setup_preview(projectId, mcName, sourceBin, dayTab?)
      main fetches slate notes over EP-token (lpos_client.getSlateNotes)
      main → resolve worker: timeline_setup_preview { mc_name, source_bin, slate_notes }
          worker: read source clips → spans → match codes → PLAN
      ← plan (spans, names, marker sets, skips, warnings)
  → renderer renders preview table
  → on Confirm → main → resolve worker: timeline_setup_create { same inputs }
          worker recomputes plan (single source of truth) → CreateTimelineFromClips per span
      ← result (created, skipped, errors)
```

The resolve worker never does HTTP. The electron main process fetches slate notes
(EP-token) and passes them into the worker payload — the same pattern as Pull
Comments (`main` gathers comments, hands `target_comments` to
`sync_comment_markers`).

## Backend (lpos-dashboard) — one addition

`GET /api/ep/projects/:id/slate-notes` — EP-token auth (`requireEpToken`), mirrors
the existing `/api/ep/projects/:id/notes`. Returns the project's slate notes
(reads `data/projects/{id}/slate-notes.json` via SlateService), optional `?tab=`
filter for a shoot-day tab.

```
{ "notes": [ { "timestamp": "HH:MM:SS:FF", "code": "A1", "note": "Opening Remarks", "tabId": "..." }, ... ],
  "tabs":  [ { "id": "...", "name": "Day 1" }, ... ] }
```

`code === "ATEM"` rows are the Recording started/stopped events (kept for
reference; NOT used for boundaries under decision #1). Everything else is a video
code used for naming + markers.

## editpanel resolve commands (3)

All three must be registered in THREE places or they fail before reaching Resolve
(lesson from `slate_span_report`): (a) `helper/commands/__init__.py` HANDLERS,
(b) `electron/orchestrator/contracts.js` `COMMAND_OWNER` + `COMMAND_SCHEMAS`,
(c) the UI call site.

### `list_multicam_clips`
Input: `{ bin_name?: string }` (defaults to project root). Scans the bin for
clips whose `GetClipProperty("Type")` contains "Multicam". Output:
`{ multicams: [ { name, start_tc, frames } ] }`. Powers the MC picker.

### `timeline_setup_preview` (read-only — replaces `slate_span_report`)
Input: `{ mc_name, source_bin, slate_notes: [...] }`. Steps:
1. Read every video clip in `source_bin`; for each: `Start TC`, `Frames`, `FPS`.
2. Each clip → span `[start_tc, start_tc + frames]` (TOD). Dedup across cameras by
   matching TC range (tolerance); **merge gapless chunks** (next-in ≈ prev-out).
3. Anchor: `mc_start_tod = min(span in-points)` = multicam source frame 0.
   Cross-check against the MC's own `Start TC` if readable; warn on mismatch.
4. Per span: `mc_in_frame = tc(span_in) - tc(mc_start)`, `mc_out_frame = mc_in +
   span_frames`.
5. Match slate codes (code ≠ "ATEM") whose `timestamp` falls in the span's TOD
   window → sort → name = `first → last` (`"A1 - Opening → A2 - Closing"`); one
   marker per code at `tc(code) - tc(span_in)` (0-relative on the output timeline).
6. Skip spans with **no** codes (false starts) — list them.

Output (the PLAN):
```
{ mc_name, fps, mc_start_tc,
  spans: [ { index, src_in_tc, src_out_tc, mc_in_frame, mc_out_frame, frames,
             name, markers: [ { frame, code, note, color } ], chunks } ],
  skipped: [ { src_in_tc, src_out_tc, reason } ],
  warnings: [ ... ] }
```

### `timeline_setup_create` (write)
Input: same as preview. Recomputes the plan (single source of truth), then per
non-skipped span:
1. `CreateTimelineFromClips(name, [{ "mediaPoolItem": theMC, "startFrame":
   mc_in_frame, "endFrame": mc_out_frame }])`.
2. `AddMarker` for each code marker on the new timeline (0-relative frames).
3. Place the new timeline in a target bin (e.g. `SEQUENCES`, reusing bin_tree).

Idempotency: if a timeline with the target name already exists, **skip** it (no
dupes) and report it. No overwrite by default.

Output: `{ created: [ { name, uid } ], skipped: [ { name, reason } ], errors: [...] }`.

## editpanel UI

"Timeline Setup" task tile under **Edit** (remove the "Slate Spans" tile). Opens
a `TimelineSetupOverlay`:
1. **LPOS project** picker (searchable — reuse the export destination picker
   pattern) → drives which slate notes are fetched.
2. **Multicam** picker (from `list_multicam_clips`).
3. **Source-clip bin** picker (reuse `list_media_bins` / bin_tree).
4. Optional **shoot-day tab** filter.
5. **Preview table** — one row per span: TC in/out, proposed name, marker count;
   a separate section for skipped/false-start spans and warnings.
6. **Confirm** → `timeline_setup_create` → result report (created / skipped /
   errors). Streams progress to the slideout console via `rh.log()`.

## Edge cases

- **Gapless chunks** (ATEM split one recording across files): merged into one span.
- **Name collisions** on re-run: skip existing, report — never duplicate.
- **Codeless spans** (false starts): skipped, listed.
- **Codes during a non-recording gap**: fall in no span → dropped, noted.
- **Out-of-range markers**: attempt-and-report (mirror `sync_comment_markers`).
- **Multi-day / multiple multicams**: user picks the specific MC + day tab.

## Residuals to verify on the first real run (not blockers)

- `CreateTimelineFromClips` with a multicam MediaPoolItem + `startFrame/endFrame`
  yields a **live, angle-switchable** multicam in the new timeline (not flattened).
  Fallback if not: editor drags the MC onto one timeline manually; we script only
  the per-span slicing from there.
- `mc_start_tod = min(source-clip in-points)` equals multicam source frame 0
  (cross-checked against the MC's `Start TC` when readable).
- Source-clip embedded TC reads as wall-clock TOD (so slate codes land in the
  right span for naming — approximate is acceptable here).

## Build order

1. lpos-dashboard: `/api/ep/projects/:id/slate-notes` endpoint (+ lpos_client
   `getSlateNotes`).
2. editpanel worker: `list_multicam_clips` + `timeline_setup_preview` (port TC
   helpers from `slate_span_report`) + register in all three places.
3. editpanel UI: `TimelineSetupOverlay` + tile; wire preview.
4. Verify residuals on a real project (preview only — read-only).
5. editpanel worker: `timeline_setup_create` + wire Confirm.
6. Remove `slate_span_report` + the Slate Spans tile.

## Why one multicam (research, 2026-07-08)

The Resolve scripting API cannot read inside a multicam clip and cannot create
one; a multicam clip is not a Timeline object. But it CAN be placed/trimmed onto
new timelines as a MediaPoolItem (`CreateTimelineFromClips` / `AppendToTimeline`
take `mediaPoolItem` + `startFrame/endFrame`). Grades made at the source level
(*Open in Timeline* → grade angles) live inside the multicam container, survive
flattening, and are therefore inherited by every timeline that references the MC.
Grades applied per-instance on a take-timeline do NOT propagate. Sources: Resolve
v20.3 Python API reference; BMD forum t=81603; Larry Jordan "Color Grading
Multicam Clips in Resolve 20"; Resolve manual "Editing Multicam Clips in the
Timeline".
