# Project Overview Dashboard ("Eyes in the Sky") — Design Spec

- Status: Draft for review (no code yet)
- Date: 2026-08-03
- Scope: editpanel (sensor) + lpos-dashboard (control room)
- Related: [ADR-001](adr/ADR-001-target-architecture.md), `docs/lpos-contract.md`, `docs/export-and-delivery.md`, LPOS `docs/lpos-activity-monitor-architecture.md`

## 1. Goal

Give a producer/manager a single high-level view across all in-progress edit projects and the
editors working them: which projects are in motion (most-recent first), how far along each is
(sequences cut vs. total, pipeline stage), what's rendering/exporting right now and on which
machine, and where finished exports landed in LPOS. Drill from a summary card into per-project
detail. The view must be reachable **on the go** — i.e. it lives in LPOS (web), not only on a
workstation.

> Motivating example: "Where's Brian's project at? → 40 of 80 sequences cut, colour done, sound not
> started. Back out → Lee Jenkins project has a batch of exports running on LP3."

## 2. The structural constraint that shapes everything

**DaVinci Resolve's scripting API exposes only the *currently open* project on the *local*
machine.** There is no API to:

- read a project that is closed on disk,
- read a project open on a *different* editor's machine,
- enumerate "all projects" with their internals.

Therefore a live, single-pane view of 8 projects across 3 editors **cannot be read from one place**.
The only workable shape is **sensor → control room**:

- **Each editor's editpanel = a sensor.** While attached to Resolve with a project open, it snapshots
  *that one* project and pushes the snapshot to LPOS. It also persists the last-known snapshot of every
  project it has ever seen, so a project that's currently closed still shows its last state.
- **LPOS = the control room.** It aggregates the latest snapshot per project across every editor's
  machine, plus live device heartbeats. The dashboard is an LPOS page; editpanel keeps only a local
  "my projects" mirror.

Consequence: **freshness is per-project and best-effort.** A project's numbers are as current as the
last time an editor had it open with editpanel running. The UI must always show "as of <timestamp> on
<machine>" so stale data is never mistaken for live.

## 3. Locked decisions (from planning)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Primary dashboard surface | **LPOS (web).** editpanel feeds it; editpanel gets only a local mirror of its own projects. |
| D2 | "Cut / done" signal (numerator) | **Editor applies a Resolve flag colour** to a timeline to mark it cut. |
| D3 | "Total sequences" (denominator) | **All real sequences across all bins, excluding compounds/multicam/media/other objects.** Naturally satisfied by `GetTimelineByIndex` enumeration (compounds are not timelines). |
| D4 | First deliverable | **This spec**, reviewed before any code. |

## 4. Feasibility matrix

Legend: 🟢 available today · 🟡 small net-new · 🔴 manual/human-sourced (no API exists).

| Data point | Source | Status | Notes |
|---|---|---|---|
| Projects in motion, most-recent-first | LPOS `project_current_state.last_activity_at` | 🟢 | Rollup table already exists. |
| Live "who's on what / rendering on LP3" | EP heartbeat `POST /api/ep/status` + render queue | 🟢 | Heartbeat already carries machine, project, jobs. Needs persistence + UI. |
| Render/export in progress + % | `list_render_jobs` / `render_status` + local `export_runs` | 🟢 | Live per-job %, target dir, output filename. |
| Exports made → where in LPOS | `export_runs` + `editpanelRender`/`editorial_links` | 🟢 | Timeline↔asset↔project tether captured on every push. |
| Sequences that exist in a project | `list_timelines` | 🟢 (project must be open) | Excludes compounds automatically. Snapshot-and-remember for closed projects. |
| **Total sequence count (Y)** | `list_timelines` count | 🟢 | See §7. |
| **Cut/done count (X)** | timeline flag colour | 🟡 | Read-back of flags is net-new (~small). See §7. |
| Open comments per project | LPOS asset comments | 🟢 | Already fetched by comment-pull. |
| **Pipeline stage (colour done / sound pending)** | — | 🔴 | Resolve exposes **zero** colour-grade or Fairlight/audio state. Human-entered stage board only. See §8. |
| "Whose project" (editor identity) | EP token → LPOS user + machine hostname | 🟢 (mostly) | "Assignee" (who *should* own it) is a net-new field. |

