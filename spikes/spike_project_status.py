#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE: can EditPanel read what the LPOS project-status rings need? (READ-ONLY)

The /editing Projects section (docs/editing-dashboard-plan.md) shows three rings per project:
  Cut       multicam minutes that finished cut-through (Prep through Check)
  Reviewed  timelines with a GREEN flag, out of the counted ones
  Uploaded  timelines that are in LPOS, out of the counted ones (LPOS works this out itself)
Counted = every timeline, minus YELLOW-flagged ones, minus cut-through's own
"(cut-through)" rough cuts.

This probe checks, on a real project:
  1. Timelines: count, names, unique ids (Project.GetTimelineByIndex)
  2. Each timeline's Media Pool item is found by unique id (same match flag_timelines.py uses)
  3. MediaPoolItem.GetFlagList() returns the flag colours, and in what form
  4. Multicam clips and their length: GetClipProperty("Frames" / "FPS" / "Duration")
  5. How long the whole read takes (it would run every few minutes on a busy machine)

Nothing in the project is changed. The report prints and is saved on the NAS as
N:\\LPOS\\spike reports\\project_status_<project>.txt (the Desktop if the NAS isn't reachable).

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
Workspace > Console > Py3, then
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_project_status.py", encoding="utf-8").read())

Before running, it helps to put a Green flag on a couple of timelines and a Yellow flag on
one (right-click the timeline in the Media Pool > Flags), so the report shows them.
"""

import os
import time
from collections import Counter
from typing import Any, Dict, List, Optional

REVIEWED_FLAG = "Green"
EXCLUDE_FLAG = "Yellow"  # Resolve has no Orange flag
CUT_THROUGH_SUFFIX = "(cut-through)"
DESKTOP = os.path.expanduser("~/Desktop")
# The shared NAS (N:\\ on Windows, /Volumes/LeaderPass Main on the Mac): Claude reads it from there.
NAS_DIR = r"N:\LPOS\spike reports" if os.name == "nt" else "/Volumes/LeaderPass Main/LPOS/spike reports"

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


def walk_folders(root: Any):
    stack = [(root, [])]
    seen = 0
    while stack:
        folder, path = stack.pop()
        if folder is None:
            continue
        seen += 1
        if seen > 5000:
            return
        yield folder, path
        for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
            stack.append((sub, path + [_safe(lambda: sub.GetName(), "?") or "?"]))


def to_float(v: Any) -> Optional[float]:
    try:
        return float(str(v).strip())
    except Exception:
        return None


def hm(seconds: float) -> str:
    m = int(round(seconds / 60))
    return f"{m // 60}h {m % 60:02d}m" if m >= 60 else f"{m}m"


def main() -> None:
    resolve = get_resolve()
    project = _safe(lambda: resolve.GetProjectManager().GetCurrentProject())
    if not project:
        say("No project open in Resolve.")
        return
    say(f"Project: {_safe(lambda: project.GetName())}")
    say(f"Resolve: {_safe(lambda: resolve.GetVersionString(), '?')}")
    say()

    # 1. Timelines
    t0 = time.time()
    timelines: List[Dict[str, Any]] = []
    count = int(_safe(lambda: project.GetTimelineCount(), 0) or 0)
    for i in range(1, count + 1):
        tl = _safe(lambda: project.GetTimelineByIndex(i))
        if not tl:
            continue
        timelines.append({
            "name": str(_safe(lambda: tl.GetName(), "") or ""),
            "uid": _safe(lambda: tl.GetUniqueId()),
        })
    t_timelines = time.time() - t0
    say(f"[1] Timelines: {len(timelines)} ({t_timelines:.2f}s)")

    # 2-4. One Media Pool walk: map uid -> item, read flags, find multicams
    t0 = time.time()
    by_uid: Dict[str, Any] = {}
    types = Counter()
    multicams: List[Dict[str, Any]] = []
    clips_seen = 0
    for folder, path in walk_folders(_safe(lambda: project.GetMediaPool().GetRootFolder())):
        for clip in _safe(lambda: folder.GetClipList(), []) or []:
            clips_seen += 1
            uid = _safe(lambda: clip.GetUniqueId())
            if uid:
                by_uid[uid] = clip
            ctype = str(_safe(lambda: clip.GetClipProperty("Type"), "") or "")
            types[ctype or "?"] += 1
            if "multicam" in ctype.lower():
                frames = to_float(_safe(lambda: clip.GetClipProperty("Frames")))
                fps = to_float(_safe(lambda: clip.GetClipProperty("FPS")))
                multicams.append({
                    "name": _safe(lambda: clip.GetName(), "?"),
                    "bin": " / ".join(path),
                    "frames": frames,
                    "fps": fps,
                    "duration": _safe(lambda: clip.GetClipProperty("Duration")),
                    "seconds": (frames / fps) if frames and fps else None,
                })
    t_walk = time.time() - t0
    say(f"[2] Media Pool walk: {clips_seen} items in {t_walk:.2f}s")
    say("    Item types: " + ", ".join(f"{k} {v}" for k, v in types.most_common()))

    t0 = time.time()
    raw_examples = []
    matched = 0
    flag_counts = Counter()
    for t in timelines:
        item = by_uid.get(t["uid"]) if t["uid"] else None
        t["matched"] = item is not None
        t["flags"] = []
        if item is None:
            continue
        matched += 1
        raw = _safe(lambda: item.GetFlagList(), "ERROR")
        if len(raw_examples) < 5 and raw:
            raw_examples.append((t["name"], raw))
        if isinstance(raw, (list, tuple)):
            t["flags"] = [str(f) for f in raw]
        elif isinstance(raw, dict):
            t["flags"] = [str(v) for v in raw.values()]
        elif raw == "ERROR":
            t["flags"] = ["<GetFlagList failed>"]
        for f in t["flags"]:
            flag_counts[f] += 1
    t_flags = time.time() - t0
    say(f"    Timelines matched to a Media Pool item: {matched} of {len(timelines)}")
    say(f"[3] Flags read in {t_flags:.2f}s. Colours: " + (", ".join(f"{k} {v}" for k, v in flag_counts.most_common()) or "none"))
    for name, raw in raw_examples:
        say(f"    raw GetFlagList for '{name}': {raw!r} ({type(raw).__name__})")
    say()

    # Multicams
    total = sum(m["seconds"] or 0 for m in multicams)
    missing = [m for m in multicams if m["seconds"] is None]
    say(f"[4] Multicams: {len(multicams)}, total {hm(total)}" + (f" ({len(missing)} without a length)" if missing else ""))
    for m in sorted(multicams, key=lambda m: m["name"]):
        length = hm(m["seconds"]) if m["seconds"] else "?"
        say(f"    {m['name']:<40} {length:>8}  frames={m['frames']} fps={m['fps']} duration={m['duration']}  [{m['bin']}]")
    say()

    # What the rings would show from this project
    ct_own = [t for t in timelines if t["name"].endswith(CUT_THROUGH_SUFFIX)]
    excluded = [t for t in timelines if EXCLUDE_FLAG in t["flags"] and t not in ct_own]
    counted = [t for t in timelines if t not in ct_own and t not in excluded]
    reviewed = [t for t in counted if REVIEWED_FLAG in t["flags"]]
    say("Rings from this project (Uploaded is worked out in LPOS; Cut also needs cut-through's run files):")
    say(f"    Timelines {len(timelines)}: {len(ct_own)} cut-through rough cuts and {len(excluded)} {EXCLUDE_FLAG}-flagged left out, {len(counted)} counted")
    say(f"    Reviewed  {len(reviewed)} of {len(counted)} ({EXCLUDE_FLAG} excluded, {REVIEWED_FLAG} = reviewed)")
    say(f"    Cut total {hm(total)} of multicam footage")
    say()
    say("Timelines:")
    for t in timelines:
        tag = "cut-through" if t in ct_own else ("left out" if t in excluded else ("REVIEWED" if t in reviewed else ""))
        flags = ",".join(t["flags"]) or "-"
        say(f"    {t['name']:<50} flags={flags:<16} {'' if t['matched'] else 'NO MEDIA POOL ITEM '}{tag}")
    say()
    say(f"Total read time: {t_timelines + t_walk + t_flags:.2f}s")

    safe_name = "".join(c if c.isalnum() or c in " -_" else "_" for c in str(_safe(lambda: project.GetName(), "project"))).strip() or "project"
    body = "\n".join(_lines) + "\n"
    for folder in (NAS_DIR, DESKTOP):
        path = os.path.join(folder, f"project_status_{safe_name}.txt")
        try:
            os.makedirs(folder, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
            print(f"\nSaved {path}")
            return
        except Exception as err:
            print(f"\nCould not save to {folder}: {err}")


main()
