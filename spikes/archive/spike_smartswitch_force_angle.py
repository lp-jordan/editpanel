#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Can a script choose the camera angle of a multicam piece?

The scripting API has no "set angle" call. This tests a loophole: run SmartSwitch
on ONE piece at a time, tell it the angle we want IS "the wide", and ask it to use
the wide for intros/outros with a long minimum shot length, so the whole piece
should land on that angle.

It also tests whether a piece's NAME tells us its angle ("<MC> - Camera 3"), which
would let a script check angles without exporting the timeline.

What it does (needs Resolve 21.1+ and the day multicam from spike_build_timelines):
  1. Builds a new timeline `__SPIKE_force_angles_<n>` from 4 separate ranges of the
     multicam (the gaps between them are "cut out"; nothing is razored).
  2. Reads each piece's name (= starting angle).
  3. Runs SmartSwitch on each piece with that piece's target angle as "the wide".
  4. Reads every piece's name again and reports target vs result, plus whether
     SmartSwitch split any piece into several.

Then CHECK BY EYE: scrub the timeline. Does each piece SHOW the camera its name
says? (That's what tells us whether names can be trusted.)

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_smartswitch_force_angle.py", encoding="utf-8").read())
Report also saved to the Desktop as smartswitch_force_angle_spike.txt.
"""

import os
from typing import Any, List, Optional

# ──────────────────────────────────────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────────────────────────────────────
MC_BIN = "SEQUENCES / MC"
MC_NAME: Optional[str] = None     # None = first multicam clip in MC_BIN
TIMELINE_BIN = "SEQUENCES"
# (seconds from the multicam's start, length in seconds, angle we want)
# Short pieces (< MIN_EDIT) test the trick; the 30 s one tests a piece long
# enough that SmartSwitch is allowed to cut inside it.
PIECES = [
    (120, 8, "Camera 3"),
    (180, 8, "Camera 2"),
    (240, 8, "Camera 4"),
    (300, 30, "Camera 3"),
]
MIN_EDIT = 10.0                   # SmartSwitch minimum shot length (max allowed is 10)
REPORT_PATH = os.path.expanduser("~/Desktop/smartswitch_force_angle_spike.txt")

BIN_SEP = " / "
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


def find_folder(root: Any, path: str) -> Optional[Any]:
    current = root
    for seg in [s.strip() for s in path.split(BIN_SEP) if s.strip()]:
        current = next((c for c in (_safe(lambda: current.GetSubFolderList(), []) or [])
                        if _safe(lambda: c.GetName()) == seg), None)
        if current is None:
            return None
    return current


def items_on_v1(tl: Any) -> List[Any]:
    return sorted(_safe(lambda: tl.GetItemListInTrack("video", 1), []) or [],
                  key=lambda it: _safe(lambda: it.GetStart(), 0))


def describe(it: Any) -> str:
    return (f"'{_safe(lambda: it.GetName())}' "
            f"rec {_safe(lambda: it.GetStart())}..{_safe(lambda: it.GetEnd())} "
            f"({_safe(lambda: it.GetDuration())} fr)")


def main() -> None:
    r = get_resolve()
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}'")
    if getattr(r, "SMART_SWITCH_ANALYSIS_MODE_NONE", None) is None:
        raise RuntimeError("No SmartSwitch scripting API — needs Resolve 21.1+.")

    # ── Find the multicam ─────────────────────────────────────────────────────
    mc_bin = find_folder(mp.GetRootFolder(), MC_BIN)
    if mc_bin is None:
        raise RuntimeError(f"Bin not found: {MC_BIN}")
    mc = None
    for clip in _safe(lambda: mc_bin.GetClipList(), []) or []:
        is_mc = "multicam" in str(_safe(lambda: clip.GetClipProperty("Type"), "")).lower()
        if is_mc and (MC_NAME is None or _safe(lambda: clip.GetName()) == MC_NAME):
            mc = clip
            break
    if mc is None:
        raise RuntimeError(f"No multicam clip in {MC_BIN}")
    fps = float(mc.GetClipProperty("FPS") or project.GetSetting("timelineFrameRate"))
    say(f"Multicam '{mc.GetName()}' @ {fps} fps, {mc.GetClipProperty('Frames')} frames")

    # ── 1. Build the test timeline from separate ranges ───────────────────────
    existing = {_safe(lambda: project.GetTimelineByIndex(i).GetName())
                for i in range(1, int(project.GetTimelineCount() or 0) + 1)}
    n = 1
    while f"__SPIKE_force_angles_{n}" in existing:
        n += 1
    tl_name = f"__SPIKE_force_angles_{n}"
    tl_bin = find_folder(mp.GetRootFolder(), TIMELINE_BIN)
    if tl_bin:
        mp.SetCurrentFolder(tl_bin)
    tl = mp.CreateEmptyTimeline(tl_name)
    if not tl:
        raise RuntimeError("CreateEmptyTimeline failed")
    project.SetCurrentTimeline(tl)
    _safe(lambda: r.OpenPage("edit"))

    infos = []
    for start_s, length_s, _angle in PIECES:
        a = int(round(start_s * fps))
        infos.append({"mediaPoolItem": mc, "startFrame": a,
                      "endFrame": a + int(round(length_s * fps))})
    appended = mp.AppendToTimeline(infos) or []
    say(f"\n== 1. Timeline '{tl_name}': appended {len(appended)} of {len(PIECES)} piece(s) ==")
    pieces = items_on_v1(tl)
    for (start_s, length_s, angle), it in zip(PIECES, pieces):
        say(f"  {start_s}s +{length_s}s (want {angle}) → {describe(it)}")
    if len(pieces) != len(PIECES):
        say(f"⚠ Expected {len(PIECES)} pieces on V1, found {len(pieces)} (adjacent ranges may have merged).")

    # ── 2 + 3. SmartSwitch each piece with its target as "the wide" ───────────
    say("\n== 2. SmartSwitch per piece ==")
    spans = [(_safe(lambda: it.GetStart()), _safe(lambda: it.GetEnd())) for it in pieces]
    for (start_s, length_s, angle), it in zip(PIECES, pieces):
        settings = {
            "analysisMode": r.SMART_SWITCH_ANALYSIS_MODE_NONE,
            "isAutoDetectWideAngle": False,
            "wideAngleID": angle,
            "wideAngleFrequency": r.SMART_SWITCH_WIDE_ANGLE_FREQ_HIGH,
            "isUseWideAngleForIntroOutro": True,
            "isUseWideAngleForSilence": True,
            "minEditDuration": MIN_EDIT,
        }
        ok = _safe(lambda: it.PerformMulticamSmartSwitch(settings), "raised")
        if ok is not True:
            # Run 1 (21.1.2): the FIRST call returned False, the rest worked. Retry
            # once to tell a one-off warm-up failure from a per-piece one.
            retry = _safe(lambda: it.PerformMulticamSmartSwitch(settings), "raised")
            ok = f"{ok}, retry → {retry}"
        say(f"  piece at {start_s}s, wide = {angle}: PerformMulticamSmartSwitch → {ok}")

    # ── 4. Read back ──────────────────────────────────────────────────────────
    say("\n== 3. Result (piece names after SmartSwitch) ==")
    after = items_on_v1(tl)
    say(f"V1 now has {len(after)} item(s) (was {len(pieces)}).")
    hits = 0
    for (start_s, length_s, angle), (s, e) in zip(PIECES, spans):
        inside = [it for it in after
                  if s is not None and e is not None
                  and _safe(lambda: it.GetStart(), -1) < e and _safe(lambda: it.GetEnd(), -1) > s]
        names = [str(_safe(lambda: it.GetName(), "")) for it in inside]
        all_hit = bool(names) and all(nm.endswith(angle) for nm in names)
        hits += all_hit
        say(f"  {start_s}s +{length_s}s want {angle}: {'✓' if all_hit else '✗'} "
            f"{len(inside)} item(s): " + "; ".join(describe(it) for it in inside))
    say(f"\n{hits}/{len(PIECES)} piece(s) named as the target angle.")
    say("Now scrub the timeline: does each piece SHOW the camera its name says?")


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