**The two hard gaps are colour/sound status (§8) and the flag read-back (§7).** Everything else is
surfacing data that already exists.

## 5. Architecture & data flow

```
 Editor machine (LP3)                         LPOS (control room, web)
 ┌───────────────────────────┐               ┌─────────────────────────────────┐
 │ Resolve (1 open project)  │               │  ep_project_snapshots (persisted)│
 │        ▲                  │   HTTPS        │  ep_instances (persisted)        │
 │  list_timelines/flags     │  x-ep-token    │  activity_events / current_state │
 │  list_render_jobs         │ ─────────────► │                                  │
 │        │                  │  heartbeat +   │  ┌────────────────────────────┐  │
 │ editpanel (sensor)        │  snapshot      │  │ /overview  dashboard page  │  │
 │  reconcile tick (3s)      │                │  │  - project cards (recent)  │  │
 │  project_snapshots (local)│                │  │  - editors/machines strip  │  │
 │  local mirror UI          │                │  │  - project detail drawer   │  │
 └───────────────────────────┘               │  └────────────────────────────┘  │
                                              └─────────────────────────────────┘
        (same shape on every editor's machine → LPOS aggregates by lpos_project_id)
```

**Snapshot cadence:** piggyback on editpanel's existing 3s reconcile tick (`reconcileTick`,
`electron/main.js`). When Resolve is connected and a project is open, additionally collect a light
project snapshot (timelines + flags + counts) — throttled (e.g. push up at most every 30–60s, or on
change) so we don't spam LPOS every 3s. Render/heartbeat stays at its current cadence.

**Project identity (the binding problem):** editpanel knows the *Resolve project name*; LPOS is keyed
by *project id*. Today they're linked only per-export. For a project-level view the editor makes a
one-time **bind**: "this Resolve project ⇒ this LPOS project" (dropdown in editpanel, stored locally,
pushed up). Auto-suggest by name match, but require confirmation — name-matching alone is too fragile
to anchor a dashboard. Unbound projects still appear as "unbound" so nothing is silently dropped.

## 6. New/extended interfaces

### 6.1 Resolve worker commands (`editpanel/helper/commands/`)

| Command | New/extend | Returns | Cost |
|---|---|---|---|
| `list_timelines` | **extend** | add `flag` (colour or list) per timeline, plus `deliverable` bool | 🟡 requires walking the media pool to map each timeline uid → MediaPoolItem to read `GetFlagList()` (the uid→item walk already exists in `flag_timelines.py`). |
| `project_snapshot` | **new (thin)** | `{ project_name, page, timeline_count, timelines[{name,uid,flag,fps,start_tc}], render_summary }` | 🟡 mostly composes existing calls; single round-trip so the reconcile tick stays fast. |

No colour/audio commands — none exist in the API (confirmed).

### 6.2 LPOS EP-token endpoints (`lpos-dashboard/app/api/ep/`)

| Endpoint | Method | New/extend | Purpose |
|---|---|---|---|
| `/api/ep/status` | POST | **extend** | heartbeat gains optional `snapshot` block (see §9.2). |
| `/api/ep/projects/:id/bind` | POST | **new** | record Resolve-project-name ⇄ LPOS-project-id bind + machine. |
| `/api/ep/projects/:id/snapshot` | POST | **new** (or fold into `/status`) | push a per-project snapshot. |
| `/api/ep/projects/:id/stage-board` | PATCH | **new** | editor sets pipeline stage flags (colour/sound/…). |

Auth reuses `requireEpToken` + `ep_tokens`. Human identity resolves server-side from the token; machine
is the reported hostname. No new auth surface.

### 6.3 LPOS read/UI

- `/api/overview` (session-auth) — aggregated project cards + editor/machine strip.
- `app/overview/` page (or a tab under an existing admin/projects surface) — see §10.

## 7. The X / Y sequence math

