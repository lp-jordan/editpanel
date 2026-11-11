#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cut-through: helpers the pipeline scripts share (and helper/commands, through ct_common.py).

Not a step: nothing runs on import. The scripts load it from their own folder with a small
_common() loader instead of `import common`, because they run three ways (plain `python x.py`,
exec'd by EditPanel's Resolve worker with __file__ set, and pasted into Resolve's console without
__file__), and Resolve's long-lived Python would otherwise keep a stale copy in sys.modules.

  Resolve media pool   ARCHIVE_BINS, _safe, walk
  FCPXML               secs, attrs, frame_duration, bundle_xml, export_multicam
  angles               cam_no, angle_of
  recordings           group_spans, merge_spans
  timecode             tc_to_frames, frames_to_tc, _is_drop_frame
"""
import os
import re
import shutil
from fractions import Fraction
from typing import Any, Callable, List, Optional

# the original multicam is out of play in these. "MC QUARANTINE" is the archive bin's old name:
# projects built before it was renamed still have their original multicam there
ARCHIVE_BINS = {"MC ORIGINAL", "MC QUARANTINE"}
DEFAULT_FD = Fraction(1001, 24000)        # 23.976, when an export doesn't say


# ── Resolve media pool ───────────────────────────────────────────────────────
def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def walk(folder: Any, skip=ARCHIVE_BINS):
    """Every (bin, clip) under `folder`, leaving out bins named in `skip` (the archive bins)."""
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield folder, clip
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        if _safe(lambda: sub.GetName()) not in skip:
            yield from walk(sub, skip)


# ── FCPXML ───────────────────────────────────────────────────────────────────
def secs(v: str) -> Fraction:
    """An FCPXML time ("1001/24000s", "3600s") as exact seconds."""
    v = v.rstrip("s")
    if "/" in v:
        n, d = v.split("/")
        return Fraction(int(n), int(d))
    return Fraction(v)


def attrs(tag: str) -> dict:
    """An element's attributes, whatever order Resolve wrote them in (it differs by version)."""
    return dict(re.findall(r'([\w:-]+)="([^"]*)"', tag))


def frame_duration(xml: str, mc_names=None) -> Fraction:
    """The multicam's frame duration from its <format frameDuration>, so a 25p or 29.97 day builds
    at its own rate (23.976 only when the export doesn't say). mc_names: only these multicams."""
    formats = {a.get("id"): a.get("frameDuration") for a in map(attrs, re.findall(r"<format ([^>]*)/?>", xml))}
    for m in re.finditer(r"<media ([^>]*)>\s*<multicam ([^>]*)>", xml):
        if mc_names and attrs(m.group(1)).get("name") not in mc_names:
            continue
        fd = formats.get(attrs(m.group(2)).get("format"))
        if fd:
            return secs(fd)
    return DEFAULT_FD


def bundle_xml(path: str) -> Optional[str]:
    """FCPXML 1.10+ exports as a bundle folder with Info.fcpxml inside; older ones as a file."""
    for p in (path, path + "d", os.path.splitext(path)[0] + ".fcpxmld"):
        if os.path.isfile(p):
            return p
        if os.path.isdir(p):
            inner = [os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(".fcpxml")]
            if inner:
                return inner[0]
    return None


def export_type(r: Any):
    """Newest FCPXML export this Resolve offers: (version, Resolve constant)."""
    for v in ("1_14", "1_13", "1_12", "1_11", "1_10", "1_9", "1_8"):
        val = _safe(lambda: getattr(r, f"EXPORT_FCPXML_{v}"))
        if val is not None:
            return v.replace("_", "."), val
    raise RuntimeError("This Resolve offers no FCPXML export type")


def export_multicam(r: Any, project: Any, mp: Any, mc: Any, label: str, out_dir: str):
    """The multicam's description straight from Resolve: a throwaway timeline holding just the
    multicam is exported as FCPXML (newest version offered) to <out_dir>/mcdef_<label>.fcpxml(d),
    then deleted again. Returns (version, the export's .fcpxml path or None if it failed, whether
    the throwaway timeline was deleted)."""
    version, etype = export_type(r)
    tmp = mp.CreateTimelineFromClips(f"Cut-through temp {label} layout", [mc])
    if not tmp:
        raise RuntimeError("Couldn't make the throwaway multicam timeline")
    mcdef = os.path.join(out_dir, f"mcdef_{label}.fcpxml")
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
    return version, (src if ok else None), gone


