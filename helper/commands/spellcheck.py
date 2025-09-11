from typing import Any, Dict, List, Tuple


def _safe_get(obj, name, default=None):
    return getattr(obj, name, default)


def _get_fusion_comps(timeline_item):
    comps = []
    get_count = _safe_get(timeline_item, "GetFusionCompCount")
    get_by_idx = _safe_get(timeline_item, "GetFusionCompByIndex")
    if callable(get_count) and callable(get_by_idx):
        try:
            count = int(get_count() or 0)
            for i in range(1, count + 1):
                comp = get_by_idx(i)
                if comp:
                    comps.append(comp)
        except Exception:
            pass

    get_list = _safe_get(timeline_item, "GetFusionCompList")
    if callable(get_list):
        try:
            d = get_list() or {}
            for _, comp in (d.items() if hasattr(d, "items") else []):
                if comp and comp not in comps:
                    comps.append(comp)
        except Exception:
            pass

    get_by_name = _safe_get(timeline_item, "GetFusionCompByName")
    if callable(get_by_name):
        for name in ("Fusion Composition", "FusionComp", "Effects"):
            try:
                comp = get_by_name(name)
                if comp and comp not in comps:
                    comps.append(comp)
            except Exception:
                pass

    return comps


def _tool_id(tool):
    try:
        tid = _safe_get(tool, "ID")
        if tid:
            return str(tid)
        attrs = tool.GetAttrs() if hasattr(tool, "GetAttrs") else {}
        reg = attrs.get("TOOLS_RegID") if isinstance(attrs, dict) else None
        if reg:
            return str(reg)
    except Exception:
        pass
    return "UnknownTool"


def _extract_text_from_tool(comp, tool):
    texts: List[str] = []
    tid = _tool_id(tool).lower()
    candidates: Tuple[str, ...] = ()
    if "textplus" in tid or "text+" in tid:
        candidates = ("StyledText",)
    elif "text3d" in tid:
        candidates = ("Text", "StyledText")

    for inp in candidates:
        try:
            get_input = _safe_get(tool, "GetInput")
            if callable(get_input):
                val = get_input(inp)
            else:
                val = _safe_get(tool, inp)

            if isinstance(val, dict) and hasattr(comp, "CurrentTime"):
                frame = int(getattr(comp, "CurrentTime", 0) or 0)
                val = val.get(frame, "")
            if val is None:
                val = _safe_get(tool, inp)

            if val:
                s = str(val).strip()
                if s:
                    texts.append(s)
        except Exception:
            pass
    return texts


def _extract_texts_from_comp(comp):
    out: List[Tuple[str, str]] = []
    try:
        get_tool_list = _safe_get(comp, "GetToolList")
        if not callable(get_tool_list):
            return out
        seen = set()
        for arg in (False, True):
            try:
                tools = get_tool_list(arg) or {}
                iterable = tools.values() if hasattr(tools, "values") else tools
                for t in iterable:
                    tid = _tool_id(t)
                    if (id(t), tid) in seen:
                        continue
                    seen.add((id(t), tid))
                    texts = _extract_text_from_tool(comp, t)
                    for s in texts:
                        out.append((tid, s))
            except Exception:
                continue
    except Exception:
        pass
    return out


def _frames_to_tc(frame: int, fps: float) -> str:
    """Convert a frame number to HH:MM:SS:FF timecode."""
    try:
        fps_int = int(round(fps))
        if fps_int <= 0:
            fps_int = 24
    except Exception:
        fps_int = 24
    hours = frame // (fps_int * 3600)
    minutes = (frame // (fps_int * 60)) % 60
    seconds = (frame // fps_int) % 60
    frames = frame % fps_int
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frames:02d}"


def handle_spellcheck(_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Extract all Text+ strings from the active timeline."""
    from .. import resolve_helper as rh

    if not rh.timeline:
        raise RuntimeError("No active timeline")

    timeline = rh.timeline
    try:
        fps = float(timeline.GetSetting("timelineFrameRate") or 24)
    except Exception:
        fps = 24
    vcount = int(timeline.GetTrackCount("video") or 0)
    found: List[Dict[str, Any]] = []

    for track_index in range(1, vcount + 1):
        try:
            get_items = getattr(timeline, "GetItemListInTrack", None)
            if not callable(get_items):
                break
            items = get_items("video", track_index) or []
        except Exception:
            items = []

        for item in items:
            try:
                get_start = getattr(item, "GetStart", None)
                start_frame = int(get_start() or 0) if callable(get_start) else 0
                timecode = _frames_to_tc(start_frame, fps)
                comps = _get_fusion_comps(item)
                if not comps:
                    continue
                for comp in comps:
                    pairs = _extract_texts_from_comp(comp)
                    for tool_id, text in pairs:
                        found.append({
                            "track": track_index,
                            "tool": tool_id,
                            "timecode": timecode,
                            "text": text,
                        })
            except Exception:
                continue

    return {"items": found}
