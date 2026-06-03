"""Phase 5c.8 (2026-06-02): flag timeline MediaPoolItems by their uid.

Called by the comment-pull orchestrator after sync_comment_markers to mark the
timelines that got new comment activity, so the editor can sort the media pool
by Flag in Resolve and jump straight to the ones that need attention.

Walks the media pool recursively (timelines live anywhere in the bin tree —
the editor's organization is their own), matches MediaPoolItems by
GetUniqueId, and calls AddFlag(color) on the matches. Idempotent: AddFlag
adds a flag of the given color but doesn't duplicate if one already exists
for that color.

Bin auto-sort is NOT exposed in the Resolve scripting API. Editor sorts
manually via Resolve's UI (right-click column header → sort by Flag, or use
the Sort drop-down in the bin view) — the report message tells them.

Input payload:
  {
    "cmd": "flag_timelines",
    "timeline_uids": ["abc-123", "def-456", ...],
    "color": "Sand"   # any Resolve flag color name; default "Sand"
  }

Output:
  {
    "result":  True,
    "flagged": [{"uid": str, "name": str}, ...],
    "missing": [str, ...]   # uids not found in the media pool
  }
"""

from typing import Any, Dict, List, Optional


DEFAULT_FLAG_COLOR = "Sand"


def _walk_folders(root_folder: Any):
    """Depth-first iterator over every folder under root_folder (root included)."""
    stack = [root_folder]
    seen_count = 0
    while stack:
        folder = stack.pop()
        if folder is None:
            continue
        seen_count += 1
        # Defensive cap so a pathological tree doesn't spin forever.
        if seen_count > 5000:
            return
        yield folder
        try:
            children = folder.GetSubFolderList() or []
        except Exception:
            children = []
        stack.extend(children)


def _media_pool_item_uid(clip: Any) -> Optional[str]:
    try:
        return clip.GetUniqueId()
    except Exception:
        return None


def _media_pool_item_name(clip: Any) -> str:
    try:
        name = clip.GetName()
    except Exception:
        name = ""
    if name:
        return name
    try:
        return clip.GetClipProperty("File Name") or ""
    except Exception:
        return ""


def handle_flag_timelines(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    raw_uids = payload.get("timeline_uids") or []
    if not isinstance(raw_uids, list):
        raise ValueError("timeline_uids must be a list")
    wanted = {u for u in raw_uids if isinstance(u, str) and u}
    if not wanted:
        return {"result": True, "flagged": [], "missing": []}

    color_raw = payload.get("color") or DEFAULT_FLAG_COLOR
    color = str(color_raw).strip() or DEFAULT_FLAG_COLOR

    media_pool = rh.project.GetMediaPool()
    if not media_pool:
        raise RuntimeError("No media pool")
    root_folder = media_pool.GetRootFolder()
    if not root_folder:
        raise RuntimeError("Could not retrieve the root folder of the Media Pool")

    flagged: List[Dict[str, Any]] = []
    found_uids = set()

    for folder in _walk_folders(root_folder):
        try:
            clips = folder.GetClipList() or []
        except Exception:
            clips = []
        for clip in clips:
            uid = _media_pool_item_uid(clip)
            if not uid or uid not in wanted or uid in found_uids:
                continue
            try:
                ok = bool(clip.AddFlag(color))
            except Exception:
                ok = False
            if ok:
                flagged.append({"uid": uid, "name": _media_pool_item_name(clip)})
                found_uids.add(uid)

    missing = sorted(wanted - found_uids)
    return {"result": True, "flagged": flagged, "missing": missing}
