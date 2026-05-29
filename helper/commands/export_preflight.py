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

    if not rh.project:
        raise RuntimeError("No active project")

    project = rh.project
    media_pool = project.GetMediaPool()
    root_folder = media_pool.GetRootFolder()
    if not root_folder:
        raise RuntimeError("Could not retrieve the root folder of the Media Pool")

    export_bin_name = payload.get("export_bin_name") or DEFAULT_EXPORT_BIN_NAME

    export_folder = None
    for folder in (root_folder.GetSubFolderList() or []):
        if folder.GetName() == export_bin_name:
            export_folder = folder
            break
    if not export_folder:
        return {"names": [], "bin_found": False}

    export_names: List[str] = []
    for clip in (export_folder.GetClipList() or []):
        try:
            nm = clip.GetName()
        except Exception:
            nm = clip.GetClipProperty("File Name")
        if nm:
            export_names.append(nm)

    matched: List[str] = []
    timeline_count = int(project.GetTimelineCount() or 0)
    for idx in range(1, timeline_count + 1):
        tl = project.GetTimelineByIndex(idx)
        if tl and tl.GetName() in export_names:
            matched.append(tl.GetName())

    return {"names": matched, "bin_found": True}
