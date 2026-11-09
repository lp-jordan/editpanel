"""Import rendered Graphics overlays into a media pool bin of the open project.

Payload: { "bin_path": "GRAPHICS / Elevate", "files": ["C:/.../001_title.mov", ...] }
Missing bins are created. Returns { "result": True, "imported": N, "failed": M }.
"""
from typing import Any, Dict

from .import_media import BIN_PATH_SEPARATOR, _find_or_create_path


def handle_import_graphics(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project — open the target project in Resolve first.")
    files = [f for f in (payload.get("files") or []) if f]
    if not files:
        raise RuntimeError("No files to import")
    bin_path = str(payload.get("bin_path") or "GRAPHICS").strip() or "GRAPHICS"

    media_pool = rh.project.GetMediaPool()
    if not media_pool:
        raise RuntimeError("Could not retrieve the media pool")
    root = media_pool.GetRootFolder()
    segments = [s.strip() for s in bin_path.split(BIN_PATH_SEPARATOR.strip()) if s.strip()]
    folder = _find_or_create_path(media_pool, root, segments)
    if folder is None:
        raise RuntimeError(f"Could not create bin: {bin_path}")
    if not media_pool.SetCurrentFolder(folder):
        raise RuntimeError(f"Could not open bin: {bin_path}")

    items = media_pool.ImportMedia(files) or []
    rh.log(f"[import_graphics] {bin_path}: imported {len(items)}/{len(files)}")
    return {"result": True, "imported": len(items), "failed": max(0, len(files) - len(items))}
