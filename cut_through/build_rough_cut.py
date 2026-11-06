#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cut-through step 4 (Build): the whole build in one run, nothing copied between machines.

  1. Resolve exports the day multicam's description: a throwaway timeline holding just the
     multicam is exported as FCPXML (newest version this Resolve offers), then deleted.
  1b. Finds the mic WAVs Jordan placed in the multicam; the cut uses them as plain clips
     (Resolve places clips inside an imported multicam by timecode, and the recorder's WAVs
     start at 00:00:00:00, so they can't ride along in the copy's angles).
  2. write_timeline_xml.py builds ONE joined timeline from the cut plan (PLAN_FILE; EditPanel keeps it in the run folder) on top
     of that description, plus its ranges file.
  3. import_into_resolve.py imports it (one multicam copy → primary in the MC bin; the original
     goes to "MC ORIGINAL").
  4. split_into_videos.py cuts it into one timeline per video in SEQ_BIN.
Generated files go to OUT_DIR (EditPanel: the run folder; by hand: the Desktop) (they name client media — never into git).

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    LABEL="ConvoTest"; MICS={"host": "Camera 2", "guest": "Camera 3"}; SPLIT=3; SEQ_BIN="MASTER / SEQUENCES"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\cut_through\\build_rough_cut.py", encoding="utf-8").read())
Plans from plan_convo.py carry their mic angles, so MICS can be left out:
    LABEL="Convo2"; SEQ_BIN="MASTER / SEQUENCES"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\cut_through\\build_rough_cut.py", encoding="utf-8").read())
Optional: RAW="*" (or names) moves the original's timelines into "MC ORIGINAL" too.
Report saved to Desktop\\cut_through_<LABEL>.txt (includes the import and split reports).
"""

import importlib.util
import json
import os
import re
import shutil
import time
import xml.etree.ElementTree as ET
from fractions import Fraction
from typing import Any, List
from urllib.parse import unquote

LABEL = globals().get("LABEL", "ConvoTest")
MICS = globals().get("MICS") or {}                     # role → angle carrying that person's mic
SPLIT = int(globals().get("SPLIT", 1))                 # one plan cut into N videos (test only)
SEQ_BIN = globals().get("SEQ_BIN")
RAW = globals().get("RAW")
REPO = r"C:\lp-app-ecosystem\editpanel"
PIPELINE = os.path.join(REPO, "cut_through")
PLAN_FILE = globals().get("PLAN_FILE") or os.path.join(PIPELINE, "plans", f"{LABEL}_plan.json")
OUT_DIR = globals().get("OUT_DIR") or os.path.expanduser("~/Desktop")   # EditPanel: the run folder
os.makedirs(OUT_DIR, exist_ok=True)
ARCHIVE_BINS = {"MC ORIGINAL", "MC QUARANTINE"}
_lines: List[str] = []
_T0 = time.time()


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


def walk(folder: Any):
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield folder, clip
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        if _safe(lambda: sub.GetName()) not in ARCHIVE_BINS:
            yield from walk(sub)


def export_type(r: Any):
    """Newest FCPXML export this Resolve offers."""
    for v in ("1_14", "1_13", "1_12", "1_11", "1_10", "1_9", "1_8"):
        val = _safe(lambda: getattr(r, f"EXPORT_FCPXML_{v}"))
        if val is not None:
            return v.replace("_", "."), val
    raise RuntimeError("This Resolve offers no FCPXML export type")


FD = Fraction(1001, 24000)


def _s(v: str) -> Fraction:
    v = v.rstrip("s")
    return Fraction(*map(int, v.split("/"))) if "/" in v else Fraction(v)


def wav_timecodes(xml: str, mc_name: str) -> dict:
    """Where Jordan placed each extra-track clip (the mic WAVs) inside the multicam, as the start
    timecode that file needs so Resolve's timecode placement lands it there:
    {file name: (start frame, angle, path)}. Resolve exports an angle's extra tracks as a second
    run restarting at offset 0; a clip's angle position = its offset in that run."""
    res = re.search(r"<resources>.*?</resources>", xml, re.S).group(0)
    root = ET.fromstring(res)
    paths = {a.get("id"): unquote((a.find("media-rep").get("src") if a.find("media-rep") is not None else "")
                                  .replace("file://localhost/", ""))
             for a in root.iter("asset")}
    out = {}
    for media in root.iter("media"):
        if media.get("name") != mc_name:
            continue
        mc = media.find("multicam")
        start = _s(mc.get("tcStart"))
        for ang in mc.iter("mc-angle"):
            end, run = Fraction(0), 0
            for el in ang:
                if "offset" not in el.attrib:
                    continue
                o = _s(el.get("offset"))
                if o < end:
                    run += 1
                end = o + _s(el.get("duration", "0s"))
                if run and el.tag == "asset-clip":
                    frames = round((start + o - _s(el.get("start", "0s"))) / FD)
                    out.setdefault(el.get("name"), (frames, ang.get("name"), paths.get(el.get("ref"), "")))
    return out


