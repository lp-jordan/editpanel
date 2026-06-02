"""Phase 5c.5 (2026-06-02): enumerate the current Resolve project's timelines.

Returns one row per timeline with `name` + `uid` so the orchestrator can fan a
comment pull across every timeline in the project without asking the editor
which LPOS project to query — the uids carry the tether back to whichever LPOS
project(s) each timeline was uploaded to.

Output:
  {
    "project_name": str | None,
    "timelines": [
      { "name": str, "uid": str | None },
      ...
    ]
  }

`uid` is None on a Resolve build where `Timeline.GetUniqueId()` isn't available
(< Resolve 19). User-confirmed target is Resolve 20 so this should be populated
in practice; degraded behavior on older builds is None which the orchestrator
filters out (no tether → can't match to LPOS asset).
"""

from typing import Any, Dict, List, Optional


def handle_list_timelines(_payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    project = rh.project
    project_name: Optional[str] = None
    try:
        project_name = project.GetName()
    except Exception:
        project_name = None

    timelines: List[Dict[str, Any]] = []
    try:
        count = int(project.GetTimelineCount() or 0)
    except Exception:
        count = 0

    for idx in range(1, count + 1):
        try:
            tl = project.GetTimelineByIndex(idx)
        except Exception:
            tl = None
        if not tl:
            continue
        try:
            name = tl.GetName() or ""
        except Exception:
            name = ""
        uid: Optional[str] = None
        try:
            uid = tl.GetUniqueId()
        except Exception:
            uid = None
        timelines.append({"name": name, "uid": uid})

    return {"project_name": project_name, "timelines": timelines}
