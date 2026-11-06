#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Why does the imported multicam copy lose the ATEM mix (Camera 1's audio, track 1)?

It was online in copies whose angles kept the mic WAVs, and went red once the WAVs were taken
out of the copy's angles (2026-11-05). This imports two tiny copies of the multicam from a fresh
export, one per variant, and measures the ATEM mix through each:
  keep  — angles exactly as Resolve exported them (mic WAVs left in)
  strip — mic WAVs taken out (what the cut-through does now)
plus the original multicam as a control, and lists the clip properties that differ between the
original and each copy. Everything it creates is deleted again (KEEP=True leaves the copies).

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    LABEL="ConvoTest"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_mc_audio_ab.py", encoding="utf-8").read())
Report saved to Desktop\\mc_audio_ab.txt.
"""
import importlib.util
import json
import os
import shutil
import time
from typing import Any, List

LABEL = globals().get("LABEL", "ConvoTest")
KEEP = bool(globals().get("KEEP"))
SPIKES = r"C:\lp-app-ecosystem\editpanel\spikes"
DESKTOP = os.path.expanduser("~/Desktop")
ARCHIVE_BINS = {"MC ORIGINAL", "MC QUARANTINE"}
LENGTH = 240                                           # 10 s of talking
_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def walk(folder: Any, skip=ARCHIVE_BINS):
    for c in _safe(lambda: folder.GetClipList(), []) or []:
        yield folder, c
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        if _safe(lambda: sub.GetName()) not in skip:
            yield from walk(sub, skip)


def all_folders(folder: Any) -> list:
    out = [folder]
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        out += all_folders(sub)
    return out


def multicams(mp: Any, name: str, skip=frozenset()) -> list:
    return [c for _, c in walk(mp.GetRootFolder(), skip)
            if _safe(lambda: c.GetName()) == name
            and "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()]


def bundle_xml(path: str):
    for p in (path, path + "d"):
        if os.path.isfile(p):
            return p
        if os.path.isdir(p):
            inner = [os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(".fcpxml")]
            if inner:
                return inner[0]
    return None


def timelines(project: Any) -> dict:
    return {project.GetTimelineByIndex(i).GetName(): project.GetTimelineByIndex(i)
            for i in range(1, int(project.GetTimelineCount()) + 1)}


def mix_level(project: Any, mp: Any, mc: Any, frame: int, tag: str):
    """Loudness of the multicam's own audio (the ATEM mix) over LENGTH frames from `frame`."""
    name = f"__SPIKE_mixcheck_{tag}"
    old = timelines(project).get(name)
    if old:
        mp.DeleteTimelines([old])
    tl = mp.CreateEmptyTimeline(name)
    project.SetCurrentTimeline(tl)
    its = _safe(lambda: mp.AppendToTimeline([{"mediaPoolItem": mc, "startFrame": frame,
                                               "endFrame": frame + LENGTH, "mediaType": 2}]), []) or []
    lufs, raw = None, None
    if its:
        modes = [m for m in (tl.GetNormalizeAudioModes() or []) if "Peak" not in m]
        for _ in range(3):                                 # fresh items sometimes need a moment
            raw = _safe(lambda: its[0].AnalyzeAudioLevels(modes[0]))
            lufs = (raw or {}).get("Integrated") if isinstance(raw, dict) else None
            if lufs is not None:
                break
            time.sleep(2)
        if lufs is None:
            say(f"   (measure {tag}: AnalyzeAudioLevels returned {raw!r}; item type "
                f"{_safe(lambda: its[0].GetType())}, modes {modes[:2]})")
    return tl, lufs, len(its)


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    plan = json.load(open(os.path.join(REPO, "cut_through", "plans", f"{LABEL}_plan.json"), encoding="utf-8"))
    name = plan["multicam"]
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — ATEM mix A/B")
    live = multicams(mp, name, ARCHIVE_BINS)
    if len(live) != 1:
        raise RuntimeError(f"Expected one {name!r} outside the archive bins, found {len(live)} — "
                           "put the original back in MC and delete other copies first")
    orig = live[0]
    say(f"Multicam under test: {name} [{orig.GetUniqueId()[:8]}] in "
        f"'{_safe(lambda: orig.GetParentFolder().GetName(), '?')}'")
    frame = sorted(plan["mics"][next(iter(plan["mics"]))])[0][0] + 24   # inside the first talking stretch
    trash_tl, trash_mc = [], []

    tl, lufs, n = mix_level(project, mp, orig, frame, "orig")
    trash_tl.append(tl)
    say(f"Control — ATEM mix through the ORIGINAL: {lufs} LUFS ({n} audio item(s))")

    # fresh export of the multicam's description
    tmp = mp.CreateTimelineFromClips(f"__SPIKE_mcdef_ab", [{"mediaPoolItem": orig}]) \
        or mp.CreateTimelineFromClips(f"__SPIKE_mcdef_ab", [orig])
    mcdef = os.path.join(DESKTOP, "mcdef_ab.fcpxml")
    for p in (mcdef, mcdef + "d"):
        shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else (os.path.exists(p) and os.remove(p))
    tmp.Export(mcdef, r.EXPORT_FCPXML_1_10)
    trash_tl.append(tmp)
    src = bundle_xml(mcdef)
    if not src:
        raise RuntimeError("export failed")

    spec = importlib.util.spec_from_file_location("make_fcpxml", os.path.join(REPO, "cut_through", "write_timeline_xml.py"))
    mk = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mk)
    mini = {**plan, "video": [{"in": frame, "out": frame + LENGTH, "angle": "Camera 1"}], "mics": {}}
    mini_path = os.path.join(DESKTOP, "mc_ab_plan.json")
    json.dump(mini, open(mini_path, "w", encoding="utf-8"))
    base_props = _safe(lambda: orig.GetClipProperty(), {}) or {}

    for variant in ("keep", "strip"):
        t1 = time.time()
        out = os.path.join(DESKTOP, f"mc_ab_{variant}.fcpxml")
        mk.main([src, out, f"angle_tracks={variant}", f"{mini_path}:__SPIKE_ab_{variant}"])
        before = {c.GetUniqueId() for c in multicams(mp, name)}
        old = timelines(project).get(f"__SPIKE_ab_{variant}")
        if old:
            mp.DeleteTimelines([old])
        mp.SetCurrentFolder(_safe(lambda: orig.GetParentFolder()) or mp.GetRootFolder())
        tlv = mp.ImportTimelineFromFile(out, {"timelineName": f"__SPIKE_ab_{variant}", "importSourceClips": False,
                                              "sourceClipsFolders": all_folders(mp.GetRootFolder())})
        copy = next((c for c in multicams(mp, name) if c.GetUniqueId() not in before), None)
        if not tlv or not copy:
            say(f"{variant}: ✗ import {'failed' if not tlv else 'made no copy'}")
            continue
        trash_tl.append(tlv)
        mtl, lufs, n = mix_level(project, mp, copy, frame, variant)
        trash_tl.append(mtl)
        props = _safe(lambda: copy.GetClipProperty(), {}) or {}
        diff = {k: (base_props.get(k), props.get(k)) for k in sorted(set(base_props) | set(props))
                if base_props.get(k) != props.get(k) and k not in ("Clip Name", "Date Added", "Date Modified")}
        verdict = "✗ silent/offline" if lufs is None or lufs <= -90 else "✓ online"
        say(f"{variant}: ATEM mix through the copy: {lufs} LUFS {verdict} ({n} audio item(s), {time.time() - t1:.1f}s)")
        say(f"   properties that differ from the original: {diff or 'none'}")
        if not KEEP:
            trash_mc.append(copy)
        else:
            _safe(lambda: copy.SetName(f"{name} AB {variant}"))

    # clean up everything this test made
    other = next((t for n_, t in timelines(project).items() if not n_.startswith("__SPIKE_")), None)
    if other:
        project.SetCurrentTimeline(other)
    tls, clips = trash_tl, trash_mc
    gone_t = _safe(lambda: mp.DeleteTimelines(tls), False)
    gone_c = _safe(lambda: mp.DeleteClips(clips), False) if clips else True
    say(f"\nCleaned up: {len(tls)} test timeline(s) {'✓' if gone_t else '✗'}, "
        f"{len(clips)} test copy(ies) {'✓' if gone_c else '✗'}" + (" (copies kept: KEEP=True)" if KEEP else ""))


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(os.path.join(DESKTOP, "mc_audio_ab.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("LABEL", "KEEP"):
        globals().pop(_k, None)
