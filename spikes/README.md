# Spikes

Throwaway feasibility probes. **Not** wired into editpanel's command dispatch
(`helper/commands/HANDLERS`) — they exist to prove a Resolve API assumption on a
real project before we build the real feature.

## `spike_slate_multicam.py`

Proves the three mechanics the planned **slate-driven auto-sequencing** feature
depends on:

1. **Source-TC read** — read a multicam clip's *source* timecode (= slate
   wall-clock, because the ATEM jams time-of-day TC) and map a slate timestamp
   to a timeline frame.
2. **Trimmed-timeline creation** — create a new timeline cut to one ATEM
   recording span (source in/out) via `CreateTimelineFromClips`.
3. **Marker placement** — drop a marker at a computed frame (the code-change
   markers that will live inside each span sequence).

### Run it

1. Open the **multicam sequence** you want to probe so it's the *current*
   timeline in Resolve.
2. (Optional) Edit the `CONFIG` block at the top to feed a real ATEM
   START/STOP timecode pair from the slate.
3. Run one of:
   - **Inside Resolve** — Workspace ▸ Console ▸ `Py3`, then:
     `exec(open(r"...\editpanel\spikes\spike_slate_multicam.py").read())`
   - **External terminal** (Resolve already open): `python spike_slate_multicam.py`

It prints a full diagnostic report. Paste that back — it tells us the exact
source-TC → frame formula and whether `CreateTimelineFromClips` preserves the
multicam angles, which decides the creation path before any wiring.

Cleans up after itself: the one test marker is tagged `spike:slate-multicam` and
deleted; the one test timeline is named `__SPIKE_span_...` (delete manually).
