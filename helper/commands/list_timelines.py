"""Phase 5c.5 (2026-06-02): enumerate the current Resolve project's timelines.

Returns one row per timeline with `name` + `uid` so the orchestrator can fan a
comment pull across every timeline in the project without asking the editor
which LPOS project to query — the uids carry the tether back to whichever LPOS
project(s) each timeline was uploaded to.

Phase 5c.11 extension (2026-06-08): also return `start_timecode` and `fps` per
timeline. Required by the Phase 3.5 orphan-export path: when the reconciler
picks up an untracked render and the user later assigns it to an LPOS project,
the push-to-LPOS upload now sends a full `renderMeta` block so an
`editorial_links` row gets written — same shape the render-triggered path uses.
`parseRenderMeta` on the LPOS side requires both fields, so we have to capture
them here at the moment the timeline is still loaded in Resolve.

Output:
  {
    "project_name": str | None,
    "timelines": [
      { "name": str,
        "uid": str | None,
        "start_timecode": str | None,
        "fps": float | None },
      ...
    ]
  }

`uid` is None on a Resolve build where `Timeline.GetUniqueId()` isn't available
(< Resolve 19). User-confirmed target is Resolve 20 so this should be populated
in practice; degraded behavior on older builds is None which the orchestrator
filters out (no tether → can't match to LPOS asset).

`start_timecode` / `fps` are best-effort: any API hiccup falls back to None and
the orchestrator skips building renderMeta for that timeline (asset uploads
untethered rather than uploading with a partial/bad payload that finalize would
reject with a 400).
"""

from typing import Any, Dict, List, Optional


def _parse_fps(raw: Any) -> Optional[float]:
    """Resolve's GetSetting('timelineFrameRate') returns a string like '23.976'
    or '24' — coerce to float, drop on garbage."""
    if raw is None:
        return None
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return None
    if val <= 0:
        return None
    return val


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
        start_tc: Optional[str] = None
        try:
            start_tc = tl.GetStartTimecode() or None
        except Exception:
            start_tc = None
        fps: Optional[float] = None
        try:
            fps = _parse_fps(tl.GetSetting('timelineFrameRate'))
        except Exception:
            fps = None
        timelines.append({
            "name": name,
            "uid": uid,
            "start_timecode": start_tc,
            "fps": fps,
        })

    return {"project_name": project_name, "timelines": timelines}
