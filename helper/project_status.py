"""Background read of the open project for the LPOS /editing project rings.

What LPOS needs (docs/editing-dashboard-plan.md, "project status rings"):
  * every timeline: name, unique id (LPOS matches it to uploaded renders) and its
    Media Pool flags (Green = reviewed, Yellow = left out)
  * every multicam outside cut-through's archive bins, with its flags

Why a background thread: every Resolve call costs ~30 ms
(spikes/spike_media_pool_timing.py on Elevate Pools, 2026-11-21). The timelines
take ~5-10 s, the multicam search ~70 s (it has to ask every Media Pool item its
Type). One long command would hold up EditPanel's other Resolve commands, so this
reads in small chunks with pauses between them, like helper/timeline_index.py.

The multicam list changes rarely: it is only re-read when EditPanel asks for it
(project opened, a cut-through step finished, or an hour since the last one) and
is kept per project in between.

Commands (helper/commands/project_status.py):
  project_status_refresh {multicams: bool} -> starts a read unless one is running
  project_status_get                        -> the last finished read + whether one is running
"""

import threading
import time
from typing import Any, Dict, List, Optional

_CHUNK = 20            # Resolve calls' worth of items per chunk
_CHUNK_PAUSE_S = 0.15  # yield between chunks so foreground commands get a turn
ARCHIVE_BINS = {"MC ORIGINAL", "MC QUARANTINE"}  # cut_through/common.py

_lock = threading.Lock()
_building = threading.Event()
_state: Dict[str, Any] = {
    "project": None,        # project name the read belongs to
    "read_at": None,        # epoch seconds the timeline read finished
    "seconds": None,        # how long it took
    "timelines": [],        # [{name, uid, flags}]
    "multicams": None,      # [{name, bin, flags}] or None when never read for this project
    "multicams_at": None,
    "error": None,
}


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _flags(item: Any) -> List[str]:
    raw = _safe(lambda: item.GetFlagList(), None) if item is not None else None
    if isinstance(raw, dict):
        raw = list(raw.values())
    if not isinstance(raw, (list, tuple)):
        return []
    return [str(f) for f in raw if f]


def _pause(n: int) -> None:
    if n and n % _CHUNK == 0:
        time.sleep(_CHUNK_PAUSE_S)


def read_timelines(project: Any, pause: bool = True) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    count = int(_safe(lambda: project.GetTimelineCount(), 0) or 0)
    for i in range(1, count + 1):
        tl = _safe(lambda: project.GetTimelineByIndex(i))
        if not tl:
            continue
        name = str(_safe(lambda: tl.GetName(), "") or "")
        if not name:
            continue
        item = _safe(lambda: tl.GetMediaPoolItem())  # Resolve 19+; flags live on the Media Pool item
        out.append({"name": name, "uid": _safe(lambda: tl.GetUniqueId()), "flags": _flags(item)})
        if pause:
            _pause(i)
    return out


def read_multicams(project: Any, skip_names: set, pause: bool = True) -> List[Dict[str, Any]]:
    """Multicams outside the archive bins. Items named like a timeline are skipped
    without asking their Type (they are the timelines themselves)."""
    found: List[Dict[str, Any]] = []
    root = _safe(lambda: project.GetMediaPool().GetRootFolder())
    stack = [(root, [])] if root else []
    calls = 0
    while stack:
        folder, path = stack.pop()
        for clip in _safe(lambda: folder.GetClipList(), []) or []:
            calls += 1
            if pause:
                _pause(calls)
            name = str(_safe(lambda: clip.GetName(), "") or "")
            if not name or name in skip_names:
                continue
            if "multicam" not in str(_safe(lambda: clip.GetClipProperty("Type"), "") or "").lower():
                continue
            found.append({"name": name, "bin": " / ".join(path), "flags": _flags(clip)})
        for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
            sub_name = str(_safe(lambda: sub.GetName(), "") or "")
            if sub_name in ARCHIVE_BINS:
                continue
            stack.append((sub, path + [sub_name]))
    return found


def refresh_in_background(project: Any, multicams: bool = False, log=None) -> bool:
    """Start a read unless one is running. Returns whether one was started."""
    if project is None or _building.is_set():
        return False
    _building.set()
    name = str(_safe(lambda: project.GetName(), "") or "")

    def _run() -> None:
        try:
            t0 = time.time()
            timelines = read_timelines(project)
            with _lock:
                same = _state["project"] == name
                need_mc = multicams or not same or _state["multicams"] is None
            mcs = read_multicams(project, {t["name"] for t in timelines}) if need_mc else None
            took = time.time() - t0
            with _lock:
                prev_mc = _state["multicams"] if same else None
                prev_mc_at = _state["multicams_at"] if same else None
                _state.update(
                    project=name, read_at=time.time(), seconds=round(took, 1), timelines=timelines,
                    multicams=mcs if mcs is not None else prev_mc,
                    multicams_at=time.time() if mcs is not None else prev_mc_at,
                    error=None,
                )
            if log:
                log(f"[project-status] {len(timelines)} timelines"
                    + (f", {len(mcs)} multicams" if mcs is not None else "")
                    + f" read in the background ({took:.1f}s)")
        except Exception as exc:  # never let the thread die loudly
            with _lock:
                _state["error"] = str(exc)
        finally:
            _building.clear()

    threading.Thread(target=_run, name="project-status", daemon=True).start()
    return True


def snapshot() -> Dict[str, Any]:
    with _lock:
        out = dict(_state)
        out["timelines"] = list(_state["timelines"])
        out["multicams"] = list(_state["multicams"]) if _state["multicams"] is not None else None
    out["building"] = _building.is_set()
    return out
