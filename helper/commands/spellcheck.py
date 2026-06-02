from typing import Any, Dict, List, Tuple


def _safe_get(obj, name, default=None):
    return getattr(obj, name, default)


def _comp_key(comp):
    """Stable identity for a Fusion comp wrapper.

    Resolve returns a fresh Python wrapper on every API call, so `comp in list`
    (which falls back to identity) treats the same underlying comp as different
    objects each time. That broke dedup across the three discovery paths
    below — the same comp was getting walked 2-3× and every text string
    flagged 2-3× downstream.

    Use the comp's name when available (stable for a given clip), otherwise
    fall back to id() — at worst we re-walk one comp once, never more.
    """
    try:
        get_attrs = _safe_get(comp, "GetAttrs")
        if callable(get_attrs):
            attrs = get_attrs() or {}
            name = attrs.get("COMPS_Name") if isinstance(attrs, dict) else None
            if name:
                return ("name", str(name))
    except Exception:
        pass
    return ("id", id(comp))


def _get_fusion_comps(timeline_item):
    comps = []
    seen_keys = set()

    def _add(comp):
        if not comp:
            return
        k = _comp_key(comp)
        if k in seen_keys:
            return
        seen_keys.add(k)
        comps.append(comp)

    get_count = _safe_get(timeline_item, "GetFusionCompCount")
    get_by_idx = _safe_get(timeline_item, "GetFusionCompByIndex")
    if callable(get_count) and callable(get_by_idx):
        try:
            count = int(get_count() or 0)
            for i in range(1, count + 1):
                _add(get_by_idx(i))
        except Exception:
            pass

    get_list = _safe_get(timeline_item, "GetFusionCompList")
    if callable(get_list):
        try:
            d = get_list() or {}
            for _, comp in (d.items() if hasattr(d, "items") else []):
                _add(comp)
        except Exception:
            pass

    get_by_name = _safe_get(timeline_item, "GetFusionCompByName")
    if callable(get_by_name):
        for name in ("Fusion Composition", "FusionComp", "Effects"):
            try:
                _add(get_by_name(name))
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


def _tool_unique_name(tool):
    """Return the tool's unique-within-comp name (e.g. 'Text1', 'TextPlus2').

    DO NOT rely on the integer key from `Comp.GetToolList()` — Resolve returns
    that as a 1-indexed integer dict in current builds, so iterating gives
    you "1", "12", … which is meaningless for tool-name-based dedup or
    later lookup from update_text. The persistent name lives at
    GetAttrs()["TOOLS_Name"] and is what `comp.FindTool(name)` matches on.
    """
    try:
        get_attrs = _safe_get(tool, "GetAttrs")
        if callable(get_attrs):
            attrs = get_attrs() or {}
            name = attrs.get("TOOLS_Name") if isinstance(attrs, dict) else None
            if name:
                return str(name)
    except Exception:
        pass
    return ""


def _extract_text_from_tool(comp, tool):
    """Return every distinct text string the tool would display.

    For keyframed StyledText (Resolve stores it as a frame→value dict whenever
    the input is animated — common because Text+ fade-ins/outs keyframe many
    inputs), we scan ALL keyframe values, not just the one at comp.CurrentTime.
    Earlier behavior read at CurrentTime which is the comp's internal playhead
    (often 0) — completely unrelated to where the visible text actually is on
    the timeline, so an older keyframe value at frame 0 would surface instead
    of the editor's current text.

    Returning every distinct keyframe value is the right move for spellcheck:
    if any version of the text is misspelled the editor needs to know, and
    they typically only have one or two distinct strings across all keyframes.
    """
    texts: List[str] = []
    seen: set = set()

    def _add(raw):
        if raw is None:
            return
        s = str(raw).strip()
        if s and s not in seen:
            seen.add(s)
            texts.append(s)

    tid = _tool_id(tool).lower()
    candidates: Tuple[str, ...] = ()
    if "textplus" in tid or "text+" in tid:
        candidates = ("StyledText",)
    elif "text3d" in tid:
        candidates = ("Text", "StyledText")

    for inp in candidates:
        try:
            get_input = _safe_get(tool, "GetInput")
            val = get_input(inp) if callable(get_input) else _safe_get(tool, inp)

            if isinstance(val, dict):
                # Keyframed input — emit every distinct value across the
                # animation curve. Dict keys are frames (int/float); values
                # are the strings. Do NOT also call _safe_get(tool, inp)
                # here: in some Resolve builds that attribute access
                # returns the same dict object, and _add(dict) would
                # str(dict) the whole thing producing gibberish that
                # surfaces as a phantom flagged token.
                for v in val.values():
                    _add(v)
            else:
                _add(val)
                if not texts:
                    _add(_safe_get(tool, inp))
        except Exception:
            pass
    return texts


def _extract_texts_from_comp(comp):
    """List every (tool_id, tool_name, text) triple in the comp.

    GetToolList(False) returns ALL tools; we only need that one call. The
    earlier code also iterated GetToolList(True) (selected-only) as a
    "belt-and-suspenders" pass and tried to dedupe with `(id(t), tid)`,
    but Resolve returns a fresh wrapper on every call so id(t) was
    always new — every Text+ tool ended up emitted twice. Just call
    GetToolList(False) once and dedupe by the tool's stable name.
    """
    out: List[Tuple[str, str, str]] = []
    try:
        get_tool_list = _safe_get(comp, "GetToolList")
        if not callable(get_tool_list):
            return out

        try:
            tools = get_tool_list(False) or {}
        except Exception:
            tools = {}

        # GetToolList(False) returns a 1-indexed integer-keyed dict in
        # current Resolve builds — the iteration key is the index, NOT the
        # tool's unique name. Pull the name off each tool's GetAttrs()
        # instead. The earlier code treated the iteration key as the name
        # and ended up recording tool_name="12", which then failed to
        # match anything in update_text's lookup.
        if hasattr(tools, "values"):
            tool_iterable = list(tools.values())
        else:
            tool_iterable = list(tools)

        seen_names: set = set()
        for t in tool_iterable:
            tool_name = _tool_unique_name(t)
            if tool_name and tool_name in seen_names:
                continue
            if tool_name:
                seen_names.add(tool_name)
            try:
                texts = _extract_text_from_tool(comp, t)
            except Exception:
                continue
            tid = _tool_id(t)
            for s in texts:
                out.append((tid, tool_name, s))
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
                    for tool_id, tool_name, text in pairs:
                        found.append({
                            "track": track_index,
                            "tool": tool_id,
                            "tool_name": tool_name,
                            "start_frame": start_frame,
                            "timecode": timecode,
                            "text": text,
                        })
            except Exception:
                continue

    return {"items": found}
