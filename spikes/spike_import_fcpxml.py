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

A file whose timeline names come from the file (make_fcpxml.py split/joined): add BATCH=True.
Every import makes a new copy of the multicam (tested 2026-11-04), so a batch is imported as
one joined timeline and cut up with spike_split_batch.py.
ARCHIVE=True (once a copy exists): the original multicam moves to its own root bin
ORIG_BIN (default "MC ORIGINAL") and stays the source of the raw/prep timelines; the imported
copy stays in the multicam's bin as the primary. Timelines that use the original are listed;
RAW="*" (or a list of names) moves those timelines into ORIG_BIN too.

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
BATCH = bool(globals().get("BATCH"))                   # the file holds several timelines (names come from it)
ARCHIVE = bool(globals().get("ARCHIVE") or globals().get("QUARANTINE"))  # original multicam → its own bin
ORIG_BIN = globals().get("ORIG_BIN", "MC ORIGINAL")
RAW = globals().get("RAW")                             # "*" or [names]: timelines on the original to move with it
SKIP_BINS = {ORIG_BIN, "MC QUARANTINE"}                # the original is out of play in these
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


def walk(folder: Any, skip=SKIP_BINS):
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield folder, clip
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        if _safe(lambda: sub.GetName()) not in skip:
            yield from walk(sub, skip)


def uses(tl: Any) -> set:
    """Unique IDs of the media pool items a timeline's clips come from."""
    ids = set()
    for kind in ("video", "audio"):
        for k in range(1, int(tl.GetTrackCount(kind) or 0) + 1):
            for it in _safe(lambda: tl.GetItemListInTrack(kind, k), []) or []:
                mpi = _safe(lambda: it.GetMediaPoolItem())
                if mpi:
                    ids.add(mpi.GetUniqueId())
    return ids


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
    names_before = {project.GetTimelineByIndex(i).GetName() for i in range(1, int(project.GetTimelineCount()) + 1)}
    opts = {"importSourceClips": False, "sourceClipsFolders": [orig_folder]}
    if not BATCH:
        opts["timelineName"] = f"__SPIKE_xml_{LABEL}_{int(time.time()) % 100000}"
    mp.SetCurrentFolder(orig_folder)
    t1 = time.time()
    tl = mp.ImportTimelineFromFile(path, opts)
    say(f"ImportTimelineFromFile → {'ok' if tl else 'FAILED'} in {time.time() - t1:.1f}s")
    new = [project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount()) + 1)
           if project.GetTimelineByIndex(i).GetName() not in names_before]
    say(f"New timeline(s): {len(new)} — {[x.GetName() for x in new]}")
    after = multicams(mp, name)
    say(f"After: {len(after)} multicam(s) named {name!r} (+{len(after) - len(before)} copies for {len(new)} timeline(s))")
    copies = {}
    for t in new:
        v1 = sorted(_safe(lambda: t.GetItemListInTrack("video", 1), []) or [], key=lambda x: x.GetStart())
        ids = {}
        for it in v1:
            mpi = _safe(lambda: it.GetMediaPoolItem())
            k = mpi.GetUniqueId() if mpi else "none"
            ids[k] = ids.get(k, 0) + 1
            copies[k] = copies.get(k, 0) + 1
        angs = {}
        for it in v1:
            angs[angle_of(it)] = angs.get(angle_of(it), 0) + 1
        auds = []
        for k in range(1, int(t.GetTrackCount("audio") or 0) + 1):
            its = _safe(lambda: t.GetItemListInTrack("audio", k), []) or []
            a = {}
            for x in its:
                a[angle_of(x)] = a.get(angle_of(x), 0) + 1
            auds.append(f"A{k} {len(its)} {a}")
        say(f"  {t.GetName()}: {len(v1)} picture clip(s) {angs}; multicam(s) used {[k[:8] for k in ids]}; " + "; ".join(auds))
    say(f"Multicam copies used across the new timeline(s): {len(copies)}" +
        ("  ✓ one copy for the whole batch" if len(copies) == 1 else ""))
    if len(after) == len(before) and set(copies) <= {orig_id}:
        say(f"✓ REUSED the existing {name} [{orig_id[:8]}] — no new copy")
    elif len(after) > len(before):
        say(f"✗ made another copy (existing {name} [{orig_id[:8]}] was not reused)")
    if len(new) == 1 and not BATCH:
        v1 = sorted(_safe(lambda: new[0].GetItemListInTrack("video", 1), []) or [], key=lambda x: x.GetStart())
        hits = sum(1 for p, it in zip(plan["video"], v1) if angle_of(it) == p["angle"])
        say(f"Picture angles matching the plan: {hits}/{len(plan['video'])}")
    if ARCHIVE and len(after) > len(before):
        root = mp.GetRootFolder()
        dest = next((f for f in (root.GetSubFolderList() or []) if f.GetName() == ORIG_BIN), None) \
            or mp.AddSubFolder(root, ORIG_BIN)
        new_names = {x.GetName() for x in new}
        raw = [project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount()) + 1)]
        raw = [x for x in raw if x.GetName() not in new_names and orig_id in uses(x)]
        say(f"Timelines on the original {name} [{orig_id[:8]}]: {len(raw)} — {[x.GetName() for x in raw]}")
        pick = {x.GetName() for x in raw} if RAW == "*" else set(RAW or [])
        tl_items = [c for _, c in walk(root, set())
                    if "timeline" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()
                    and _safe(lambda: c.GetName()) in pick]
        _safe(lambda: mp.MoveClips([orig] + tl_items, dest), False)
        where = {c.GetUniqueId(): _safe(lambda: f.GetName()) for f, c in walk(root, set())}
        say(f"Original {name} [{orig_id[:8]}] now in bin '{where.get(orig_id)}' "
            f"{'✓' if where.get(orig_id) == ORIG_BIN else '✗ (move did not stick)'}; "
            f"copy stays in '{_safe(lambda: orig_folder.GetName())}' as the primary")
        if pick:
            moved = sum(1 for c in tl_items if where.get(c.GetUniqueId()) == ORIG_BIN)
            say(f"Raw timelines moved with it: {moved}/{len(pick)}"
                + ("" if len(tl_items) == len(pick) else f" (only {len(tl_items)} found in the media pool)"))
    say(f"\nOpen the new timeline(s) and check angles + mics. Grade is shared with the original (checked before).")


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
    for _k in ("XML", "LABEL", "BATCH", "QUARANTINE", "ARCHIVE", "ORIG_BIN", "RAW"):    # the console keeps run-line settings between runs
        globals().pop(_k, None)
