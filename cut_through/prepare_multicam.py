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
import xml.etree.ElementTree as ET
from fractions import Fraction
from typing import List
from urllib.parse import unquote


def _common():
    """common.py from this script's own folder, loaded fresh each run (see its docstring). EditPanel's
    Resolve worker sets __file__; a console exec(open(...).read()) has none → the LP1 checkout."""
    import importlib.util
    here = (os.path.dirname(os.path.abspath(globals()["__file__"])) if globals().get("__file__")
            else r"C:\lp-app-ecosystem\editpanel\cut_through")
    spec = importlib.util.spec_from_file_location("cut_through_common", os.path.join(here, "common.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_c = _common()
_safe, walk, export_multicam, frame_duration, merge_spans = (
    _c._safe, _c.walk, _c.export_multicam, _c.frame_duration, _c.merge_spans)

LABEL = globals().get("LABEL", "Convo2")
MC = globals().get("MC")
AUDIO_ANGLE = globals().get("AUDIO_ANGLE")     # no mic WAVs: whose camera audio (track 1) to use; default Camera 1
OUT_DIR = globals().get("OUT_DIR") or os.path.expanduser("~/Desktop")   # EditPanel: the run folder
os.makedirs(OUT_DIR, exist_ok=True)
_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def phase(text: str) -> None:
    """What's happening now, for the Cut-through page's live label (a "▸ " line; not in the report)."""
    print(f"▸ {text}", flush=True)


def _s(v) -> Fraction:
    """An FCPXML time; a missing one (no start= on a clip) is 0."""
    return _c.secs(v or "0s")


AUDIO_EXTS = {".wav", ".bwf", ".aif", ".aiff", ".aifc", ".flac", ".mp3", ".m4a", ".caf", ".ogg"}


def is_audio_file(p: str) -> bool:
    """A recorder/mixer audio file (a person's mic), not a camera or ATEM video file."""
    return os.path.splitext(p)[1].lower() in AUDIO_EXTS


def describe(xml: str, mc_name: str = None) -> dict:
    """Multicam facts + every audio-only clip in it. Positions are seconds from the multicam's
    start. A clip at angle position P with media start S has its file's 0:00 at P − S."""
    root = ET.fromstring(re.search(r"<resources>.*?</resources>", xml, re.S).group(0))
    assets = {a.get("id"): a for a in root.iter("asset")}
    medias = [m for m in root.iter("media") if m.find("multicam") is not None
              and (mc_name is None or m.get("name") == mc_name)]
    if not medias:
        raise RuntimeError(f"No multicam {mc_name or ''} in the export")
    media = medias[0]
    mc = media.find("multicam")
    fd = frame_duration(xml, {media.get("name")})

    def path(ref):
        a = assets.get(ref)
        rep = a.find("media-rep") if a is not None else None
        return unquote((rep.get("src") if rep is not None else "").replace("file://localhost/", ""))

    angles, mics, cams, pics, length = [], [], [], [], Fraction(0)
    pic_sound = []      # picture clips whose file has sound the multicam doesn't use (a pick for the Audio menu)

    def visit(el, angle, pos0, start0):
        """One rule for every audio piece, whatever its file: it sits at `pos` in the angle, and its
        start counts in the file's own time, which begins at the asset's start (a camera/ATEM file's
        timecode; 0 for a recorder WAV) — so the file's 0:00 is at pos − (start − asset start).
        RB_MC_2 (2026-11-20): the ATEM mp4's sound under the 4K picture was read as a WAV without
        the asset start → placed 10.7 h off → silence → no words.
        What it is goes by the FILE: an audio file (.wav …) is a person's mic; a camera or ATEM
        video file's sound is camera audio, whatever picture the angle shows."""
        for ch in el:
            if "offset" not in ch.attrib:
                continue
            pos = pos0 + _s(ch.get("offset")) - start0          # this child's place in the angle
            dur = _s(ch.get("duration"))
            ref = ch.get("ref")
            a = assets.get(ref)
            if a is not None and a.get("hasVideo") == "1" and ch.tag in ("asset-clip", "video"):
                # every picture clip, for reading the slider's movement (Cut-through, 2026-11-10)
                start = _s(ch.get("start")) - _s(a.get("start"))
                pic = {"angle": angle, "path": path(ref), "file_zero_sec": float(pos - start),
                       "from_sec": float(pos), "to_sec": float(pos + dur)}
                if not any(x["angle"] == angle and x["path"] == pic["path"] and x["from_sec"] == pic["from_sec"] for x in pics):
                    pics.append(pic)
                    if a.get("hasAudio") == "1":           # its file's own sound: only for an angle with no sound pieces
                        pic_sound.append({**pic, "name": a.get("name"), "channels": int(a.get("audioChannels") or 1),
                                          "camera": True})
            # the clip's SOUND: an <audio> piece, or an asset-clip (picture + sound, maybe a split
            # edit: audioStart/audioDuration). A <video> piece is picture only (RB_MC_1/2: the 4K
            # MXF's own scratch audio isn't used, so it isn't the angle's audio).
            sound = (a is not None and a.get("hasAudio") == "1"
                     and (ch.tag == "audio" or (ch.tag == "asset-clip" and ch.get("srcEnable", "all") in ("all", "audio"))))
            if sound:
                a_start = _s(ch.get("audioStart") or ch.get("start"))
                a_dur = _s(ch.get("audioDuration") or ch.get("duration"))
                a_pos = pos + a_start - _s(ch.get("start"))        # a split edit's sound can start off the picture
                item = {"name": a.get("name"), "angle": angle, "path": path(ref),
                        "file_zero_sec": float(a_pos - (a_start - _s(a.get("start")))),   # where the file's 0:00 sits
                        "from_sec": float(a_pos), "to_sec": float(a_pos + a_dur),
                        "channels": int(a.get("audioChannels") or 1)}
                if is_audio_file(item["path"] or a.get("name") or ""):
                    mics.append(item)
                else:
                    item["camera"] = True
                    if not any(c["angle"] == angle and c["path"] == item["path"] and c["from_sec"] == item["from_sec"] for c in cams):
                        cams.append(item)      # a punch-in angle shares its files with another angle and keeps its own entry
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
    with_sound = {c["angle"] for c in cams}
    cams += [p for p in pic_sound if p["angle"] not in with_sound]
    return {"multicam": media.get("name"), "fps": float(1 / fd), "frame_sec": [fd.numerator, fd.denominator],
            "tc_start_sec": float(_s(mc.get("tcStart"))), "length_sec": float(length),
            "angles": angles, "mics": mics, "camera_audio": cams, "picture_clips": pics, "recordings": recordings(pictures)}


def pick_audio(day: dict, audio_angle: str = None) -> None:
    """The day's audio. Mic files (WAVs from the outside mixer) → each angle's mic is that
    person's own track (two or more angles = a conversation). None (or AUDIO_ANGLE set, the page's
    Audio pick) → one angle's camera audio: the ATEM mix on Camera 1 by default, every clip of that
    angle on one track. Four identical ATEM sounds under four angles are camera audio, so still one
    speaker."""
    cams = day.pop("camera_audio")
    day["camera_audio_angles"] = sorted({c["angle"] for c in cams}, key=lambda a: (len(a), a))
    day["audio_source"] = "wav"
    day["wav_mics"] = len(day["mics"])
    if not day["mics"] or audio_angle:
        want = audio_angle or ("Camera 1" if "Camera 1" in day["camera_audio_angles"] else
                               (day["camera_audio_angles"] or [None])[0])
        picked = [c for c in cams if c["angle"] == want]
        if not picked:
            raise RuntimeError(f"No mic WAVs, and no camera audio on {want or 'any angle'}")
        day["mics"], day["audio_source"] = picked, "camera"


def recordings(pictures, join_sec: float = 0.5) -> list:
    """Camera clips on every angle → the recordings: where the cameras rolled. The ATEM records
    every camera at once, so clips that overlap or touch (a long recording split into files) are one
    recording; a real gap between them is a stop. Seconds from the multicam's start."""
    return [{"from_sec": float(a), "to_sec": float(b)} for a, b in merge_spans(pictures, Fraction(join_sec))]


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
    _, src, gone = export_multicam(r, project, mp, orig, LABEL, OUT_DIR)
    if not src:
        raise RuntimeError("FCPXML export failed")
    day = describe(open(src, encoding="utf-8").read(), orig.GetName())
    day.update({"label": LABEL, "project": project.GetName()})
    pick_audio(day, AUDIO_ANGLE)
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
