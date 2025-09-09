from typing import Any, Dict


def handle_add_marker(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Add a marker on the current timeline.

    Accepts either:
      - timecode: "HH:MM:SS:FF"  -> preferred for precision
      - frame: int               -> will be used directly
      - none                     -> uses current playhead timecode
    """
    from .. import resolve_helper as rh

    if not rh.timeline:
        raise RuntimeError("No active timeline")

    color = payload.get("color", "Blue")
    name = payload.get("name", "")
    note = payload.get("note", "")
    duration = int(payload.get("duration", 1))
    custom_data = payload.get("custom_data", "")

    if "timecode" in payload and payload["timecode"]:
        tc = str(payload["timecode"])
        res = rh.timeline.AddMarker(tc, color, name, note, duration, custom_data)
    elif "frame" in payload:
        try:
            frame = int(payload["frame"])
            res = rh.timeline.AddMarker(frame, color, name, note, duration, custom_data)  # type: ignore[arg-type]
        except Exception:
            tc = rh.timeline.GetCurrentTimecode()
            res = rh.timeline.AddMarker(tc, color, name, note, duration, custom_data)
    else:
        tc = rh.timeline.GetCurrentTimecode()
        res = rh.timeline.AddMarker(tc, color, name, note, duration, custom_data)

    return {"result": bool(res)}
