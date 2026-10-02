import time
from typing import Any, Dict, List

DEFAULT_EXPORT_BIN_NAME = "EXPORT"


def handle_export_preflight(payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    """Return the timeline names lp_base_export WOULD queue, without queuing
    anything. Read-only; powers the pre-export version-conflict warning.

    This mirrors the EXPORT-bin -> timeline matching in
    lp_base_export.handle_lp_base_export. Kept as a separate read-only command
    (rather than refactoring the proven export path) so a drift here can only
    make the advisory warning slightly off, never break an actual export.
    """
    from .. import resolve_helper as rh
    from .bin_tree import resolve_folder_by_path
    from ..timeline_index import find_timelines, is_timeline_clip

    t0 = time.time()
    if not rh.project:
        raise RuntimeError("No active project")

    project = rh.project
    media_pool = project.GetMediaPool()
    root_folder = media_pool.GetRootFolder()
    if not root_folder:
        raise RuntimeError("Could not retrieve the root folder of the Media Pool")

    export_bin_name = payload.get("export_bin_name") or DEFAULT_EXPORT_BIN_NAME

    # Resolve a bare name ("EXPORT") or a nested path ("SEQUENCES / MC"),
    # matching lp_base_export so the advisory reflects what would actually queue.
    export_folder = resolve_folder_by_path(root_folder, export_bin_name)
    if not export_folder:
        rh.log(f"[check] Bin '{export_bin_name}' not found ({time.time() - t0:.1f}s).")
        return {"names": [], "bin_found": False}
    rh.log(f"[check] Found bin '{export_bin_name}' ({time.time() - t0:.1f}s).")
    t1 = time.time()

    export_names: List[str] = []
    timeline_names: List[str] = []
    for clip in (export_folder.GetClipList() or []):
        try:
            nm = clip.GetName()
        except Exception:
            nm = clip.GetClipProperty("File Name")
        if nm:
            export_names.append(nm)
            if is_timeline_clip(clip):
                timeline_names.append(nm)

    rh.log(f"[check] Read {len(export_names)} clip names ({time.time() - t1:.1f}s).")

    matched: List[str] = []
    # Per-timeline subtitle track count, keyed by timeline name. Powers the
    # burn-in pre-export warning: a "… - Subtitle" preset on a timeline with no
    # subtitle track renders an uncaptioned video with no error, so EditPanel
    # flags the gap before queuing. Always an int (0 on any Resolve hiccup) so
    # the UI can treat "missing key" and "0 tracks" the same way.
    subtitle_tracks: Dict[str, int] = {}
    for name, tl in find_timelines(project, export_names, rh.log, required=timeline_names):
        matched.append(name)
        try:
            subtitle_tracks[name] = int(tl.GetTrackCount("subtitle") or 0)
        except Exception:
            subtitle_tracks[name] = 0

    rh.log(f"[check] Done: {len(matched)} timelines matched ({time.time() - t0:.1f}s total).")
    return {"names": matched, "subtitle_tracks": subtitle_tracks, "bin_found": True}
