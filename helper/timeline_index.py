"""Background index of the current Resolve project's timelines (name -> index).

Why: Resolve's scripting API has no "find timeline by name", so the pre-export
check and the export queue both used to walk EVERY timeline in the project
(GetTimelineByIndex + GetName, one Resolve round trip each) before doing any
real work. On a large project that is hundreds of round trips, twice per export.

How it works:
  * After connect, and whenever the open project or its timeline count
    changes, a daemon thread walks the timeline list in small chunks (pausing
    between chunks so foreground commands interleave) and records
    {name: [index, ...]}. Which bin a timeline sits in doesn't matter — the
    index is the project's timeline list, not the Media Pool.
  * find_timelines() looks the wanted names up in the index and VERIFIES each
    hit with one call (GetTimelineByIndex(i).GetName() == name), so a rename
    or reorder can never return the wrong timeline.
  * It falls back to a full foreground walk (the old behaviour, which also
    refreshes the index) only when the index isn't usable: not built yet for
    this project, the timeline count changed, or a wanted name was missing or
    failed verification.

Every lookup logs how it was answered and how long it took, so a slow export
shows exactly where the time went.

Persistence: each project's index is saved to
$EDITPANEL_DATA_DIR/timeline-index/<project key>.json (the Electron userData
folder), keyed by Resolve's project unique id (falling back to the name on
builds without one). On connect or project switch the saved index loads
instantly; a timeline-count mismatch then triggers a background rebuild. A
stale saved index is harmless — every hit is still verified before use.
"""

import hashlib
import json
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

_CHUNK = 25            # timelines per background chunk
_CHUNK_PAUSE_S = 0.05  # yield between chunks so foreground commands get a turn

_lock = threading.Lock()
_state: Dict[str, Any] = {
    "project": None,   # project key (unique id, else name) the index belongs to
    "count": None,     # GetTimelineCount() when the index was built
    "by_name": {},     # name -> [1-based index, ...]
    "built_at": None,
}
_building = threading.Event()
_generation = 0  # bumped on invalidate so an in-flight background walk discards its result


def _project_key(project: Any) -> Optional[str]:
    """Resolve's project unique id when available (two projects can share a
    name), else the project name."""
    try:
        uid = project.GetUniqueId()
        if uid:
            return f"id:{uid}"
    except Exception:
        pass
    try:
        name = project.GetName()
        return f"name:{name}" if name else None
    except Exception:
        return None


def _index_path(key: str) -> Optional[str]:
    base = os.environ.get("EDITPANEL_DATA_DIR")
    if not base or not key:
        return None
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()
    return os.path.join(base, "timeline-index", f"{digest}.json")


def _save(key: Optional[str], count: int, by_name: Dict[str, List[int]]) -> None:
    path = _index_path(key or "")
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"project": key, "count": count, "by_name": by_name,
                       "saved_at": time.time()}, fh)
        os.replace(tmp, path)
    except Exception:
        pass  # persistence is an optimisation; never fail a lookup over it


def _load(key: Optional[str]) -> Optional[Dict[str, Any]]:
    path = _index_path(key or "")
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("project") != key or not isinstance(data.get("by_name"), dict):
            return None
        return data
    except Exception:
        return None


def _timeline_count(project: Any) -> int:
    try:
        return int(project.GetTimelineCount() or 0)
    except Exception:
        return 0


def _walk(project: Any, count: int, pause: bool) -> Dict[str, List[int]]:
    by_name: Dict[str, List[int]] = {}
    for idx in range(1, count + 1):
        try:
            tl = project.GetTimelineByIndex(idx)
            name = tl.GetName() if tl else None
        except Exception:
            name = None
        if name:
            by_name.setdefault(name, []).append(idx)
        if pause and idx % _CHUNK == 0:
            time.sleep(_CHUNK_PAUSE_S)
    return by_name


def _store(key: Optional[str], count: int, by_name: Dict[str, List[int]], persist: bool = True) -> None:
    with _lock:
        _state.update(project=key, count=count, by_name=by_name, built_at=time.time())
    if persist:
        _save(key, count, by_name)


def invalidate() -> None:
    """Forget the index (project closed/switched)."""
    global _generation
    with _lock:
        _generation += 1
        _state.update(project=None, count=None, by_name={}, built_at=None)