**Y — total sequences (denominator).** `Project.GetTimelineByIndex(i)` for `i in 1..GetTimelineCount()`
returns **only true timelines** — compound clips, multicam clips, Fusion clips and plain media are *not*
included. So the existing `list_timelines` count already equals "all sequences across all bins, excluding
compounds and ancillary objects" (D3). No filtering needed.

- *Caveat:* if editors keep scratch/temp timelines they don't consider deliverables, those inflate Y.
  If that becomes a problem, add a convention later (e.g. exclude timelines whose media-pool item carries
  a "scratch" flag colour, or that live in a `_WIP` bin). Not built initially.

**X — cut/done (numerator).** A timeline counts as "cut" when its media-pool item carries the
**designated cut-flag colour** (D2). Mechanics:

- Reading: extend `list_timelines` to include each timeline's `GetFlagList()`. Count timelines whose flag
  list contains the configured cut colour.
- The cut colour is **configurable** (LPOS setting), defaulting to one colour (e.g. Green), so it doesn't
  collide with the Sand/Red flags already used by comment-marker sync (`flag_timelines.py`,
  `sync_comment_markers.py`). **Reserve a distinct colour for "cut" to avoid clobbering existing flag
  semantics** — this is a required design detail, not optional.
- Applying the flag is a manual editor action in Resolve (or a one-click "mark cut" in editpanel via the
  existing `flag_timelines` add path). editpanel just *reads* it for the count.

**Also surface (free, auto):** "exported" count = distinct timeline uids that have a completed
`export_runs` row. This is not the same as "cut" but is a valuable second progress signal at zero extra
cost (the tether already exists). Show both: `40/80 cut · 32 exported`.

## 8. Pipeline stage board (colour / sound / graphics)

Resolve gives **no** signal for grade or audio state, so this is unavoidably human-entered. Keep it
cheap:

- A small per-project **stage board**: an ordered set of stages, each `not_started | in_progress | done`.
  Proposed default stages: `Assembly · Edit · Colour · Sound · Graphics · Review · Delivered`.
- Set from editpanel (a compact toggle strip on the bound project) **and/or** from LPOS. Stored on the
  LPOS side (per-project) so it survives regardless of which machine last touched it.
- **Do not infer stages from heuristics.** (Reaching the Deliver page, or graded-looking clips, are
  unreliable proxies; a wrong "colour done" erodes trust in the whole dashboard.) Manual is the source of
  truth. Auto-derived facts (an export exists; N comments still open) are shown *alongside* the board as
  context, never as the stage itself.

## 9. Data model

### 9.1 editpanel local (SQLite, `electron/store/jobs-db.js`)

New table `project_snapshots` (one row per Resolve project this machine has seen):

| Column | Type | Notes |
|---|---|---|
| `resolve_project_name` | TEXT PK | as reported by Resolve |
| `lpos_project_id` | TEXT | the bind (nullable until bound) |
| `lpos_project_name` | TEXT | cached label |
| `timeline_count` | INTEGER | Y |
| `cut_count` | INTEGER | X (timelines with cut flag) |
| `exported_count` | INTEGER | distinct tethered timelines with a completed export |
| `open_comment_count` | INTEGER | last known |
| `timelines_json` | TEXT | `[{name,uid,flag,fps,start_tc}]` for the detail view |
| `last_render_summary_json` | TEXT | queue snapshot at last tick |
| `last_seen_at` | INTEGER | epoch ms |
| `last_pushed_at` | INTEGER | throttle guard for upstream push |

Populated/updated by the reconcile tick when a project is open. No change to `export_runs`,
`editorial_links` (LPOS-side), `ep_tokens` (LPOS-side).

### 9.2 LPOS (control room)

- **Persist device heartbeats.** Today `ep_instances` is an in-memory `Map` (30s offline threshold, no
  history). "Monitor on the go" needs at least current-state persistence — move to a small store
  (`ep_instances` table) so a restart / your phone opening the page still sees the fleet.
- **New `ep_project_snapshots` store** — latest snapshot per `(lpos_project_id, machine)`; the dashboard
  reduces to one card per project by newest `last_seen_at`. Fields mirror §9.1 plus `machine`,
  `reported_by_user`.
