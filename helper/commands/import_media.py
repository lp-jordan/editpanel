"""Import already-ingested ATEM footage from disk into the current Resolve
project's media pool, mirroring the on-disk ingest layout as nested bins.

Called by the "Import into Resolve" toggle in AtemIngestOverlay after the FTP
ingest finishes. Import can ONLY target the currently-open project — there is no
importing into a closed project — so the toggle is gated on resolveConnected.

Payload:
  {
    "parent_bin": "FOOTAGE / ATEM",      # bin path (bin_tree.BIN_PATH_SEPARATOR)
    "files": [
      { "local_path": "C:/.../CAM 1/Sess CAM 1 01.mp4",
        "session": "ACM_Shorts_05-22-26",
        "cam_number": 1 },               # null → "Unknown" sub-bin
      ...
    ]
  }

Each file lands in <parent_bin> / <session> / CAM <n>, an exact mirror of the
disk structure the ingest wrote. Missing bins (incl. the parent) are created —
mirrors create_project_bins' AddSubFolder pattern; the parent path is resolved
with bin_tree.resolve_folder_by_path first so an existing FOOTAGE/ATEM is reused.

Returns:
  {
    "result": True,
    "imported": <int>,                   # MediaPoolItems actually created
    "failed":   <int>,                   # files that produced no item
    "per_bin": [ { "bin": "<path>", "requested": N, "imported": M }, ... ]
  }
"""
from typing import Any, Dict, List, Optional


BIN_PATH_SEPARATOR = " / "


def _subfolders(folder: Any) -> List[Any]:
    try:
        return folder.GetSubFolderList() or []
    except Exception:
        return []


def _folder_name(folder: Any) -> Optional[str]:
    try:
        return folder.GetName()
    except Exception:
        return None


def _find_or_create(media_pool: Any, parent: Any, name: str) -> Optional[Any]:
    for child in _subfolders(parent):
        if _folder_name(child) == name:
            return child
    return media_pool.AddSubFolder(parent, name)


def _find_or_create_path(media_pool: Any, root: Any, segments: List[str]) -> Optional[Any]:
    current = root
    for seg in segments:
        current = _find_or_create(media_pool, current, seg)
        if current is None:
            return None
    return current


def _sanitize(name: Any, fallback: str) -> str:
    s = str(name).strip() if name is not None else ""
    return s or fallback


def handle_import_media(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh
    from .bin_tree import resolve_folder_by_path

    if not rh.project:
        raise RuntimeError("No active project — open the target project in Resolve first.")

    files = payload.get("files")
    if not isinstance(files, list) or not files:
        raise RuntimeError("No files to import")

    parent_bin = payload.get("parent_bin") or "FOOTAGE / ATEM"

    media_pool = rh.project.GetMediaPool()
    if not media_pool:
        raise RuntimeError("Could not retrieve the media pool")
    root = media_pool.GetRootFolder()
    if not root:
        raise RuntimeError("Could not retrieve the media pool root folder")

    # Resolve the parent bin; create the whole path if it doesn't exist yet (a
    # bare project may not have run project-setup). Reuses an existing bin.
    parent = resolve_folder_by_path(root, parent_bin)
    if parent is None:
        parent = _find_or_create_path(media_pool, root, parent_bin.split(BIN_PATH_SEPARATOR))
    if parent is None:
        raise RuntimeError(f"Could not resolve or create parent bin: {parent_bin}")

    # Group requested files by their nested target bin so we SetCurrentFolder
    # once per bin and hand ImportMedia the batch for that bin.
    groups: Dict[str, Dict[str, Any]] = {}
    for f in files:
        local_path = f.get("local_path")
        if not local_path:
            continue
        session = _sanitize(f.get("session"), "UnknownSession")
        cam = f.get("cam_number")
        cam_folder = f"CAM {cam}" if cam not in (None, "") else "Unknown"
        key = f"{session}\x00{cam_folder}"
        g = groups.setdefault(key, {"segments": [session, cam_folder], "paths": []})
        g["paths"].append(local_path)

    rh.log(f"[import_media] {len(files)} file(s) → {parent_bin} across {len(groups)} bin(s)")

    imported_total = 0
    failed_total = 0
    per_bin: List[Dict[str, Any]] = []

    for g in groups.values():
        segments = g["segments"]
        paths = g["paths"]
        bin_path = BIN_PATH_SEPARATOR.join([parent_bin] + segments)

        leaf = _find_or_create_path(media_pool, parent, segments)
        if leaf is None:
            rh.log(f"[import_media] ✗ could not create bin {bin_path} — skipping {len(paths)} file(s)")
            failed_total += len(paths)
            per_bin.append({"bin": bin_path, "requested": len(paths), "imported": 0})
            continue

        if not media_pool.SetCurrentFolder(leaf):
            rh.log(f"[import_media] ✗ SetCurrentFolder failed for {bin_path}")
            failed_total += len(paths)
            per_bin.append({"bin": bin_path, "requested": len(paths), "imported": 0})
            continue

        try:
            items = media_pool.ImportMedia(paths)
        except Exception as exc:  # noqa: BLE001 — surface as a per-bin failure, keep going
            rh.log(f"[import_media] ✗ ImportMedia raised for {bin_path}: {exc}")
            items = None

        n = len(items) if items else 0
        imported_total += n
        failed_total += max(0, len(paths) - n)
        rh.log(f"[import_media] {bin_path}: imported {n}/{len(paths)}")
        per_bin.append({"bin": bin_path, "requested": len(paths), "imported": n})

    return {
        "result": True,
        "imported": imported_total,
        "failed": failed_total,
        "per_bin": per_bin,
    }
