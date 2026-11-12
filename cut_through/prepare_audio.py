#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cut-through step 1 for narration (Prep): describe an audio-only timeline for transcription.

An audiobook / narration session has no multicam: the recording is one or more audio files laid
on a timeline (any format Resolve and ffmpeg read: WAV, AIFF, MP3, M4A …). EditPanel runs this in
its Resolve worker (Cut-through page → pick an audio timeline → Prep). It reads the timeline's
audio clips straight from Resolve (nothing exported, nothing changed) and writes
  day_<LABEL>.json — the same shape prepare_multicam.py writes, so Transcribe and Plan run
                     unchanged: one speaker ("Narrator"), no angles, source = "audio_timeline".
Positions are seconds from the timeline's first frame (the "day" clock).

Only the first audio track with clips is used (the narrator's mic). Other tracks are listed in
the report and left out.

By hand in Resolve's Py3 console (project open):
    LABEL="Book1"; TIMELINE="Book 1 session"; OUT_DIR=r"<run folder>"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\cut_through\\prepare_audio.py", encoding="utf-8").read())
"""
import json
import os
from fractions import Fraction
from typing import List


def _common():
    """common.py from this script's own folder, loaded fresh each run (see its docstring)."""
    import importlib.util
    here = (os.path.dirname(os.path.abspath(globals()["__file__"])) if globals().get("__file__")
            else r"C:\lp-app-ecosystem\editpanel\cut_through")
    spec = importlib.util.spec_from_file_location("cut_through_common", os.path.join(here, "common.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_c = _common()
_safe, merge_spans, tc_to_frames = _c._safe, _c.merge_spans, _c.tc_to_frames

LABEL = globals().get("LABEL", "Narration")
TIMELINE = globals().get("TIMELINE")
OUT_DIR = globals().get("OUT_DIR") or os.path.expanduser("~/Desktop")
SPEAKER = "Narrator"
os.makedirs(OUT_DIR, exist_ok=True)
_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def phase(text: str) -> None:
    print(f"▸ {text}", flush=True)


def frame_fraction(fps: float) -> Fraction:
    """A timeline frame rate → exact frame duration (23.976 = 1001/24000)."""
    for nominal in (24, 30, 48, 60, 120):
        if abs(fps - nominal * 1000 / 1001) < 0.01:
            return Fraction(1001, nominal * 1000)
    return Fraction(1) / Fraction(fps).limit_denominator(1000)


def source_start_sec(item, fd: Fraction) -> float:
    """Where in its file a timeline clip starts, in seconds."""
    v = _safe(lambda: item.GetSourceStartTime())          # seconds (Resolve 19+)
    if v is not None:
        return float(v)
    off = _safe(lambda: item.GetLeftOffset())              # frames
    return float(off or 0) * float(fd)


def describe(tl) -> dict:
    fps = float(_safe(lambda: tl.GetSetting("timelineFrameRate"), 0) or 0) or 24.0
    fd = frame_fraction(fps)
    t0 = int(_safe(lambda: tl.GetStartFrame(), 0) or 0)
    tracks = []
    for t in range(1, int(_safe(lambda: tl.GetTrackCount("audio"), 0) or 0) + 1):
        its = sorted(_safe(lambda: tl.GetItemListInTrack("audio", t), []) or [], key=lambda x: x.GetStart())
        if its:
            tracks.append((t, its))
    if not tracks:
        raise RuntimeError(f"No audio clips on {tl.GetName()!r}")
    track, items = tracks[0]
    mics, spans, end = [], [], 0.0
    for it in items:
        mpi = _safe(lambda: it.GetMediaPoolItem())
        path = str(_safe(lambda: mpi.GetClipProperty("File Path"), "") or "") if mpi else ""
        a = (int(it.GetStart()) - t0) * float(fd)
        b = (int(it.GetEnd()) - t0) * float(fd)
        src = source_start_sec(it, fd)
        mics.append({"name": os.path.basename(path) or str(_safe(lambda: it.GetName(), "?")), "angle": SPEAKER,
                     "path": path, "file_zero_sec": a - src, "from_sec": a, "to_sec": b, "src_start_sec": src,
                     "channels": int(str(_safe(lambda: mpi.GetClipProperty("Audio Ch"), "1") or "1").split()[0] or 1)
                     if mpi else 1})
        spans.append((a, b))
        end = max(end, b)
    start_tc = _safe(lambda: tl.GetStartTimecode()) or "00:00:00:00"
    tc0 = _safe(lambda: tc_to_frames(start_tc, fps), 0) or 0
    day = {"multicam": tl.GetName(), "timeline": tl.GetName(), "source": "audio_timeline",
           "fps": float(1 / fd), "frame_sec": [fd.numerator, fd.denominator],
           "tc_start_sec": float(tc0 * fd), "length_sec": float(end),
           "angles": [], "mics": mics, "camera_audio_angles": [], "picture_clips": [],
           "audio_source": "wav", "wav_mics": len(mics), "audio_track": track,
           "recordings": [{"from_sec": float(x), "to_sec": float(y)} for x, y in merge_spans(spans, 0.5)]}
    return day, [t for t, _ in tracks[1:]]


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — narration prep {LABEL}")
    if not TIMELINE:
        raise RuntimeError("No timeline given (TIMELINE=\"name\")")
    phase(f"Reading {TIMELINE}'s audio from Resolve")
    tl = next((project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount() or 0) + 1)
               if _safe(lambda: project.GetTimelineByIndex(i).GetName()) == TIMELINE), None)
    if tl is None:
        raise RuntimeError(f"No timeline named {TIMELINE!r}")
    day, other = describe(tl)
    day.update({"label": LABEL, "project": project.GetName()})
    out = os.path.join(OUT_DIR, f"day_{LABEL}.json")
    json.dump(day, open(out, "w", encoding="utf-8"), indent=1)
    say(f"Timeline '{TIMELINE}': {day['length_sec'] / 60:.1f} min at {day['fps']:.3f} fps; "
        f"{len(day['mics'])} clip(s) on A{day['audio_track']}" + (f"; tracks left out: {', '.join(f'A{t}' for t in other)}" if other else ""))
    for m in day["mics"]:
        ok = bool(m["path"]) and os.path.isfile(m["path"])
        say(f"   {m['name']}: timeline {m['from_sec'] / 60:.1f}–{m['to_sec'] / 60:.1f} min, from {m['src_start_sec']:.2f}s into the file; "
            f"file {'found' if ok else 'NOT FOUND'}")
    say(f"Saved {out}")


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(os.path.join(OUT_DIR, f"day_prep_{LABEL}.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("LABEL", "TIMELINE", "OUT_DIR"):
        globals().pop(_k, None)
