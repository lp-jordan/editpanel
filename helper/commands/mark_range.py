"""Mark a fixed-length In/Out range on the current timeline, starting at the playhead.

Triggered by EditPanel's global "Mark range" hotkey, so it works while Resolve has focus.

Frames passed to Timeline.SetMarkInOut are offsets from the timeline start (same
convention as Timeline.AddMarker). The out point is inclusive, so a range of N frames
is in .. in + N - 1.
"""

from typing import Any, Dict


def _tc_to_frames(tc: str, fps_nominal: int, drop: bool) -> int:
    parts = str(tc).replace(";", ":").replace(".", ":").split(":")
    if len(parts) != 4:
        raise ValueError(f"Unexpected timecode {tc!r}")
    h, m, s, f = (int(p) for p in parts)
    total = ((h * 60 + m) * 60 + s) * fps_nominal + f
    if drop:
        # SMPTE drop-frame: skip 2 (29.97) or 4 (59.94) frame numbers each minute except every tenth.
        dropped = 2 if fps_nominal <= 30 else 4
        minutes = h * 60 + m
        total -= dropped * (minutes - minutes // 10)
    return total


def handle_mark_range(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No project open in Resolve")
    tl = rh.project.GetCurrentTimeline()
    if not tl:
        raise RuntimeError("No timeline open in Resolve")
    if not callable(getattr(tl, "SetMarkInOut", None)):
        raise RuntimeError("This Resolve version can't set In/Out from scripts")

    seconds = float(payload.get("seconds") or 0)
    if seconds <= 0:
        raise ValueError("Range length must be more than 0 seconds")

    fps = float(tl.GetSetting("timelineFrameRate") or 24)
    drop = str(tl.GetSetting("timelineDropFrameTimecode") or "0") in ("1", "True", "true")
    fps_nominal = int(round(fps))

    playhead = _tc_to_frames(tl.GetCurrentTimecode(), fps_nominal, drop)
    start = _tc_to_frames(tl.GetStartTimecode(), fps_nominal, drop)
    in_f = playhead - start
    frames = max(1, int(round(seconds * fps)))
    out_f = in_f + frames - 1

    ok = bool(tl.SetMarkInOut(in_f, out_f))
    readback = {}
    try:
        readback = tl.GetMarkInOut() or {}
    except Exception:
        pass
    rh.log(f"mark_range: {seconds}s = {frames}f at {tl.GetCurrentTimecode()} -> in {in_f} out {out_f} ok={ok} readback={readback}")
    if not ok:
        raise RuntimeError("Resolve refused the In/Out")
    return {"result": True, "in": in_f, "out": out_f, "frames": frames, "readback": readback}
