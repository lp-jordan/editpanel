#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Step 1 of the all-in-one test: describe the day multicam for transcription.

Run in Resolve's console with the new project open. It exports the day multicam's description
(a throwaway timeline holding just the multicam → FCPXML, then deleted), finds every audio-only
clip inside it (the mic WAVs on your person tracks) and where each sits in the multicam, and saves:
  Desktop\\day_<LABEL>.json   — multicam name, fps, length, angles, and per mic WAV: file path,
                               angle, and the multicam time where the WAV's 0:00 sits
  Desktop\\mcdef_<LABEL>.fcpxml(d) — the export itself
Nothing in the project changes (the throwaway timeline is deleted again).

Then transcribe on LP1 with transcribe_day.py (see its docstring).

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    LABEL="Convo2"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_day_prep.py", encoding="utf-8").read())
Optional: MC="name" when the project has more than one multicam.
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
DESKTOP = os.path.expanduser("~/Desktop")
ARCHIVE_BINS = {"MC ORIGINAL", "MC QUARANTINE"}
_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


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

    angles, mics, length = [], [], Fraction(0)

    def visit(el, angle, pos0, start0):
        for ch in el:
            if "offset" not in ch.attrib:
                continue
            pos = pos0 + _s(ch.get("offset")) - start0          # this child's place in the angle
            dur = _s(ch.get("duration"))
            ref = ch.get("ref")
            a = assets.get(ref)
            if a is not None and a.get("hasVideo") != "1" and a.get("hasAudio") == "1":
                start = _s(ch.get("start"))
                mics.append({"name": a.get("name"), "angle": angle, "path": path(ref),
                             "file_zero_sec": float(pos - start),      # where the file's 0:00 sits
                             "from_sec": float(pos), "to_sec": float(pos + dur),
                             "channels": int(a.get("audioChannels") or 1)})
            visit(ch, angle, pos, _s(ch.get("start")))

    for ang in mc.findall("mc-angle"):
        angles.append(ang.get("name"))
        visit(ang, ang.get("name"), Fraction(0), Fraction(0))
        for ch in ang:
            if "offset" in ch.attrib:
                length = max(length, _s(ch.get("offset")) + _s(ch.get("duration")))
    return {"multicam": media.get("name"), "fps": float(1 / fd), "frame_sec": [fd.numerator, fd.denominator],
            "tc_start_sec": float(_s(mc.get("tcStart"))), "length_sec": float(length),
            "angles": angles, "mics": mics}


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — day prep {LABEL}")
    mcs = [c for _, c in walk(mp.GetRootFolder())
           if "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()
           and (MC is None or _safe(lambda: c.GetName()) == MC)]
    if len(mcs) != 1:
        raise RuntimeError(f"Expected one multicam{f' named {MC!r}' if MC else ''} outside the archive bins, found "
                           f"{[c.GetName() for c in mcs]} — set MC=\"name\"")
    orig = mcs[0]
    etype = next((getattr(r, f"EXPORT_FCPXML_{v}") for v in ("1_14", "1_13", "1_12", "1_11", "1_10")
                  if _safe(lambda: getattr(r, f"EXPORT_FCPXML_{v}")) is not None), None)
    tmp = mp.CreateTimelineFromClips(f"__SPIKE_mcdef_{LABEL}", [orig])
    if not tmp:
        raise RuntimeError("Couldn't make the throwaway multicam timeline")
    mcdef = os.path.join(DESKTOP, f"mcdef_{LABEL}.fcpxml")
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
    out = os.path.join(DESKTOP, f"day_{LABEL}.json")
    json.dump(day, open(out, "w", encoding="utf-8"), indent=1)
    say(f"Multicam '{day['multicam']}': {day['length_sec'] / 60:.1f} min at {day['fps']:.3f} fps; "
        f"angles {day['angles']}; throwaway timeline deleted: {gone}")
    for m in day["mics"]:
        ok_file = os.path.isfile(m["path"])
        say(f"   audio clip {m['name']} under {m['angle']}: multicam {m['from_sec'] / 60:.1f}–{m['to_sec'] / 60:.1f} min, "
            f"file 0:00 at {m['file_zero_sec']:+.2f}s; file {'found' if ok_file else 'NOT FOUND'}")
    if not day["mics"]:
        say("   ✗ no audio-only clips found in the multicam — where are the person mics?")
    say(f"Saved {out}")


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(os.path.join(DESKTOP, f"day_prep_{LABEL}.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("LABEL", "MC"):
        globals().pop(_k, None)
