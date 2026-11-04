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
    all clips use one multicam,
  - moves the cut timelines into SEQ_BIN (e.g. "MASTER / SEQUENCES"; left in place if not given),
  - deletes the joined timeline once every video split cleanly (KEEP_JOINED=True keeps it).

HOW TO RUN (Windows Resolve machine, project open, ranges JSON on the Desktop, after `git pull`,
after importing the joined FCPXML with spike_import_fcpxml.py):
    RANGES="ConvoTest_joined_ranges.json"; SEQ_BIN="MASTER / SEQUENCES"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_split_batch.py", encoding="utf-8").read())
Report saved to Desktop\\split_<timeline>.txt.
"""

import json
import os
import time
from typing import Any, Dict, List, Optional

RANGES = globals().get("RANGES", "ConvoTest_joined_ranges.json")
SEQ_BIN = globals().get("SEQ_BIN")                     # where the cut timelines go, "A / B" path
KEEP_JOINED = bool(globals().get("KEEP_JOINED"))
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


def find_folder(root: Any, path: str) -> Optional[Any]:
    current = root
    segs = [x.strip() for x in path.split(" / ") if x.strip()]
    if segs and segs[0].lower() == str(_safe(lambda: root.GetName(), "")).lower():
        segs = segs[1:]                                # "MASTER / ..." = the root bin itself
    for seg in segs:
        current = next((c for c in (_safe(lambda: current.GetSubFolderList(), []) or [])
                        if _safe(lambda: c.GetName()) == seg), None)
        if current is None:
            return None
    return current


def timeline_items(folder: Any, names: set) -> Dict[str, Any]:
    """Media pool items of the timelines with these names, wherever they sit."""
    out = {}
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        if "timeline" in str(_safe(lambda: clip.GetClipProperty("Type"), "")).lower() \
                and _safe(lambda: clip.GetName()) in names:
            out[clip.GetName()] = clip
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        out.update(timeline_items(sub, names))
    return out


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
    mp = project.GetMediaPool()
    seq = find_folder(mp.GetRootFolder(), SEQ_BIN) if SEQ_BIN else None
    if SEQ_BIN and not seq:
        raise RuntimeError(f"No bin {SEQ_BIN!r}")
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

    built, clean = [], 0
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
        built.append(name)
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
        clean += (lead == 0 and length == v["end"] - v["start"] and not straddle
                  and all("✓" in x for x in sync))
        say(f"  {name}: deleted {len(after)} after (ok={ok_after}) + {len(before)} before ripple (ok={ok_before}); "
            f"starts at +{lead} fr; length {length} fr (want {v['end'] - v['start']}); "
            f"{'straddling clips: ' + str(straddle) + '; ' if straddle else ''}sync {', '.join(sync)} "
            f"({time.time() - t1:.1f}s)")
    say(f"Clean splits: {clean}/{len(spec['videos'])}")
    if seq and built:
        items = timeline_items(mp.GetRootFolder(), set(built))
        _safe(lambda: mp.MoveClips(list(items.values()), seq), False)
        landed = timeline_items(seq, set(built))
        say(f"Cut timelines in '{SEQ_BIN}': {len(landed)}/{len(built)}")
    if clean == len(spec["videos"]) and not KEEP_JOINED:
        other = next((project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount()) + 1)
                      if project.GetTimelineByIndex(i).GetName() != spec["timeline"]), None)
        if other:                                       # don't delete the timeline that's open
            project.SetCurrentTimeline(other)
        gone = _safe(lambda: mp.DeleteTimelines([src]), False)
        say(f"Joined timeline {spec['timeline']} deleted: {gone}")
    elif not KEEP_JOINED:
        say(f"Joined timeline {spec['timeline']} kept (not every split was clean)")
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
    for _k in ("RANGES", "SEQ_BIN", "KEEP_JOINED"):       # the console keeps run-line settings between runs
        globals().pop(_k, None)
