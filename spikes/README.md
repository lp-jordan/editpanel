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
