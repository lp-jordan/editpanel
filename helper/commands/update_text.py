from typing import Any, Dict

from .spellcheck import _get_fusion_comps


def handle_update_text(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Update the text of a Fusion tool identified by timeline position."""
    from .. import resolve_helper as rh

    if not rh.timeline:
        raise RuntimeError("No active timeline")

    track = int(payload.get("track", 0))
    start_frame = int(payload.get("start_frame", 0))
    tool_name = payload.get("tool_name")
    text = payload.get("text", "")

    get_items = getattr(rh.timeline, "GetItemListInTrack", None)
    if not callable(get_items):
        return {"result": False}
    items = get_items("video", track) or []
    target = None
    for item in items:
        get_start = getattr(item, "GetStart", None)
        if callable(get_start) and int(get_start() or 0) == start_frame:
            target = item
            break
    if not target:
        return {"result": False}

    comps = _get_fusion_comps(target)
    for comp in comps:
        get_tool_list = getattr(comp, "GetToolList", None)
        if not callable(get_tool_list):
            continue
        try:
            tools = get_tool_list(True) or {}
            tool = tools.get(tool_name) if hasattr(tools, "get") else None
            if not tool and hasattr(tools, "items"):
                for name, t in tools.items():
                    if name == tool_name:
                        tool = t
                        break
            if tool:
                set_input = getattr(tool, "SetInput", None)
                if callable(set_input):
                    res = set_input("StyledText", text)
                    return {"result": bool(res) if res is not None else True}
        except Exception:
            continue
    return {"result": False}
