"""Shared, read-only helpers for walking the Resolve Media Pool folder tree and
resolving a bin *path* (e.g. "SEQUENCES / MC") to a folder object.

Editors nest bins (sub-bins) and want to target them from EditPanel's bin
dropdowns. A bare bin name becomes ambiguous once nesting is allowed — two
different parents can each hold a "MC" bin — so nested bins are identified by
their full path from the root, joined with BIN_PATH_SEPARATOR. Top-level bins
keep their bare name, so existing persisted selections ("EXPORT", "SEQUENCES")
and any caller that still passes a bare name keep working unchanged.

Kept as its own module (rather than folded into resolve_helper) so the three
matchers (lp_base_export, export_preflight, list_bin_sequences) and the
enumerator (list_media_bins) resolve a path *identically* — the whole point is
that the dropdown and the matcher agree on what a given path means. This is pure
folder traversal; the export business logic (clip → timeline matching) stays in
each command, unshared, as before.
"""

from typing import Any, Dict, Iterator, List, Optional, Tuple

# Display + wire separator between bin path segments. Space-padded so it reads
# as a path in the dropdown and collides less with real bin names than a bare
# "/". Resolve bin names *can* contain this substring; that ambiguity is
# accepted — resolve_folder_by_path tries a bare-name match first, so a
# top-level bin literally named "A / B" still resolves to itself.
BIN_PATH_SEPARATOR = " / "

# Defensive cap mirroring flag_timelines._walk_folders — a pathological or
# cyclic tree (Resolve shouldn't produce one, but be safe) must not spin.
_MAX_FOLDERS = 5000


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


def walk_bin_tree(root_folder: Any) -> Iterator[Tuple[Any, List[str], int]]:
    """Preorder depth-first walk of every bin *under* root_folder (root itself
    excluded). Yields (folder, path_segments, depth) where path_segments is the
    list of folder names from the first level down to this folder, and
    depth == len(path_segments) (top-level bins are depth 1). Child order
    follows GetSubFolderList() so the dropdown mirrors the Media Pool.
    """
    counter = {"n": 0}

    def _rec(folder: Any, prefix: List[str]) -> Iterator[Tuple[Any, List[str], int]]:
        for child in _subfolders(folder):
            if counter["n"] >= _MAX_FOLDERS:
                return
            name = _folder_name(child)
            if not name:
                continue
            counter["n"] += 1
            segments = prefix + [name]
            yield child, segments, len(segments)
            yield from _rec(child, segments)

    yield from _rec(root_folder, [])


def enumerate_bin_paths(root_folder: Any) -> List[Dict[str, Any]]:
    """Flatten the whole bin tree to a list of dropdown-ready entries, in
    Media-Pool preorder:

        { "path": "SEQUENCES / MC", "name": "MC", "depth": 2 }

    Top-level bins have depth 1 and path == name, so the joined `path` doubles
    as the back-compat flat identifier the matchers already accept.
    """
    entries: List[Dict[str, Any]] = []
    for _folder, segments, depth in walk_bin_tree(root_folder):
        entries.append({
            "path": BIN_PATH_SEPARATOR.join(segments),
            "name": segments[-1],
            "depth": depth,
        })
    return entries


def resolve_folder_by_path(root_folder: Any, bin_path: Any) -> Optional[Any]:
    """Locate the folder identified by *bin_path*, or None if it doesn't exist.

    Back-compat first: a bare top-level name (the legacy contract) is matched
    against root's immediate subfolders exactly — this also covers a top-level
    bin whose own name happens to contain BIN_PATH_SEPARATOR. Only if that
    fails and the string carries a separator do we split it and walk the tree
    segment by segment from the root.
    """
    if bin_path is None:
        return None
    bin_path = str(bin_path)

    # Legacy / top-level exact match (fast path, fully back-compatible).
    for folder in _subfolders(root_folder):
        if _folder_name(folder) == bin_path:
            return folder

    if BIN_PATH_SEPARATOR not in bin_path:
        return None

    # Path walk: descend one segment at a time.
    current = root_folder
    for segment in bin_path.split(BIN_PATH_SEPARATOR):
        nxt = None
        for child in _subfolders(current):
            if _folder_name(child) == segment:
                nxt = child
                break
        if nxt is None:
            return None
        current = nxt
    return current
