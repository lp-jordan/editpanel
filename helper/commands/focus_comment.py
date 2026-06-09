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

──────────────────────────────────────────────────────────────────────────
2026-06-09 fix (matches the sync_comment_markers gotcha at L145-156):

Resolve's AddMarker(frameId, ...) writes markers at a 0-relative content
frame (frame 0 = first frame of content, regardless of GetStartTimecode).
The ruler DISPLAYS that marker at `start_tc + frameId/fps`.

But Timeline.SetCurrentTimecode takes the ABSOLUTE ruler TC — not a
0-relative one. For any timeline whose start TC isn't 00:00:00:00 —
i.e. the editorial default 01:00:00:00, or ATEM TOD wall-clock starts —
passing `_frames_to_tc(frame, fps)` directly (which produces a TC counted
from 00:00:00:00) puts the playhead BEFORE the timeline's range and
Resolve silently rejects the call. From the editor's POV: "I'm in the
right timeline, nothing happens."

The fix is symmetric to the 2026-06-02 first-cut bug in
sync_comment_markers (which placed markers ~86,400 frames PAST the
visible content because the placement path was adding GetStartFrame() to
a value that already lived in 0-relative coordinates). Here, the jump
path needs to ADD the start TC instead of using zero.

Implementation:
  start_tc_seconds = parse(timeline.GetStartTimecode())  # non-drop
  target_tc_seconds = start_tc_seconds + frame / fps
  tc = format(target_tc_seconds, fps)
  Timeline.SetCurrentTimecode(tc)
──────────────────────────────────────────────────────────────────────────
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


def _tc_to_seconds(tc: str, fps: float) -> float:
    """Parse a HH:MM:SS:FF TC string to absolute seconds. Non-drop only —
    matches the limitation called out across the codebase. Returns 0.0 on
    any parse failure so the caller fails open (start-TC = 00:00:00:00
    behaviour), not closed (jump aborted)."""
    if not isinstance(tc, str) or fps <= 0:
        return 0.0
    parts = tc.strip().split(":")
    if len(parts) != 4:
        return 0.0
    try:
        hh, mm, ss, ff = (int(p) for p in parts)
    except (TypeError, ValueError):
        return 0.0
    return hh * 3600.0 + mm * 60.0 + ss + (ff / fps)


def _seconds_to_tc(total_seconds: float, fps: float) -> str:
    """Inverse of _tc_to_seconds. Rounds the fractional part to the nearest
    frame at fps; clamps frame count to [0, fps-1] to keep TC well-formed
    even when float rounding tips the last frame over the second boundary."""
    if fps <= 0:
        fps = 24.0
    if total_seconds < 0:
        total_seconds = 0.0
    whole = int(total_seconds)
    frac = total_seconds - whole
    ff = int(round(frac * fps))
    if ff >= int(round(fps)):
        whole += 1
        ff = 0
    hh = whole // 3600
    mm = (whole % 3600) // 60
    ss = whole % 60
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def _frames_to_tc(frame: int, fps: float) -> str:
    """0-relative frame→TC. Retained for callers that want a TC from
    frame 0 (e.g. duration formatting); for playhead positioning use
    start_tc + frame/fps via _tc_to_seconds + _seconds_to_tc."""
    if fps <= 0:
        fps = 24.0
    total_frames = max(0, int(frame))
    return _seconds_to_tc(total_frames / fps, fps)


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
    # SetCurrentTimecode takes an ABSOLUTE ruler TC, not a 0-relative one.
    # See the module docstring for the full gotcha; the short version:
    # `frame` here is the 0-relative content frame the marker was placed at,
    # but the ruler displays it at `start_tc + frame/fps`. Passing the
    # 0-relative TC directly silently no-ops for any non-zero-start timeline
    # (i.e. 01:00:00:00 default, ATEM TOD wall-clock starts, etc).
    #
    # The frame stored in the comment record was computed at render time
    # against the captured fps. If the editor has since changed fps the
    # placement might land slightly off, but that's a deeper problem out of
    # scope here.
    try:
        fps = float(timeline.GetSetting("timelineFrameRate") or 24.0)
    except Exception:
        fps = 24.0

    start_tc = ""
    get_start_tc = getattr(timeline, "GetStartTimecode", None)
    if callable(get_start_tc):
        try:
            start_tc = get_start_tc() or ""
        except Exception:
            start_tc = ""
    start_seconds = _tc_to_seconds(start_tc, fps) if start_tc else 0.0
    target_seconds = start_seconds + (frame / fps if fps > 0 else 0.0)
    tc = _seconds_to_tc(target_seconds, fps)

    ok = False
    set_tc = getattr(timeline, "SetCurrentTimecode", None)
    if callable(set_tc):
        try:
            ok = bool(set_tc(tc))
        except Exception:
            ok = False
    if not ok:
        rh.log(
            f"focus_comment: SetCurrentTimecode rejected tc={tc} "
            f"(start_tc={start_tc or '00:00:00:00'}, frame={frame}, fps={fps})"
        )
        return {"result": False, "reason": "goto_failed", "timeline_name": timeline_name}

    rh.log(f"Jumped to {timeline_name} @ {tc} (start_tc={start_tc or '00:00:00:00'}, frame={frame})")
    return {"result": True, "timeline_name": timeline_name, "frame": frame, "tc": tc}
