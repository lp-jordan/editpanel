from typing import Any, Dict


def handle_start_render(_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Start rendering with current Deliver settings (creates job if necessary)."""
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")
    jobs = rh.project.GetRenderJobList() or []
    if not jobs:
        rh.project.AddRenderJob()
    ok = rh.project.StartRendering()
    return {"result": bool(ok)}
