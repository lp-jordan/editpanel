"""Phase 5c.2 (2026-06-02): desired-state reconciliation of Frame.io comment
markers on a Resolve timeline.

This command is the only writer of `frameio:*`-tagged markers in editpanel. The
orchestrator (electron/main.js, 5c.3) gathers comments from LPOS, drops anything
already marked completed, formats name/note, and hands the unresolved set to
this helper as the "desired state" for the timeline. The helper:

  1. Locates the timeline by uid (Resolve 20: Timeline.GetUniqueId()).
  2. Reads existing markers and identifies the frameio:* tagged subset.
  3. Removes any frameio:* marker whose commentId isn't in the target set —
     covers BOTH "comment now completed in LPOS" AND "comment deleted upstream"
     in one rule.
  4. Adds any target comment that doesn't already have a marker.
  5. Leaves markers whose commentId is still in target untouched — preserves
     manual note edits the editor made between pulls.

Out-of-range comment behaviour (locked 2026-06-02): no pre-check on
GetEndFrame(). Just attempt the AddMarker and aggregate the API's return value
into the `skipped` list, so any rejection — timeline shortened, drop-frame
mismatch, anything else — surfaces uniformly in the JobPanel result row.

Input payload (from orchestrator):
  {
    "cmd": "sync_comment_markers",
    "timeline_uid": "abc-123",
    "fps": 23.976,              # captured at render time, NOT current timeline fps
    "target_comments": [
      {
        "commentId":   "fio-...",  # used as the frameio:{...} tether tag
        "timestamp_s": 42.3,        # seconds from output frame 0
        "duration_s":  4.1 | None,
        "name":        "Jane · 00:00:42",
        "note":        "Audio drop\n  ↳ Bob: confirmed at 0:42"
      },
      ...
    ]
  }

Output:
  Success → {
    "result":    True,
    "placed":    int,            # newly added markers this pull
    "removed":   int,            # frameio:* markers deleted (completed or upstream-deleted)
    "kept":      int,            # frameio:* markers left untouched
    "skipped":   [{"commentId": str, "frame": int, "reason": str}, ...],
    "timeline_name": str         # latest known name, for display
  }
  Timeline missing → { "result": False, "reason": "timeline_not_found" }
"""

from typing import Any, Dict, List, Optional, Tuple


FRAMEIO_TAG_PREFIX = "frameio:"
MARKER_COLOR = "Red"


def _find_timeline_by_uid(project: Any, target_uid: str) -> Optional[Any]:
    """Iterate timelines in the current project and return the one whose
    GetUniqueId() matches target_uid. Returns None if no match — handled at the
    caller as `timeline_not_found`, which the orchestrator surfaces per-row in
    the JobPanel result rather than failing the whole pull.

    Resolve has no FindTimelineByUid; iteration over GetTimelineCount() is the
    only path. Typical projects have <100 timelines so this is fast in practice.
    """
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
            # Older Resolve builds / corrupt timeline entries — skip and keep iterating.
            continue
    return None


def _extract_existing_frameio_markers(timeline: Any) -> Dict[str, Tuple[int, Dict[str, Any]]]:
    """Read every marker on the timeline, filter to those whose customData carries
    the `frameio:` prefix, and return {commentId -> (frame, marker_dict)}.

    Resolve's GetMarkers() returns a {frame -> marker_dict} mapping. Marker dicts
    have used both `customData` and `custom_data` keys across builds — read both
    defensively. Markers without a frameio:* tag are left alone (manual editor
    markers, recording/note markers from other phases).
    """
    try:
        markers = timeline.GetMarkers() or {}
    except Exception:
        return {}
    result: Dict[str, Tuple[int, Dict[str, Any]]] = {}
    for frame, marker in markers.items():
        if not isinstance(marker, dict):
            continue
        # Defensive: Resolve has used both spellings of this field across versions.
        cd = marker.get("customData") or marker.get("custom_data") or ""
        if not isinstance(cd, str) or not cd.startswith(FRAMEIO_TAG_PREFIX):
            continue
        comment_id = cd[len(FRAMEIO_TAG_PREFIX):].strip()
        if not comment_id:
            continue
        result[comment_id] = (int(frame), marker)
    return result