- **Project model additions** (`lib/models/project.ts`): optional `assignee`/`editorId`, and
  `stageBoard` (the §8 board). Keep them optional/additive.
- **Reuse** `activity_events` + `project_current_state` for the recency feed and rollup. Snapshot pushes
  can emit an `editpanel.project.snapshot` activity (visibility `operator_only`) so the existing feed and
  "most recent activity" sort light up for free.

## 10. UI

### 10.1 LPOS `/overview` (primary)

- **Editors / Machines strip (top):** one chip per known machine — online/offline, current Resolve
  project, live render queue + % (e.g. "LP3 · Lee Jenkins · rendering 3 jobs 62%"). This alone answers
  "there's a batch exporting on LP3" and is almost entirely existing data (Phase 0).
- **Project cards (most-recent first):** name, client, assignee, `X/Y cut · N exported`, stage-board
  pips, open-comment count, "as of <t> on <machine>", a "rendering now" badge if applicable.
- **Detail drawer (click-in):** per-sequence list with cut-flag state; stage board (editable);
  export history for the project (reuse the delivery/exports data); open comments; last-seen provenance.
- Mobile-friendly layout (this is the on-the-go surface).

### 10.2 editpanel (local mirror only)

- A read view of *this machine's* bound projects with the same numbers, plus the **bind** control and a
  one-click "mark sequence cut" (add cut flag) and stage-board toggles. Deliberately thin — LPOS is the
  aggregate.

## 11. Phasing

| Phase | Deliverable | Leans on | Value |
|---|---|---|---|
| **0** | Persist heartbeats + LPOS "Editors/Machines" strip (who's online, current project, live render % ). | existing `/api/ep/status`, render queue | "Batch exporting on LP3", "where's Brian" — on the go, almost no new capture. |
| **1** | Resolve⇄LPOS **bind** + `project_snapshots` (local) + `project_snapshot` push + `ep_project_snapshots` (LPOS) + project cards with Y and exported-count. | reconcile tick, `list_timelines`, tether | Per-project recency list + drill-in. |
| **2** | Flag read-back (X = cut count) + **stage board** (colour/sound). | extended `list_timelines`, new stage endpoint | The full "40/80 cut, colour done, sound pending" narrative. |
| **3** | Polish: staleness alerts (reuse stale-monitor pattern), trends, assignee field, mobile refinements. | LPOS monitors | Proactive "this project's gone quiet". |

## 12. Risks & open questions

- **Snapshot freshness is best-effort.** A project not opened for days shows stale numbers. Mitigate with
  prominent "as of" stamps; never render stale as live. *Accepted limitation.*
- **Flag colour collision.** Cut-flag must not reuse the Sand/Red flags that comment-sync already applies.
  Reserve a dedicated colour; make it configurable. *(Required.)*
- **Bind drift.** If an editor renames a Resolve project or duplicates it, the bind can point at the wrong
  project. Re-confirm bind on project-name change; show "unbound/ambiguous" rather than guess.
- **Media-pool walk cost** for flag read-back on huge projects (linear over bins × items). Acceptable for
  <100 timelines (same assumption the rest of the app already makes); cache within a snapshot.
- **Scratch timelines inflating Y.** Deferred; add an exclusion convention only if it bites.
- **Multicam internals** remain unreadable — irrelevant to counts (multicam clips aren't timelines) but
  worth remembering for any future per-sequence depth.
- **Open:** should the stage board be per-project or per-sequence? Spec assumes **per-project** (matches
  the motivating example). Per-sequence is a bigger surface; revisit after Phase 2.
- **Open:** confirm the default cut-flag colour and the stage list with the team before Phase 2.

## 13. What needs a human vs. what's automatic (summary)

- **Automatic (no editor effort):** project recency, live render/export status per machine, sequence
  *total* (Y), exported count, open-comment count, where exports landed, who last touched it.
- **One-time / low-effort human input:** bind each Resolve project to its LPOS project (once); apply the
  cut flag per finished sequence (an action editors can fold into their existing "done with this cut"
  habit).
- **Ongoing human input (unavoidable):** pipeline stage board (colour/sound/graphics), because Resolve
  exposes no grade or audio state at all.
