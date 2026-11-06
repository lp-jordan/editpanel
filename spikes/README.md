# Spikes

> The cut-through pipeline (prep, transcribe, Claude's editor briefs, cut placement, build) moved
> to `../cut_through/` on 2026-11-05 with plain names (`spike_day_prep.py` → `prepare_multicam.py`,
> `transcribe_day.py` → `transcribe.py`, `plan_solo.py` → `place_cuts.py`, `make_fcpxml.py` →
> `write_timeline_xml.py`, `spike_cut_through_batch.py` → `build_rough_cut.py`,
> `spike_import_fcpxml.py` → `import_into_resolve.py`, `spike_split_batch.py` →
> `split_into_videos.py`, `prompts/` → `editor_briefs/`, `plans/` → `../cut_through/plans/`).
> Sections below that describe those files are history.

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

## `spike_auto_rough_cut_whisperx.py`

Same build as `spike_auto_rough_cut.py`, from a merged two-pass WhisperX transcript
instead of Resolve's. Needs `Desktop\Z8_whisperx_export.json` (client transcript, so kept
out of git) and `Desktop\Z8_whisperx_plan.json`. Removal cuts never land inside a word.
Builds `__SPIKE_auto_Z8_whisperx_<n>` with 2-frame audio crossfades at removals, 8-frame
audio fades, and 8-frame picture Cross Dissolves at head and tail.

## All-in-one test on a fresh project: `spike_day_prep.py` → `transcribe_day.py`

1. **Resolve console** (project open): `LABEL="Convo2"; exec(open(r"C:\lp-app-ecosystem\editpanel\spikes\spike_day_prep.py", encoding="utf-8").read())`
   exports the day multicam (throwaway timeline, deleted again) and writes `Desktop\day_<LABEL>.json`:
   fps, length, angles, and each audio-only clip (the person mic WAVs) with its angle, file path and
   where the file's 0:00 sits in the multicam. Changes nothing.
2. **LP1 Command Prompt** (the `C:\wxbench` venv from `bench_whisper.py`):
   `C:\wxbench\Scripts\python C:\lp-app-ecosystem\editpanel\spikes\transcribe_day.py Convo2` (add `minutes=3` for a quick test).
   faster-whisper large-v3 on the GPU per mic, words on the multicam frame grid, each word owned by
   the mic where it's loudest (after per-mic gain). Writes `words_<LABEL>.json`,
   `transcript_<LABEL>.txt`, `transcribe_<LABEL>.txt` to the Desktop (client words: never into git).
3. **Plan** (Mac or any Python 3): `python3 plan_convo.py words_<LABEL>.json day_<LABEL>.json plans/<LABEL>_plan.json start=<frame> end=<frame> [extra="Camera 4"] [cut=<from>-<to> ...]`
   drafts the cut from the style guide's conversation rules, with no LLM: talker on screen (angle N = person on camera N), ~10 s close-ups
   broken by reactions / the wide, open + close on the wide, ≥ 2 s shots, pauses > 30 fr trimmed
   to 11 fr on an angle change, mic gating (backchannels that step on the talker stay closed).
   The plan carries `mic_angles`, so the cut-through run needs no `MICS`.
4. `LABEL="<LABEL>"; exec(open(r"C:\lp-app-ecosystem\editpanel\spikes\spike_cut_through_batch.py", encoding="utf-8").read())`
