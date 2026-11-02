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

## `spike_build_timelines.py`

Proves the "Build Timelines" mechanics on Resolve 21.1+ (which added
`MediaPool.CreateMulticamClip`):

1. Uses cameras 1-4 + 6 (`CAMERAS`), tags `Camera #` from the `CAM n` bin if missing, then creates ONE day
   multicam: timecode sync, same-camera clips on one angle, no "Original Clips"
   bin. Reused on re-run.
2. Finds recording spans from the source clips' timecode (gapless ATEM chunks
   merged, unioned across cameras).
3. Creates one `__SPIKE_` timeline per span (first 3 by default) from the
   multicam with `CreateTimelineFromClips`, and reports whether each piece
   still points at the shared multicam.

Run with the project open: Workspace ▸ Console ▸ `Py3`, then
`exec(open("/Users/lpos/lp-app-ecosystem/editpanel/spikes/spike_build_timelines.py").read())`.
Edit `SOURCE_BIN` at the top if the footage isn't under `FOOTAGE / ATEM`.
Report also saved to `~/Desktop/build_timelines_spike.txt`. Then check by hand:
angle switching on a spike clip, and a multicam grade showing in every spike
timeline.

## `spike_smartswitch_force_angle.py`

Tests whether a script can CHOOSE a multicam piece's angle (the API has no
set-angle call). Builds `__SPIKE_force_angles_<n>` from 4 separate ranges of the
day multicam, then runs SmartSwitch on each piece with the wanted angle named as
"the wide" (wide for intro/outro/silence on, minimum shot 10 s). Reports each
piece's name before/after (does the name show the angle?) and whether SmartSwitch
split any piece. Then scrub by eye: does each piece show the camera its name says?

Windows: `exec(open(r"C:\lp-app-ecosystem\editpanel\spikes\spike_smartswitch_force_angle.py", encoding="utf-8").read())`
Report: `Desktop\smartswitch_force_angle_spike.txt`.

## `spike_transcribe_precision.py`

Is Resolve's built-in transcription precise enough to cut with? Transcribes the
day multicam in one go (falls back to a CAM 1 source clip), shows progress, saves
every word + timing to `Desktop\transcript_words.json`, then builds two test
timelines over a 2-minute window: `__SPIKE_words_<n>` (a marker on every word
start; do they sit on the words?) and `__SPIKE_tight_<n>` (pauses over 0.5 s
removed; any clipped words?). If it's not precise enough → WhisperX.

## `spike_scan_past_edits.py`

READ-ONLY. Open a finished project and run it: for every timeline it reads each
multicam piece's angle (from the item name), length and source range, then
reports shot length per angle, cuts per minute, cut types (angle switch / trim /
jump cut / backwards), how much is removed at trims, and which angle follows
which. Writes `Desktop\past_edits_report.txt` + `past_edits_items.csv`.

## `spike_auto_rough_cut.py`

First automatic rough cut, judged against a real finished edit (Steve Heroux).
`MODE = "export"`: finds finished timeline `VIDEO` (default `Z8`), transcribes its
day multicam if needed, renders that raw section's audio and measures every
frame's level, and saves words + levels to `Desktop\auto_cut_<VIDEO>_export.json`.
Claude then writes `spikes/plans/<VIDEO>_plan.json` blind (without the finished edit).
`MODE = "build"`: snaps every cut to the quietest frame within ±8 frames, builds
`__SPIKE_auto_<VIDEO>_<n>`, forces each angle, adds 2-frame "Cross Fade 0 dB"
audio crossfades, and compares cut points and removals with the finished edit.
