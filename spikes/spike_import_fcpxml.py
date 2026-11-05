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

import base64
import json
import os
import struct
import time
import zlib
from typing import Any, List

XML = globals().get("XML", "ConvoTest_xml.fcpxml")
LABEL = globals().get("LABEL", "ConvoTest")
BATCH = bool(globals().get("BATCH"))                   # the file holds several timelines (names come from it)
ARCHIVE = bool(globals().get("ARCHIVE") or globals().get("QUARANTINE"))  # original multicam → its own bin
ORIG_BIN = globals().get("ORIG_BIN", "MC ORIGINAL")
RAW = globals().get("RAW")
MICS = globals().get("MICS") or {}                     # role → mic angle; puts each person's clips on their track
MIC_FILES = globals().get("MIC_FILES") or {}           # mic WAV file → the angle it sits under                             # "*" or [names]: timelines on the original to move with it
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


def clip_label(item: Any) -> str:
    """The angle for multicam clips, the file name for plain clips (the mic WAVs)."""
    a = angle_of(item)
    return a if a != "?" else str(_safe(lambda: item.GetName(), "?"))


def all_folders(folder: Any) -> list:
    out = [folder]
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        out += all_folders(sub)
    return out


def png_mean(data: bytes):
    """Mean (R, G, B) of an 8-bit RGB/RGBA PNG — enough to spot the red Media Offline frame."""
    pos, w, h, ctype, idat = 8, 0, 0, 2, b""
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, _, ctype = struct.unpack(">IIBB", body[:10])
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    bpp = 4 if ctype == 6 else 3
    raw, stride, prev, tot = zlib.decompress(idat), w * bpp, bytearray(w * bpp), [0, 0, 0]
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b, c = prev[i], prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        for i in range(0, stride, bpp):
            tot[0] += line[i]; tot[1] += line[i + 1]; tot[2] += line[i + 2]
        prev = line
    return tuple(round(v / (w * h)) for v in tot)


def fix_mic_tracks(project: Any, tl: Any, want: dict) -> None:
    """Put every mic clip on its person's track (track k = k-th role's mic angle): Resolve packs
    the imported mic storylines onto A1/A2 as space allows, mixing the two people."""
    project.SetCurrentTimeline(tl)
    moved = failed = 0
    for k in range(1, int(tl.GetTrackCount("audio") or 0) + 1):
        for it in list(_safe(lambda: tl.GetItemListInTrack("audio", k), []) or []):
            dest = want.get(angle_of(it)) or want.get(_safe(lambda: it.GetName()))
            if dest and dest != k:
                if _safe(lambda: it.SetPosition({"trackIndex": dest}, False), False):
                    moved += 1
                else:
                    failed += 1
    if moved or failed:
        say(f"    mic clips moved to their person's track: {moved}" + (f" (✗ {failed} could not move)" if failed else ""))


