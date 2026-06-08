"""Enumerate the top-level bins (folders) in the current Resolve project's
media pool.

Powers the Export bin dropdown in ExportDeliverOverlay. We mirror the lookup
already used by lp_base_export.handle_lp_base_export and export_preflight:
both match the chosen bin against the root folder's immediate subfolders
only — nested bins are out of scope here for the same reason they're out of
scope in the matcher (lp_base_export iterates `root_folder.GetSubFolderList()`
once, no recursion).

Output:
  { "bins": [str, ...] }   # top-level subfolder names, original order

The DEFAULT_EXPORT_BIN_NAME ("EXPORT") is not injected by this handler — the
renderer keeps its own constant and shows it as a placeholder/fallback when
the dropdown can't be built (Resolve disconnected, fetch error, etc.).
"""

from typing import Any, Dict, List


def handle_list_media_bins(_payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    media_pool = rh.project.GetMediaPool()
    if not media_pool:
        raise RuntimeError("Could not retrieve the media pool")
    root_folder = media_pool.GetRootFolder()
    if not root_folder:
        raise RuntimeError("Could not retrieve the root folder of the Media Pool")

    bins: List[str] = []
    for folder in (root_folder.GetSubFolderList() or []):
        try:
            name = folder.GetName()
        except Exception:
            name = None
        if name:
            bins.append(name)

    return {"bins": bins}
