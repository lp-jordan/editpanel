"""Slate auto-sequencing — Step 1 (read-only diagnostic).

Derives the recording spans of a stacked/synced multicam timeline purely from
where the clips start/stop on a reference angle track, and streams the result to
the EditPanel console via `rh.log()`. This is the button-driven successor to
`spikes/spike_slate_multicam.py` — same MECHANIC 0 logic, but wired into the
command dispatch so the editor clicks once and watches the console instead of
pasting a script into Resolve's Py3 console.

DELIBERATELY READ-ONLY. It does not place markers, create timelines, or touch the
project in any way — safe to run on a live edit. Creating the actual per-span
sequences (and pulling the slate codes to name them) is the next step, gated on
eyeballing this report against the slate.

Why boundaries come from clip edges, not the LPOS slate's ATEM events: the slate
`timestamp` is the LPOS server system clock (createTimestamp() in atem-utils.ts),
not the ATEM's embedded hardware TC — so the ATEM "Recording started/stopped"
notes are approximate. The clips carry the true embedded TC, so the edges are
frame-exact. Gapless chunks (ATEM splitting one long recording across files —
source TOD stays continuous) are merged back into a single span.

Input:  { "cmd": "slate_span_report" }   # operates on the current timeline
Output:
  {
    "timeline_name": str,
    "fps": float,
    "reference_track": int,          # V-track the spans were read from
    "clips": [ {name, rec_in, rec_out, src_in_tc, src_out_tc}, ... ],
    "spans": [ {index, src_in_tc, src_out_tc, rec_in, rec_out, frames, chunks}, ... ]
  }
"""

from typing import Any, Dict, List, Optional


# ── Timecode helpers (self-contained; mirror the spike) ──────────────────────
def _is_drop_frame(tc: str) -> bool:
    return ";" in tc


def _round_fps(fps: float) -> int:
    return int(round(fps))


