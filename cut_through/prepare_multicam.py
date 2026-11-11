#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cut-through step 1 (Prep): describe the day multicam for transcription.

EditPanel runs it inside its Resolve worker (Cut-through page → Prep). It exports the day
multicam's description (a throwaway timeline holding just the multicam → FCPXML, then deleted),
finds every audio-only clip inside it (the mic WAVs on your person tracks) and where each sits in
the multicam, and saves into OUT_DIR (EditPanel: the run folder; by hand without OUT_DIR: the Desktop):
  day_<LABEL>.json   — multicam name, fps, length, angles, and per mic WAV: file path,
                       angle, and the multicam time where the WAV's 0:00 sits
  mcdef_<LABEL>.fcpxml(d) — the export itself
Nothing in the project changes (the throwaway timeline is deleted again).

Then transcribe.py (step 2) transcribes the day file's mics (see its docstring).

By hand in Resolve's Py3 console (project open):
    LABEL="Convo2"; OUT_DIR=r"<run folder>"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\cut_through\\prepare_multicam.py", encoding="utf-8").read())
Optional: MC="name" when the project has more than one multicam.
No mic WAVs in the multicam (only the ATEM mix or in-camera audio on track 1): the day's audio is
that camera audio — Camera 1 by default, AUDIO_ANGLE="Camera 3" to pick another — one angle, so
one speaker track. audio_source in the day file says which ("wav" / "camera").
"""
import json
import os
import re
import shutil
import xml.etree.ElementTree as ET
from fractions import Fraction
from typing import Any, List
from urllib.parse import unquote

LABEL = globals().get("LABEL", "Convo2")
MC = globals().get("MC")
AUDIO_ANGLE = globals().get("AUDIO_ANGLE")     # no mic WAVs: whose camera audio (track 1) to use; default Camera 1
OUT_DIR = globals().get("OUT_DIR") or os.path.expanduser("~/Desktop")   # EditPanel: the run folder
os.makedirs(OUT_DIR, exist_ok=True)
ARCHIVE_BINS = {"MC ORIGINAL", "MC QUARANTINE"}
_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def phase(text: str) -> None:
    """What's happening now, for the Cut-through page's live label (a "▸ " line; not in the report)."""
    print(f"▸ {text}", flush=True)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _s(v) -> Fraction:
    v = (v or "0s").rstrip("s")
    return Fraction(*map(int, v.split("/"))) if "/" in v else Fraction(v)


def walk(folder: Any):
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield folder, clip
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        if _safe(lambda: sub.GetName()) not in ARCHIVE_BINS:
            yield from walk(sub)


def bundle_xml(path: str):
    for p in (path, path + "d", os.path.splitext(path)[0] + ".fcpxmld"):
        if os.path.isfile(p):
            return p
        if os.path.isdir(p):
            inner = [os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(".fcpxml")]
            if inner:
                return inner[0]
    return None


def describe(xml: str, mc_name: str = None) -> dict:
    """Multicam facts + every audio-only clip in it. Positions are seconds from the multicam's
    start. A clip at angle position P with media start S has its file's 0:00 at P − S."""
    root = ET.fromstring(re.search(r"<resources>.*?</resources>", xml, re.S).group(0))
    assets = {a.get("id"): a for a in root.iter("asset")}
    formats = {f.get("id"): f for f in root.iter("format")}
    medias = [m for m in root.iter("media") if m.find("multicam") is not None
              and (mc_name is None or m.get("name") == mc_name)]
    if not medias:
        raise RuntimeError(f"No multicam {mc_name or ''} in the export")
    media = medias[0]
    mc = media.find("multicam")
    fd = _s(formats[mc.get("format")].get("frameDuration")) if mc.get("format") in formats else Fraction(1001, 24000)

    def path(ref):
        a = assets.get(ref)
        rep = a.find("media-rep") if a is not None else None
        return unquote((rep.get("src") if rep is not None else "").replace("file://localhost/", ""))

    angles, mics, cams, pics, length = [], [], [], [], Fraction(0)
    # an audio-only asset of a file that is also a picture asset = that camera's own sound on its
    # own track (Bill Smith mc_1, 2026-11-05): camera audio, not a mic WAV
    pic_paths = {path(i) for i, a in assets.items() if a.get("hasVideo") == "1"}

    def visit(el, angle, pos0, start0):
        for ch in el:
            if "offset" not in ch.attrib:
                continue
            pos = pos0 + _s(ch.get("offset")) - start0          # this child's place in the angle
            dur = _s(ch.get("duration"))
            ref = ch.get("ref")
            a = assets.get(ref)
            cam_track = a is not None and a.get("hasVideo") != "1" and a.get("hasAudio") == "1" and path(ref) in pic_paths
            if a is not None and a.get("hasVideo") == "1":
                # every picture clip, for reading the slider's movement (Cut-through, 2026-11-10)
                start = _s(ch.get("start")) - _s(a.get("start"))
                pic = {"angle": angle, "path": path(ref), "file_zero_sec": float(pos - start),
                       "from_sec": float(pos), "to_sec": float(pos + dur)}
                if not any(x["angle"] == angle and x["path"] == pic["path"] and x["from_sec"] == pic["from_sec"] for x in pics):
                    pics.append(pic)
            if a is not None and a.get("hasVideo") != "1" and a.get("hasAudio") == "1" and not cam_track:
                start = _s(ch.get("start"))
                mics.append({"name": a.get("name"), "angle": angle, "path": path(ref),
                             "file_zero_sec": float(pos - start),      # where the file's 0:00 sits
                             "from_sec": float(pos), "to_sec": float(pos + dur),
                             "channels": int(a.get("audioChannels") or 1)})
            elif a is not None and a.get("hasAudio") == "1" and (a.get("hasVideo") == "1" or cam_track):
                # camera clip with its own audio (ATEM mix or in-camera): fallback when no WAVs.
                # Its start is in the file's timecode, which begins at the asset's start.
                start = _s(ch.get("start")) - _s(a.get("start"))
                item = {"name": a.get("name"), "angle": angle, "path": path(ref),
                        "file_zero_sec": float(pos - start), "from_sec": float(pos), "to_sec": float(pos + dur),
                        "channels": int(a.get("audioChannels") or 1), "camera": True}
                if not any(c["angle"] == angle and c["path"] == item["path"] and c["from_sec"] == item["from_sec"] for c in cams):
                    cams.append(item)      # a <clip> holds the same file as <video> and <audio>; a punch-in angle shares its files with another angle and keeps its own entry
            visit(ch, angle, pos, _s(ch.get("start")))

    def has_picture(el) -> bool:
        a = assets.get(el.get("ref"))
        if a is not None and a.get("hasVideo") == "1":
            return True
        return el.tag == "video" or any(has_picture(ch) for ch in el)

    pictures = []                                  # [from, to] of every camera clip, any angle
    for ang in mc.findall("mc-angle"):
        angles.append(ang.get("name"))
        visit(ang, ang.get("name"), Fraction(0), Fraction(0))
        for ch in ang:
            if "offset" in ch.attrib:
                length = max(length, _s(ch.get("offset")) + _s(ch.get("duration")))
                if ch.tag != "gap" and not re.search(r"slate", ang.get("name") or "", re.I) and has_picture(ch):
                    pictures.append((_s(ch.get("offset")), _s(ch.get("offset")) + _s(ch.get("duration"))))
    return {"multicam": media.get("name"), "fps": float(1 / fd), "frame_sec": [fd.numerator, fd.denominator],
            "tc_start_sec": float(_s(mc.get("tcStart"))), "length_sec": float(length),
            "angles": angles, "mics": mics, "camera_audio": cams, "picture_clips": pics, "recordings": recordings(pictures)}


