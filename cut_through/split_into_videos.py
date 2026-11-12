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

Run by build_rough_cut.py (step 4, after import_into_resolve.py) with RANGES (the ranges file's
name inside OUT_DIR), SEQ_BIN and OUT_DIR (EditPanel: the run folder; without it: the Desktop).
Report saved to OUT_DIR/split_<timeline>.txt.
"""

import json
import os
import time
from typing import Any, Dict, List, Optional

RANGES = globals().get("RANGES", "ConvoTest_joined_ranges.json")
SEQ_BIN = globals().get("SEQ_BIN")                     # where the cut timelines go, "A / B" path
KEEP_JOINED = bool(globals().get("KEEP_JOINED"))
FINISH = globals().get("FINISH", True)                 # crossfades + head/tail fades (style guide)
UNLINK = globals().get("UNLINK", True)                 # finished timelines come out unlinked
FADE_FRAMES = 8
# Jordan's saved Resolve transition preset (a Subtractive Cross Dissolve); plain Cross Dissolve
# (Resolve's default "Film" type) if the preset isn't found on this machine
LP_FADE = "Default LP Fade"
CROSSFADE = {"type": "Cross Fade 0 dB", "category": "audio", "position": "end", "alignment": "center", "duration": 2}
OUT_DIR = globals().get("OUT_DIR") or os.path.expanduser("~/Desktop")   # EditPanel: the run folder
os.makedirs(OUT_DIR, exist_ok=True)
_lines: List[str] = []
_T0 = time.time()
_report = "split_report.txt"


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def phase(text: str) -> None:
    """What's happening now, for the Cut-through page's live label (a "▸ " line; not in the report)."""
    print(f"▸ {text}", flush=True)


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
    jumps) and the mic is open on at least one side, and on every mic open / close (a gated clip
    next to an open one: Jordan 2026-11-10, so room tone doesn't snap on and off); 8-frame audio
    fades at head and tail;
    8-frame picture dissolve from/to black ("Default LP Fade" preset, else Cross Dissolve). Also counts the disabled (gated) mic clips."""
    project.SetCurrentTimeline(tl)
    t = tracks(tl)
    start, end = tl.GetStartFrame(), tl.GetEndFrame()
    out = []
    for name, its in t.items():
        if not name.startswith("A") or not its:
            continue
        on = [bool(_safe(lambda: it.GetClipEnabled(), True)) for it in its]
        xf = gate = 0
        for (a, ea), (b, eb) in zip(zip(its, on), zip(its[1:], on[1:])):
            if int(a.GetEnd()) != int(b.GetStart()):
                continue
            jump = abs(float(b.GetSourceStartFrame()) - float(a.GetSourceEndFrame())) > 1
            if ea != eb:
                gate += bool(_safe(lambda: a.AddTransition(CROSSFADE)))
            elif jump and ea:
                xf += bool(_safe(lambda: a.AddTransition(CROSSFADE)))
        head = int(its[0].GetStart()) == start and bool(_safe(lambda: its[0].AddTransition(
            {**CROSSFADE, "position": "start", "alignment": "right", "duration": FADE_FRAMES})))
        tail = int(its[-1].GetEnd()) == end and bool(_safe(lambda: its[-1].AddTransition(
            {**CROSSFADE, "position": "end", "alignment": "left", "duration": FADE_FRAMES})))
        out.append(f"{name} {len(its)} clips ({on.count(False)} gated off), {xf} crossfade(s), {gate} on mic open/close, "
                   f"fade in {'✓' if head else '✗'} out {'✓' if tail else '✗'}")
    v = t.get("V1", [])
    if v:
        def dissolve(item, edge, align):
            for kind in (LP_FADE, "Cross Dissolve"):
                # the preset sits under Effects > User Presets; which category name the API wants
                # for it is unknown, so try the likely ones
                for cat in (("simple", None, "user", "User Presets") if kind == LP_FADE else ("simple", None)):
                    opts = {"type": kind, "position": edge, "alignment": align, "duration": FADE_FRAMES}
                    if cat:
                        opts["category"] = cat
                    if _safe(lambda: item.AddTransition(opts)):
                        return "✓" if kind == LP_FADE else "✓ (Cross Dissolve, no LP preset)"
            return "✗"
        out.append(f"picture from black {dissolve(v[0], 'start', 'right')} to black {dissolve(v[-1], 'end', 'left')}")
    return "; ".join(out)


def review(tl: Any, v: dict) -> str:
    """Review markers (red = check, yellow = worth a look) and the quieter backchannels' 2-frame
    crossfades at both ends (Jordan's treatment of a "yeah" stepping on the talker)."""
    s0 = tl.GetStartFrame()
    marks = v.get("markers") or []
    placed = {"Red": 0, "Yellow": 0}
    for m in marks:
        ok = _safe(lambda: tl.AddMarker(int(m["frame"]), m["color"], m["name"][:60], m["note"][:500], 1))
        if ok:
            placed[m["color"]] = placed.get(m["color"], 0) + 1
    out = [f"markers {sum(placed.values())}/{len(marks)} (red {placed['Red']}, yellow {placed['Yellow']})"] if marks else []
    ducks = v.get("ducks") or []
    if ducks:
        xf, found = 0, 0
        for name, its in tracks(tl).items():
            if not name.startswith("A"):
                continue
            starts = {int(it.GetStart()) - s0: k for k, it in enumerate(its)}
            for a, b, _gain in ducks:
                k = starts.get(int(a))
                if k is None or int(its[k].GetEnd()) - s0 != int(b):
                    continue
                found += 1
                if k > 0 and int(its[k - 1].GetEnd()) == int(its[k].GetStart()):
                    xf += bool(_safe(lambda: its[k - 1].AddTransition(CROSSFADE)))
                xf += bool(_safe(lambda: its[k].AddTransition(CROSSFADE)))
        out.append(f"backchannels opened quieter: {found}/{len(ducks)}, {xf} crossfade(s)")
    return "; ".join(out)


def unlink(tl: Any) -> str:
    """Unlink every clip (picture from its sound, and the clips stacked under it), so trimming one
    clip doesn't drag the rest of A1 with it (Bill Smith mc_1, 2026-11-11: a trim on the first clip
    slid all the audio 1s13f). Runs last, after the split's ripple deletes, fades and markers."""
    its = [it for v in tracks(tl).values() for it in v]
    if not its:
        return "nothing to unlink"
    ok = bool(_safe(lambda: tl.SetClipsLinked(its, False), False))
    linked = [_safe(lambda: it.GetLinkedItems()) for it in its]
    still = sum(1 for x in linked if x)
    if ok and not still:
        return f"{len(its)} clip(s) unlinked ✓"
    known = " " + str(still) + " still linked;" if any(x is not None for x in linked) else ""
    return f"✗ unlink failed ({len(its)} clip(s));{known} unlink by hand: select all, Clip → Link Clips"


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
    spec = json.load(open(os.path.join(OUT_DIR, RANGES), encoding="utf-8"))
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
        phase(f"Cutting out {name}")
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
            phase(f"Adding fades and crossfades — {name}")
            say(f"    finish: {finish(project, dup)}")
        phase(f"Adding review markers — {name}")
        rv = review(dup, v)
        if rv:
            say(f"    review: {rv}")
        if UNLINK:
            phase(f"Unlinking clips — {name}")
            say(f"    unlink: {unlink(dup)}")
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
        with open(os.path.join(OUT_DIR, _report), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("RANGES", "SEQ_BIN", "KEEP_JOINED", "FINISH", "OUT_DIR"):       # the console keeps run-line settings between runs
        globals().pop(_k, None)
