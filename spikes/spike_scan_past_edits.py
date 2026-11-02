#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Read past multicam edits to learn the house style (READ-ONLY).

Open a finished project (e.g. Steve Heroux) and run this. For every timeline it
reads each multicam piece: its angle (from the item name, "<MC> - Camera 2"),
its length, and which part of the multicam it came from. From that it works out:

  - shot length per angle (median, 10th / 90th percentile)
  - which angle follows which (switch matrix)
  - cuts per minute
  - how each cut was made, by comparing consecutive pieces' source ranges:
      switch    = picture continues, only the angle changes
      trim      = material removed between the pieces (silence, flub, retake)
      jump      = material removed but the angle stays the same
      back      = the next piece starts EARLIER in the source (reorder / retake)
  - how much gets removed at a trim cut (median / 90th percentile)

Nothing in the project is changed. Writes to the Desktop:
  past_edits_report.txt   the summary
  past_edits_items.csv    every multicam piece, for deeper analysis later

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_scan_past_edits.py", encoding="utf-8").read())
"""

import csv
import os
import re
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional

# ──────────────────────────────────────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────────────────────────────────────
NAME_FILTER: Optional[str] = None   # regex on timeline names; None = every timeline
SOURCE_TOLERANCE = 1                # frames; a smaller source gap counts as continuous
DESKTOP = os.path.expanduser("~/Desktop")
REPORT_PATH = os.path.join(DESKTOP, "past_edits_report.txt")
CSV_PATH = os.path.join(DESKTOP, "past_edits_items.csv")

_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def get_resolve() -> Any:
    g = globals().get("resolve")
    if g is not None:
        return g
    import DaVinciResolveScript as dvr  # type: ignore
    return dvr.scriptapp("Resolve")


def pct(values: List[float], p: float) -> Optional[float]:
    if not values:
        return None
    v = sorted(values)
    return v[min(len(v) - 1, int(round(p * (len(v) - 1))))]


def fmt(x: Optional[float]) -> str:
    return "-" if x is None else f"{x:.1f}"


def angle_of(item_name: str, mc_name: str) -> str:
    if mc_name and item_name.startswith(mc_name + " - "):
        return item_name[len(mc_name) + 3:]
    return item_name.rsplit(" - ", 1)[-1] if " - " in item_name else "?"


def classify(prev: Dict[str, Any], cur: Dict[str, Any]) -> str:
    gap = cur["src_in"] - prev["src_out"]
    if abs(gap) <= SOURCE_TOLERANCE:
        return "switch" if cur["angle"] != prev["angle"] else "continue"
    if gap < 0:
        return "back"
    return "trim" if cur["angle"] != prev["angle"] else "jump"


def scan_timeline(tl: Any) -> Dict[str, Any]:
    fps = float(_safe(lambda: tl.GetSetting("timelineFrameRate"), 0) or 0) or 24.0
    tracks = int(_safe(lambda: tl.GetTrackCount("video"), 0) or 0)
    pieces: List[Dict[str, Any]] = []
    other = 0
    for t in range(1, tracks + 1):
        for it in _safe(lambda: tl.GetItemListInTrack("video", t), []) or []:
            mpi = _safe(lambda: it.GetMediaPoolItem())
            ctype = str(_safe(lambda: mpi.GetClipProperty("Type"), "") or "") if mpi else ""
            if "multicam" not in ctype.lower():
                other += 1
                continue
            mc_name = _safe(lambda: mpi.GetName(), "") or ""
            pieces.append({
                "track": t,
                "mc": mc_name,
                "angle": angle_of(str(_safe(lambda: it.GetName(), "")), mc_name),
                "start": int(_safe(lambda: it.GetStart(), 0)),
                "end": int(_safe(lambda: it.GetEnd(), 0)),
                "src_in": int(round(float(_safe(lambda: it.GetSourceStartFrame(), 0)))),
                "src_out": int(round(float(_safe(lambda: it.GetSourceEndFrame(), 0)))),
            })
    pieces.sort(key=lambda p: (p["track"], p["start"]))
    cuts = []
    for prev, cur in zip(pieces, pieces[1:]):
        if cur["track"] == prev["track"] and cur["mc"] == prev["mc"] and cur["start"] == prev["end"]:
            cuts.append({"kind": classify(prev, cur), "from": prev["angle"], "to": cur["angle"],
                         "removed": max(0, cur["src_in"] - prev["src_out"])})
    return {"fps": fps, "tracks": tracks, "pieces": pieces, "cuts": cuts, "other": other}


def main() -> None:
    r = get_resolve()
    project = r.GetProjectManager().GetCurrentProject()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' (read-only scan)")
    rx = re.compile(NAME_FILTER, re.IGNORECASE) if NAME_FILTER else None

    shot_len: Dict[str, List[float]] = defaultdict(list)
    removed: List[float] = []
    kinds: Counter = Counter()
    matrix: Counter = Counter()
    total_s = 0.0
    used = 0
    rows = []

    count = int(project.GetTimelineCount() or 0)
    say(f"{count} timeline(s).\n")
    say(f"{'timeline':40} {'pieces':>6} {'mins':>6} {'cuts/min':>8}  angles")
    for i in range(1, count + 1):
        tl = project.GetTimelineByIndex(i)
        name = str(_safe(lambda: tl.GetName(), "?"))
        if rx and not rx.search(name):
            continue
        res = scan_timeline(tl)
        pieces, fps = res["pieces"], res["fps"]
        if not pieces:
            say(f"{name[:40]:40} {'—':>6}  no multicam pieces ({res['other']} other video item(s))")
            continue
        used += 1
        dur_s = (max(p["end"] for p in pieces) - min(p["start"] for p in pieces)) / fps
        total_s += dur_s
        angles = Counter(p["angle"] for p in pieces)
        say(f"{name[:40]:40} {len(pieces):>6} {dur_s / 60:>6.1f} {len(res['cuts']) / max(dur_s / 60, 0.01):>8.1f}  "
            + ", ".join(f"{a}×{n}" for a, n in sorted(angles.items())))
        for p in pieces:
            shot_len[p["angle"]].append((p["end"] - p["start"]) / fps)
            rows.append([name, p["track"], p["angle"], p["start"], p["end"], p["end"] - p["start"],
                         p["src_in"], p["src_out"], p["mc"]])
        for c in res["cuts"]:
            kinds[c["kind"]] += 1
            if c["kind"] in ("switch", "trim"):
                matrix[(c["from"], c["to"])] += 1
            if c["kind"] in ("trim", "jump"):
                removed.append(c["removed"] / fps)

    say(f"\n== Summary: {used} edited timeline(s), {total_s / 60:.1f} min ==")
    if not used:
        say("No multicam pieces found. Were these timelines flattened, or cut from flat clips?")
        return
    say("\nShot length per angle (seconds): count, median, p10, p90")
    for a in sorted(shot_len):
        v = shot_len[a]
        say(f"  {a:20} {len(v):>5}  {fmt(pct(v, .5)):>6} {fmt(pct(v, .1)):>6} {fmt(pct(v, .9)):>6}")
    n_cuts = sum(kinds.values())
    say(f"\nCuts: {n_cuts} total, {n_cuts / max(total_s / 60, 0.01):.1f} per minute")
    for k in ("switch", "trim", "jump", "back", "continue"):
        say(f"  {k:9} {kinds[k]:>5}  ({100 * kinds[k] / max(n_cuts, 1):.0f}%)")
    if removed:
        say(f"Removed at trim/jump cuts (s): median {fmt(pct(removed, .5))}, p10 {fmt(pct(removed, .1))}, "
            f"p90 {fmt(pct(removed, .9))}, total {sum(removed) / 60:.1f} min")
    say("\nAngle switches (from → to): count")
    for (a, b), n in matrix.most_common(20):
        say(f"  {a} → {b}: {n}")

    try:
        with open(CSV_PATH, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["timeline", "track", "angle", "rec_start", "rec_end", "frames",
                        "src_in", "src_out", "multicam"])
            w.writerows(rows)
        say(f"\nEvery piece saved to {CSV_PATH}")
    except Exception as exc:
        say(f"(Couldn't save CSV: {exc})")


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(REPORT_PATH, "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
        print(f"\nReport saved to {REPORT_PATH}")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
