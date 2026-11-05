#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Whole cut-through batch in one run, nothing copied between machines.

  1. Resolve exports the day multicam's description: a throwaway timeline holding just the
     multicam is exported as FCPXML (newest version this Resolve offers), then deleted.
  2. make_fcpxml.py builds ONE joined timeline from the cut plan in git (spikes/plans/) on top
     of that description, plus its ranges file.
  3. spike_import_fcpxml.py imports it (one multicam copy → primary in the MC bin; the original
     goes to "MC ORIGINAL").
  4. spike_split_batch.py cuts it into one timeline per video in SEQ_BIN.
Generated files go to the Desktop (they name client media — never into git).

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    LABEL="ConvoTest"; MICS={"host": "Camera 2", "guest": "Camera 3"}; SPLIT=3; SEQ_BIN="MASTER / SEQUENCES"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_cut_through_batch.py", encoding="utf-8").read())
Optional: RAW="*" (or names) moves the original's timelines into "MC ORIGINAL" too.
Report saved to Desktop\\cut_through_<LABEL>.txt (includes the import and split reports).
"""

import importlib.util
import json
import os
import re
import shutil
import time
from typing import Any, List

LABEL = globals().get("LABEL", "ConvoTest")
MICS = globals().get("MICS") or {}                     # role → angle carrying that person's mic
SPLIT = int(globals().get("SPLIT", 1))                 # one plan cut into N videos (test only)
SEQ_BIN = globals().get("SEQ_BIN")
RAW = globals().get("RAW")
REPO = r"C:\lp-app-ecosystem\editpanel"
SPIKES = os.path.join(REPO, "spikes")
DESKTOP = os.path.expanduser("~/Desktop")
ARCHIVE_BINS = {"MC ORIGINAL", "MC QUARANTINE"}
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


def run_script(name: str, settings: dict, r: Any) -> None:
    """Run a sibling spike in its own namespace and fold its report into this one."""
    g = {"__name__": "__main__", "resolve": r, **settings}
    exec(open(os.path.join(SPIKES, name), encoding="utf-8").read(), g)
    _lines.extend("    " + x for x in g.get("_lines", []))


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    plan = json.load(open(os.path.join(SPIKES, "plans", f"{LABEL}_plan.json"), encoding="utf-8"))
    name = plan["multicam"]
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — cut-through {LABEL}")
    missing = [role for role in plan["mics"] if role not in MICS]
    if missing:
        raise RuntimeError(f"MICS needs an angle for {missing}")
    joined, base = f"__SPIKE_joined_{LABEL}", f"__SPIKE_split_{LABEL}"
    existing = {project.GetTimelineByIndex(i).GetName() for i in range(1, int(project.GetTimelineCount()) + 1)}
    stale = sorted(n for n in existing if n == joined or n.startswith(base))
    if stale:
        raise RuntimeError(f"Delete these from an earlier run first: {stale}")
    mcs = [c for _, c in walk(mp.GetRootFolder())
           if _safe(lambda: c.GetName()) == name
           and "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()]
    if len(mcs) != 1:
        raise RuntimeError(f"Expected one multicam named {name!r} outside the archive bins, found {len(mcs)}")
    orig = mcs[0]

    # 1. the multicam's description, straight from Resolve
    t1 = time.time()
    version, etype = export_type(r)
    tmp = mp.CreateTimelineFromClips(f"__SPIKE_mcdef_{LABEL}", [orig])
    if not tmp:
        raise RuntimeError("Couldn't make the throwaway multicam timeline")
    mcdef = os.path.join(DESKTOP, f"mcdef_{LABEL}.fcpxml")
    for p in (mcdef, mcdef + "d"):                      # leftovers from an earlier run
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.isfile(p):
            os.remove(p)
    # Probe export-type numbers just past the newest named one: a 1.11–1.14 export the API
    # doesn't name would show up here (each probe file's own header says what it is).
    probes = []
    if isinstance(etype, int):
        pdir = os.path.join(DESKTOP, f"mcdef_probe_{LABEL}")
        shutil.rmtree(pdir, ignore_errors=True)
        os.makedirs(pdir, exist_ok=True)
        for n in range(etype + 1, etype + 9):
            pp = os.path.join(pdir, f"t{n}.fcpxml")
            if not _safe(lambda: tmp.Export(pp, n), False):
                probes.append(f"{n}: no")
                continue
            found = bundle_xml(pp) or next((os.path.join(pdir, f) for f in os.listdir(pdir) if f.startswith(f"t{n}")), None)
            head = open(found, encoding="utf-8", errors="replace").read(400) if found and os.path.isfile(found) else ""
            v = re.search(r'<fcpxml version="([^"]+)"', head)
            probes.append(f"{n}: {'FCPXML ' + v.group(1) if v else 'not FCPXML'}")
            if v and tuple(map(int, v.group(1).split("."))) > tuple(map(int, version.split("."))):
                version, etype = v.group(1), n
        shutil.rmtree(pdir, ignore_errors=True)
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
    offered = sorted(a for a in dir(r) if "FCPXML" in a)
    say(f"1. Exported {name} as FCPXML {version} in {time.time() - t1:.1f}s "
        f"({os.path.relpath(src, DESKTOP)}, {os.path.getsize(src) // 1024} KB, {len(re.findall(r'<asset ', xml))} source file(s), "
        f"angles {angles}); throwaway timeline deleted: {gone}; export types offered: {offered or '(not listed)'}")
    say(f"   Export type probe past the newest named one: {probes or '(skipped)'}")

    # 2. the joined timeline, built on that description
    t1 = time.time()
    spec = importlib.util.spec_from_file_location("make_fcpxml", os.path.join(SPIKES, "make_fcpxml.py"))
    mk = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mk)
    out = os.path.join(DESKTOP, f"{LABEL}_joined.fcpxml")
    plan_arg = os.path.join(SPIKES, "plans", f"{LABEL}_plan.json") + f":{base}"
    args = [src, out, *(f"{k}={v}" for k, v in MICS.items()), f"split={SPLIT}", f"joined={joined}", plan_arg]
    ranges = mk.main(args)
    say(f"2. Built {os.path.basename(out)} (written as FCPXML 1.14): {len(ranges)} video(s) in one timeline "
        f"({time.time() - t1:.1f}s)")

    # 3. import → one copy (primary); original archived
    t1 = time.time()
    run_script("spike_import_fcpxml.py", {"XML": os.path.basename(out), "LABEL": LABEL, "BATCH": True,
                                          "ARCHIVE": True, "RAW": RAW}, r)
    say(f"3. Import done ({time.time() - t1:.1f}s)")

    # 4. split into one timeline per video
    t1 = time.time()
    run_script("spike_split_batch.py", {"RANGES": os.path.basename(out).rsplit(".", 1)[0] + "_ranges.json",
                                        "SEQ_BIN": SEQ_BIN}, r)
    say(f"4. Split done ({time.time() - t1:.1f}s)")


try:
    main()
    say(f"\nTotal time: {time.time() - _T0:.1f}s")
except (Exception, SystemExit) as exc:                # make_fcpxml stops with SystemExit
    say(f"\n✗ STOPPED after {time.time() - _T0:.1f}s: {exc}")
finally:
    try:
        with open(os.path.join(DESKTOP, f"cut_through_{LABEL}.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("LABEL", "MICS", "SPLIT", "SEQ_BIN", "RAW"):   # the console keeps run-line settings between runs
        globals().pop(_k, None)