# ── angles ───────────────────────────────────────────────────────────────────
def cam_no(name: str) -> int:
    """An angle's camera number ("Camera 3" → 3), for camera order; 999 when it has none."""
    m = re.search(r"(\d+)\s*$", name or "")
    return int(m.group(1)) if m else 999


def angle_of(item_name: str, mc_name: str = None) -> str:
    """A multicam piece's active angle, from its item name ("<MC> - Camera 2"). With mc_name the
    multicam's own name is stripped off the front; without it, the text after the last " - "."""
    if mc_name and item_name.startswith(mc_name + " - "):
        return item_name[len(mc_name) + 3:]
    return item_name.rsplit(" - ", 1)[-1] if " - " in item_name else "?"


# ── recordings ───────────────────────────────────────────────────────────────
def group_spans(items, join, start: Callable = lambda x: x[0], end: Callable = lambda x: x[1],
                chain: bool = False) -> List[list]:
    """Clip ranges → the recordings they make (where the cameras rolled), as groups of the items,
    in the order given (sort them first). `join` is in the items' own unit (seconds, frames).
      chain=False: an item joins the recording when it starts no later than the recording's end
        + join, so overlapping or touching clips are one recording; it ends at its latest end.
      chain=True: an item joins only when it starts within ±join of the previous item's end —
        gapless file chunks of one recording (a long ATEM recording split across files); an
        overlap bigger than join starts a new recording.
    An item with no start (None), or after one with no end, starts a new recording."""
    groups: List[list] = []
    group_end = None
    for it in items:
        a, b = start(it), end(it)
        if groups and a is not None and group_end is not None and (
                abs(a - group_end) <= join if chain else a <= group_end + join):
            groups[-1].append(it)
            group_end = b if chain else max(group_end, b)
        else:
            groups.append([it])
            group_end = b
    return groups


def merge_spans(ranges, join, min_len=0) -> List[list]:
    """[start, end] ranges → the recordings, [[start, end], ...] in order: ranges that overlap or
    sit within `join` of each other merge; recordings shorter than min_len are dropped."""
    out = [[g[0][0], max(r[1] for r in g)] for g in group_spans(sorted(ranges), join)]
    return [s for s in out if s[1] - s[0] >= min_len]


# ── timecode ─────────────────────────────────────────────────────────────────
def _is_drop_frame(tc: str) -> bool:
    return ";" in tc


def _round_fps(fps: float) -> int:
    return int(round(fps))


def tc_to_frames(tc: str, fps: float) -> int:
    tc = tc.strip()
    drop = _is_drop_frame(tc)
    parts = tc.replace(";", ":").split(":")
    if len(parts) != 4:
        raise ValueError(f"Bad timecode {tc!r}; expected HH:MM:SS:FF")
    hh, mm, ss, ff = (int(p) for p in parts)
    nominal = _round_fps(fps)
    if drop:
        drop_frames = 2 if nominal == 30 else (4 if nominal == 60 else 0)
        total_minutes = 60 * hh + mm
        return (
            (hh * 3600 + mm * 60 + ss) * nominal
            + ff
            - drop_frames * (total_minutes - total_minutes // 10)
        )
    return ((hh * 3600 + mm * 60 + ss) * nominal) + ff


def frames_to_tc(frame: int, fps: float, drop: bool = False) -> str:
    nominal = _round_fps(fps)
    sep = ";" if drop else ":"
    if drop:
        drop_frames = 2 if nominal == 30 else (4 if nominal == 60 else 0)
        fps_int = nominal
        frames_per_min = fps_int * 60 - drop_frames
        frames_per_10min = frames_per_min * 10 + drop_frames
        tens = frame // frames_per_10min
        rem = frame % frames_per_10min
        rem_min = 0 if rem < drop_frames else (rem - drop_frames) // frames_per_min
        minutes = tens * 10 + rem_min
        total = frame + drop_frames * (minutes - minutes // 10)
        ff = total % fps_int
        ss = (total // fps_int) % 60
        mm = (total // (fps_int * 60)) % 60
        hh = total // (fps_int * 3600)
        return f"{hh:02d}:{mm:02d}:{ss:02d}{sep}{ff:02d}"
    ff = frame % nominal
    ss = (frame // nominal) % 60
    mm = (frame // (nominal * 60)) % 60
    hh = frame // (nominal * 3600)
    return f"{hh:02d}:{mm:02d}:{ss:02d}{sep}{ff:02d}"
