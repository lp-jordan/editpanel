#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Which way of describing Camera 1 keeps its audio (the ATEM mix) online in the copy?
Also: does writing the angles in camera order fix the copy's track stack?

Every import rebuilds the multicam from our FCPXML. Camera 1 is the only angle whose clip
carries audio, written the way Resolve exports it: an <asset-clip> with audioStart/audioDuration.
Its picture comes in fine; its audio comes in red (Robin Bone and Frenzy, 2026-11-05). The copy's
angle stack follows the file's angle order (Frenzy exported Camera 3, 2, 4, 1).

This makes one tiny 10 s import per variant from a fresh export of the ORIGINAL multicam, using
only the bins that hold the exact source files:
  control    — as exported (current pipeline)
  sorted     — angles in camera order (1, 2, 3, 4), Camera 1 unchanged
  clip_av    — sorted + Camera 1 written like the other angles: <clip> with <video> and
               <audio> children
  no_split   — sorted + Camera 1 <asset-clip> without audioStart / audioDuration
  hdr_1_10   — sorted + file headed FCPXML 1.10 (as exported) instead of 1.14
Each copy is renamed "<mc> C1 <variant>" and left in bin __SPIKE_CAM1 with its timeline
__SPIKE_c1_<variant>. Open each copy and note: Camera 1 audio red or green? Angle stack order?
Nothing else in the project changes.

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    LABEL="Convo2"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_cam1_variants.py", encoding="utf-8").read())
Uses the multicam named in plans/<LABEL>_plan.json; prefers the one in "MC ORIGINAL" (the original).
Report: Desktop\\cam1_variants.txt.
CLEAN UP afterwards (deletes bin __SPIKE_CAM1 with everything in it + the __SPIKE_c1_* timelines):
    LABEL="Convo2"; CLEAN=True; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_cam1_variants.py", encoding="utf-8").read())