def rebuild_in_background(project: Any, log: Optional[Callable[[str], None]] = None) -> None:
    """Start a background walk unless one is already running."""
    if project is None or _building.is_set():
        return
    _building.set()
    with _lock:
        gen = _generation

    def _run() -> None:
        try:
            t0 = time.time()
            name = _project_key(project)
            count = _timeline_count(project)
            by_name = _walk(project, count, pause=True)
            with _lock:
                stale = gen != _generation
            if not stale:
                _store(name, count, by_name)
                if log:
                    log(f"[timelines] Indexed {count} timelines in the background ({time.time() - t0:.1f}s).")
        except Exception:
            pass
        finally:
            _building.clear()

    threading.Thread(target=_run, name="timeline-index", daemon=True).start()


def note_possible_change(project: Any, log: Optional[Callable[[str], None]] = None) -> None:
    """Cheap staleness check (one call). Rebuild in the background when the open
    project or its timeline count differs from what the index was built from."""
    if project is None:
        return
    name = _project_key(project)
    count = _timeline_count(project)
    with _lock:
        same = _state["project"] == name and _state["count"] == count
    if not same:
        rebuild_in_background(project, log)


def load_or_rebuild(project: Any, log: Optional[Callable[[str], None]] = None) -> None:
    """On connect / project switch: use this project's saved index if there is
    one, then rebuild in the background if its timeline count is out of date."""
    if project is None:
        return
    key = _project_key(project)
    data = _load(key)
    if data:
        by_name = {str(k): [int(i) for i in v] for k, v in data["by_name"].items()}
        _store(key, int(data.get("count") or 0), by_name, persist=False)
        if log:
            log(f"[timelines] Loaded saved index ({data.get('count')} timelines).")
        note_possible_change(project, log)
    else:
        rebuild_in_background(project, log)


def is_timeline_clip(clip: Any) -> bool:
    """True unless Resolve says this Media Pool item is something other than a
    timeline. Unknown → True (conservative: we then insist on finding it)."""
    try:
        kind = clip.GetClipProperty("Type")
    except Exception:
        return True
    return not kind or str(kind).strip().lower() == "timeline"


def find_timelines(project: Any, names: List[str],
                   log: Callable[[str], None],
                   required: Optional[List[str]] = None) -> List[Tuple[str, Any]]:
    """Return [(name, timeline), ...] for every project timeline whose name is in
    *names*, in project order — the same result as walking the whole list.

    *required* are names that are known to be timelines (see is_timeline_clip).
    A required name missing from the index means the index is out of date (e.g.
    a rename) and forces a full walk; any other missing name (a video file in
    the bin) is simply not a timeline. Defaults to all of *names*."""
    wanted = set(n for n in names if n)
    must_find = wanted if required is None else set(n for n in required if n) & wanted
    if not wanted:
        return []
    t0 = time.time()
    proj_name = _project_key(project)
    count = _timeline_count(project)

    with _lock:
        usable = (_state["project"] == proj_name and _state["count"] == count
                  and _state["built_at"] is not None)
        by_name = dict(_state["by_name"]) if usable else {}

    if usable:
        hits: List[Tuple[int, str, Any]] = []
        ok = True
        calls = 0
        for name in wanted:
            idxs = by_name.get(name)
            if not idxs:
                if name in must_find:
                    ok = False
                    break
                continue
            for idx in idxs:
                calls += 1
                try:
                    tl = project.GetTimelineByIndex(idx)
                    if not tl or tl.GetName() != name:
                        ok = False
                        break
                except Exception:
                    ok = False
                    break
                hits.append((idx, name, tl))
            if not ok:
                break
        if ok:
            hits.sort(key=lambda h: h[0])
            log(f"[timelines] Found {len(hits)} of {count} timelines from the index "
                f"({calls} checks, {time.time() - t0:.1f}s).")
            return [(name, tl) for _idx, name, tl in hits]
        reason = "a timeline was renamed or added"
    else:
        reason = ("the index isn't built yet" if _building.is_set() or _state["built_at"] is None
                  else "the timeline count changed")

    # Fallback: full walk in the foreground (old behaviour), refreshing the index.
    log(f"[timelines] Scanning all {count} timelines ({reason})…")
    by_name = _walk(project, count, pause=False)
    _store(proj_name, count, by_name)
    matched = sorted((idx, name) for name in wanted for idx in by_name.get(name, []))
    out: List[Tuple[str, Any]] = []
    for idx, name in matched:
        try:
            tl = project.GetTimelineByIndex(idx)
        except Exception:
            tl = None
        if tl:
            out.append((name, tl))
    log(f"[timelines] Full scan of {count} timelines took {time.time() - t0:.1f}s; matched {len(out)}.")
    return out
