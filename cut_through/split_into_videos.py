#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cut-through: cut one imported "joined" timeline into one timeline per video.

Every FCPXML import makes a new copy of the multicam, so all videos of a batch are imported as
ONE timeline (write_timeline_xml.py joined=NAME → one copy). This script then, for each video in the
<out>_ranges.json file write_timeline_xml.py wrote:
  - duplicates the joined timeline under the video's name,
  - deletes every clip after the video, then ripple-deletes every clip before it,
  - checks every track moved by the same amount (picture and mics still in sync) and that
    all clips use one multicam,
  - moves the cut timelines into SEQ_BIN (e.g. "MASTER / SEQUENCES"; left in place if not given),
  - deletes the joined timeline once every video split cleanly (KEEP_JOINED=True keeps it).

HOW TO RUN (Windows Resolve machine, project open, ranges JSON on the Desktop, after `git pull`,
after importing the joined FCPXML with import_into_resolve.py):
    RANGES="ConvoTest_joined_ranges.json"; SEQ_BIN="MASTER / SEQUENCES"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\cut_through\\split_into_videos.py", encoding="utf-8").read())
Report saved to Desktop\\split_<timeline>.txt.
"""

import json
import os
import time
from typing import Any, Dict, List, Optional

RANGES = globals().get("RANGES", "ConvoTest_joined_ranges.json")
SEQ_BIN = globals().get("SEQ_BIN")                     # where the cut timelines go, "A / B" path
KEEP_JOINED = bool(globals().get("KEEP_JOINED"))
FINISH = globals().get("FINISH", True)                 # crossfades + head/tail fades (style guide)
FADE_FRAMES = 8
CROSSFADE = {"type": "Cross Fade 0 dB", "category": "audio", "position": "end", "alignment": "center", "duration": 2}
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


def finish(project: Any, tl: Any) -> str:
    """Style guide finishing: 2-frame "Cross Fade 0 dB" only where audio was removed (the source
    jumps) and the mic is open on at least one side; 8-frame audio fades at head and tail;
    8-frame picture Cross Dissolve from/to black. Also counts the disabled (gated) mic clips."""
    project.SetCurrentTimeline(tl)
    t = tracks(tl)
    start, end = tl.GetStartFrame(), tl.GetEndFrame()
    out = []
    for name, its in t.items():
        if not name.startswith("A") or not its:
            continue
        on = [bool(_safe(lambda: it.GetClipEnabled(), True)) for it in its]
        xf = 0
        for (a, ea), (b, eb) in zip(zip(its, on), zip(its[1:], on[1:])):
            jump = abs(float(b.GetSourceStartFrame()) - float(a.GetSourceEndFrame())) > 1
            if int(a.GetEnd()) == int(b.GetStart()) and jump and (ea or eb):
                xf += bool(_safe(lambda: a.AddTransition(CROSSFADE)))
        head = int(its[0].GetStart()) == start and bool(_safe(lambda: its[0].AddTransition(
            {**CROSSFADE, "position": "start", "alignment": "right", "duration": FADE_FRAMES})))
        tail = int(its[-1].GetEnd()) == end and bool(_safe(lambda: its[-1].AddTransition(
            {**CROSSFADE, "position": "end", "alignment": "left", "duration": FADE_FRAMES})))
        out.append(f"{name} {len(its)} clips ({on.count(False)} gated off), {xf} crossfade(s), "
                   f"fade in {'✓' if head else '✗'} out {'✓' if tail else '✗'}")
    v = t.get("V1", [])
    if v:
        def dissolve(item, edge, align):
            for cat in ("simple", None):
                opts = {"type": "Cross Dissolve", "position": edge, "alignment": align, "duration": FADE_FRAMES}
                if cat:
                    opts["category"] = cat
                if _safe(lambda: item.AddTransition(opts)):
                    return "✓"
            return "✗"
        out.append(f"picture from black {dissolve(v[0], 'start', 'right')} to black {dissolve(v[-1], 'end', 'left')}")
    return "; ".join(out)


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
        if FINISH:
            say(f"    finish: {finish(project, dup)}")
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
    for _k in ("RANGES", "SEQ_BIN", "KEEP_JOINED", "FINISH"):       # the console keeps run-line settings between runs
        globals().pop(_k, None)
