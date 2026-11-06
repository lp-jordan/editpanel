# Cut-through

Turns a recorded multicam into a first-pass edit in Resolve. EditPanel's **Cut-through** page runs
these steps on LP1. They are plain scripts, so a `git pull` on LP1 updates them without
rebuilding EditPanel.

| Step | File | What it does |
|---|---|---|
| Prep | `prepare_multicam.py` | Reads the multicam from Resolve: its angles, its length, and where each mic or camera's audio sits. Writes `day_<LABEL>.json`. |
| Transcribe | `transcribe.py` | Transcribes every mic on LP1's GPU (Whisper), then pins every word to the audio with WhisperX alignment (wav2vec2) so word starts and ends are within a frame or two. Also measures the loudness of every frame. Writes `words_`, `levels_`, `align_` and `transcript_<LABEL>` files. A transcript made before alignment existed is aligned automatically the next time Plan runs (`align_only=1`, no Whisper). Needs `whisperx` in `C:\wxbench` (alignment-only install: torch/torchaudio 2.8 + transformers + pandas + nltk, then `whisperx --no-deps`); without it Transcribe says "Words NOT aligned" and Plan stops with an error. |
| Plan | `editor_briefs/solo.md`, `editor_briefs/conversation.md` | Claude's brief: how Jordan edits. Claude reads the transcript and decides what to remove and which angle is on screen. |
| Plan | `place_cuts.py` | Places Claude's decisions on exact frames: each removal starts 3 frames after the kept word's sound ends and ends 3 frames before the next kept word starts, and drops any unwritten "uh" or mumble in between. Tightens pauses (scripted: gaps over 20 frames go to 11) and sets mic levels. Review markers: red "Word cut off" names the word, yellow "Volume jump" and "Retake replaced", red "Check" from Claude. Words Whisper wrote twice but the aligner can't find ("show show") are ignored. Writes `<LABEL>_plan.json`. |
| Build | `build_rough_cut.py` | Builds the edit in Resolve and runs the next two files. |
| Build | `write_timeline_xml.py` | Writes the plan as one timeline file that Resolve can import. |
| Build | `import_into_resolve.py` | Imports that timeline and checks picture and sound. The original multicam goes to `MC ORIGINAL`, renamed `<name>_original`. |
| Build | `split_into_videos.py` | Cuts the result into one timeline per video, named `<LABEL> rough cut`, in the chosen bin. |
| Plan | `electron/workers/cut_through_check.js` (second pass) | After the cuts are placed, Check runs on the plan and `place_cuts.py` runs once more with `trim=` (silences: gaps at joins, long pauses, head/tail air, wordless slivers) and `keep=` (the rest of a word a cut went through). Before any build, no Claude. |
| Check | `electron/workers/cut_through_check.js` | Reads each `<LABEL> rough cut` back from Resolve as it is now and marks what's left to fix, against the aligned words: red = word cut off, ends mid-sentence, redo cue kept; yellow = joins mid-sentence, gaps and pauses, repeats, sound with no words, flash shots. Free (no Claude). A re-run replaces only its own markers. Runs automatically after Build. Writes `check_<LABEL>.txt` / `.json`. |

Every file a run writes goes in one folder: `Documents\Cut-through\<Resolve project>\<label>\` on LP1 (changeable in the page's Settings → Run files). Run by hand in Resolve's console, the scripts still write to the Desktop.

Temporary timelines are named `Cut-through temp …` and are deleted when the build finishes.

Rules applied by the code, and the editorial style Claude follows: see `editor_briefs/` and
`/Users/lpos/lp-app-ecosystem/docs/ai-rough-cut-multicam-notes.md`.

Experiments and diagnostics that came before this pipeline stay in `../spikes/`.
