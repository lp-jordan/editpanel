from typing import Any, Dict


def handle_context(_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Return basic Resolve context information."""
    from .. import resolve_helper as rh

    return {
        "project": rh.project.GetName() if rh.project else None,
        "timeline": rh.timeline.GetName() if rh.timeline else None,
    }
