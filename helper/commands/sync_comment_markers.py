"""Desired-state reconciliation of LPOS review-comment markers on a Resolve
timeline.

This command is the only writer of comment markers in editpanel. The
orchestrator (electron/main.js) gathers comments from the LPOS comments system,
drops anything already marked done, formats name/note, and hands the unresolved
set to this helper as the "desired state" for the timeline. The helper:

  1. Locates the timeline by uid (Resolve 20: Timeline.GetUniqueId()).
  2. Reads existing markers and identifies the comment-tagged subset.
  3. Removes any comment marker whose comment isn't in the target set —
     covers BOTH "comment now done in LPOS" AND "comment deleted" in one rule.
  4. Adds any target comment that doesn't already have a marker.
  5. Leaves markers whose comment is still in target untouched — preserves
     manual note edits the editor made between pulls.

Marker tag (customData): `lpos:{commentId}`, where commentId is the stable LPOS
comment_id. Markers placed before 2026-10-02 are tagged `frameio:{frameioId}`;
when a target comment carries that id as `legacyCommentId`, the legacy marker is
re-tagged in place (same frame, colour, name, note and duration) instead of
being removed and duplicated. Legacy markers with no matching target comment
are removed like any other resolved comment.

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
        "commentId":       "c_...",      # LPOS comment_id → lpos:{...} tag
        "legacyCommentId": "fio-..." | None,  # pre-2026-10-02 frameio:{...} tag, if any
        "timestamp_s":     42.3,         # seconds from output frame 0
        "duration_s":      4.1 | None,
        "name":            "Jane - 0:42",
        "note":            "Audio drop\n  ↳ Bob: confirmed at 0:42"
      },
      ...
    ]
  }

Output:
  Success → {
    "result":   True,
    "placed":   [{"commentId": str, "frame": int}, ...],   # newly added this pull
    "removed":  [{"commentId": str, "frame": int}, ...],   # deleted (done or deleted in LPOS)
    "kept":     [{"commentId": str, "frame": int}, ...],   # left in place (still in target; includes re-tagged legacy markers)
    "skipped":  [{"commentId": str, "frame": int, "reason": str}, ...],
    "timeline_name": str
  }
  Timeline missing → { "result": False, "reason": "timeline_not_found" }
"""

from typing import Any, Dict, List, Optional, Tuple


TAG_PREFIX = "lpos:"
LEGACY_TAG_PREFIX = "frameio:"
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


def _extract_comment_markers(timeline: Any) -> Tuple[
        Dict[str, Tuple[int, Dict[str, Any]]], Dict[str, Tuple[int, Dict[str, Any]]]]:
    """Read every marker on the timeline and split the comment-tagged ones into
    ({lposId -> (frame, marker)}, {legacyFrameioId -> (frame, marker)}).

    Resolve's GetMarkers() returns a {frame -> marker_dict} mapping. Marker dicts
    have used both `customData` and `custom_data` keys across builds — read both
    defensively. Untagged markers are left alone (manual editor markers,
    recording/note markers from other phases).
    """
    try:
        markers = timeline.GetMarkers() or {}
    except Exception:
        return {}, {}
    current: Dict[str, Tuple[int, Dict[str, Any]]] = {}
    legacy: Dict[str, Tuple[int, Dict[str, Any]]] = {}
    for frame, marker in markers.items():
        if not isinstance(marker, dict):
            continue
        cd = marker.get("customData") or marker.get("custom_data") or ""
        if not isinstance(cd, str):
            continue
        for prefix, bucket in ((TAG_PREFIX, current), (LEGACY_TAG_PREFIX, legacy)):
            if cd.startswith(prefix):
                key = cd[len(prefix):].strip()
                if key:
                    bucket[key] = (int(frame), marker)
                break
    return current, legacy


def _delete_marker(timeline: Any, custom_data: str, frame: int) -> bool:
    try:
        if timeline.DeleteMarkerByCustomData(custom_data):
            return True
    except Exception:
        pass
    # Fallback: delete by frame if customData-based delete is unsupported.
    try:
        return bool(timeline.DeleteMarkerAtFrame(frame))
    except Exception:
        return False


