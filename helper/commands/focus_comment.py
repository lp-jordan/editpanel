"""Phase 5c.10 (2026-06-03): switch to a timeline by uid and move the playhead
to a specific frame in one atomic call.

Powers the "Jump" button on every comment row in the CommentPullReport. The
editor clicks a comment → Resolve switches to its timeline → the playhead
lands on the marker frame. Zero context-switching, no manual lookup.

Input:
  { "cmd": "focus_comment", "timeline_uid": str, "frame": int }

Output:
  Success → { "result": True, "timeline_name": str, "frame": int }
  Timeline missing → { "result": False, "reason": "timeline_not_found" }
  Goto failed → { "result": False, "reason": "goto_failed", "timeline_name": str }
"""

from typing import Any, Dict, Optional


def _find_timeline_by_uid(project: Any, target_uid: str) -> Optional[Any]:
    """Same lookup pattern as sync_comment_markers — Resolve has no
    FindTimelineByUid so we iterate. Defensive against older builds that
    might throw on GetUniqueId for some timelines."""
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


def _frames_to_tc(frame: int, fps: float) -> str:
    """Best-effort frame→TC conversion for SetCurrentTimecode. Non-drop only;
    drop-frame TC is a known footgun documented elsewhere. Mirrors the
    conversion already in helper/commands/spellcheck.py to avoid drift."""
    if fps <= 0:
        fps = 24.0
    total_frames = max(0, int(frame))
    hh = int(total_frames // (3600 * fps))
    rem = total_frames - int(hh * 3600 * fps)
    mm = int(rem // (60 * fps))
    rem -= int(mm * 60 * fps)
    ss = int(rem // fps)
    ff = int(rem - int(ss * fps))
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def handle_focus_comment(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    timeline_uid = payload.get("timeline_uid")
    if not isinstance(timeline_uid, str) or not timeline_uid.strip():
        raise ValueError("timeline_uid is required")
    frame_raw = payload.get("frame")
    try:
        frame = int(frame_raw)
    except (TypeError, ValueError):
        raise ValueError("frame must be an integer")

    timeline = _find_timeline_by_uid(rh.project, timeline_uid)
    if timeline is None:
        return {"result": False, "reason": "timeline_not_found"}

    # Switch to the timeline first. If it's already current, this is a no-op
    # in Resolve (no flicker). After this, rh.timeline gets refreshed by the
    # background monitor thread, but for our scope we operate on the local
    # `timeline` handle.
    try:
        rh.project.SetCurrentTimeline(timeline)
    except Exception as exc:
        return {"result": False, "reason": f"set_current_timeline_failed: {exc}"}

    timeline_name = ""
    try:
        timeline_name = timeline.GetName() or ""
    except Exception:
        pass

    # Resolve a TC string from the frame using the timeline's current fps —
    # SetCurrentTimecode takes a TC string. The frame stored in the comment
    # record was computed at render time against the captured fps; if the
    # editor has since changed fps the placement might land at a slightly
    # different visual position, but that's a deeper problem than scope here.
    try:
        fps = float(timeline.GetSetting("timelineFrameRate") or 24.0)
    except Exception:
        fps = 24.0
    tc = _frames_to_tc(frame, fps)

    ok = False
    set_tc = getattr(timeline, "SetCurrentTimecode", None)
    if callable(set_tc):
        try:
            ok = bool(set_tc(tc))
        except Exception:
            ok = False
    if not ok:
        return {"result": False, "reason": "goto_failed", "timeline_name": timeline_name}

    rh.log(f"Jumped to {timeline_name} @ {tc} (frame {frame})")
    return {"result": True, "timeline_name": timeline_name, "frame": frame}