def handle_sync_comment_markers(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    timeline_uid = payload.get("timeline_uid")
    if not isinstance(timeline_uid, str) or not timeline_uid.strip():
        raise ValueError("timeline_uid is required")

    fps_raw = payload.get("fps")
    if not isinstance(fps_raw, (int, float)) or fps_raw <= 0:
        raise ValueError("fps must be a positive number")
    fps = float(fps_raw)

    target_comments = payload.get("target_comments") or []
    if not isinstance(target_comments, list):
        raise ValueError("target_comments must be a list")

    timeline = _find_timeline_by_uid(rh.project, timeline_uid)
    if timeline is None:
        return {"result": False, "reason": "timeline_not_found"}

    timeline_name: str = ""
    try:
        timeline_name = timeline.GetName() or ""
    except Exception:
        pass

    # Resolve's AddMarker(frameId, …) takes a 0-relative frame index into the
    # timeline content (frame 0 = first frame, regardless of GetStartTimecode).
    # The ruler displays that frame at start_tc + frameId/fps. So a comment at
    # render-relative second X lands at frame round(X * fps_at_render) — we do
    # NOT add GetStartFrame() (that's the absolute project-coordinate frame of
    # the timeline start, which is NOT what AddMarker expects).
    #
    # 2026-06-02 first-cut bug: this code originally added GetStartFrame(),
    # which for a 01:00:00:00-start timeline put markers ~86,400 frames past
    # the visible content. AddMarker silently accepted (returned True) and
    # the editor saw "1 placed" but no marker on the timeline. Verified by
    # cross-checking add_marker.py which already places markers as 0-relative.

    existing = _extract_existing_frameio_markers(timeline)
    target_ids = set()
    for c in target_comments:
        cid = c.get("commentId") if isinstance(c, dict) else None
        if isinstance(cid, str) and cid.strip():
            target_ids.add(cid)

    existing_ids = set(existing.keys())
    to_remove_ids = existing_ids - target_ids
    to_add = [c for c in target_comments if isinstance(c, dict)
              and isinstance(c.get("commentId"), str)
              and c["commentId"] not in existing_ids]
    kept = len(existing_ids & target_ids)

    # ── Remove (frameio:* markers no longer in target — completed in LPOS or
    #    deleted upstream) ────────────────────────────────────────────────────
    removed = 0
    for cid in to_remove_ids:
        custom_data = f"{FRAMEIO_TAG_PREFIX}{cid}"
        ok = False
        try:
            ok = bool(timeline.DeleteMarkerByCustomData(custom_data))
        except Exception:
            ok = False
        if not ok:
            # Fallback: delete by frame if customData-based delete is unsupported.
            try:
                frame, _ = existing[cid]
                ok = bool(timeline.DeleteMarkerAtFrame(frame))
            except Exception:
                ok = False
        if ok:
            removed += 1

    # ── Add (target comments not yet on the timeline) ─────────────────────────
    placed = 0
    skipped: List[Dict[str, Any]] = []
    for comment in to_add:
        cid = comment["commentId"]
        try:
            timestamp_s = float(comment.get("timestamp_s") or 0.0)
        except (TypeError, ValueError):
            skipped.append({"commentId": cid, "frame": -1,
                            "reason": "invalid timestamp_s"})
            continue
        duration_raw = comment.get("duration_s")
        try:
            duration_s = float(duration_raw) if duration_raw is not None else 0.0
        except (TypeError, ValueError):
            duration_s = 0.0

        marker_frame = int(round(timestamp_s * fps))
        duration_frames = max(1, int(round(duration_s * fps))) if duration_s > 0 else 1
        name = str(comment.get("name") or "")
        note = str(comment.get("note") or "")
        custom_data = f"{FRAMEIO_TAG_PREFIX}{cid}"

        # Locked behaviour 2026-06-02: just attempt. Don't pre-check against
        # GetEndFrame — Resolve's own response is the source of truth for
        # whether the frame is placeable. Any rejection (out-of-range, drop-
        # frame mismatch, etc.) becomes a skipped[] row with the frame number
        # so the editor sees exactly where it tried.
        try:
            ok = bool(timeline.AddMarker(marker_frame, MARKER_COLOR, name, note,
                                          duration_frames, custom_data))
        except Exception as exc:
            skipped.append({"commentId": cid, "frame": marker_frame,
                            "reason": f"AddMarker raised: {exc}"})
            continue
        if ok:
            placed += 1
        else:
            skipped.append({"commentId": cid, "frame": marker_frame,
                            "reason": "AddMarker returned False (likely out of range)"})

    return {
        "result": True,
        "placed": placed,
        "removed": removed,
        "kept": kept,
        "skipped": skipped,
        "timeline_name": timeline_name,
    }
