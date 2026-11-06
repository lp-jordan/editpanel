# Cut-through

Turns a recorded multicam into a first-pass edit in Resolve. EditPanel's **Cut-through** page runs
these steps on LP1. They are plain scripts, so a `git pull` on LP1 updates them without
rebuilding EditPanel.

| Step | File | What it does |
|---|---|---|
| Prep | `prepare_multicam.py` | Reads the multicam from Resolve: its angles, its length, and where each mic or camera's audio sits. Writes `day_<LABEL>.json`. |
| Transcribe | `transcribe.py` | Transcribes every mic on LP1's GPU (Whisper). Also measures the loudness of every frame, which is used to place cuts. Writes `words_`, `levels_` and `transcript_<LABEL>` files. |
| Plan | `editor_briefs/solo.md`, `editor_briefs/conversation.md` | Claude's brief: how Jordan edits. Claude reads the transcript and decides what to remove and which angle is on screen. |
| Plan | `place_cuts.py` | Places Claude's decisions on exact frames using the waveform, tightens pauses and sets mic levels. Writes `<LABEL>_plan.json`. |
| Build | `build_rough_cut.py` | Builds the edit in Resolve and runs the next two files. |
| Build | `write_timeline_xml.py` | Writes the plan as one timeline file that Resolve can import. |
| Build | `import_into_resolve.py` | Imports that timeline and checks picture and sound. The original multicam goes to `MC ORIGINAL`, renamed `<name>_original`. |
| Build | `split_into_videos.py` | Cuts the result into one timeline per video, named `<LABEL> rough cut`, in the chosen bin. |

Every file a run writes goes in one folder: `Documents\Cut-through\<Resolve project>\<label>\` on LP1 (changeable in the page's Settings → Run files). Run by hand in Resolve's console, the scripts still write to the Desktop.

Temporary timelines are named `Cut-through temp …` and are deleted when the build finishes.

Rules applied by the code, and the editorial style Claude follows: see `editor_briefs/` and
`/Users/lpos/lp-app-ecosystem/docs/ai-rough-cut-multicam-notes.md`.

Experiments and diagnostics that came before this pipeline stay in `../spikes/`.
