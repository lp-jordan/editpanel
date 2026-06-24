"""Enumerate the sequences (timelines) that live in a chosen top-level media
pool bin.

Powers the "Open Sequences" edit function (OpenSequencesOverlay). The bin
picker uses the same top-level-bin lookup as the Export bin dropdown
(list_media_bins / lp_base_export): we match the chosen bin against the root
folder's immediate subfolders only — nested bins are out of scope for the same
reason they are in the matcher.

A bin holds MediaPoolItems; the ones that are timelines share their name with a
Project timeline. There is no MediaPoolItem -> Timeline accessor in the Resolve
API, so we mirror lp_base_export: collect the clip names in the bin, then match
them against the project's timelines by name. Only names that correspond to an
actual timeline come back, so non-timeline clips in the bin are naturally
filtered out.

Input:
  { "cmd": "list_bin_sequences", "bin_name": str }

Output:
  {
    "bin_found": bool,
    "bin_name": str,
    "sequences": [ { "name": str, "uid": str | None }, ... ]   # media-pool order
  }

`uid` (Timeline.GetUniqueId(), Resolve 19+) is the rename-safe key the opener
prefers; it falls back to name matching when None. Order follows the bin's clip
list so the editor opens them in the order they appear in the bin.
"""

from typing import Any, Dict, List, Optional


def handle_list_bin_sequences(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    bin_name = (payload.get("bin_name") or "").strip()
    if not bin_name:
        raise ValueError("bin_name is required")

    project = rh.project
    media_pool = project.GetMediaPool()
    if not media_pool:
        raise RuntimeError("Could not retrieve the media pool")
    root_folder = media_pool.GetRootFolder()
    if not root_folder:
        raise RuntimeError("Could not retrieve the root folder of the Media Pool")

    # Find the chosen top-level bin (immediate subfolders only).
    target_folder = None
    for folder in (root_folder.GetSubFolderList() or []):
        try:
            if folder.GetName() == bin_name:
                target_folder = folder
                break
        except Exception:
            continue
    if not target_folder:
        return {"bin_found": False, "bin_name": bin_name, "sequences": []}

    # Names of every clip in the bin, in media-pool order.
    bin_names: List[str] = []
    for clip in (target_folder.GetClipList() or []):
        try:
            name = clip.GetName()
        except Exception:
            try:
                name = clip.GetClipProperty("File Name")
            except Exception:
                name = None
        if name:
            bin_names.append(name)

    # Map project timelines by name so we can attach a uid and confirm each bin
    # entry is actually a timeline. Later timelines win on duplicate names —
    # rare, and opening is by-name anyway when the uid path can't disambiguate.
    timelines_by_name: Dict[str, Optional[str]] = {}
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
            tl_name = tl.GetName() or ""
        except Exception:
            tl_name = ""
        if not tl_name:
            continue
        uid: Optional[str] = None
        try:
            uid = tl.GetUniqueId()
        except Exception:
            uid = None
        timelines_by_name[tl_name] = uid

    # Keep bin order; only emit entries that resolve to a real timeline. Guard
    # against a bin that lists the same timeline twice.
    sequences: List[Dict[str, Any]] = []
    seen = set()
    for name in bin_names:
        if name in seen or name not in timelines_by_name:
            continue
        seen.add(name)
        sequences.append({"name": name, "uid": timelines_by_name[name]})

    rh.log(
        f"list_bin_sequences: '{bin_name}' → {len(sequences)} sequence"
        f"{'' if len(sequences) == 1 else 's'} of {len(bin_names)} bin item"
        f"{'' if len(bin_names) == 1 else 's'}"
    )
    return {"bin_found": True, "bin_name": bin_name, "sequences": sequences}
