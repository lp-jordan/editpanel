from typing import Any, Dict


def handle_stop_render(_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Stop the current render job."""
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")
    ok = rh.project.StopRendering()
    return {"result": bool(ok)}