def self_check(project: Any, tl: Any) -> bool:
    """Look inside what the import built: a frame per picture angle (red = Media Offline) and
    the loudness of each mic track (-100 LUFS = silent). True when nothing looks broken."""
    project.SetCurrentTimeline(tl)
    ok, seen = True, {}
    for it in sorted(_safe(lambda: tl.GetItemListInTrack("video", 1), []) or [], key=lambda x: x.GetStart()):
        seen.setdefault(angle_of(it), it)
    for ang, it in sorted(seen.items()):
        res = _safe(lambda: it.ExportFrame(int((it.GetEnd() - it.GetStart()) // 2),
                                          {"encodedImageFormat": "png", "maxDimension": 48}), {}) or {}
        if not res.get("success"):
            say(f"    check {ang}: frame export failed ({res.get('error')})")
            continue
        rgb = _safe(lambda: png_mean(base64.b64decode(res["data"])))
        offline = bool(rgb) and rgb[0] > 120 and rgb[1] < 60 and rgb[2] < 60
        ok &= not offline
        say(f"    check {ang}: frame mean RGB {rgb} {'✗ looks like Media Offline' if offline else '✓'}")
    modes = [m for m in (_safe(lambda: tl.GetNormalizeAudioModes(), []) or []) if "Peak" not in m]
    for k in range(1, int(tl.GetTrackCount("audio") or 0) + 1):
        its = _safe(lambda: tl.GetItemListInTrack("audio", k), []) or []
        if not its or not modes:
            continue
        its = [x for x in its if _safe(lambda: x.GetIsEnabled(), True)] or its   # an open (enabled) stretch
        lv = _safe(lambda: its[0].AnalyzeAudioLevels(modes[0]), {}) or {}
        lufs = lv.get("Integrated")
        silent = lufs is not None and lufs <= -90
        ok &= not silent
        say(f"    check A{k} ({clip_label(its[0])}): {lufs} LUFS {'✗ silent' if silent else '✓' if lufs is not None else '(not measured)'}")
    return ok


def reference_levels(project: Any, mc_id: str, skip: set, angles: set) -> dict:
    """Control for the silence check: the same loudness measurement on mic clips from an
    existing timeline cut from the ORIGINAL multicam (known to have sound)."""
    modes = None
    out = {}
    for i in range(1, int(project.GetTimelineCount()) + 1):
        tl = project.GetTimelineByIndex(i)
        if tl.GetName() in skip:
            continue
        for k in range(1, int(tl.GetTrackCount("audio") or 0) + 1):
            for it in _safe(lambda: tl.GetItemListInTrack("audio", k), []) or []:
                ang = angle_of(it)
                mpi = _safe(lambda: it.GetMediaPoolItem())
                if ang in angles and ang not in out and mpi and mpi.GetUniqueId() == mc_id:
                    project.SetCurrentTimeline(tl)
                    modes = modes or [m for m in (tl.GetNormalizeAudioModes() or []) if "Peak" not in m]
                    lv = _safe(lambda: it.AnalyzeAudioLevels(modes[0]), {}) or {}
                    out[ang] = (tl.GetName(), lv.get("Integrated"))
        if angles <= set(out):
            break
    return out


def mix_level(project: Any, mp: Any, mc: Any, frame: int, tag: str):
    """Loudness of a multicam's own audio (the ATEM mix on Camera 1) over 10 s from `frame`,
    via a throwaway timeline (deleted again)."""
    tl = mp.CreateEmptyTimeline(f"__SPIKE_mixcheck_{tag}_{int(time.time()) % 100000}")
    if not tl:
        return None
    project.SetCurrentTimeline(tl)
    its = _safe(lambda: mp.AppendToTimeline([{"mediaPoolItem": mc, "startFrame": frame,
                                               "endFrame": frame + 240, "mediaType": 2}]), []) or []
    modes = [m for m in (_safe(lambda: tl.GetNormalizeAudioModes(), []) or []) if "Peak" not in m]
    lv = (_safe(lambda: its[0].AnalyzeAudioLevels(modes[0]), {}) or {}) if its and modes else {}
    _safe(lambda: mp.DeleteTimelines([tl]))
    return lv.get("Integrated")


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
    # Search EVERY bin for the source clips: with only the multicam's bin, Resolve couldn't find
    # the camera files or mic WAVs and rebuilt the copy with angles offline (2026-11-05).
    folders = all_folders(mp.GetRootFolder())
    opts = {"importSourceClips": False, "sourceClipsFolders": folders}
    if not BATCH:
        opts["timelineName"] = f"__SPIKE_xml_{LABEL}_{int(time.time()) % 100000}"
    mp.SetCurrentFolder(orig_folder)
    t1 = time.time()
    tl = mp.ImportTimelineFromFile(path, opts)
    say(f"ImportTimelineFromFile → {'ok' if tl else 'FAILED'} in {time.time() - t1:.1f}s "
        f"(source clips searched in {len(folders)} bin(s))")
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
                a[clip_label(x)] = a.get(clip_label(x), 0) + 1
            auds.append(f"A{k} {len(its)} {a}")
        say(f"  {t.GetName()}: {len(v1)} picture clip(s) {angs}; multicam(s) used {[k[:8] for k in ids]}; " + "; ".join(auds))
        if MICS:
            want = {MICS[role]: k for k, role in enumerate(plan["mics"], 1) if role in MICS}
            want.update({f: want[a] for f, a in MIC_FILES.items() if a in want})
            fix_mic_tracks(project, t, want)
            _safe(lambda: say("    after: " + "; ".join(
                f"A{k} " + str({a: sum(1 for x in t.GetItemListInTrack('audio', k) if clip_label(x) == a)
                                for a in {clip_label(x) for x in t.GetItemListInTrack('audio', k)}})
                for k in range(1, int(t.GetTrackCount("audio") or 0) + 1))))
        good = self_check(project, t)
        globals()["CHECK_OK"] = globals().get("CHECK_OK", True) and good
    copy = next((c for _, c in after if c.GetUniqueId() not in {b.GetUniqueId() for _, b in before}), None)
    if copy and plan.get("mics"):
        frame = sorted(plan["mics"][next(iter(plan["mics"]))])[0][0] + 24   # inside the first talking stretch
        back = new[0] if new else None
        lc, lo = mix_level(project, mp, copy, frame, "copy"), mix_level(project, mp, orig, frame, "orig")
        if back:
            project.SetCurrentTimeline(back)
        bad = (lc is None or lc <= -90) and lo is not None and lo > -90
        globals()["CHECK_OK"] = globals().get("CHECK_OK", True) and not bad
        say(f"    check ATEM mix (multicam audio): copy {lc} LUFS vs original {lo} LUFS "
            f"{'✗ offline in the copy' if bad else '✓'}")
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
    if not globals().get("CHECK_OK", True) and MICS:
        ref = reference_levels(project, orig_id, {x.GetName() for x in new}, set(MICS.values()))
        for ang, (tname, lufs) in sorted(ref.items()):
            say(f"    control: {ang} audio on the ORIGINAL in '{tname}': {lufs} LUFS")
        if ref and all(l is not None and l <= -90 for _, l in ref.values()):
            say("    → the original measures silent too: the loudness check can't be trusted here, "
                "listen to the copy instead")
        elif not ref:
            say("    → no timeline on the original uses those audio angles; no control measured")
    if not globals().get("CHECK_OK", True):
        say("✗ SELF-CHECK FAILED — the copy looks broken; original left in place, nothing archived")
    if ARCHIVE and len(after) > len(before) and globals().get("CHECK_OK", True):
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
    for _k in ("XML", "LABEL", "BATCH", "QUARANTINE", "ARCHIVE", "ORIG_BIN", "RAW", "MICS", "MIC_FILES"):  # CHECK_OK stays for the caller    # the console keeps run-line settings between runs
        globals().pop(_k, None)
