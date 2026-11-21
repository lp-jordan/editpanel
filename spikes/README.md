# Spikes

Throwaway feasibility probes. **Not** wired into editpanel's command dispatch
(`helper/commands/HANDLERS`) — they prove a Resolve API assumption on a real project
before the real feature is built. Run them from Resolve's Py3 console:
`exec(open(r"...\editpanel\spikes\<name>.py").read())`.

The cut-through pipeline grew out of these and lives in `../cut_through/` (see its README).
Finished experiments are kept in `archive/` for reference; they are not maintained and some
assume old file layouts.

## Still useful

| File | Use |
|---|---|
| `bench_whisper.py` | faster-whisper speed, CPU vs GPU — run on a new GPU machine |
| `spike_scan_past_edits.py` | Read-only house-style stats from finished edits (feeds `docs/ai-rough-cut-style-guide.md`) |
| `spike_video_quality.py` | How this Resolve build takes a bitrate (re-run on a new Resolve version) |
| `spike_media_pool_timing.py` | Why the Media Pool read is slow: per-call cost, Timeline.GetMediaPoolItem, by-name flag read, multicams outside archive bins (read-only) |
| `spike_project_status.py` | LPOS project-status rings: timeline flags (Green reviewed, Yellow left out), multicam lengths, read time (read-only) |
| `spike_word_edges.py` | Cut-through round 2 by hand: one built timeline's rendered audio → clipped words + phantom repeats → refined plan → rebuild |

### `spike_video_quality.py`

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


### `spike_word_edges.py`

Refines ONE built cut-through timeline from what its audio really plays. In Resolve's Py3 console
(timeline as Build left it):
`TIMELINE="J1"; RUN_DIR=r"<run folder>"; exec(open(r"C:\lp-app-ecosystem\editpanel\spikes\spike_word_edges.py", encoding="utf-8").read())`

- renders the timeline's audio (WAV), then runs the analysis in the transcription pack's Python
- **greedy CTC decode** (the pack's wav2vec2, letters only, no language model) = what is heard, so it
  can't fill a chopped or doubled word in from context the way Whisper does → phantom repeats
  ("the | the" across a join, stutters inside a shot, copies Transcribe marked "ghost") and truncated words
- **join_check.py** forced alignment + edge loudness at every join (Score's measures)
- **false repeat cuts** (what Jordan expands by hand): where the plan cut one copy of a word the transcript
  has twice (Whisper writes one spoken word twice; the edit cuts a copy as a flub), it listens at that join;
  if the kept copy isn't heard whole, the copy is given back (copies that touch = one word: back to the cut
  copy's start; apart: ≤ 12 fr before the kept word, so a removed redo stays out). Yellow marker on the timeline.
- existing markers are hints ("cut off"/"clipped" → fixed on one sign, "repeat" → wider search) and each
  gets a verdict in the report
- writes `<plan>__refined.json` (original untouched): clipped joins move to the word's real edge (≤ 12 fr),
  repeats lose the first copy (re-angling a ≥ 36 fr shot so there's no jump cut; refused otherwise),
  plus Cyan "Refined: …" review markers; findings go on the current timeline as markers (tag `ct-word-edges`)
- prints the rebuild line (`build_rough_cut.py` with `PLAN_FILES=[[refined, "<name> refined"]]`, `ARCHIVE=False`
  so the multicam copy in use isn't renamed `_original`); `REBUILD=True` runs it straight away. Every import
  makes a new multicam copy: delete the extra copy + the losing timeline after comparing.

**Narration timelines** (audio only, `build_narration.py`, e.g. `BenWebinarNov2026 (cut-through)`): the A1 clips are
read as they are now (each clip's file + source frame → the session clock via the day file), so an edited
timeline works and the refined plan keeps your edits; the narration plan is the one it covers most. Fixes
patch the kept spans (`mics.<talker>`), no angle rules, and the rebuild runs `build_narration.py` as
`<chapter> refined (cut-through)`.

Report: `<RUN_DIR>\word_edges\word_edges_<TIMELINE>.txt/.json`. Options: `PLAN=`, `FIX=False`, `SEQ_BIN=`,
`KEEP_RENDER=True`, `PACK_PYTHON=`. Tested on the Mac with the models stubbed on real Elevate plans
(ELEVATE_MC_2 J1; ELEVATE_MC_1 A2 + B3 for false repeat cuts; Ben webinar narration); not yet run in Resolve.

### `spike_scan_past_edits.py`

READ-ONLY. Open a finished project and run it: for every timeline it reads each
multicam piece's angle (from the item name), length and source range, then
reports shot length per angle, cuts per minute, cut types (angle switch / trim /
jump cut / backwards), how much is removed at trims, and which angle follows
which. Writes `Desktop\past_edits_report.txt` + `past_edits_items.csv`.


## `archive/` (finished, superseded)

| File | What it settled |
|---|---|
| `plan_convo.py` | Rule-based conversation plans — replaced by Claude + `editor_briefs/conversation.md` (1.2.78) |
| `spike_auto_rough_cut.py` | First Z8 rough cut (export → blind plan → build → compare) |
| `spike_auto_rough_cut_2spk.py` | Blind two-speaker build forcing angles with SmartSwitch |
| `spike_build_timelines.py` | Day multicam + one timeline per span — shipped as `helper/commands/create_multicam.py` |
| `spike_cam1_audio_fix.py`, `spike_cam1_variants.py` | Keeping the ATEM mix online in the copy — fixed by `atem=mc` (c241047) |
| `spike_collect_example.py` | Raw-vs-finished examples for the style guide |
| `spike_diag_audio_links.py`, `spike_mc_audio_ab.py`, `spike_mc_bins_ab.py` | ATEM-mix offline diagnosis — fixed by exact-file source bins |
| `spike_diag_sync.py` | Picture/mic placement in a cut (same-named WAVs) — fixed by `source_bins` in import |
| `spike_slate_multicam.py` | Spans from clip edges, source TC → frame — replaced by `helper/commands/slate_span_report.py` |
| `spike_smartswitch_force_angle.py` | Forcing an angle per piece — dropped; angles are set via FCPXML import |
| `spike_transcribe_precision.py` | Resolve's `TranscribeAudio` precision — ruled out; WhisperX is used |
