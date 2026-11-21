"""Project status for the LPOS /editing rings (see helper/project_status.py)."""
from typing import Any, Dict


def handle_project_status_refresh(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh
    from .. import project_status

    if not rh.project:
        return {"started": False, "reason": "no project"}
    started = project_status.refresh_in_background(rh.project, multicams=bool(payload.get("multicams")), log=rh.log)
    return {"started": started}


def handle_project_status_get(_payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import project_status

    return project_status.snapshot()
