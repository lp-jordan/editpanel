#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Cut one imported "joined" timeline into one timeline per video.

Every FCPXML import makes a new copy of the multicam, so all videos of a batch are imported as
ONE timeline (make_fcpxml.py joined=NAME → one copy). This script then, for each video in the
<out>_ranges.json file make_fcpxml.py wrote:
  - duplicates the joined timeline under the video's name,
  - deletes every clip after the video, then ripple-deletes every clip before it,
  - checks every track moved by the same amount (picture and mics still in sync) and that
    all clips use one multicam.

HOW TO RUN (Windows Resolve machine, project open, ranges JSON on the Desktop, after `git pull`,
after importing the joined FCPXML with spike_import_fcpxml.py):
    RANGES="ConvoTest_joined_ranges.json"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_split_batch.py", encoding="utf-8").read())
Report saved to Desktop\\split_<timeline>.txt.
"""

import json
import os
import time
from typing import Any, Dict, List

RANGES = globals().get("RANGES", "ConvoTest_joined_ranges.json")
DESKTOP = os.path.expanduser("~/Desktop")
_lines: List[str] = []
_T0 = time.time()
_report = "split_report.txt"


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def tracks(tl: Any) -> Dict[str, List[Any]]:
    """Every track's items in record order, keyed V1, A1, A2…"""
    out = {}
    for kind, tag in (("video", "V"), ("audio", "A")):
        for k in range(1, int(tl.GetTrackCount(kind) or 0) + 1):
            its = _safe(lambda: tl.GetItemListInTrack(kind, k), []) or []
            out[f"{tag}{k}"] = sorted(its, key=lambda x: x.GetStart())
    return out


def main() -> None:
    global _report
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    spec = json.load(open(os.path.join(DESKTOP, RANGES), encoding="utf-8"))
    _report = f"split_{spec['timeline']}.txt"
    timelines = {project.GetTimelineByIndex(i).GetName(): project.GetTimelineByIndex(i)
                 for i in range(1, int(project.GetTimelineCount()) + 1)}
    src = timelines.get(spec["timeline"])
    if not src:
        raise RuntimeError(f"No timeline named {spec['timeline']!r} — import the joined FCPXML first.")
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — split {spec['timeline']}")
    mcs = {(_safe(lambda: it.GetMediaPoolItem().GetUniqueId()) or "none")[:8]
           for its in tracks(src).values() for it in its}
    say(f"Joined timeline: {sum(len(v) for v in tracks(src).values())} clip(s) on "
        f"{len(tracks(src))} track(s); multicam(s) used {sorted(mcs)}")

    for v in spec["videos"]:
        t1 = time.time()
        name = v["name"]
        if name in timelines:
            say(f"  {name}: already exists — skipped (delete it to rebuild)")
            continue
        project.SetCurrentTimeline(src)
        dup = src.DuplicateTimeline(name)
        if not dup:
            say(f"  {name}: ✗ DuplicateTimeline failed")
            continue
        s0 = dup.GetStartFrame()
        a, b = s0 + v["start"], s0 + v["end"]
        before, after, keep, straddle = [], [], {}, 0
        for tr, its in tracks(dup).items():
            for it in its:
                if it.GetStart() >= b:
                    after.append(it)
                elif it.GetEnd() <= a:
                    before.append(it)
                else:
                    keep.setdefault(tr, []).append(it.GetStart())
                    straddle += it.GetStart() < a or it.GetEnd() > b
        ok_after = dup.DeleteClips(after, False) if after else True
        ok_before = dup.DeleteClips(before, True) if before else True
        now = tracks(dup)
        shift = a - s0
        sync = []
        for tr, starts in keep.items():
            got = [it.GetStart() for it in now.get(tr, [])]
            moved = {o - g for o, g in zip(starts, got)}
            if len(got) != len(starts):
                sync.append(f"{tr} ✗ {len(got)}/{len(starts)} clips")
            elif moved == {shift} or (not shift and moved <= {0}):
                sync.append(f"{tr} ✓")
            else:
                sync.append(f"{tr} ✗ moved {sorted(moved)[:3]} (picture needs {shift})")
        first = now.get("V1", [None])[0]
        lead = (first.GetStart() - s0) if first else None
        length = dup.GetEndFrame() - s0
        say(f"  {name}: deleted {len(after)} after (ok={ok_after}) + {len(before)} before ripple (ok={ok_before}); "
            f"starts at +{lead} fr; length {length} fr (want {v['end'] - v['start']}); "
            f"{'straddling clips: ' + str(straddle) + '; ' if straddle else ''}sync {', '.join(sync)} "
            f"({time.time() - t1:.1f}s)")
    say("\nOpen the split timelines and check the first and last cut and that the mics line up.")


try:
    main()
    say(f"\nTotal time: {time.time() - _T0:.1f}s")
except Exception as exc:
    say(f"\n✗ STOPPED after {time.time() - _T0:.1f}s: {exc}")
finally:
    try:
        with open(os.path.join(DESKTOP, _report), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    globals().pop("RANGES", None)                         # the console keeps run-line settings between runs
