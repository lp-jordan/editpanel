#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Is Resolve's built-in transcription precise enough to cut with?

Resolve 21.1 can transcribe a media-pool clip and hand back every word with its
own start/end timecode. This spike:

  1. Transcribes the day MULTICAM clip in one go (falls back to the first CAM 1
     source clip if the multicam can't be transcribed), printing progress.
     An existing transcription is reused unless FORCE_RETRANSCRIBE is True.
  2. Saves every word with its timing to the Desktop (transcript_words.json).
  3. Builds two test timelines over a WINDOW of the multicam:
       __SPIKE_words_<n>    the window untouched, with a marker on every word start
                            → scrub: does each marker sit right on its word?
       __SPIKE_tight_<n>    the same window with every pause longer than
                            MAX_PAUSE removed (words padded by PAD_FRAMES)
                            → listen: are word starts or ends clipped?

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_transcribe_precision.py", encoding="utf-8").read())
A full-day transcription can take a while; progress prints every few seconds.
Report saved to the Desktop as transcribe_precision_spike.txt.
"""

import json
import os
import time
from typing import Any, Dict, List, Optional

# ──────────────────────────────────────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────────────────────────────────────
MC_BIN = "SEQUENCES / MC"
MC_NAME: Optional[str] = None       # None = first multicam clip in MC_BIN
FALLBACK_SOURCE_BIN = "FOOTAGE / ATEM"   # searched for a CAM 1 clip if the MC fails
TIMELINE_BIN = "SEQUENCES"
FORCE_RETRANSCRIBE = False
WINDOW_START_S = 120                # window = seconds from the multicam's start
WINDOW_LEN_S = 120
MAX_PAUSE = 0.5                     # seconds; longer pauses get cut out of the tight timeline
PAD_FRAMES = 2                      # frames kept before/after each run of speech
POLL_SECONDS = 5
TIMEOUT_MINUTES = 180
DESKTOP = os.path.expanduser("~/Desktop")
REPORT_PATH = os.path.join(DESKTOP, "transcribe_precision_spike.txt")
WORDS_PATH = os.path.join(DESKTOP, "transcript_words.json")

BIN_SEP = " / "
SILENCE = "(...)"
_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def get_resolve() -> Any:
    g = globals().get("resolve")
    if g is not None:
        return g
    import DaVinciResolveScript as dvr  # type: ignore
    return dvr.scriptapp("Resolve")


def tc_to_frames(tc: str, fps: float) -> int:
    hh, mm, ss, ff = (int(p) for p in tc.strip().replace(";", ":").split(":"))
    return (hh * 3600 + mm * 60 + ss) * int(round(fps)) + ff


def find_folder(root: Any, path: str) -> Optional[Any]:
    current = root
    for seg in [s.strip() for s in path.split(BIN_SEP) if s.strip()]:
        current = next((c for c in (_safe(lambda: current.GetSubFolderList(), []) or [])
                        if _safe(lambda: c.GetName()) == seg), None)
        if current is None:
            return None
    return current


def walk_clips(folder: Any):
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield clip, _safe(lambda: folder.GetName(), "")
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        yield from walk_clips(sub)


def flatten_words(tr: Dict[str, Any]) -> List[Dict[str, Any]]:
    words = []
    for seg in tr.get("segments") or []:
        for w in seg.get("words") or []:
            words.append({"text": w.get("text", ""), "start": w.get("start"), "end": w.get("end")})
    return words


def speech_runs(words: List[Dict[str, Any]], max_pause_f: int) -> List[List[int]]:
    """Merge spoken words ([start_f, end_f)) into runs; gaps > max_pause_f split runs."""
    runs: List[List[int]] = []
    for w in words:
        if w["text"].strip() == SILENCE:
            continue
        if runs and w["s"] - runs[-1][1] <= max_pause_f:
            runs[-1][1] = max(runs[-1][1], w["e"])
        else:
            runs.append([w["s"], w["e"]])
    return runs


def unique_name(project: Any, base: str) -> str:
    existing = {_safe(lambda: project.GetTimelineByIndex(i).GetName())
                for i in range(1, int(project.GetTimelineCount() or 0) + 1)}
    n = 1
    while f"{base}_{n}" in existing:
        n += 1
    return f"{base}_{n}"


def transcribe(project: Any, clip: Any) -> Optional[Dict[str, Any]]:
    """Run TranscribeAudio on one clip and wait for it. Returns the transcription."""
    name = _safe(lambda: clip.GetName(), "?")
    existing = _safe(lambda: clip.GetTranscription())
    if existing and existing.get("segments") and not FORCE_RETRANSCRIBE:
        say(f"'{name}' already has a transcription — reusing it.")
        return existing
    if FORCE_RETRANSCRIBE:
        _safe(lambda: clip.ClearTranscription())
    t0 = time.time()
    started = _safe(lambda: clip.TranscribeAudio(), "raised")
    say(f"TranscribeAudio on '{name}' → {started}")
    if started is not True:
        return None
    last = None
    seen_running = False
    while time.time() - t0 < TIMEOUT_MINUTES * 60:
        st = _safe(lambda: project.GetTranscribeAudioStatus(), {}) or {}
        job = st.get("JobStatus")
        state = f"{job} {st.get('CompletionPercentage', '')}%"
        if state != last:
            say(f"  {int(time.time() - t0)}s: {state}")
            last = state
        if job in ("Initializing", "Analyzing", "Cancelling"):
            seen_running = True
        # TranscribeAudio may block until done (then we land straight on Complete or
        # Inactive) or return at once; give a non-blocking job 15 s to show up.
        if job in ("Complete", "Cancelled") or (job in ("Inactive", None)
                                                and (seen_running or time.time() - t0 > 15)):
            break
        time.sleep(POLL_SECONDS)
    say(f"Transcription took {int(time.time() - t0)}s.")
    tr = _safe(lambda: clip.GetTranscription())
    return tr if tr and tr.get("segments") else None


def main() -> None:
    r = get_resolve()
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    root = mp.GetRootFolder()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}'")

    mc_bin = find_folder(root, MC_BIN)
    mc = None
    for clip in (_safe(lambda: mc_bin.GetClipList(), []) or []) if mc_bin else []:
        if "multicam" in str(_safe(lambda: clip.GetClipProperty("Type"), "")).lower() \
                and (MC_NAME is None or _safe(lambda: clip.GetName()) == MC_NAME):
            mc = clip
            break
    if mc is None:
        raise RuntimeError(f"No multicam clip in {MC_BIN}")
    fps = float(mc.GetClipProperty("FPS") or project.GetSetting("timelineFrameRate"))
    mc_start_f = tc_to_frames(mc.GetClipProperty("Start TC"), fps)
    say(f"Multicam '{mc.GetName()}' @ {fps} fps, start TC {mc.GetClipProperty('Start TC')}")

    # ── 1. Transcribe ─────────────────────────────────────────────────────────
    say("\n== 1. Transcribe ==")
    source = "multicam"
    tr = transcribe(project, mc)
    if tr is None:
        say("✗ The multicam couldn't be transcribed — falling back to a CAM 1 source clip.")
        src_bin = find_folder(root, FALLBACK_SOURCE_BIN)
        cam1 = [c for c, folder in (walk_clips(src_bin) if src_bin else [])
                if "CAM 1" in folder.upper() or "CAM 1" in str(_safe(lambda: c.GetName(), "")).upper()]
        cam1.sort(key=lambda c: -int(str(_safe(lambda: c.GetClipProperty("Frames"), 0)) or 0))
        if not cam1:
            raise RuntimeError("No CAM 1 clip found to fall back on.")
        source = f"source clip '{cam1[0].GetName()}'"
        tr = transcribe(project, cam1[0])
        if tr is None:
            raise RuntimeError("Transcription failed on the source clip too.")

    words = flatten_words(tr)
    spoken = [w for w in words if w["text"].strip() != SILENCE]
    say(f"Transcribed from the {source}: language {tr.get('language')}, "
        f"{len(tr.get('segments') or [])} segment(s), {len(spoken)} word(s), "
        f"{len(words) - len(spoken)} silence marker(s).")
    say(f"First words: {' '.join(w['text'] for w in spoken[:25])}")
    say(f"First word timings: " + ", ".join(f"{w['text']}[{w['start']}–{w['end']}]" for w in spoken[:5]))
    try:
        with open(WORDS_PATH, "w", encoding="utf-8") as fh:
            json.dump({"source": source, "fps": fps, "transcription": tr}, fh, ensure_ascii=False, indent=1)
        say(f"All words saved to {WORDS_PATH}")
    except Exception as exc:
        say(f"(Couldn't save words: {exc})")

    # Word timecodes → multicam frames. Source-clip fallback shares the same TOD TC.
    for w in words:
        w["s"] = tc_to_frames(w["start"], fps) - mc_start_f
        w["e"] = tc_to_frames(w["end"], fps) - mc_start_f
    if spoken and spoken[0]["s"] < 0:
        say("⚠ Word timecodes are BEFORE the multicam start — they may be clip-relative "
            "(starting 00:00:00:00 or 01:00:00:00), not time of day. Markers will be off.")
    lengths = sorted(w["e"] - w["s"] for w in spoken)
    if lengths:
        say(f"Word length in frames: min {lengths[0]}, median {lengths[len(lengths) // 2]}, "
            f"max {lengths[-1]}; zero-length words: {sum(1 for x in lengths if x <= 0)}")

    # ── 2. Test timelines over the window ─────────────────────────────────────
    win_a = int(WINDOW_START_S * fps)
    win_b = win_a + int(WINDOW_LEN_S * fps)
    in_win = [w for w in spoken if w["s"] >= win_a and w["e"] <= win_b]
    say(f"\n== 2. Window {WINDOW_START_S}s–{WINDOW_START_S + WINDOW_LEN_S}s: {len(in_win)} word(s) ==")
    if not in_win:
        raise RuntimeError("No words in the window — move WINDOW_START_S to a stretch of talking.")
    tl_bin = find_folder(root, TIMELINE_BIN)
    if tl_bin:
        mp.SetCurrentFolder(tl_bin)

    words_name = unique_name(project, "__SPIKE_words")
    tl = mp.CreateTimelineFromClips(words_name, [{"mediaPoolItem": mc, "startFrame": win_a, "endFrame": win_b}])
    if not tl:
        raise RuntimeError("Couldn't create the words timeline.")
    placed = 0
    for w in in_win:
        if _safe(lambda: tl.AddMarker(w["s"] - win_a, "Blue", w["text"][:30],
                                       f"{w['start']}–{w['end']}", max(1, w["e"] - w["s"])), False):
            placed += 1
    say(f"{words_name}: {placed}/{len(in_win)} word markers (marker = word start, length = word length).")

    pad = PAD_FRAMES
    runs = speech_runs(in_win, int(round(MAX_PAUSE * fps)))
    ranges = []
    for s, e in runs:
        s, e = max(win_a, s - pad), min(win_b, e + pad)
        if ranges and s <= ranges[-1][1]:
            ranges[-1][1] = e
        else:
            ranges.append([s, e])
    tight_name = unique_name(project, "__SPIKE_tight")
    tight = mp.CreateEmptyTimeline(tight_name)
    project.SetCurrentTimeline(tight)
    appended = mp.AppendToTimeline([{"mediaPoolItem": mc, "startFrame": s, "endFrame": e}
                                    for s, e in ranges]) or []
    kept = sum(e - s for s, e in ranges)
    say(f"{tight_name}: {len(ranges)} piece(s), {len(appended)} appended, "
        f"{kept / fps:.1f}s kept of {WINDOW_LEN_S}s ({WINDOW_LEN_S - kept / fps:.1f}s of pauses removed, "
        f"pauses > {MAX_PAUSE}s cut, {PAD_FRAMES}-frame padding).")
    say("\nNow: scrub the words timeline (do markers sit on word starts?) and play the "
        "tight timeline (any clipped words or breaths?).")


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(REPORT_PATH, "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
        print(f"\nReport saved to {REPORT_PATH}")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
