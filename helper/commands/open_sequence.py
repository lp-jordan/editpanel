"""Open (make current) a single timeline by uid or name.

Powers the per-sequence step of the "Open Sequences" edit function. The
renderer drives the loop — it fetches the bin's sequences via
list_bin_sequences, then calls open_sequence once per sequence with a short
delay between calls. Keeping each open as its own fast command (rather than one
long blocking Python loop with sleeps) lets the worker keep answering health
pings between sequences, so a large bin can't trip the ~30s unresponsive
watchdog and get the worker restarted mid-run.

Input:
  { "cmd": "open_sequence", "uid": str | None, "name": str | None }

At least one of uid / name is required; uid is preferred (rename-safe) and we
fall back to a name match.

Output:
  Success → { "result": True,  "name": str }
  Missing → { "result": False, "reason": "timeline_not_found" }
  Failed  → { "result": False, "reason": "set_current_timeline_failed: ...", "name": str }
"""

from typing import Any, Dict, Optional


def _find_timeline(project: Any, uid: Optional[str], name: Optional[str]) -> Optional[Any]:
    """Resolve has no FindTimelineByUid/Name, so iterate. Prefer the uid match
    (rename-safe); fall back to the first timeline whose name matches."""
    try:
        count = int(project.GetTimelineCount() or 0)
    except Exception:
        return None

    name_match = None
    for idx in range(1, count + 1):
        try:
            tl = project.GetTimelineByIndex(idx)
        except Exception:
            tl = None
        if not tl:
            continue
        if uid:
            try:
                if tl.GetUniqueId() == uid:
                    return tl
            except Exception:
                pass
        if name and name_match is None:
            try:
                if (tl.GetName() or "") == name:
                    name_match = tl
            except Exception:
                pass
    return name_match


def handle_open_sequence(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    uid = payload.get("uid")
    name = payload.get("name")
    uid = uid.strip() if isinstance(uid, str) else None
    name = name.strip() if isinstance(name, str) else None
    if not uid and not name:
        raise ValueError("uid or name is required")

    timeline = _find_timeline(rh.project, uid, name)
    if timeline is None:
        return {"result": False, "reason": "timeline_not_found", "name": name or ""}

    tl_name = name or ""
    try:
        tl_name = timeline.GetName() or tl_name
    except Exception:
        pass

    try:
        # SetCurrentTimeline is a no-op (no flicker) when it's already current.
        ok = bool(rh.project.SetCurrentTimeline(timeline))
    except Exception as exc:
        rh.log(f"open_sequence: SetCurrentTimeline failed for '{tl_name}': {exc}")
        return {"result": False, "reason": f"set_current_timeline_failed: {exc}", "name": tl_name}

    if not ok:
        rh.log(f"open_sequence: Resolve rejected SetCurrentTimeline for '{tl_name}'")
        return {"result": False, "reason": "set_current_timeline_rejected", "name": tl_name}

    rh.log(f"Opened sequence '{tl_name}'")
    return {"result": True, "name": tl_name}
