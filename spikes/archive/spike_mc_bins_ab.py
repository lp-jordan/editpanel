#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Does the bin search pick up the wrong clips and knock the ATEM mix offline?

Facts so far (2026-11-05):
  * The A/B "keep" file has the SAME multicam definition and resources as the 11:30 run, whose copy
    had CAM 1 audio online. Same input, red result → something in the project changed.
  * audio_links.txt: no clip has linked audio, so the linked-audio theory is out.
  * New since then: two COMPOUND clips named "02MIC2.WAV" (bins AUDIO and SEQUENCES, garbage TC).
    The import searches EVERY bin for source clips by name, so it can see them.

This imports Desktop\\mc_ab_strip.fcpxml (written by spike_mc_audio_ab.py; what the cut-through
imports now) three times, changing ONLY which bins Resolve may take source clips from:
  all        — every bin (what the cut-through does now)
  nocompound — every bin except those holding a Compound clip
  media      — only the bins holding the actual CAM / WAV files named in the XML
Each copy is renamed "mc1 BINS <variant>" and left, with its timeline, in a new bin __SPIKE_BINS so
you can open each copy and see whether Camera 1's audio is red (the API can't measure it yet).
Nothing else in the project is touched.

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_mc_bins_ab.py", encoding="utf-8").read())
Report saved to Desktop\\mc_bins_ab.txt.

CLEAN UP afterwards (deletes the __SPIKE_BINS bin with its copies, plus every timeline named
__SPIKE_bins_*, __SPIKE_ab_*, __SPIKE_mcdef_ab, __SPIKE_mixcheck_*):
    CLEAN=True; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_mc_bins_ab.py", encoding="utf-8").read())
"""
import os
import re
from typing import Any, List
from urllib.parse import unquote

CLEAN = bool(globals().get("CLEAN"))
MC_NAME = globals().get("MC_NAME", "mc1")
DESKTOP = os.path.expanduser("~/Desktop")
XML = os.path.join(DESKTOP, "mc_ab_strip.fcpxml")
BIN = "__SPIKE_BINS"
TRASH_TL = ("__SPIKE_bins_", "__SPIKE_ab_", "__SPIKE_mcdef_ab", "__SPIKE_mixcheck_")
_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def folders(folder: Any, path: str = "") -> list:
    here = f"{path} / {folder.GetName()}" if path else folder.GetName()
    out = [(here, folder)]
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        out += folders(sub, here)
    return out


def clips(folder: Any) -> list:
    return _safe(lambda: folder.GetClipList(), []) or []


def timelines(project: Any) -> dict:
    return {project.GetTimelineByIndex(i).GetName(): project.GetTimelineByIndex(i)
            for i in range(1, int(project.GetTimelineCount()) + 1)}


def multicam_ids(all_f: list) -> set:
    return {c.GetUniqueId() for _, f in all_f for c in clips(f)
            if "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()}


def clean(project: Any, mp: Any) -> None:
    root = mp.GetRootFolder()
    tls = [t for n, t in timelines(project).items() if n.startswith(TRASH_TL)]
    keep = next((t for n, t in timelines(project).items() if not n.startswith(TRASH_TL)), None)
    if keep:
        project.SetCurrentTimeline(keep)
    say(f"Timelines to delete ({len(tls)}): {[t.GetName() for t in tls]}")
    ok_t = _safe(lambda: mp.DeleteTimelines(tls), False) if tls else True
    say(f"   {'✓ deleted' if ok_t else '✗ DeleteTimelines failed'}")
    spike_bins = [f for f in (_safe(lambda: root.GetSubFolderList(), []) or []) if f.GetName() == BIN]
    for f in spike_bins:
        names = [c.GetName() for c in clips(f)]
        say(f"Bin {BIN} holds: {names}")
        if clips(f):
            say(f"   clips {'✓ deleted' if _safe(lambda: mp.DeleteClips(clips(f)), False) else '✗ DeleteClips failed'}")
        say(f"   bin {'✓ deleted' if _safe(lambda: mp.DeleteFolders([f]), False) else '✗ DeleteFolders failed'}")
    if not spike_bins:
        say(f"No {BIN} bin.")
    left = [(p, c.GetName(), c.GetUniqueId()[:8]) for p, f in folders(root) for c in clips(f)
            if c.GetName() == MC_NAME]
    say(f"\n{MC_NAME} multicams left in the project ({len(left)}): {left}")
    say("(The extra mc1 copies from the earlier A/B are named mc1 too — delete those by hand; keep the "
        "original, unique ID starting 3f444b91.)")


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — "
        f"{'clean up' if CLEAN else 'bin-search A/B'}")
    if CLEAN:
        return clean(project, mp)
    if not os.path.isfile(XML):
        raise RuntimeError(f"{XML} not found — run spike_mc_audio_ab.py once to write it.")

    xml = open(XML, encoding="utf-8").read()
    srcs = {os.path.normcase(unquote(s).replace("file://localhost/", "").replace("/", "\\"))
            for s in re.findall(r'src="([^"]+)"', xml)}
    all_f = folders(mp.GetRootFolder())
    all_f = [(p, f) for p, f in all_f if f.GetName() != BIN]

    compound_bins, media_bins = set(), set()
    for p, f in all_f:
        for c in clips(f):
            typ = str(_safe(lambda: c.GetClipProperty("Type"), ""))
            fp = os.path.normcase(str(_safe(lambda: c.GetClipProperty("File Path"), "") or ""))
            if typ.lower() == "compound":
                compound_bins.add(p)
                say(f"Compound clip '{c.GetName()}' [{c.GetUniqueId()[:8]}] in '{p}'")
            if fp and fp in srcs:
                media_bins.add(p)
    say(f"Bins: {len(all_f)} total; with a Compound clip: {sorted(compound_bins)}; "
        f"holding the XML's media files: {sorted(media_bins)}")

    variants = {
        "all": [f for _, f in all_f],
        "nocompound": [f for p, f in all_f if p not in compound_bins],
        "media": [f for p, f in all_f if p in media_bins],
    }
    root = mp.GetRootFolder()
    spike_bin = next((f for f in (_safe(lambda: root.GetSubFolderList(), []) or []) if f.GetName() == BIN), None) \
        or mp.AddSubFolder(root, BIN)
    for v, search in variants.items():
        tname = f"__SPIKE_bins_{v}"
        old = timelines(project).get(tname)
        if old:
            mp.DeleteTimelines([old])
        before = multicam_ids(folders(mp.GetRootFolder()))
        mp.SetCurrentFolder(spike_bin)
        tl = mp.ImportTimelineFromFile(XML, {"timelineName": tname, "importSourceClips": False,
                                             "sourceClipsFolders": search})
        new = [c for _, f in folders(mp.GetRootFolder()) for c in clips(f)
               if "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()
               and c.GetUniqueId() not in before]
        for c in new:
            _safe(lambda: c.SetName(f"{MC_NAME} BINS {v}"))
            if _safe(lambda: c.GetParentFolder().GetName()) != BIN:
                _safe(lambda: mp.MoveClips([c], spike_bin))
        say(f"{v}: searched {len(search)} bin(s) → import {'ok' if tl else 'FAILED'}, "
            f"{len(new)} new multicam(s) → named '{MC_NAME} BINS {v}' in {BIN}")
    say(f"\nNow open each '{MC_NAME} BINS …' copy in {BIN} (Open in Timeline) and note whether Camera 1's "
        "audio is red. Then clean up with CLEAN=True.")


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(os.path.join(DESKTOP, "mc_bins_ab.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("CLEAN", "MC_NAME"):
        globals().pop(_k, None)
