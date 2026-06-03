"""Phase 5c.10 (2026-06-03): delete one frameio:* marker from a specific
timeline by commentId.

Called by the orchestrator immediately after a successful Mark-complete
through-write to LPOS, so the marker disappears from the timeline at the
same moment the comment is resolved upstream — no stale visual cue.

Lighter-weight than running a full sync_comment_markers cycle just to drop
one marker.

Input:
  { "cmd": "delete_comment_marker", "timeline_uid": str, "comment_id": str }

Output:
  Success → { "result": True, "deleted": bool, "timeline_name": str }
    deleted=True means the marker was found and removed.
    deleted=False means the marker didn't exist (already gone — also success).
  Timeline missing → { "result": False, "reason": "timeline_not_found" }
"""

from typing import Any, Dict, Optional


FRAMEIO_TAG_PREFIX = "frameio:"


def _find_timeline_by_uid(project: Any, target_uid: str) -> Optional[Any]:
    try:
        count = int(project.GetTimelineCount() or 0)
    except Exception:
        return None
    for idx in range(1, count + 1):
        try:
            tl = project.GetTimelineByIndex(idx)
            if tl and tl.GetUniqueId() == target_uid:
                return tl
        except Exception:
            continue
    return None


def handle_delete_comment_marker(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    timeline_uid = payload.get("timeline_uid")
    if not isinstance(timeline_uid, str) or not timeline_uid.strip():
        raise ValueError("timeline_uid is required")
    comment_id = payload.get("comment_id")
    if not isinstance(comment_id, str) or not comment_id.strip():
        raise ValueError("comment_id is required")

    timeline = _find_timeline_by_uid(rh.project, timeline_uid)
    if timeline is None:
        return {"result": False, "reason": "timeline_not_found"}

    timeline_name = ""
    try:
        timeline_name = timeline.GetName() or ""
    except Exception:
        pass

    custom_data = f"{FRAMEIO_TAG_PREFIX}{comment_id}"

    # DeleteMarkerByCustomData is the cleanest path. If Resolve doesn't have
    # it (older builds), fall back to scanning + deleting by frame.
    deleted = False
    try:
        deleted = bool(timeline.DeleteMarkerByCustomData(custom_data))
    except Exception:
        deleted = False

    if not deleted:
        # Fallback path. GetMarkers returns {frame: marker_dict}; find ours and
        # call DeleteMarkerAtFrame.
        try:
            markers = timeline.GetMarkers() or {}
            for frame, marker in markers.items():
                if not isinstance(marker, dict):
                    continue
                cd = marker.get("customData") or marker.get("custom_data") or ""
                if cd == custom_data:
                    try:
                        deleted = bool(timeline.DeleteMarkerAtFrame(int(frame)))
                    except Exception:
                        deleted = False
                    break
        except Exception:
            pass

    return {"result": True, "deleted": bool(deleted), "timeline_name": timeline_name}
