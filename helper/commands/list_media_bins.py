"""Enumerate the bins (folders) in the current Resolve project's media pool,
including nested sub-bins.

Powers the bin dropdowns in ExportDeliverOverlay and OpenSequencesOverlay. The
whole folder tree is walked (see bin_tree.enumerate_bin_paths); each nested bin
is identified by its full path from the root, joined with BIN_PATH_SEPARATOR
("SEQUENCES / MC"), while top-level bins keep their bare name. The matchers
(lp_base_export, export_preflight, list_bin_sequences) resolve the chosen path
back to a folder via bin_tree.resolve_folder_by_path, so a selected sub-bin
actually exports / opens.

Output:
  {
    "bins": [str, ...],                                  # full paths, preorder
    "bin_tree": [ { "path": str, "name": str, "depth": int }, ... ]
  }

`bins` stays a flat string list (back-compat: the value the renderer persists
and the matcher receives). `bin_tree` carries depth so the dropdown can indent
sub-bins. The DEFAULT_EXPORT_BIN_NAME ("EXPORT") is not injected here — the
renderer keeps its own constant and shows it as a placeholder/fallback when the
dropdown can't be built (Resolve disconnected, fetch error, etc.).
"""

from typing import Any, Dict


def handle_list_media_bins(_payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh
    from .bin_tree import enumerate_bin_paths

    if not rh.project:
        raise RuntimeError("No active project")

    media_pool = rh.project.GetMediaPool()
    if not media_pool:
        raise RuntimeError("Could not retrieve the media pool")
    root_folder = media_pool.GetRootFolder()
    if not root_folder:
        raise RuntimeError("Could not retrieve the root folder of the Media Pool")

    entries = enumerate_bin_paths(root_folder)
    return {
        "bins": [entry["path"] for entry in entries],
        "bin_tree": entries,
    }
