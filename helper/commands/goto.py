from typing import Any, Dict

from .spellcheck import _frames_to_tc


def handle_goto(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Move the timeline playhead to a specified timecode or frame."""
    from .. import resolve_helper as rh

    if not rh.timeline:
        raise RuntimeError("No active timeline")

    timecode = payload.get("timecode")
    frame = payload.get("frame")
    if timecode:
        tc = str(timecode)
    elif frame is not None:
        try:
            frame_num = int(frame)
        except Exception:
            raise ValueError("Invalid frame")
        try:
            fps = float(rh.timeline.GetSetting("timelineFrameRate") or 24)
        except Exception:
            fps = 24
        tc = _frames_to_tc(frame_num, fps)
    else:
        raise ValueError("No timecode or frame provided")

    rh.log(f"Goto: requesting playhead move to {tc}")
    set_tc = getattr(rh.timeline, "SetCurrentTimecode", None)
    result = False
    if callable(set_tc):
        try:
            result = bool(set_tc(tc))
        except Exception:
            result = False
    if result:
        rh.log(f"Goto: playhead moved to {tc}")
    else:
        rh.log(f"Goto: failed to move playhead to {tc}")
    return {"result": result}
