#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cut-through (console, one-off): unlink the clips on timelines Build already made.

Build's unlink step failed on every video until 1.2.187 (it sent every clip to Resolve; only the
linked ones are accepted: spike_unlink 2026-11-20). This runs the fixed unlink
(common.unlink_timeline) over the cut timelines that are still linked. Clips only lose their
links; nothing moves.

Which timelines: every timeline in a media pool bin named BIN (default "SEQUENCES", at any depth,
e.g. "Master / SEQUENCES"), or exactly the ones in NAMES = ["B1_Convo", ...] when set.

Run in Resolve (project open): Workspace → Console → Py3, then
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\cut_through\\unlink_timelines.py", encoding="utf-8").read())
Report: printed, and saved to the NAS spike-report folder
(N:\\Client AV Assets\\[1] ACTIVE\\Elevate Pools\\Cut-Through\\spike reports\\unlink_timelines_<date>_<time>.txt;
the Desktop if N: isn't there).
"""
import importlib.util
import os
import time

BIN = globals().get("BIN") or "SEQUENCES"
NAMES = globals().get("NAMES")
REPORT_DIR = r"N:\Client AV Assets\[1] ACTIVE\Elevate Pools\Cut-Through\spike reports"
_name = f"unlink_timelines_{time.strftime('%Y-%m-%d_%H%M%S')}.txt"
try:
    os.makedirs(REPORT_DIR, exist_ok=True)
    REPORT = os.path.join(REPORT_DIR, _name)
except OSError:
    REPORT = os.path.join(os.path.expanduser("~"), "Desktop", _name)
_out = []


def say(m=""):
    print(m)
    _out.append(str(m))


def _common():
    here = (os.path.dirname(os.path.abspath(globals()["__file__"])) if globals().get("__file__")
            else r"C:\lp-app-ecosystem\editpanel\cut_through")
    spec = importlib.util.spec_from_file_location("cut_through_common", os.path.join(here, "common.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def timeline_names_in_bins(root, bin_name):
    """Names of the timeline clips in every bin called `bin_name` (any depth)."""
    out = []

    def walk(f):
        if f.GetName() == bin_name:
            out.extend(c.GetName() for c in (f.GetClipList() or [])
                       if "timeline" in str(c.GetClipProperty("Type") or "").lower())
        for sub in f.GetSubFolderList() or []:
            walk(sub)
    walk(root)
    return out


def main():
    c = _common()
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    say(f"Resolve {c._safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — unlink_timelines")
    by_name = {}
    for i in range(1, int(project.GetTimelineCount()) + 1):
        t = project.GetTimelineByIndex(i)
        by_name.setdefault(t.GetName(), t)
    want = list(NAMES) if NAMES else timeline_names_in_bins(mp.GetRootFolder(), BIN)
    say(f"Timelines: {len(want)} " + (f"(NAMES)" if NAMES else f"in bin(s) named '{BIN}'"))
    missing = [n for n in want if n not in by_name]
    if missing:
        say(f"  not found as timelines: {missing}")
    cur = project.GetCurrentTimeline()
    done = failed = untouched = 0
    try:
        for n in want:
            tl = by_name.get(n)
            if not tl:
                continue
            project.SetCurrentTimeline(tl)
            line = c.unlink_timeline(tl)
            say(f"  {n}: {line}")
            if line.startswith("✗"):
                failed += 1
            elif "unlinked ✓" in line:
                done += 1
            else:
                untouched += 1
    finally:
        if cur:
            project.SetCurrentTimeline(cur)
    say(f"\nUnlinked: {done}; already unlinked: {untouched}; failed: {failed}")


try:
    main()
except Exception:  # noqa: BLE001 — the report must say why it stopped
    import traceback
    say("\nSTOPPED with an error:")
    for line in traceback.format_exc().rstrip().splitlines():
        say(f"  {line}")
finally:
    try:
        with open(REPORT, "w", encoding="utf-8") as fh:
            fh.write("\n".join(_out) + "\n")
        say(f"Report saved to {REPORT}")
    except Exception as e:  # noqa: BLE001
        print(f"(couldn't save report: {e})")
    for _k in ("BIN", "NAMES"):
        globals().pop(_k, None)
