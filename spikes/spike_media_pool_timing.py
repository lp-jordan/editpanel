#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE: why reading the Media Pool took 71 s, and the fastest way to get what the
/editing project rings need (READ-ONLY).

spike_project_status.py on Elevate Pools (1,652 items) took 71 s for one walk that asked every
item for its name, unique id and Type. Timeline uids also never matched their Media Pool item.
This probe times each piece separately and tries faster routes:

  A. Folder walk only (GetSubFolderList + GetClipList), no per-item calls
  B. Cost per call, on a sample of items: GetName, GetUniqueId, GetClipProperty("Type"),
     GetClipProperty("Frames"), GetClipProperty() (everything), GetFlagList
  C. Timeline.GetMediaPoolItem() (newer Resolve): flags straight from each timeline, no walk
  D. By name: timeline names come from GetTimelineByIndex (fast); walk once asking only GetName,
     then GetFlagList only on items whose name is a timeline name
  E. Multicams: Type only on items in bins that aren't cut-through archive bins

Nothing in the project is changed. The report prints and is saved on the NAS as
N:\\LPOS\\spike reports\\media_pool_timing_<project>.txt (the Desktop if the NAS isn't reachable).

HOW TO RUN (Windows Resolve machine, a big project open, after `git pull`):
Workspace > Console > Py3, then
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_media_pool_timing.py", encoding="utf-8").read())

Takes a minute or two on a big project. Put a Green flag on a couple of timelines and a Yellow
flag on one first, so the report shows what GetFlagList returns.
"""

import os
import random
import time
from typing import Any, Callable, Dict, List, Tuple

SAMPLE = 150                                   # items per call type in part B
ARCHIVE_BINS = {"MC ORIGINAL", "MC QUARANTINE"}  # cut-through/common.py
DESKTOP = os.path.expanduser("~/Desktop")
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


def timed(fn: Callable[[], Any]) -> Tuple[Any, float]:
    t0 = time.perf_counter()
    out = fn()
    return out, time.perf_counter() - t0


def walk(root: Any) -> List[Tuple[List[str], Any]]:
    """Every (bin path, item), with no calls on the items themselves."""
    out: List[Tuple[List[str], Any]] = []
    stack = [(root, [])]
    while stack:
        folder, path = stack.pop()
        for clip in _safe(lambda: folder.GetClipList(), []) or []:
            out.append((path, clip))
        for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
            stack.append((sub, path + [_safe(lambda: sub.GetName(), "?") or "?"]))
    return out


def per_call(items: List[Any], name: str, fn: Callable[[Any], Any]) -> float:
    t0 = time.perf_counter()
    for it in items:
        _safe(lambda: fn(it))
    each = (time.perf_counter() - t0) / max(1, len(items))
    return each


def main() -> None:
    resolve = get_resolve()
    project = _safe(lambda: resolve.GetProjectManager().GetCurrentProject())
    if not project:
        say("No project open in Resolve.")
        return
    say(f"Project: {_safe(lambda: project.GetName())}")
    say(f"Resolve: {_safe(lambda: resolve.GetVersionString(), '?')}")
    say()

    # Timelines (was 0.05 s for 263)
    def read_timelines():
        out = []
        for i in range(1, int(_safe(lambda: project.GetTimelineCount(), 0) or 0) + 1):
            tl = _safe(lambda: project.GetTimelineByIndex(i))
            if tl:
                out.append(tl)
        return out
    timelines, t_tl = timed(read_timelines)
    names, t_names = timed(lambda: [str(_safe(lambda: tl.GetName(), "") or "") for tl in timelines])
    say(f"Timelines: {len(timelines)} listed in {t_tl:.2f}s, names in {t_names:.2f}s")

    # A. Walk only
    root = _safe(lambda: project.GetMediaPool().GetRootFolder())
    items, t_walk = timed(lambda: walk(root))
    say(f"[A] Folder walk, no per-item calls: {len(items)} items in {t_walk:.2f}s")
    say()

    # B. Per-call cost
    clips = [c for _, c in items]
    sample = random.sample(clips, min(SAMPLE, len(clips))) if clips else []
    say(f"[B] Cost per call ({len(sample)} random items), and what it would cost for all {len(clips)}:")
    calls = [
        ("GetName()", lambda c: c.GetName()),
        ("GetUniqueId()", lambda c: c.GetUniqueId()),
        ('GetClipProperty("Type")', lambda c: c.GetClipProperty("Type")),
        ('GetClipProperty("Frames")', lambda c: c.GetClipProperty("Frames")),
        ("GetClipProperty() all", lambda c: c.GetClipProperty()),
        ("GetFlagList()", lambda c: c.GetFlagList()),
    ]
    for label, fn in calls:
        each = per_call(sample, label, fn)
        say(f"    {label:<28} {each * 1000:7.2f} ms each  ~{each * len(clips):6.1f}s for all")
    # The second time round (does Resolve cache anything?)
    each = per_call(sample, "Type again", lambda c: c.GetClipProperty("Type"))
    say(f"    {'GetClipProperty(Type) again':<28} {each * 1000:7.2f} ms each")
    say()

    # C. Timeline.GetMediaPoolItem()
    has_mpi = bool(timelines) and callable(_safe(lambda: getattr(timelines[0], "GetMediaPoolItem"), None))
    if has_mpi:
        def via_timeline():
            got, flags = 0, []
            for tl in timelines:
                mpi = _safe(lambda: tl.GetMediaPoolItem())
                if mpi is not None:
                    got += 1
                    flags.append(_safe(lambda: mpi.GetFlagList(), None))
            return got, flags
        (got, flags_c), t_c = timed(via_timeline)
        flagged = [(n, f) for n, f in zip(names, flags_c) if f]
        say(f"[C] Timeline.GetMediaPoolItem(): {got} of {len(timelines)} items + flags in {t_c:.2f}s")
        for n, f in flagged[:8]:
            say(f"    '{n}': GetFlagList -> {f!r} ({type(f).__name__})")
        if not flagged:
            say("    no flags set on any timeline")
        mpi0 = _safe(lambda: timelines[0].GetMediaPoolItem())
        say(f"    timeline uid {_safe(lambda: timelines[0].GetUniqueId())} vs its item uid {_safe(lambda: mpi0.GetUniqueId())}")
    else:
        say("[C] Timeline.GetMediaPoolItem() is not available in this Resolve")
    say()

    # D. By name
    name_set = set(names)
    def by_name():
        hits: Dict[str, List[Any]] = {}
        for _, c in items:
            n = _safe(lambda: c.GetName())
            if n in name_set:
                hits.setdefault(n, []).append(c)
        flags = {n: [_safe(lambda: c.GetFlagList()) for c in cs] for n, cs in hits.items()}
        return hits, flags
    (hits, flags_d), t_d = timed(by_name)
    dup = sorted(n for n, cs in hits.items() if len(cs) > 1)
    missing = len(name_set - set(hits))
    say(f"[D] By name: {sum(len(v) for v in hits.values())} items for {len(hits)} of {len(name_set)} timeline names in {t_d:.2f}s")
    say(f"    names with more than one item: {len(dup)}{(' (' + ', '.join(dup[:10]) + ')') if dup else ''}; names not found: {missing}")
    flagged_d = [(n, f) for n, fl in flags_d.items() for f in fl if f]
    for n, f in flagged_d[:8]:
        say(f"    '{n}': GetFlagList -> {f!r} ({type(f).__name__})")
    say()

    # E. Multicams outside archive bins, Type only there
    def multicams():
        found = []
        for path, c in items:
            if path and path[0] in ARCHIVE_BINS:
                continue
            if _safe(lambda: c.GetName()) in name_set:
                continue                                  # a timeline, not a multicam
            if "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower():
                found.append((path, c))
        return found
    found, t_e = timed(multicams)
    asked = sum(1 for path, c in items if not (path and path[0] in ARCHIVE_BINS))
    say(f"[E] Multicams outside {sorted(ARCHIVE_BINS)}: {len(found)} in {t_e:.2f}s (Type asked of up to {asked} items)")
    for path, c in found:
        say(f"    {_safe(lambda: c.GetName(), '?'):<40} frames={_safe(lambda: c.GetClipProperty('Frames'))} fps={_safe(lambda: c.GetClipProperty('FPS'))} flags={_safe(lambda: c.GetFlagList())}  [{' / '.join(path)}]")
    say()
    say(f"Total time: {t_tl + t_names + t_walk + t_d + t_e:.1f}s (plus part B samples)")

    safe_name = "".join(c if c.isalnum() or c in " -_" else "_" for c in str(_safe(lambda: project.GetName(), "project"))).strip() or "project"
    body = "\n".join(_lines) + "\n"
    for folder in (NAS_DIR, DESKTOP):
        path = os.path.join(folder, f"media_pool_timing_{safe_name}.txt")
        try:
            os.makedirs(folder, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
            print(f"\nSaved {path}")
            return
        except Exception as err:
            print(f"\nCould not save to {folder}: {err}")


main()
