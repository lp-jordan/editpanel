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


def _parse_fps_setting(raw: Any, default: Optional[float]) -> Optional[float]:
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return default
    return v if v > 0 else default


def handle_slate_span_report(_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Dispatcher: prefer the current timeline; fall back to the media pool.

    Fetches the current timeline FRESH from the project rather than trusting the
    cached `rh.timeline` (which the monitor thread only refreshes every ~1.5s and
    which is None while a multicam clip — not a timeline — is in the viewer).
    """
    from .. import resolve_helper as rh

    project = rh.project
    if not project:
        pm = _safe(lambda: rh._resolve_project_manager())
        project = _safe(lambda: pm.GetCurrentProject()) if pm else None
    if not project:
        raise RuntimeError("No active project — connect to Resolve first")

    page = _safe(lambda: rh.resolve.GetCurrentPage()) if rh.resolve else None
    proj_name = _safe(lambda: project.GetName(), "?")
    tl_count = _safe(lambda: int(project.GetTimelineCount()), 0) or 0
    rh.log(f"Resolve state — project '{proj_name}', page '{page}', {tl_count} timeline(s).")

    tl = _safe(lambda: project.GetCurrentTimeline()) or rh.timeline
    if tl:
        rh.log(f"Current timeline: '{_safe(lambda: tl.GetName(), '?')}' — reading spans from clip edges.")
        return _report_from_timeline(rh, tl)

    # No open timeline. The multicam CLIP in the source viewer is not a timeline,
    # and the API can't read a collapsed multicam clip's internal angle sub-clips.
    # Fall back to deriving spans from the source clips in the current bin — each
    # ATEM recording is its own clip whose Start TC + duration IS a span.
    rh.log("No current timeline open (a multicam clip in the viewer is NOT a timeline).")
    if tl_count:
        names = []
        for i in range(1, tl_count + 1):
            t = _safe(lambda: project.GetTimelineByIndex(i))
            if t:
                names.append(_safe(lambda: t.GetName(), "?"))
        rh.log(f"Timelines that exist: {', '.join(names)}. To use the timeline path, "
               f"open the stacked/synced one (Edit page) and run again.")
    rh.log("Falling back to source clips in the current media-pool bin…")
    return _report_from_media_pool(rh, project)


def _report_from_timeline(rh: Any, tl: Any) -> Dict[str, Any]:
    tl_name = _safe(lambda: tl.GetName(), "?")
    fps = _parse_fps_setting(_safe(lambda: tl.GetSetting("timelineFrameRate")), None)
    if fps is None:
        fps = 24.0
        rh.log(f"⚠ couldn't read timeline frame rate; assuming {fps}")
    tl_start_frame = _safe(lambda: int(tl.GetStartFrame()), 0)

    rh.log(f"Timeline '{tl_name}' @ {fps}fps")

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
        "mode": "timeline",
        "timeline_name": tl_name,
        "fps": fps,
        "reference_track": best_tno,
        "clips": clips_out,
        "spans": spans_out,
    }


def _report_from_media_pool(rh: Any, project: Any) -> Dict[str, Any]:
    """Derive spans from the source clips in the current media-pool bin.

    Each ATEM recording is its own clip: Start TC = the recording's TOD in-point,
    Start TC + Frames = its out-point. So the recording spans are just the clips'
    own timecode ranges — no timeline and no multicam internals needed. Gapless
    chunks (same recording split across files) merge into one span.
    """
    mp = _safe(lambda: project.GetMediaPool())
    folder = _safe(lambda: mp.GetCurrentFolder()) if mp else None
    folder_name = _safe(lambda: folder.GetName(), "?") if folder else None
    clips = (_safe(lambda: folder.GetClipList(), []) or []) if folder else []
    rh.log(f"Current bin '{folder_name}': {len(clips)} clip(s).")

    # Working frame rate: first source clip's FPS, else the project timeline setting.
    fps: Optional[float] = None
    for c in clips:
        fps = _parse_fps_setting(_safe(lambda: c.GetClipProperty("FPS")), None)
        if fps:
            break
    if not fps:
        fps = _parse_fps_setting(_safe(lambda: project.GetSetting("timelineFrameRate")), 24.0)
    rh.log(f"Working frame rate: {fps}fps")

    rows: List[Dict[str, Any]] = []
    multicam: List[Dict[str, Any]] = []
    for c in clips:
        ctype = str(_safe(lambda: c.GetClipProperty("Type")) or "")
        name = _safe(lambda: c.GetName(), "?")
        start_tc = _safe(lambda: c.GetClipProperty("Start TC"))
        if "multicam" in ctype.lower():
            multicam.append({"name": name, "type": ctype, "start_tc": start_tc})
            continue
        if not start_tc:
            continue  # not a timecoded video clip (audio, still, etc.)
        try:
            frames = int(str(_safe(lambda: c.GetClipProperty("Frames"))))
        except (TypeError, ValueError):
            frames = None
        drop = _is_drop_frame(start_tc)
        try:
            src_in_f = tc_to_frames(start_tc, fps)
        except Exception:
            continue
        src_out_f = (src_in_f + frames) if frames is not None else None
        rows.append({"name": name, "src_in_f": src_in_f,
                     "src_out_f": src_out_f, "drop": drop})

    if multicam:
        rh.log(f"Found {len(multicam)} multicam clip(s) (internals not readable via API): "
               + ", ".join(m["name"] for m in multicam))
    if not rows:
        rh.log("No timecoded source clips in this bin. Select the bin that holds the "
               "camera recordings (e.g. an angle's clips) and run again — or open the "
               "stacked timeline.")
        return {"mode": "media_pool", "bin": folder_name, "fps": fps,
                "source_clips": [], "multicam_clips": multicam, "spans": []}

    rows.sort(key=lambda r: (r["src_in_f"] if r["src_in_f"] is not None else 0))

    def tc(f: Optional[int], drop: bool) -> Optional[str]:
        return frames_to_tc(f, fps, drop) if f is not None else None

    clips_out: List[Dict[str, Any]] = []
    rh.log("Source clips (name | source TOD in→out):")
    for r in rows:
        sin, sout = tc(r["src_in_f"], r["drop"]), tc(r["src_out_f"], r["drop"])
        rh.log(f"  {str(r['name'])[:44]}  src[{sin or '?'}..{sout or '?'}]")
        clips_out.append({"name": r["name"], "src_in_tc": sin, "src_out_tc": sout})

    # Merge gapless chunks (next clip's TOD in ≈ prev clip's TOD out) into spans.
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
            prev["chunks"] += 1
        else:
            spans.append({**r, "chunks": 1})

    rh.log(f"→ {len(spans)} recording span(s) after merging gapless chunks:")
    spans_out: List[Dict[str, Any]] = []
    for i, s in enumerate(spans, 1):
        frames = ((s["src_out_f"] - s["src_in_f"])
                  if (s["src_in_f"] is not None and s["src_out_f"] is not None) else None)
        secs = round(frames / fps, 1) if frames is not None else None
        sin, sout = tc(s["src_in_f"], s["drop"]), tc(s["src_out_f"], s["drop"])
        rh.log(f"  span {i}: src[{sin or '?'} → {sout or '?'}]  "
               f"{frames} frames (~{secs}s)  {s['chunks']} chunk(s)")
        spans_out.append({"index": i, "src_in_tc": sin, "src_out_tc": sout,
                          "frames": frames, "chunks": s["chunks"]})

    rh.log("Done. Compare span source-TCs to the slate's ATEM Recording "
           "started/stopped timestamps — do they roughly line up?")
    return {"mode": "media_pool", "bin": folder_name, "fps": fps,
            "source_clips": clips_out, "multicam_clips": multicam, "spans": spans_out}
