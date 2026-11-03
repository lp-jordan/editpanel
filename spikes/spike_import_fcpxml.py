#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Import a generated FCPXML so its clips use the EXISTING day multicam.

The menu import (File → Import → Timeline) made a second "mc1" in the media pool, which
breaks the one-multicam-per-day rule (grade lives on one multicam). This imports through
the scripting API with importSourceClips=False and points it at the bin that already holds
the multicam (sourceClipsFolders), then checks:
  - how many multicams with that name exist before/after (a new one = failed),
  - whether the new timeline's clips point at the ORIGINAL multicam (unique ID),
  - picture angles vs the plan, and each audio track's angle.

HOW TO RUN (Windows Resolve machine, project open, FCPXML on the Desktop, after `git pull`):
    XML="ConvoTest_xml.fcpxml"; LABEL="ConvoTest"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_import_fcpxml.py", encoding="utf-8").read())
Report saved to Desktop\\import_<LABEL>.txt.
"""

import json
import os
import time
from typing import Any, List

XML = globals().get("XML", "ConvoTest_xml.fcpxml")
LABEL = globals().get("LABEL", "ConvoTest")
REPO = r"C:\lp-app-ecosystem\editpanel"
DESKTOP = os.path.expanduser("~/Desktop")
_lines: List[str] = []
_T0 = time.time()


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def walk(folder: Any):
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield folder, clip
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        yield from walk(sub)


def multicams(mp: Any, name: str):
    return [(f, c) for f, c in walk(mp.GetRootFolder())
            if _safe(lambda: c.GetName()) == name
            and "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()]


def angle_of(item: Any) -> str:
    n = str(_safe(lambda: item.GetName(), ""))
    return n.rsplit(" - ", 1)[-1] if " - " in n else "?"


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    plan = json.load(open(os.path.join(REPO, "spikes", "plans", f"{LABEL}_plan.json"), encoding="utf-8"))
    name = plan["multicam"]
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — import {XML}")

    before = multicams(mp, name)
    if not before:
        raise RuntimeError(f"No multicam named {name!r} in the media pool.")
    orig_folder, orig = before[0]
    orig_id = orig.GetUniqueId()
    say(f"Before: {len(before)} multicam(s) named {name!r}: "
        + ", ".join(f"{_safe(lambda: f.GetName())} [{c.GetUniqueId()[:8]}]" for f, c in before))

    path = os.path.join(DESKTOP, XML)
    if not os.path.exists(path):
        raise RuntimeError(f"{path} not found.")
    tl_name = f"__SPIKE_xml_{LABEL}_{int(time.time()) % 100000}"
    opts = {"timelineName": tl_name, "importSourceClips": False, "sourceClipsFolders": [orig_folder]}
    mp.SetCurrentFolder(orig_folder)
    tl = mp.ImportTimelineFromFile(path, opts)
    say(f"ImportTimelineFromFile(importSourceClips=False, sourceClipsFolders=[{_safe(lambda: orig_folder.GetName())}]) "
        f"→ {'timeline ' + tl.GetName() if tl else 'FAILED'}")
    after = multicams(mp, name)
    say(f"After: {len(after)} multicam(s) named {name!r}" +
        ("  ✓ no duplicate" if len(after) == len(before) else "  ✗ a new multicam was created"))
    if not tl:
        return

    v1 = sorted(_safe(lambda: tl.GetItemListInTrack("video", 1), []) or [], key=lambda x: x.GetStart())
    ids = {}
    for it in v1:
        mpi = _safe(lambda: it.GetMediaPoolItem())
        k = mpi.GetUniqueId() if mpi else "none"
        ids[k] = ids.get(k, 0) + 1
    on_orig = ids.get(orig_id, 0)
    say(f"Picture: {len(v1)} clip(s) (plan {len(plan['video'])}); pointing at the ORIGINAL {name}: "
        f"{on_orig}/{len(v1)}" + ("" if on_orig == len(v1) else f"  (others: { {k[:8]: n for k, n in ids.items() if k != orig_id} })"))
    hits = sum(1 for p, it in zip(plan["video"], v1) if angle_of(it) == p["angle"])
    say(f"Picture angles matching the plan: {hits}/{len(plan['video'])}")
    for k in range(1, int(tl.GetTrackCount("audio") or 0) + 1):
        its = _safe(lambda: tl.GetItemListInTrack("audio", k), []) or []
        angs = {}
        for x in its:
            angs[angle_of(x)] = angs.get(angle_of(x), 0) + 1
        say(f"A{k}: {len(its)} clip(s), angles {angs}")
    say(f"\nOpen {tl_name}. Then grade one clip on it and check an older {name} timeline: does the grade follow?")


try:
    main()
    say(f"\nTotal time: {time.time() - _T0:.1f}s")
except Exception as exc:
    say(f"\n✗ STOPPED after {time.time() - _T0:.1f}s: {exc}")
finally:
    try:
        with open(os.path.join(DESKTOP, f"import_{LABEL}.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