def _retag_legacy_marker(timeline: Any, frame: int, marker: Dict[str, Any],
                         legacy_id: str, comment_id: str) -> bool:
    """Swap a `frameio:` marker for an identical `lpos:` one at the same frame.
    Resolve has no customData setter for an existing marker, so this is delete +
    re-add with the marker's own colour/name/note/duration (the editor's edits
    survive). Returns False if the re-add failed."""
    if not _delete_marker(timeline, f"{LEGACY_TAG_PREFIX}{legacy_id}", frame):
        return False
    try:
        duration = max(1, int(marker.get("duration") or 1))
    except (TypeError, ValueError):
        duration = 1
    try:
        return bool(timeline.AddMarker(frame, marker.get("color") or MARKER_COLOR,
                                       str(marker.get("name") or ""),
                                       str(marker.get("note") or ""),
                                       duration, f"{TAG_PREFIX}{comment_id}"))
    except Exception:
        return False


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

    target_by_cid: Dict[str, Dict[str, Any]] = {}
    legacy_to_cid: Dict[str, str] = {}
    for c in target_comments:
        cid = c.get("commentId") if isinstance(c, dict) else None
        if isinstance(cid, str) and cid.strip():
            target_by_cid[cid] = c
            legacy = c.get("legacyCommentId")
            if isinstance(legacy, str) and legacy.strip():
                legacy_to_cid[legacy] = cid
    target_ids = set(target_by_cid.keys())

    existing, legacy_markers = _extract_comment_markers(timeline)

    # ── Re-tag legacy frameio:* markers whose comment is still open ──────────
    # Each becomes an lpos:* marker at the same frame and joins `existing`, so
    # the rules below treat it exactly like a marker placed by this version.
    # Legacy markers with no open comment (done/deleted in LPOS, or a duplicate
    # of an lpos:* marker already present) are queued for removal.
    skipped: List[Dict[str, Any]] = []
    # (report id or None for a silent duplicate cleanup, frame, custom_data)
    legacy_removals: List[Tuple[Optional[str], int, str]] = []
    for legacy_id, (frame, marker) in legacy_markers.items():
        cid = legacy_to_cid.get(legacy_id)
        if cid and cid not in existing:
            if _retag_legacy_marker(timeline, frame, marker, legacy_id, cid):
                existing[cid] = (frame, marker)
            # If the re-add failed, the legacy marker is already gone; the
            # comment falls through to to_add below and is placed fresh.
            continue
        # cid set here means an lpos:* marker for the comment already exists —
        # this is a stray duplicate, so clean it up without reporting a removal.
        legacy_removals.append((None if cid else legacy_id, frame, f"{LEGACY_TAG_PREFIX}{legacy_id}"))

    existing_ids = set(existing.keys())
    to_remove_ids = set(existing_ids - target_ids)  # comments now done / deleted in LPOS

    # Stale-marker re-placement: a marker whose comment IS still in target but
    # whose current frame is far from where it would land with correct math is
    # treated as misplaced (almost always from the pre-5c.6 GetStartFrame bug)
    # and re-placed. Editor manual nudges of a few seconds are preserved;
    # nudges past tolerance are not.
    STALE_FRAME_TOLERANCE = 100  # frames (~4s at 24fps; well past any plausible editor nudge)
    misplaced_ids = set()
    for cid in (existing_ids & target_ids):
        comment = target_by_cid[cid]
        try:
            ts = float(comment.get("timestamp_s") or 0.0)
        except (TypeError, ValueError):
            continue
        expected_frame = int(round(ts * fps))
        existing_frame = existing[cid][0]
        if abs(existing_frame - expected_frame) > STALE_FRAME_TOLERANCE:
            misplaced_ids.add(cid)

    # Remove misplaced markers as part of the to_remove pass, then re-add them
    # by injecting them into to_add. Net: editor sees +N placed and they end
    # up at the correct frame.
    to_remove_ids |= misplaced_ids

    to_add = [c for c in target_comments if isinstance(c, dict)
              and isinstance(c.get("commentId"), str)
              and (c["commentId"] not in existing_ids or c["commentId"] in misplaced_ids)]
    kept_records: List[Dict[str, Any]] = [
        {"commentId": cid, "frame": existing[cid][0]}
        for cid in (existing_ids & target_ids)
        if cid not in misplaced_ids
    ]

    # ── Remove (markers whose comment is done or deleted in LPOS) ────────────
    removed_records: List[Dict[str, Any]] = []
    removals = [(cid, existing[cid][0], f"{TAG_PREFIX}{cid}") for cid in to_remove_ids]
    for report_id, frame_for_record, custom_data in removals + legacy_removals:
        if _delete_marker(timeline, custom_data, frame_for_record):
            # Misplaced markers are re-added below and reported as placed.
            if report_id and report_id not in misplaced_ids:
                removed_records.append({"commentId": report_id, "frame": frame_for_record})

    # ── Add (target comments not yet on the timeline) ─────────────────────────
    placed_records: List[Dict[str, Any]] = []
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
        custom_data = f"{TAG_PREFIX}{cid}"

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
            placed_records.append({"commentId": cid, "frame": marker_frame})
        else:
            skipped.append({"commentId": cid, "frame": marker_frame,
                            "reason": "AddMarker returned False (likely out of range)"})

    return {
        "result": True,
        "placed": placed_records,
        "removed": removed_records,
        "kept": kept_records,
        "skipped": skipped,
        "timeline_name": timeline_name,
    }
