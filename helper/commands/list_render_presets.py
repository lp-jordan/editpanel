"""Enumerate the current Resolve project's render presets.

Powers the Render preset dropdown in ExportDeliverOverlay so the editor can
pick from existing presets instead of typing a name and risking a typo. Read-
only; safe to call any time the project is loaded.

Output:
  { "presets": [str, ...] }   # order matches Resolve's UI dropdown

Resolve's `Project.GetRenderPresetList()` returns built-in + user presets in
the same order they appear in the Deliver-page preset menu. The Python API
returns either a list/tuple or a dict keyed by index depending on Resolve
build — coerce defensively.
"""

from typing import Any, Dict, List


def handle_list_render_presets(_payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    try:
        raw = rh.project.GetRenderPresetList() or []
    except Exception as exc:
        raise RuntimeError(f"Failed to list render presets: {exc}")

    presets: List[str] = []
    # Resolve may return list/tuple or dict-keyed-by-index — handle both.
    if isinstance(raw, dict):
        for key in sorted(raw.keys()):
            val = raw[key]
            if val:
                presets.append(str(val))
    else:
        for val in raw:
            if val:
                presets.append(str(val))

    return {"presets": presets}
