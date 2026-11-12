#!/usr/bin/env python3
"""
Cut-through Score helper: add " [snap]" to every timeline in the media pool bin "CT SNAPSHOT".

Resolve's Duplicate Timeline can keep the original's name, and Score needs the snapshots and the
reviewed rough cuts to have different names. Only timelines whose media pool item sits in that bin
are renamed (matched by unique id, never by name). Run it again safely: names that already end with
the suffix are skipped. Changes nothing else.

Resolve → Workspace → Console → Py3:
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\cut_through\\rename_snapshots.py", encoding="utf-8").read())
"""

BIN = "CT SNAPSHOT"
SUFFIX = " [snap]"


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _find_bin(folder):
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        if _safe(lambda: sub.GetName()) == BIN:
            return sub
        hit = _find_bin(sub)
        if hit:
            return hit
    return None


def main():
    project = resolve.GetProjectManager().GetCurrentProject()          # noqa: F821 — Resolve's console global
    if not project:
        print("✗ No project open")
        return
    snap = _find_bin(project.GetMediaPool().GetRootFolder())
    if not snap:
        print(f"✗ No bin named {BIN!r}")
        return
    in_bin = {}
    for clip in _safe(lambda: snap.GetClipList(), []) or []:
        if "timeline" in str(_safe(lambda: clip.GetClipProperty("Type"), "")).lower():
            in_bin[_safe(lambda: clip.GetUniqueId())] = clip
    if not in_bin:
        print(f"✗ No timelines in {BIN!r}")
        return
    renamed = skipped = failed = matched = 0
    for i in range(1, int(project.GetTimelineCount() or 0) + 1):
        tl = project.GetTimelineByIndex(i)
        mpi = _safe(lambda: tl.GetMediaPoolItem())
        uid = _safe(lambda: mpi.GetUniqueId()) if mpi else None
        if uid not in in_bin:
            continue
        matched += 1
        name = _safe(lambda: tl.GetName(), "") or ""
        if name.endswith(SUFFIX):
            skipped += 1
            continue
        new = name + SUFFIX
        ok = bool(_safe(lambda: tl.SetName(new), False))
        if not ok:                                   # older builds: rename the media pool item instead
            ok = bool(_safe(lambda: in_bin[uid].SetClipProperty("Clip Name", new), False))
        if ok and _safe(lambda: tl.GetName()) == new:
            renamed += 1
            print(f"  {name}  →  {new}")
        else:
            failed += 1
            print(f"  ✗ could not rename {name}")
    if not matched:
        print("✗ Couldn't match the bin's timelines to the project's (Timeline.GetMediaPoolItem missing?). Nothing renamed.")
        return
    print(f"✓ {renamed} renamed, {skipped} already had the suffix, {failed} failed ({len(in_bin)} timelines in {BIN!r})")


main()