def recordings(pictures, join_sec: float = 0.5) -> list:
    """Camera clips on every angle → the recordings: where the cameras rolled. The ATEM records
    every camera at once, so clips that overlap or touch (a long recording split into files) are one
    recording; a real gap between them is a stop. Seconds from the multicam's start."""
    out = []
    for a, b in sorted(pictures):
        if out and a <= out[-1][1] + Fraction(join_sec):
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [{"from_sec": float(a), "to_sec": float(b)} for a, b in out]


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — day prep {LABEL}")
    phase(f"Reading {MC or LABEL}'s layout from Resolve")
    mcs = [c for _, c in walk(mp.GetRootFolder())
           if "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()
           and (MC is None or _safe(lambda: c.GetName()) == MC)]
    if len(mcs) != 1:
        raise RuntimeError(f"Expected one multicam{f' named {MC!r}' if MC else ''} outside the archive bins, found "
                           f"{[c.GetName() for c in mcs]} — set MC=\"name\"")
    orig = mcs[0]
    etype = next((getattr(r, f"EXPORT_FCPXML_{v}") for v in ("1_14", "1_13", "1_12", "1_11", "1_10")
                  if _safe(lambda: getattr(r, f"EXPORT_FCPXML_{v}")) is not None), None)
    tmp = mp.CreateTimelineFromClips(f"Cut-through temp {LABEL} layout", [orig])
    if not tmp:
        raise RuntimeError("Couldn't make the throwaway multicam timeline")
    mcdef = os.path.join(OUT_DIR, f"mcdef_{LABEL}.fcpxml")
    for p in (mcdef, mcdef + "d"):
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.isfile(p):
            os.remove(p)
    ok = _safe(lambda: tmp.Export(mcdef, etype), False)
    other = next((project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount()) + 1)
                  if project.GetTimelineByIndex(i).GetName() != tmp.GetName()), None)
    if other:
        project.SetCurrentTimeline(other)
    gone = _safe(lambda: mp.DeleteTimelines([tmp]), False)
    src = bundle_xml(mcdef)
    if not ok or not src:
        raise RuntimeError("FCPXML export failed")
    day = describe(open(src, encoding="utf-8").read(), orig.GetName())
    day.update({"label": LABEL, "project": project.GetName()})
    cams = day.pop("camera_audio")
    day["camera_audio_angles"] = sorted({c["angle"] for c in cams}, key=lambda a: (len(a), a))
    day["audio_source"] = "wav"
    day["wav_mics"] = len(day["mics"])
    if not day["mics"] or AUDIO_ANGLE:
        # No person mics placed (only the ATEM mix or in-camera audio on track 1): transcribe one
        # angle's camera audio instead. Every clip of that angle is one source on the same track.
        want = AUDIO_ANGLE or ("Camera 1" if "Camera 1" in day["camera_audio_angles"] else
                               (day["camera_audio_angles"] or [None])[0])
        picked = [c for c in cams if c["angle"] == want]
        if not picked:
            raise RuntimeError(f"No mic WAVs, and no camera audio on {want or 'any angle'}")
        day["mics"], day["audio_source"] = picked, "camera"
    out = os.path.join(OUT_DIR, f"day_{LABEL}.json")
    json.dump(day, open(out, "w", encoding="utf-8"), indent=1)
    say(f"Multicam '{day['multicam']}': {day['length_sec'] / 60:.1f} min at {day['fps']:.3f} fps; "
        f"angles {day['angles']}; throwaway timeline deleted: {gone}")
    say(f"   {len(day['recordings'])} recording(s): " + ", ".join(
        f"{r['from_sec'] / 60:.1f}–{r['to_sec'] / 60:.1f} min" for r in day["recordings"][:12])
        + (" …" if len(day["recordings"]) > 12 else ""))
    for m in day["mics"]:
        ok_file = os.path.isfile(m["path"])
        say(f"   {'camera clip' if m.get('camera') else 'audio clip'} {m['name']} under {m['angle']}: multicam {m['from_sec'] / 60:.1f}–{m['to_sec'] / 60:.1f} min, "
            f"file 0:00 at {m['file_zero_sec']:+.2f}s; file {'found' if ok_file else 'NOT FOUND'}")
    if day["audio_source"] == "camera":
        say(f"   no mic WAVs used — camera audio (track 1) of {day['mics'][0]['angle']}, {len(day['mics'])} clip(s); "
            f"other angles with audio: {[a for a in day['camera_audio_angles'] if a != day['mics'][0]['angle']]}")
    say(f"Saved {out}")


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(os.path.join(OUT_DIR, f"day_prep_{LABEL}.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("LABEL", "MC", "AUDIO_ANGLE", "OUT_DIR"):
        globals().pop(_k, None)
