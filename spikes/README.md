# Spikes

Throwaway feasibility probes. **Not** wired into editpanel's command dispatch
(`helper/commands/HANDLERS`) — they exist to prove a Resolve API assumption on a
real project before we build the real feature.

## `spike_slate_multicam.py`

Proves the mechanics the planned **slate-driven auto-sequencing** feature
depends on:

0. **Spans from clip edges** — derive the recording spans purely from where the
   stacked clips start/stop on a reference angle track (merging gapless ATEM
   chunks), so boundaries come from Resolve, not from the softer ATEM slate
   timestamps. Codes are then only used to name each span + drop markers.
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

## `spike_video_quality.py`

Finds out how this Resolve build takes a bitrate. `SetRenderSettings({"VideoQuality": …})`
was rejected in every form on the Windows build (v1.2.53–60). This probe:

- dumps the render/preset/quality-related methods the API exposes (`dir()`)
- shows the format/codec right after `LoadRenderPreset`, and every mp4/mov codec
- tries VideoQuality as int kbps, str kbps, int bps, `"High"` and `0`: as loaded,
  after explicitly selecting each H.264/H.265 codec, and with the Deliver page open
- checks a control key (`ExportVideo`) so we know SetRenderSettings works at all
- exports "General LP Export" to `Desktop\General_LP_Export_preset.xml` (input for
  the preset-copy fallback) and reports whether Import/Export/DeleteRenderPreset exist

Run with the project open (Deliver page visible, watch the Quality field):
Workspace ▸ Console ▸ `Py3`, then
`exec(open(r"...\editpanel\spikes\spike_video_quality.py").read())`.
Report prints and saves to `Desktop\resolve_bitrate_probe.txt`. Never queues or
renders; reloads the preset at the end, and never edits the saved preset.
