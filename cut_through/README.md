# Cut-through

Turns a recorded multicam into a first-pass edit in Resolve. EditPanel's **Cut-through** page runs
these steps. The scripts ship inside EditPanel (`resources\cut_through`), so any machine with the
installer has them; the page's **Cut-through folder** setting can point at a git checkout instead
(LP1, for testing script changes without a rebuild) and is ignored if that folder doesn't hold them.

**Transcription pack.** Transcribe needs its own Python (faster-whisper + CUDA libraries, WhisperX)
and the Whisper large-v3 + alignment models — about 5 GB, too big for the installer. It is built on
LP1 and published to the NAS (`N:\LPOS\editpanel dist\transcription-pack\`: `pack.json` +
`transcription-pack-<version>.tar`); the page's **Setup** card installs it (copy, checksum, unpack
into `%LOCALAPPDATA%\EditPanel\transcription\<version>\`, then `pack/selftest.py` loads both models).
Models are read from the pack offline. A newer published pack shows as **Update**.
Build / republish on LP1: `node scripts/build-transcription-pack.mjs` — locks LP1's working
`C:\wxbench` versions into `pack/requirements.lock.txt` (commit it; `--lock` rebuilds from the
committed lock), fetches the same Python from NuGet, installs, downloads the models, self-tests
online and offline, writes the tar to the NAS, then `pack.json` last. Needs an NVIDIA GPU to run fast.

**Narration (audiobook, 1.2.159).** The source can also be an audio-only timeline (no clips on any
video track). The page's **Choose** dialog lists multicams and audio timelines; picking a timeline
runs `prepare_audio.py` (same `day_` shape, one speaker "Narrator", `source: audio_timeline`).
Transcribe is unchanged. **Chapters** replaces Videos: the manuscript (.docx / .txt / .md, read on
this machine, `cut_through_narration.js`) is split at its headings and each chapter is found in the
transcript; each chapter gets its own Claude edit with the `narration.md` brief and only its own
manuscript text (no shots). `place_cuts.py` keeps sound only. Build runs `build_narration.py`: one
`<chapter> (cut-through)` audio timeline per chapter, made through Resolve's API (no FCPXML), with
2-frame crossfades at joins, 8-frame head/tail fades and the review markers. Check and Compare
aren't built for narration yet. Untested on a real book.

| Step | File | What it does |
|---|---|---|
| Prep | `prepare_multicam.py` | Reads the multicam from Resolve: its angles, its length, where each mic or camera's audio sits, and the recordings (where the cameras rolled). Writes `day_<LABEL>.json`. |
| Transcribe | `transcribe.py` | Runs with the transcription pack's Python on the GPU: transcribes every mic (Whisper large-v3), then pins every word to the audio with WhisperX alignment (wav2vec2) so word starts and ends are within a frame or two. Also measures the loudness of every frame. Writes `words_`, `levels_`, `align_`, `transcript_` and `transcribe_<LABEL>` files in the run folder. A transcript made before alignment existed is aligned automatically the next time Plan runs (`align_only=1`, no Whisper). If alignment can't run, Transcribe says "Words NOT aligned" and Plan stops with an error. |
| Plan | `editor_briefs/solo.md`, `editor_briefs/conversation.md` | Claude's brief: how Jordan edits. Claude reads the transcript and decides what to remove and which angle is on screen. Each angle's role (Wide / Close-up / Slider / Side / Other / Don't use, set on the page and saved per Resolve project) tells Claude what the camera is and how Jordan uses that kind of angle. |
| Plan | `place_cuts.py` | Places Claude's decisions on exact frames: each removal starts a few frames after the kept word's sound ends (scripted: 10, others: 3) and ends 3 frames before the next kept word starts, and drops any unwritten "uh" or mumble in between. Tightens pauses by delivery (`PAUSES` in `cut_through_claude.js`): scripted, gaps over 20 frames go to 12; stage, over 36 go to 18 when that saves at least 36; conversation, over 48 go to 18 when that saves at least 24; free talk, over 30 go to 11. Gates the mics (a conversation opens each person's mic while they talk, and a backchannel that steps on the talker at −2.5 dB). With no usable shot list from Claude, picture falls back to a wide ↔ close-up rhythm. After a word Claude marks as the end of a thought (`beats`), the cut or trimmed pause keeps 6 more frames of air. Review markers: red "Word cut off" names the word, yellow "Volume jump" and "Retake replaced", red "Check" from Claude. Words Whisper wrote twice but the aligner can't find ("show show") are ignored. Writes `<LABEL>_plan.json`. |
| Plan | `electron/workers/cut_through_claude.js` | Sends the numbered transcript and the brief to Claude (live, or one Message Batch at half price) and turns its answer (removals, shots, beats, notes) into the `removals_<LABEL>.json` that `place_cuts.py` reads. Holds each delivery's pause rule (`PAUSES`). Logs every call's cost to `cut_through_costs.csv`. |
| Plan | `electron/workers/cut_through_energy.js` | On trial: how fast and loud someone talks against their own usual, from the words file. Adds hints to Claude's transcript where it changes; Compare checks whether the cuts follow it. |
| Plan | `electron/workers/cut_through_motion.js` | On trial: when the slider angle is actually moving (ffmpeg + arithmetic, no Claude). `place_cuts.py motion=` keeps slider shots inside those stretches. |
| Plan | `electron/workers/cut_through_estimate.js` | Cost and time estimates shown before a run: Claude's cost per video / minute learned from `cut_through_costs.csv`, Transcribe time from earlier reports. |
| Plan | `electron/workers/cut_through_slate.js`, `cut_through_ocr.js` | "Read slate": reads the J-code off the slate angle where the notes have none. Free local OCR (tesseract.js) first; Claude only for a read OCR isn't sure of. |
| Plan | `electron/workers/cut_through_videos.js` | "Plan by: Videos": finds the videos in the multicam from Prep's recordings and the LPOS slate's J-codes (clock offset worked out from the notes), flags odd ones, guesses solo / conversation per video. Writes `videos_<LABEL>.json`; each video then gets its own Claude edit and `<LABEL>__<id>_plan.json`, live or as one Message Batch (half price; priced before sending, can be canceled). |
| Build | `build_rough_cut.py` | Builds the edit in Resolve and runs the next two files. `PLAN_FILES` = one plan per video, each timeline named by its J-code. |
| Build | `write_timeline_xml.py` | Writes the plan as one timeline file that Resolve can import. |
| Build | `import_into_resolve.py` | Imports that timeline and checks picture and sound. The original multicam goes to `MC ORIGINAL`, renamed `<name>_original`. |
| Build | `split_into_videos.py` | Cuts the result into one timeline per video in the chosen bin: `<LABEL> rough cut` for a section plan, the video's J-code in Videos mode. Last, every clip on each finished timeline is unlinked (`SetClipsLinked`), so a trim on one clip doesn't drag the rest of A1; the report says ✗ if Resolve refused. |
| (shared) | `common.py` | Helpers the scripts share: media-pool walk, FCPXML times and frame rate, the throwaway-timeline export, angle names, recordings from clip ranges, timecode. Not a step. Each script loads it from its own folder; EditPanel's Resolve worker loads it through `helper/commands/ct_common.py`. |
| Plan | `electron/workers/cut_through_check.js` (second pass) | After the cuts are placed, Check runs on the plan and `place_cuts.py` runs once more with `trim=` (silences: gaps at joins, long pauses, head/tail air, wordless slivers) and `keep=` (the rest of a word a cut went through). Before any build, no Claude. |
| Check | `electron/workers/cut_through_check.js` | Reads each `<LABEL> rough cut` back from Resolve as it is now and marks what's left to fix, against the aligned words: red = word cut off, ends mid-sentence, redo cue kept; yellow = joins mid-sentence, gaps and pauses, repeats, sound with no words, flash shots. Free (no Claude). A re-run replaces only its own markers. Runs automatically after Build. Writes `check_<LABEL>.txt` / `.json`. |
| Compare | `electron/workers/cut_through_compare.js` | Read-only, free: what the editor changed in a rough cut against the plan it was built from (restored, cut, words finished, camera changes), in multicam source frames, measuring what's heard on A1. |

Every file a run writes goes in one folder: `<Run folder>\<Resolve project>\<label>\`. The Run folder is chosen per Resolve project at the top of the page (no default; nothing runs until it's set). Run by hand without `OUT_DIR` (`dir=` for `transcribe.py`), the scripts write to the Desktop.

Temporary timelines are named `Cut-through temp …` and are deleted when the build finishes.

Rules applied by the code, and the editorial style Claude follows: see `editor_briefs/` and
`/Users/lpos/lp-app-ecosystem/docs/ai-rough-cut-multicam-notes.md`.

Experiments and diagnostics that came before this pipeline stay in `../spikes/`.