def bundle_xml(path: str):
    """FCPXML 1.10+ exports as a bundle folder with Info.fcpxml inside; older ones as a file."""
    for p in (path, path + "d", os.path.splitext(path)[0] + ".fcpxmld"):
        if os.path.isfile(p):
            return p
        if os.path.isdir(p):
            inner = [os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(".fcpxml")]
            if inner:
                return inner[0]
    return None


def run_script(name: str, settings: dict, r: Any) -> dict:
    """Run a sibling spike in its own namespace and fold its report into this one."""
    g = {"__name__": "__main__", "resolve": r, **settings}
    exec(open(os.path.join(PIPELINE, name), encoding="utf-8").read(), g)
    _lines.extend("    " + x for x in g.get("_lines", []))
    return g


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    plan = json.load(open(PLAN_FILE, encoding="utf-8"))
    name = plan["multicam"]
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — cut-through {LABEL}")
    global MICS
    MICS = MICS or plan.get("mic_angles") or {}         # newer plans carry it (angle N = person on camera N)
    missing = [role for role in plan["mics"] if role not in MICS]
    if missing:
        raise RuntimeError(f"MICS needs an angle for {missing}")
    joined, base = f"Cut-through temp {LABEL}", f"{LABEL} rough cut"
    tls = {project.GetTimelineByIndex(i).GetName(): project.GetTimelineByIndex(i)
           for i in range(1, int(project.GetTimelineCount()) + 1)}
    if joined in tls:                                   # our own throwaway from a run that stopped
        cur = _safe(lambda: project.GetCurrentTimeline().GetName())
        if cur == joined:
            other = next((t for n, t in tls.items() if n != joined), None)
            if other:
                project.SetCurrentTimeline(other)
        gone = _safe(lambda: mp.DeleteTimelines([tls[joined]]), False)
        say(f"Deleted {joined!r} left by an earlier run: {gone}")
        if not gone:
            raise RuntimeError(f"Delete the timeline {joined!r} left by an earlier run, then build again")
    stale = sorted(n for n in tls if n.startswith(base))
    if stale:
        raise RuntimeError(f"Rename or delete these from an earlier run first: {stale}")
    mcs = [c for _, c in walk(mp.GetRootFolder())
           if _safe(lambda: c.GetName()) == name
           and "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()]
    if len(mcs) != 1:
        raise RuntimeError(f"Expected one multicam named {name!r} outside the archive bins, found {len(mcs)}"
                           + (" — a copy from a run that stopped is probably still in the MC bin; delete the newer one"
                              if len(mcs) > 1 else ""))
    orig = mcs[0]

    # 1. the multicam's description, straight from Resolve
    phase("Reading the multicam's layout from Resolve")
    t1 = time.time()
    version, etype = export_type(r)
    tmp = mp.CreateTimelineFromClips(f"Cut-through temp {LABEL} layout", [orig])
    if not tmp:
        raise RuntimeError("Couldn't make the throwaway multicam timeline")
    mcdef = os.path.join(OUT_DIR, f"mcdef_{LABEL}.fcpxml")
    for p in (mcdef, mcdef + "d"):                      # leftovers from an earlier run
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.isfile(p):
            os.remove(p)
    ok = _safe(lambda: tmp.Export(mcdef, etype), False) or _safe(lambda: tmp.Export(mcdef, etype, r.EXPORT_NONE), False)
    other = next((project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount()) + 1)
                  if project.GetTimelineByIndex(i).GetName() != tmp.GetName()), None)
    if other:
        project.SetCurrentTimeline(other)
    gone = _safe(lambda: mp.DeleteTimelines([tmp]), False)
    src = bundle_xml(mcdef)
    if not ok or not src:
        raise RuntimeError(f"FCPXML {version} export failed")
    xml = open(src, encoding="utf-8").read()
    angles = [re.search(r'name="([^"]+)"', a).group(1) for a in re.findall(r"<mc-angle ([^>]*)>", xml)]
    say(f"1. Exported {name} as FCPXML {version} in {time.time() - t1:.1f}s "
        f"({os.path.relpath(src, OUT_DIR)}, {os.path.getsize(src) // 1024} KB, {len(re.findall(r'<asset ', xml))} source file(s), "
        f"angles {angles}); throwaway timeline deleted: {gone}")

    # 1b. which mic WAV Jordan placed under which angle (the cut uses them as plain clips;
    # their timecode is never changed — stamping it knocked them offline in the original)
    wavs = wav_timecodes(xml, name)
    say("1b. Mic WAVs in the multicam: " + (", ".join(f"{n} under {a}" for n, (_, a, _) in sorted(wavs.items()))
                                           or "none (mics are in the camera files)"))

    # 2. the joined timeline, built on that description
    phase("Writing the edit as a timeline file")
    t1 = time.time()
    spec = importlib.util.spec_from_file_location("write_timeline_xml", os.path.join(PIPELINE, "write_timeline_xml.py"))
    mk = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mk)
    out = os.path.join(OUT_DIR, f"{LABEL}_joined.fcpxml")
    plan_arg = PLAN_FILE + f":{base}"
    args = [src, out, *(f"{k}={v}" for k, v in MICS.items()), f"split={SPLIT}", f"joined={joined}", plan_arg]
    ranges = mk.main(args)
    say(f"2. Built {os.path.basename(out)} (written as FCPXML 1.14): {len(ranges)} video(s) in one timeline "
        f"({time.time() - t1:.1f}s)")

    # 3. import → one copy (primary); original archived
    phase("Importing into Resolve")
    t1 = time.time()
    g = run_script("import_into_resolve.py", {"XML": os.path.basename(out), "LABEL": LABEL, "BATCH": True, "OUT_DIR": OUT_DIR,
                                          "ARCHIVE": True, "RAW": RAW, "MICS": MICS, "PLAN_FILE": PLAN_FILE,
                                              "MIC_FILES": {n: a for n, (_, a, _) in wavs.items()},
                                              "ATEM_FILE": getattr(mk, "LAST_ATEM", None)}, r)
    say(f"3. Import done ({time.time() - t1:.1f}s)")
    if not g.get("CHECK_OK", True):
        raise RuntimeError("the imported multicam copy failed its self-check — not splitting "
                           "(delete the new copy and the joined timeline before rerunning)")

    # 4. split into one timeline per video
    phase("Cutting into one timeline per video")
    t1 = time.time()
    run_script("split_into_videos.py", {"RANGES": os.path.basename(out).rsplit(".", 1)[0] + "_ranges.json",
                                        "SEQ_BIN": SEQ_BIN, "OUT_DIR": OUT_DIR}, r)
    say(f"4. Split done ({time.time() - t1:.1f}s)")


try:
    main()
    say(f"\nTotal time: {time.time() - _T0:.1f}s")
except (Exception, SystemExit) as exc:                # write_timeline_xml stops with SystemExit
    say(f"\n✗ STOPPED after {time.time() - _T0:.1f}s: {exc}")
finally:
    try:
        with open(os.path.join(OUT_DIR, f"cut_through_{LABEL}.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("LABEL", "MICS", "SPLIT", "SEQ_BIN", "RAW", "OUT_DIR", "PLAN_FILE"):   # the console keeps run-line settings between runs
        globals().pop(_k, None)