def tc_to_frames(tc: str, fps: float) -> int:
    tc = tc.strip()
    drop = _is_drop_frame(tc)
    parts = tc.replace(";", ":").split(":")
    if len(parts) != 4:
        raise ValueError(f"Bad timecode {tc!r}; expected HH:MM:SS:FF")
    hh, mm, ss, ff = (int(p) for p in parts)
    nominal = _round_fps(fps)
    if drop:
        drop_frames = 2 if nominal == 30 else (4 if nominal == 60 else 0)
        total_minutes = 60 * hh + mm
        return (
            (hh * 3600 + mm * 60 + ss) * nominal
            + ff
            - drop_frames * (total_minutes - total_minutes // 10)
        )
    return ((hh * 3600 + mm * 60 + ss) * nominal) + ff


def frames_to_tc(frame: int, fps: float, drop: bool = False) -> str:
    nominal = _round_fps(fps)
    sep = ";" if drop else ":"
    if drop:
        drop_frames = 2 if nominal == 30 else (4 if nominal == 60 else 0)
        fps_int = nominal
        frames_per_min = fps_int * 60 - drop_frames
        frames_per_10min = frames_per_min * 10 + drop_frames
        tens = frame // frames_per_10min
        rem = frame % frames_per_10min
        rem_min = 0 if rem < drop_frames else (rem - drop_frames) // frames_per_min
        minutes = tens * 10 + rem_min
        total = frame + drop_frames * (minutes - minutes // 10)
        ff = total % fps_int
        ss = (total // fps_int) % 60
        mm = (total // (fps_int * 60)) % 60
        hh = total // (fps_int * 3600)
        return f"{hh:02d}:{mm:02d}:{ss:02d}{sep}{ff:02d}"
    ff = frame % nominal
    ss = (frame // nominal) % 60
    mm = (frame // (nominal * 60)) % 60
    hh = frame // (nominal * 3600)
    return f"{hh:02d}:{mm:02d}:{ss:02d}{sep}{ff:02d}"


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


MERGE_TOLERANCE = 2  # frames of source-TOD discontinuity tolerated when merging chunks


def handle_slate_span_report(_payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project — connect to Resolve first")
    tl = rh.timeline
    if not tl:
        raise RuntimeError("No current timeline — open your multicam sequence first")

    tl_name = _safe(lambda: tl.GetName(), "?")
    fps_raw = _safe(lambda: tl.GetSetting("timelineFrameRate"))
    try:
        fps = float(fps_raw)
    except (TypeError, ValueError):
        fps = 24.0
        rh.log(f"⚠ couldn't read timeline frame rate ({fps_raw!r}); assuming {fps}")
    tl_start_frame = _safe(lambda: int(tl.GetStartFrame()), 0)

    rh.log(f"Slate span report — timeline '{tl_name}' @ {fps}fps")

    # Reference track = the video track carrying the most clips (an angle track).
    track_count = _safe(lambda: int(tl.GetTrackCount("video")), 0) or 0
    best_tno, best_items = None, []
    for tno in range(1, track_count + 1):
        items = _safe(lambda: tl.GetItemListInTrack("video", tno), []) or []
        if len(items) > len(best_items):
            best_tno, best_items = tno, items
    if not best_items:
        rh.log("No clips found on any video track — nothing to derive.")
        return {"timeline_name": tl_name, "fps": fps, "reference_track": None,
                "clips": [], "spans": []}
    rh.log(f"Reference track: V{best_tno} ({len(best_items)} clip(s))")

    # Read each clip's source + record boundaries.
    rows: List[Dict[str, Any]] = []
    for item in best_items:
        mpi = _safe(lambda: item.GetMediaPoolItem())
        start_tc = _safe(lambda: mpi.GetClipProperty("Start TC")) if mpi else None
        ssf = _safe(lambda: int(item.GetSourceStartFrame()))
        sef = _safe(lambda: int(item.GetSourceEndFrame()))
        rec_s = _safe(lambda: int(item.GetStart()))
        rec_e = _safe(lambda: int(item.GetEnd()))
        drop = _is_drop_frame(start_tc) if start_tc else False
        src_in_f = src_out_f = None
        if start_tc and ssf is not None:
            base = tc_to_frames(start_tc, fps)
            src_in_f = base + ssf
            src_out_f = (base + sef) if sef is not None else None
        rows.append({
            "name": _safe(lambda: item.GetName(), "?"),
            "src_in_f": src_in_f, "src_out_f": src_out_f,
            "rec_s": rec_s, "rec_e": rec_e, "drop": drop,
        })
    rows.sort(key=lambda r: (r["rec_s"] if r["rec_s"] is not None else 0))

    def rel(f: Optional[int]) -> Optional[int]:
        return (f - tl_start_frame) if f is not None else None

    def tc(f: Optional[int], drop: bool) -> Optional[str]:
        return frames_to_tc(f, fps, drop) if f is not None else None

    clips_out: List[Dict[str, Any]] = []
    rh.log("Per-clip boundaries (record-relative | source TOD):")
    for r in rows:
        sin, sout = tc(r["src_in_f"], r["drop"]), tc(r["src_out_f"], r["drop"])
        rh.log(f"  {str(r['name'])[:40]}  rec[{rel(r['rec_s'])}..{rel(r['rec_e'])}]  "
               f"src[{sin or '?'}..{sout or '?'}]")
        clips_out.append({"name": r["name"], "rec_in": rel(r["rec_s"]),
                          "rec_out": rel(r["rec_e"]), "src_in_tc": sin, "src_out_tc": sout})

    # Merge gapless chunks (source-TOD continuous) into single spans.
    spans: List[Dict[str, Any]] = []
    for r in rows:
        prev = spans[-1] if spans else None
        contiguous = (
            prev is not None
            and r["src_in_f"] is not None
            and prev["src_out_f"] is not None
            and abs(r["src_in_f"] - prev["src_out_f"]) <= MERGE_TOLERANCE
        )
        if contiguous:
            prev["src_out_f"] = r["src_out_f"]
            prev["rec_e"] = r["rec_e"]
            prev["chunks"] += 1
        else:
            spans.append({**r, "chunks": 1})

    rh.log(f"→ {len(spans)} recording span(s) after merging gapless chunks:")
    spans_out: List[Dict[str, Any]] = []
    for i, s in enumerate(spans, 1):
        rin, rout = rel(s["rec_s"]), rel(s["rec_e"])
        frames = (rout - rin) if (rin is not None and rout is not None) else None
        secs = round(frames / fps, 1) if frames is not None else None
        sin, sout = tc(s["src_in_f"], s["drop"]), tc(s["src_out_f"], s["drop"])
        rh.log(f"  span {i}: src[{sin or '?'} → {sout or '?'}]  rec[{rin}..{rout}]  "
               f"{frames} frames (~{secs}s)  {s['chunks']} chunk(s)")
        spans_out.append({"index": i, "src_in_tc": sin, "src_out_tc": sout,
                          "rec_in": rin, "rec_out": rout, "frames": frames,
                          "chunks": s["chunks"]})

    rh.log("Done. Compare span source-TCs to the slate's ATEM Recording "
           "started/stopped timestamps — do they roughly line up?")
    return {
        "timeline_name": tl_name,
        "fps": fps,
        "reference_track": best_tno,
        "clips": clips_out,
        "spans": spans_out,
    }
