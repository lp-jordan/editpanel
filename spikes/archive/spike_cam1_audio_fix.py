#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Put Camera 1's audio (the ATEM mix) back into the multicam copy, online.

Found 2026-11-05 (Frenzy, mc_2): every way of writing Camera 1's audio as part of the camera
clip comes in red (5 variants), while Jordan's hand-placed track plays: the same file's audio as
its OWN audio-only clip (Resolve exports it as a separate audio-only <asset> and a second run
<clip><audio/></clip> under the angle). Resolve's audio start for the file equals the picture's
(checked: 39518.187 s both); his clip sat 5 frames late only because he lined it up with Camera 3.

This reads Resolve's audio-only description of the Camera 1 file (throwaway timeline with the
clip's audio only → FCPXML export → the audio asset), then imports one 10 s copy:
  audio_run  — Camera 1 picture-only + the audio as its own audio-only clip under the Camera 1
               angle, at the picture's position (+ any audio offset Resolve reports)
Angles are written in camera order. Copy "<mc> C1 audio_run" in bin __SPIKE_CAM1, timeline
__SPIKE_c1_audio_run. Open the copy: is Camera 1's audio green, on track 1, and in sync?

With AUDIO_FILE="tcA" it uses that timecoded WAV (Camera 1's audio as a file stamped with the
picture's start TC) instead → copy "<mc> C1 wav_run".

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    LABEL="Convo2"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_cam1_audio_fix.py", encoding="utf-8").read())
Clean up as before:
    LABEL="Convo2"; CLEAN=True; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_cam1_variants.py", encoding="utf-8").read())
Report: Desktop\\cam1_audio_fix.txt.
"""
import importlib.util
import json
import os
import re
import shutil
from fractions import Fraction
from typing import Any, List
from urllib.parse import unquote

LABEL = globals().get("LABEL", "Convo2")
AUDIO_FILE = globals().get("AUDIO_FILE")   # e.g. "tcA": use that timecoded WAV (pool clip name contains it) as Camera 1's audio
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


def norm(p: str) -> str:
    return str(p or "").replace("/", "\\").lower()


def secs(v: str) -> Fraction:
    v = (v or "0s").rstrip("s")
    return Fraction(*map(int, v.split("/"))) if "/" in v else Fraction(v)


def fr(x: Fraction) -> str:
    return f"{x.numerator}/{x.denominator}s"


def export_xml(r: Any, project: Any, mp: Any, tl: Any, stem: str) -> str:
    """Export a timeline as FCPXML 1.10 and return the text (handles bundle folders)."""
    path = os.path.join(DESKTOP, f"{stem}.fcpxml")
    for p in (path, path + "d"):
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.isfile(p):
            os.remove(p)
    project.SetCurrentTimeline(tl)
    ok = _safe(lambda: tl.Export(path, r.EXPORT_FCPXML_1_10), False) or \
        _safe(lambda: tl.Export(path, r.EXPORT_FCPXML_1_10, r.EXPORT_NONE), False)
    for p in (path, path + "d"):
        if os.path.isfile(p):
            return open(p, encoding="utf-8").read()
        if os.path.isdir(p):
            inner = next((os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(".fcpxml")), None)
            if inner:
                return open(inner, encoding="utf-8").read()
    raise RuntimeError(f"export of {tl.GetName()} failed (Export returned {ok})")


def drop(project: Any, mp: Any, tl: Any) -> None:
    other = next((t for n, t in timelines(project).items() if not n.startswith("__SPIKE_")), None)
    if other:
        project.SetCurrentTimeline(other)
    _safe(lambda: mp.DeleteTimelines([tl]))


def audio_start(r: Any, project: Any, mp: Any, pool_clip: Any):
    """Resolve's own idea of where a clip's AUDIO starts: append only its audio to a throwaway
    timeline, export, read the audio asset's start/duration."""
    name = "__SPIKE_c1_audiostart"
    old = timelines(project).get(name)
    if old:
        mp.DeleteTimelines([old])
    tl = mp.CreateEmptyTimeline(name)
    project.SetCurrentTimeline(tl)
    _safe(lambda: mp.AppendToTimeline([{"mediaPoolItem": pool_clip, "mediaType": 2}]))
    try:
        xml = export_xml(r, project, mp, tl, "c1_audiostart")
    finally:
        drop(project, mp, tl)
    for a in re.finditer(r"<asset ([^>]*)>", xml):
        at = dict(re.findall(r'([\w:-]+)="([^"]*)"', a.group(1)))
        if at.get("hasVideo") != "1" and at.get("hasAudio") == "1":
            return secs(at["start"]), secs(at["duration"]), at
    raise RuntimeError("no audio-only asset in the audio-start export")


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — Camera 1 audio fix")
    plan = json.load(open(os.path.join(REPO, "cut_through", "plans", f"{LABEL}_plan.json"), encoding="utf-8"))
    name = plan["multicam"]
    cands = [(p, c) for p, f in folders(mp.GetRootFolder()) for c in clips(f)
             if _safe(lambda: c.GetName()) == name and BIN not in p
             and "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()]
    if not cands:
        raise RuntimeError(f"No multicam named {name!r}")
    where, orig = next(((p, c) for p, c in cands if "MC ORIGINAL" in p), cands[0])
    say(f"Source multicam: {name} [{orig.GetUniqueId()[:8]}] in '{where}'")

    stale = timelines(project).get("__SPIKE_c1_mcdef")
    if stale:
        mp.DeleteTimelines([stale])
    tmp = mp.CreateTimelineFromClips("__SPIKE_c1_mcdef", [orig])
    try:
        mcdef = export_xml(r, project, mp, tmp, "mcdef_cam1fix")
    finally:
        drop(project, mp, tmp)
    mcdef_path = os.path.join(DESKTOP, "mcdef_cam1fix_src.fcpxml")
    open(mcdef_path, "w", encoding="utf-8").write(mcdef)

    # Camera 1's picture clip in the multicam, and its file's pool clip
    ang = re.search(r'<mc-angle [^>]*name="Camera 1"[^>]*>(.*?)</mc-angle>', mcdef, re.S).group(1)
    c1 = dict(re.findall(r'([\w:-]+)="([^"]*)"', re.search(r"<asset-clip ([^>]*)>", ang).group(1)))
    asset = re.search(r'<asset ([^>]*id="%s"[^>]*)>\s*<media-rep [^>]*src="([^"]+)"' % c1["ref"], mcdef)
    path = norm(unquote(asset.group(2)).replace("file://localhost/", ""))
    pool = next((c for p, f in folders(mp.GetRootFolder()) if BIN not in p for c in clips(f)
                 if norm(_safe(lambda: c.GetClipProperty("File Path"), "")) == path), None)
    if not pool:
        raise RuntimeError(f"no pool clip for {path}")
    try:                                             # cross-check only: Resolve's own audio-only description
        a_start, a_dur, a_attrs = audio_start(r, project, mp, pool)
    except Exception as exc:
        # Jordan's working export showed the audio-only asset = the picture's start and length
        say(f"(audio-only probe: {exc}; using the picture's start/length, as in Jordan's working export)")
        a_start, a_dur = secs(c1["start"]), secs(c1["duration"])
        a_attrs = dict(re.findall(r'([\w:-]+)="([^"]*)"', asset.group(1)))
    v_start, v_dur, v_off = secs(c1["start"]), secs(c1["duration"]), secs(c1["offset"])
    shift = a_start - v_start
    fd = Fraction(1001, 24000)
    say(f"Camera 1 file: picture starts {float(v_start):.4f}s, Resolve's audio starts {float(a_start):.4f}s "
        f"→ audio is {float(shift):+.4f}s ({float(shift / fd):+.2f} frames) from the picture")

    # mini timeline built the usual way (copy keeps Camera 1 as exported), then rewritten
    spec = importlib.util.spec_from_file_location("make_fcpxml", os.path.join(REPO, "cut_through", "write_timeline_xml.py"))
    mk = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mk)
    frame = min(v["in"] for v in plan["video"]) + 240
    mini = {"label": "cam1", "multicam": name, "video": [{"in": frame, "out": frame + LENGTH, "angle": "Camera 1"}],
            "mics": {}}
    mini_path = os.path.join(DESKTOP, "cam1fix_plan.json")
    json.dump(mini, open(mini_path, "w", encoding="utf-8"))
    base = os.path.join(DESKTOP, "cam1fix_base.fcpxml")
    mk.main([mcdef_path, base, "atem=off", f"{mini_path}:__SPIKE_c1_base"])
    xml0 = open(base, encoding="utf-8").read()
    m = re.search(r"(<multicam [^>]*>)(.*?)(\s*</multicam>)", xml0, re.S)
    blocks = re.findall(r"\s*<mc-angle .*?</mc-angle>", m.group(2), re.S)
    num = lambda b: int((re.search(r'name="[^"]*?(\d+)"', b) or [0, 999])[1])
    xml0 = xml0.replace(m.group(0), m.group(1) + "".join(sorted(blocks, key=num)) + m.group(3))
    cam1 = re.search(r'<mc-angle [^>]*name="Camera 1"[^>]*>.*?</mc-angle>', xml0, re.S).group(0)
    ac = re.search(r"<asset-clip ([^>]*)>(.*?)</asset-clip>", cam1, re.S)

    # audio_run: picture-only clip + an audio-only asset/clip placed by Resolve's audio start
    keep = " ".join(f'{k}="{c1[k]}"' for k in ("name", "start", "duration", "enabled", "tcFormat", "offset", "format")
                    if k in c1)
    pic = f'<clip {keep}>{ac.group(2)}<video start="{c1["start"]}" duration="{c1["duration"]}" ref="{c1["ref"]}" ' \
          f'offset="{c1["start"]}"/></clip>'
    aud_off = v_off + shift
    aud_name, aud_src, variant = c1["name"], asset.group(2), "audio_run"
    if AUDIO_FILE:                                   # a separate WAV stamped with Camera 1's start timecode
        wav = next((c for p, f in folders(mp.GetRootFolder()) if BIN not in p for c in clips(f)
                    if AUDIO_FILE.lower() in str(_safe(lambda: c.GetName(), "")).lower()), None)
        if not wav:
            raise RuntimeError(f"no pool clip whose name contains {AUDIO_FILE!r}")
        aud_name = wav.GetName()
        aud_src = "file://localhost/" + str(wav.GetClipProperty("File Path")).replace("\\", "/").replace(" ", "%20")
        aud_off, a_start, a_dur = v_off, v_start, v_dur          # same start TC as the picture → same place
        variant = "wav_run"
        say(f"Camera 1 audio from {aud_name} (Start TC {wav.GetClipProperty('Start TC')}), placed with the picture")
    run = (f'<gap name="Gap" start="3600/1s" duration="{fr(aud_off)}" offset="0/1s"/>'
           f'<clip name="{aud_name}" start="{fr(a_start)}" duration="{fr(a_dur)}" enabled="1" offset="{fr(aud_off)}">'
           f'<audio srcCh="1, 2" start="{fr(a_start)}" duration="{fr(a_dur)}" ref="r_c1aud" offset="{fr(a_start)}"/></clip>')
    new_cam1 = cam1.replace(ac.group(0), pic).replace("</mc-angle>", run + "</mc-angle>")
    asset_xml = (f'<asset name="{aud_name}" start="{fr(a_start)}" duration="{fr(a_dur)}" id="r_c1aud" '
                 f'audioChannels="{a_attrs.get("audioChannels", "2")}" audioSources="1" hasAudio="1">'
                 f'<media-rep kind="original-media" src="{aud_src}"/></asset>')
    v_run = xml0.replace(cam1, new_cam1).replace("</resources>", asset_xml + "</resources>")

    search = [f for p, f in folders(mp.GetRootFolder())
              if any(norm(_safe(lambda: c.GetClipProperty("File Path"), "")) in
                     {norm(unquote(s).replace("file://localhost/", "")) for s in re.findall(r'src="([^"]+)"', v_run)}
                     for c in clips(f))]
    root = mp.GetRootFolder()
    spike_bin = next((f for f in (_safe(lambda: root.GetSubFolderList(), []) or []) if f.GetName() == BIN), None) \
        or mp.AddSubFolder(root, BIN)
    for v, text in ((variant, v_run),):
        tname = f"__SPIKE_c1_{v}"
        text = text.replace("__SPIKE_c1_base", tname)
        path_v = os.path.join(DESKTOP, f"cam1fix_{v}.fcpxml")
        open(path_v, "w", encoding="utf-8").write(text)
        old = timelines(project).get(tname)
        if old:
            mp.DeleteTimelines([old])
        before = {c.GetUniqueId() for _, f in folders(mp.GetRootFolder()) for c in clips(f)}
        mp.SetCurrentFolder(spike_bin)
        tl = mp.ImportTimelineFromFile(path_v, {"timelineName": tname, "importSourceClips": False,
                                                "sourceClipsFolders": search})
        new = [c for _, f in folders(mp.GetRootFolder()) for c in clips(f)
               if c.GetUniqueId() not in before and "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()]
        for c in new:
            _safe(lambda: c.SetName(f"{name} C1 {v}"))
            if _safe(lambda: c.GetParentFolder().GetName()) != BIN:
                _safe(lambda: mp.MoveClips([c], spike_bin))
        say(f"{v}: import {'ok' if tl else 'FAILED'}; {len(new)} copy → '{name} C1 {v}'")
    say(f"\nOpen '{name} C1 {variant}': Camera 1 audio green? on track 1? in sync with the picture?")


try:
    main()
except (Exception, SystemExit) as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(os.path.join(DESKTOP, "cam1_audio_fix.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    globals().pop("LABEL", None)
