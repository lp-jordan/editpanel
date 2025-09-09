from typing import Any, Dict
import threading


def handle_connect(_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Manually attach to a running Resolve instance."""
    from .. import resolve_helper as rh

    if rh.resolve:
        return {"result": True}
    if not rh._get_resolve_available:
        rh._status_event(False, "NO_PYTHON_GET_RESOLVE", "python_get_resolve not found")
        raise RuntimeError("python_get_resolve not available")
    r = rh.GetResolve()
    if not r:
        rh._status_event(False, "NO_SESSION", "No Resolve running or attach failed")
        raise RuntimeError("No Resolve running")
    rh.resolve = r
    rh._update_context()
    rh._status_event(True, "CONNECTED")
    threading.Thread(target=rh._monitor_resolve, daemon=True).start()
    return {"result": True}