"""
import importlib.util
import json
import os
import re
import shutil
from typing import Any, List

LABEL = globals().get("LABEL", "Convo2")
CLEAN = bool(globals().get("CLEAN"))
REPO = r"C:\lp-app-ecosystem\editpanel"
SPIKES = os.path.join(REPO, "spikes")
DESKTOP = os.path.expanduser("~/Desktop")
BIN = "__SPIKE_CAM1"
LENGTH = 240
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


def clips(f: Any) -> list:
    return _safe(lambda: f.GetClipList(), []) or []


def timelines(project: Any) -> dict:
    return {project.GetTimelineByIndex(i).GetName(): project.GetTimelineByIndex(i)
            for i in range(1, int(project.GetTimelineCount()) + 1)}


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SPIKES, f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cam_no(angle_block: str) -> int:
    m = re.search(r'<mc-angle [^>]*name="[^"]*?(\d+)"', angle_block)
    return int(m.group(1)) if m else 999


def sort_angles(xml: str) -> str:
    m = re.search(r"(<multicam [^>]*>)(.*?)(\s*</multicam>)", xml, re.S)
    blocks = re.findall(r"\s*<mc-angle .*?</mc-angle>", m.group(2), re.S)
    return xml.replace(m.group(0), m.group(1) + "".join(sorted(blocks, key=cam_no)) + m.group(3))


def cam1_block(xml: str):
    for b in re.findall(r"<mc-angle [^>]*>.*?</mc-angle>", xml, re.S):
        if cam_no(b) == 1:
            return b
    raise RuntimeError("no Camera 1 angle")


def cam1_clip_av(xml: str) -> str:
    b = cam1_block(xml)
    m = re.search(r"<asset-clip ([^>]*)>(.*?)</asset-clip>", b, re.S)
    if not m:
        raise RuntimeError("Camera 1 isn't an asset-clip")
    a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
    keep = " ".join(f'{k}="{a[k]}"' for k in ("name", "start", "duration", "enabled", "tcFormat", "offset", "format")
                    if k in a)
    av = (f'<video start="{a["start"]}" duration="{a["duration"]}" ref="{a["ref"]}" offset="{a["start"]}">'
          f'<audio lane="-1" start="{a["start"]}" duration="{a["duration"]}" ref="{a["ref"]}" offset="{a["start"]}" '
          f'srcCh="1, 2" role="dialogue"/></video>')
    return xml.replace(b, b.replace(m.group(0), f"<clip {keep}>{m.group(2)}{av}</clip>"))


def cam1_no_split(xml: str) -> str:
    b = cam1_block(xml)
    nb = re.sub(r'\s(audioStart|audioDuration)="[^"]*"', "", b)
    return xml.replace(b, nb)


def clean(project: Any, mp: Any) -> None:
    tls = [t for n, t in timelines(project).items() if n.startswith("__SPIKE_c1_")]
    keep = next((t for n, t in timelines(project).items() if not n.startswith("__SPIKE_")), None)
    if keep:
        project.SetCurrentTimeline(keep)
    say(f"Timelines deleted ({len(tls)}): {bool(_safe(lambda: mp.DeleteTimelines(tls), False)) if tls else True}")
    root = mp.GetRootFolder()
    for f in [f for f in (_safe(lambda: root.GetSubFolderList(), []) or []) if f.GetName() == BIN]:
        say(f"Bin {BIN}: {[c.GetName() for c in clips(f)]}")
        if clips(f):
            say(f"   clips deleted: {bool(_safe(lambda: mp.DeleteClips(clips(f)), False))}")
        say(f"   bin deleted: {bool(_safe(lambda: mp.DeleteFolders([f]), False))}")


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — Camera 1 variants")
    if CLEAN:
        return clean(project, mp)
    plan = json.load(open(os.path.join(SPIKES, "plans", f"{LABEL}_plan.json"), encoding="utf-8"))
    name = plan["multicam"]
    cands = [(p, c) for p, f in folders(mp.GetRootFolder()) for c in clips(f)
             if _safe(lambda: c.GetName()) == name and "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()
             and BIN not in p]
    if not cands:
        raise RuntimeError(f"No multicam named {name!r}")
    where, orig = next(((p, c) for p, c in cands if "MC ORIGINAL" in p), cands[0])
    say(f"Source multicam: {name} [{orig.GetUniqueId()[:8]}] in '{where}'"
        + ("" if "MC ORIGINAL" in where else " (no copy in MC ORIGINAL — using this one)"))

    stale = timelines(project).get("__SPIKE_c1_mcdef")
    if stale:
        mp.DeleteTimelines([stale])
    tmp = mp.CreateTimelineFromClips("__SPIKE_c1_mcdef", [orig]) \
        or mp.CreateTimelineFromClips("__SPIKE_c1_mcdef", [{"mediaPoolItem": orig}])
    if not tmp:
        raise RuntimeError("couldn't make the throwaway timeline from the multicam")
    project.SetCurrentTimeline(tmp)
    mcdef = os.path.join(DESKTOP, "mcdef_cam1.fcpxml")
    for p in (mcdef, mcdef + "d"):
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.isfile(p):
            os.remove(p)
    tried = []
    for v in ("1_10", "1_9", "1_8"):
        etype = _safe(lambda: getattr(r, f"EXPORT_FCPXML_{v}"))
        if etype is None:
            continue
        ok = _safe(lambda: tmp.Export(mcdef, etype), False) or \
            _safe(lambda: tmp.Export(mcdef, etype, r.EXPORT_NONE), False)
        tried.append(f"{v}: {ok}")
        if ok:
            break
    other = next((t for n, t in timelines(project).items() if not n.startswith("__SPIKE_")), None)
    if other:
        project.SetCurrentTimeline(other)
    _safe(lambda: mp.DeleteTimelines([tmp]))
    inner = next((p for p in (os.path.join(mcdef + "d", "Info.fcpxml"), mcdef) if os.path.isfile(p)), None)
    if not inner and os.path.isdir(mcdef + "d"):
        inner = next((os.path.join(mcdef + "d", f) for f in os.listdir(mcdef + "d") if f.lower().endswith(".fcpxml")), None)
    say(f"Export: {', '.join(tried) or 'no FCPXML export type offered'} → {inner or 'no file written'}")
    if not inner:
        raise RuntimeError("export failed")

    mk = load("make_fcpxml")
    frame = min(v["in"] for v in plan["video"]) + 240
    mini = {"label": "cam1", "multicam": name, "video": [{"in": frame, "out": frame + LENGTH, "angle": "Camera 1"}],
            "mics": {}}
    mini_path = os.path.join(DESKTOP, "cam1_plan.json")
    json.dump(mini, open(mini_path, "w", encoding="utf-8"))
    base = os.path.join(DESKTOP, "cam1_control.fcpxml")
    mk.main([inner, base, "atem=off", f"{mini_path}:__SPIKE_c1_control"])   # copy keeps Camera 1 audio (the thing under test)
    xml0 = open(base, encoding="utf-8").read()
    angle_order = [a for a in re.findall(r'<mc-angle [^>]*name="([^"]+)"', xml0)]
    say(f"Exported angle order: {angle_order}")

    srcs = imp_sources(inner)
    search = [f for p, f in folders(mp.GetRootFolder())
              if any(_norm(_safe(lambda: c.GetClipProperty('File Path'), '')) in srcs for c in clips(f))]
    say(f"Source bins searched: {len(search)}")

    variants = {
        "control": xml0,
        "sorted": sort_angles(xml0),
        "clip_av": cam1_clip_av(sort_angles(xml0)),
        "no_split": cam1_no_split(sort_angles(xml0)),
        "hdr_1_10": sort_angles(xml0).replace('<fcpxml version="1.14">', '<fcpxml version="1.10">'),
    }
    root = mp.GetRootFolder()
    spike_bin = next((f for f in (_safe(lambda: root.GetSubFolderList(), []) or []) if f.GetName() == BIN), None) \
        or mp.AddSubFolder(root, BIN)
    for v, text in variants.items():
        tname = f"__SPIKE_c1_{v}"
        text = text.replace("__SPIKE_c1_control", tname)
        path = os.path.join(DESKTOP, f"cam1_{v}.fcpxml")
        open(path, "w", encoding="utf-8").write(text)
        old = timelines(project).get(tname)
        if old:
            mp.DeleteTimelines([old])
        before = {c.GetUniqueId() for _, f in folders(mp.GetRootFolder()) for c in clips(f)}
        mp.SetCurrentFolder(spike_bin)
        tl = mp.ImportTimelineFromFile(path, {"timelineName": tname, "importSourceClips": False,
                                              "sourceClipsFolders": search})
        new = [c for _, f in folders(mp.GetRootFolder()) for c in clips(f)
               if c.GetUniqueId() not in before and "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()]
        for c in new:
            _safe(lambda: c.SetName(f"{name} C1 {v}"))
            if _safe(lambda: c.GetParentFolder().GetName()) != BIN:
                _safe(lambda: mp.MoveClips([c], spike_bin))
        order = re.findall(r'<mc-angle [^>]*name="([^"]+)"', text)
        say(f"{v}: import {'ok' if tl else 'FAILED'}; {len(new)} copy → '{name} C1 {v}'; angles written {order}")
    say(f"\nOpen each '{name} C1 …' copy in {BIN}: is Camera 1's audio red or green, and what's the stack order?"
        " Then clean up with CLEAN=True.")


def _norm(p: str) -> str:
    return str(p or "").replace("/", "\\").lower()


def imp_sources(path: str) -> set:
    from urllib.parse import unquote
    txt = open(path, encoding="utf-8").read()
    return {_norm(unquote(s).replace("file://localhost/", "")) for s in re.findall(r'src="([^"]+)"', txt)}


try:
    main()
except (Exception, SystemExit) as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(os.path.join(DESKTOP, "cam1_variants.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("LABEL", "CLEAN"):
        globals().pop(_k, None)
