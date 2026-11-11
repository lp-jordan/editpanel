#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Slate-driven auto-sequencing feasibility probe.

This is a THROWAWAY diagnostic, NOT wired into editpanel's command dispatch
(helper/commands/HANDLERS). Its only job is to prove — on a real Resolve project
with a real multicam sequence — the two mechanics the planned feature depends on:

  1. SOURCE-TC READ: can we read a multicam clip's *source* timecode (which,
     because the ATEM jams time-of-day TC, equals the slate's wall-clock time)
     and reliably map a slate TOD timestamp to a frame on the current timeline?

  2. TRIMMED-TIMELINE CREATION: can we create a new timeline cut to a source
     in/out range (i.e. one ATEM recording span) from the multicam, via
     MediaPool.CreateTimelineFromClips?

Plus a bonus check for mechanic (3) the feature also needs:

  3. MARKER MAPPING: place a marker at a computed frame (the code-change markers
     that will live inside each span sequence).

WHAT IT DOES NOT DO: talk to LPOS, read any real slate, or change your project in
a way that can't be undone (the one marker and one test timeline it creates are
clearly tagged `__SPIKE...` and cleaned up / easy to delete).

HOW TO RUN (on the Windows/Resolve machine):

  A) Easiest — inside Resolve's own console:
     Workspace ▸ Console ▸ switch to "Py3", then paste this file's contents, OR:
         exec(open(r"C:\\path\\to\\editpanel\\spikes\\spike_slate_multicam.py").read())
     The console injects a global `resolve`, so no attach step is needed.

  B) External — from a terminal, with Resolve already open:
         python spike_slate_multicam.py
     (Uses editpanel's bundled fusionscript loader; needs Resolve running.)

  Optional: feed a REAL ATEM start/stop pair to test an exact span. Edit
  CONFIG.test_span_in_tc / test_span_out_tc below to the slate's recording
  START and STOP timecodes (e.g. "10:09:32:01" / "10:15:51:16"). Leave as None
  to auto-derive a test span from the first clip on the timeline.

BEFORE RUNNING: open the multicam sequence (timeline) you want to probe so it is
the *current* timeline in Resolve.

Paste the printed report back and we lock the exact mapping formula + creation
path before wiring anything into editpanel.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional, Tuple


# ──────────────────────────────────────────────────────────────────────────────
# CONFIG — tweak here, no CLI parsing needed so it also works pasted into console
# ──────────────────────────────────────────────────────────────────────────────
class CONFIG:
    # Real ATEM recording span to test, as source timecodes "HH:MM:SS:FF".
    # Leave both None to auto-derive a harmless test span from the first clip.
    test_span_in_tc: Optional[str] = None      # e.g. "10:09:32:01"  (ATEM start)
    test_span_out_tc: Optional[str] = None      # e.g. "10:15:51:16"  (ATEM stop)

    # A slate code timestamp inside the span, to test marker placement.
    # Leave None to auto-derive the midpoint of the test span.
    test_code_tc: Optional[str] = None          # e.g. "10:10:59:00"

    place_test_marker: bool = True              # mechanic (3)
    create_test_timeline: bool = True           # mechanic (2) — the risky one
    cleanup_marker: bool = True                 # remove the spike marker after
    # The test timeline is left in place (named __SPIKE_...) so you can inspect
    # its start TC / duration; delete it manually or via the media pool.


SPIKE_MARKER_TAG = "spike:slate-multicam"
SPIKE_TL_PREFIX = "__SPIKE_span_"


# ──────────────────────────────────────────────────────────────────────────────
# Resolve attach — try every path so this runs pasted-in OR external
# ──────────────────────────────────────────────────────────────────────────────
def get_resolve() -> Any:
    # 1) Running inside Resolve's Py3 console: `resolve` is already a global.
    g = globals().get("resolve")
    if g is not None:
        return g
    try:
        return resolve  # type: ignore[name-defined]  # noqa: F821
    except NameError:
        pass

    # 2) editpanel's bundled loader (self-contained; no Blackmagic modules dir).
    here = os.path.dirname(os.path.abspath(__file__))
    helper_dir = os.path.normpath(os.path.join(here, "..", "helper"))
    if helper_dir not in sys.path:
        sys.path.insert(0, helper_dir)
    try:
        from python_get_resolve import GetResolve  # type: ignore
        r = GetResolve()
        if r is not None:
            return r
    except Exception as exc:
        print(f"[attach] bundled loader failed: {exc}")

    # 3) Blackmagic's official wrapper, if the Scripting module is installed.
    try:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
        if r is not None:
            return r
    except Exception as exc:
        print(f"[attach] DaVinciResolveScript failed: {exc}")

    raise RuntimeError(
        "Could not attach to Resolve. Make sure Resolve is running, or paste "
        "this script into Resolve's Py3 console."
    )


# ──────────────────────────────────────────────────────────────────────────────
# Timecode helpers — parse/format "HH:MM:SS:FF" (non-drop) and "HH:MM:SS;FF" (DF)
# ──────────────────────────────────────────────────────────────────────────────
def _is_drop_frame(tc: str) -> bool:
    return ";" in tc


def _round_fps(fps: float) -> int:
    """Nominal integer frame count per second used for TC math (30 for 29.97 DF)."""
    return int(round(fps))


def tc_to_frames(tc: str, fps: float) -> int:
    """Convert a timecode string to an absolute frame number.

    Handles drop-frame (';' separator, only meaningful for 29.97/59.94). For
    non-drop, this is a straight base-`nominal_fps` count. ATEM TOD TC at 25/24/30
    is non-drop in practice, but we handle DF so the spike is honest about it.
    """
    tc = tc.strip()
    drop = _is_drop_frame(tc)
    parts = tc.replace(";", ":").split(":")
    if len(parts) != 4:
        raise ValueError(f"Bad timecode {tc!r}; expected HH:MM:SS:FF")
    hh, mm, ss, ff = (int(p) for p in parts)
    nominal = _round_fps(fps)

    if drop:
        # Standard SMPTE drop-frame: drop 2 frames each minute except every 10th.
        drop_frames = 2 if nominal == 30 else (4 if nominal == 60 else 0)
        total_minutes = 60 * hh + mm
        frames = (
            (hh * 3600 + mm * 60 + ss) * nominal
            + ff
            - drop_frames * (total_minutes - total_minutes // 10)
        )
        return frames
    return ((hh * 3600 + mm * 60 + ss) * nominal) + ff


def frames_to_tc(frame: int, fps: float, drop: bool = False) -> str:
    nominal = _round_fps(fps)
    sep = ";" if drop else ":"
    if drop:
        drop_frames = 2 if nominal == 30 else (4 if nominal == 60 else 0)
        fps_int = nominal
        frames_per_min = fps_int * 60 - drop_frames
        frames_per_10min = frames_per_min * 10 + drop_frames  # first min of 10 not dropped
        tens = frame // frames_per_10min
        rem = frame % frames_per_10min
        if rem < drop_frames:
            rem_min = 0
            add = rem
        else:
            rem_min = (rem - drop_frames) // frames_per_min
            add = (rem - drop_frames) % frames_per_min
        minutes = tens * 10 + rem_min
        # reconstruct
        total_seconds_frames = frame + drop_frames * (minutes - minutes // 10)
        ff = total_seconds_frames % fps_int
        ss = (total_seconds_frames // fps_int) % 60
        mm = (total_seconds_frames // (fps_int * 60)) % 60
        hh = total_seconds_frames // (fps_int * 3600)
        return f"{hh:02d}:{mm:02d}:{ss:02d}{sep}{ff:02d}"
    ff = frame % nominal
    ss = (frame // nominal) % 60
    mm = (frame // (nominal * 60)) % 60
    hh = frame // (nominal * 3600)
    return f"{hh:02d}:{mm:02d}:{ss:02d}{sep}{ff:02d}"


def _safe(fn, default=None):
    try:
        return fn()
    except Exception as exc:
        return default


# ──────────────────────────────────────────────────────────────────────────────
# Reporting
# ──────────────────────────────────────────────────────────────────────────────
def hr(title: str = "") -> None:
    print("\n" + "=" * 78)
    if title:
        print(title)
        print("=" * 78)


def describe_item(item: Any, fps: float, tl_start_frame: int) -> Dict[str, Any]:
    """Pull every source/record coordinate we can off a timeline item + its clip.

    The whole point: reconcile GetSourceStartFrame() vs the MediaPoolItem's
    'Start TC' so we know the exact formula for source-TC → record-frame.
    """
    mpi = _safe(lambda: item.GetMediaPoolItem())
    name = _safe(lambda: item.GetName(), "?")

    src_start_f = _safe(lambda: int(item.GetSourceStartFrame()))
    src_end_f = _safe(lambda: int(item.GetSourceEndFrame()))
    rec_start_f = _safe(lambda: int(item.GetStart()))     # absolute project frame
    rec_end_f = _safe(lambda: int(item.GetEnd()))
    left_off = _safe(lambda: int(item.GetLeftOffset()))
    duration = _safe(lambda: int(item.GetDuration()))

    clip_start_tc = _safe(lambda: mpi.GetClipProperty("Start TC")) if mpi else None
    clip_type = _safe(lambda: mpi.GetClipProperty("Type")) if mpi else None
    clip_fps = _safe(lambda: mpi.GetClipProperty("FPS")) if mpi else None
    clip_name = _safe(lambda: mpi.GetName()) if mpi else None

    info = {
        "name": name,
        "clip_name": clip_name,
        "clip_type": clip_type,          # look for 'Multicam' here
        "clip_fps": clip_fps,
        "clip_start_tc": clip_start_tc,  # media first-frame TC (should read as TOD)
        "GetSourceStartFrame": src_start_f,
        "GetSourceEndFrame": src_end_f,
        "GetLeftOffset": left_off,
        "GetStart(record abs)": rec_start_f,
        "GetEnd(record abs)": rec_end_f,
        "GetDuration": duration,
        "rec_start_rel(0-based)": (rec_start_f - tl_start_frame) if rec_start_f is not None else None,
    }

    # Candidate source-TC of the item's IN point, computed two ways so we can see
    # which one lines up with the slate when you eyeball it.
    if clip_start_tc and src_start_f is not None:
        try:
            base = tc_to_frames(clip_start_tc, fps)
            info["src_in_TC (StartTC + GetSourceStartFrame)"] = frames_to_tc(
                base + src_start_f, fps, _is_drop_frame(clip_start_tc)
            )
        except Exception as exc:
            info["src_in_TC (StartTC + GetSourceStartFrame)"] = f"calc err: {exc}"
    return info, mpi, (clip_start_tc, src_start_f, src_end_f, rec_start_f, rec_end_f)


def derive_and_report_spans(tl: Any, fps: float, tl_start_frame: int) -> None:
    """MECHANIC 0 — the preferred approach: derive recording spans purely from
    where the stacked clips start/stop on a reference angle track. NO ATEM slate
    events needed for boundaries; the clip edges carry the true embedded TC (the
    slate's ATEM timestamps are only LPOS system-clock approximations).

    Merges gapless chunks (ATEM splitting one long recording into multiple files —
    source TOD stays continuous across the split) into a single span; a real time
    gap between clips = a real recording boundary.
    """
    hr("MECHANIC 0 — spans from clip boundaries (no ATEM events needed)")
    track_count = _safe(lambda: int(tl.GetTrackCount("video")), 0) or 0

    # Reference track = the video track carrying the most clips (an angle track).
    # Cameras start/stop together (confirmed), so any one angle gives the spans.
    best_tno, best_items = None, []
    for tno in range(1, track_count + 1):
        items = _safe(lambda: tl.GetItemListInTrack("video", tno), []) or []
        if len(items) > len(best_items):
            best_tno, best_items = tno, items
    if not best_items:
        print("  [stop] no clips on any video track")
        return
    print(f"  reference track: V{best_tno} ({len(best_items)} clip(s))")

    rows: List[Dict[str, Any]] = []
    for item in best_items:
        mpi = _safe(lambda: item.GetMediaPoolItem())
        start_tc = _safe(lambda: mpi.GetClipProperty("Start TC")) if mpi else None
        ssf = _safe(lambda: int(item.GetSourceStartFrame()))
        sef = _safe(lambda: int(item.GetSourceEndFrame()))
        rec_s = _safe(lambda: int(item.GetStart()))
        rec_e = _safe(lambda: int(item.GetEnd()))
        src_in_f = src_out_f = None
        drop = _is_drop_frame(start_tc) if start_tc else False
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

    def _rel(f):
        return (f - tl_start_frame) if f is not None else None

    def _tc(f, drop):
        return frames_to_tc(f, fps, drop) if f is not None else "?"

    print("\n  per-clip boundaries (record-relative | source TOD):")
    for r in rows:
        print(f"    {str(r['name'])[:40]:40}  rec[{_rel(r['rec_s'])}..{_rel(r['rec_e'])}]  "
              f"src[{_tc(r['src_in_f'], r['drop'])}..{_tc(r['src_out_f'], r['drop'])}]")

    # Merge gapless chunks: next clip's source-in TOD ≈ prev clip's source-out TOD.
    MERGE_TOLERANCE = 2  # frames of source-TOD discontinuity tolerated
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

    print(f"\n  → derived {len(spans)} recording span(s) after merging gapless chunks:")
    for i, s in enumerate(spans, 1):
        rin, rout = _rel(s["rec_s"]), _rel(s["rec_e"])
        dur = (rout - rin) if (rin is not None and rout is not None) else None
        print(f"    span {i}: src[{_tc(s['src_in_f'], s['drop'])} → {_tc(s['src_out_f'], s['drop'])}]  "
              f"rec[{rin}..{rout}]  {dur} frames  ({s['chunks']} chunk(s))")
    print("\n  These src[in→out] ranges are exactly what each sequence would cut to,")
    print("  and the source TC window is what we'd use to pull the codes that name")
    print("  each span + drop the in-span markers. Compare span src-TC to the slate:")
    print("  do the ATEM 'Recording started/stopped' timestamps roughly match?")


def main() -> None:
    resolve = get_resolve()
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject() if pm else None
    if not project:
        raise RuntimeError("No current project open in Resolve.")
    tl = project.GetCurrentTimeline()
    if not tl:
        raise RuntimeError(
            "No current timeline. Open your multicam sequence so it's the "
            "active timeline, then re-run."
        )

    hr("PROJECT / TIMELINE")
    tl_name = _safe(lambda: tl.GetName(), "?")
    tl_uid = _safe(lambda: tl.GetUniqueId())
    tl_start_tc = _safe(lambda: tl.GetStartTimecode())
    tl_fps_raw = _safe(lambda: tl.GetSetting("timelineFrameRate"))
    try:
        fps = float(tl_fps_raw)
    except (TypeError, ValueError):
        fps = 24.0
        print(f"[warn] could not read timelineFrameRate ({tl_fps_raw!r}); assuming {fps}")
    tl_start_frame = _safe(lambda: int(tl.GetStartFrame()), 0)
    tl_end_frame = _safe(lambda: int(tl.GetEndFrame()))
    print(f"  project           : {_safe(lambda: project.GetName())}")
    print(f"  timeline          : {tl_name}")
    print(f"  uid               : {tl_uid}")
    print(f"  start timecode    : {tl_start_tc}   (record TC — NOT what we map against)")
    print(f"  fps               : {fps}")
    print(f"  start frame (abs) : {tl_start_frame}")
    print(f"  end frame (abs)   : {tl_end_frame}")

    hr("VIDEO TRACK ITEMS  (mechanic 1: source-TC read)")
    track_count = _safe(lambda: int(tl.GetTrackCount("video")), 0)
    print(f"  video track count : {track_count}")
    first_mpi = None
    first_coords: Optional[Tuple] = None
    multicam_seen = False
    for tno in range(1, (track_count or 0) + 1):
        items = _safe(lambda: tl.GetItemListInTrack("video", tno), []) or []
        print(f"\n  ── V{tno}: {len(items)} item(s) ──")
        for i, item in enumerate(items):
            info, mpi, coords = describe_item(item, fps, tl_start_frame)
            if (info.get("clip_type") or "").lower().find("multicam") >= 0:
                multicam_seen = True
            for k, v in info.items():
                print(f"      {k:38}: {v}")
            print("      " + "-" * 60)
            if first_mpi is None and mpi is not None:
                first_mpi = mpi
                first_coords = coords

    print(f"\n  multicam clip detected on timeline? {multicam_seen}")
    if not multicam_seen:
        print("  [note] No item reported Type=Multicam. Either the sequence isn't")
        print("         built from a multicam clip, or this Resolve build doesn't")
        print("         surface the type. Source-TC mapping still works per-clip.")

    # Mechanic 0: derive spans purely from clip edges (the approach we're testing).
    derive_and_report_spans(tl, fps, tl_start_frame)

    if first_mpi is None or first_coords is None:
        print("\n[stop] No timeline item with a backing MediaPoolItem — cannot run")
        print("       the mapping / creation tests. Report the above.")
        return

    clip_start_tc, src_start_f, src_end_f, rec_start_f, rec_end_f = first_coords

    # ── Determine the test span (source-TC in/out) ───────────────────────────
    hr("TEST SPAN  (mechanic 1→2)")
    if CONFIG.test_span_in_tc and CONFIG.test_span_out_tc:
        span_in_tc, span_out_tc = CONFIG.test_span_in_tc, CONFIG.test_span_out_tc
        print(f"  using CONFIG span: {span_in_tc} → {span_out_tc}")
    elif clip_start_tc and src_start_f is not None and src_end_f is not None:
        # Auto-derive a harmless sub-span from the first clip: 1s in to 3s in.
        base = tc_to_frames(clip_start_tc, fps)
        in_f = base + src_start_f + int(round(1 * fps))
        out_f = min(base + src_end_f, in_f + int(round(2 * fps)))
        span_in_tc = frames_to_tc(in_f, fps, _is_drop_frame(clip_start_tc))
        span_out_tc = frames_to_tc(out_f, fps, _is_drop_frame(clip_start_tc))
        print(f"  auto-derived span from first clip: {span_in_tc} → {span_out_tc}")
    else:
        print("  [stop] cannot derive a test span (missing Start TC / source frames)")
        return

    # Map a source TC → 0-relative timeline frame using the first clip's anchor.
    # Formula under test:
    #   record_abs = item.GetStart() + (target_src_frame - (clipStartTCframes + GetSourceStartFrame))
    #   marker_frame(0-rel) = record_abs - timeline.GetStartFrame()
    def src_tc_to_timeline_frame(target_tc: str) -> Optional[int]:
        if clip_start_tc is None or src_start_f is None or rec_start_f is None:
            return None
        clip_base = tc_to_frames(clip_start_tc, fps)
        item_src_in_abs = clip_base + src_start_f      # source frame of item's in-point
        target_abs = tc_to_frames(target_tc, fps)
        offset_into_item = target_abs - item_src_in_abs
        record_abs = rec_start_f + offset_into_item
        return record_abs - tl_start_frame

    marker_tc = CONFIG.test_code_tc
    if not marker_tc:
        # midpoint of span
        mid = (tc_to_frames(span_in_tc, fps) + tc_to_frames(span_out_tc, fps)) // 2
        marker_tc = frames_to_tc(mid, fps, _is_drop_frame(span_in_tc))
    mapped = src_tc_to_timeline_frame(marker_tc)
    print(f"  code TC {marker_tc} → 0-relative timeline frame: {mapped}")
    if mapped is not None:
        print(f"    → ruler should read: {frames_to_tc((tl_start_frame or 0) + mapped, fps)}")

    # ── Mechanic 3: place a marker at the mapped frame ───────────────────────
    if CONFIG.place_test_marker and mapped is not None:
        hr("MECHANIC 3 — marker placement")
        if mapped < 0:
            print(f"  [skip] mapped frame {mapped} < 0 (code TC before this clip's in-point)")
        else:
            ok = _safe(lambda: bool(tl.AddMarker(
                mapped, "Cyan", "SPIKE code marker",
                f"code TC {marker_tc}", 1, SPIKE_MARKER_TAG)), False)
            print(f"  AddMarker({mapped}) → {ok}")
            if ok:
                print("  ✔ Open the timeline and confirm the Cyan marker sits at the")
                print(f"    expected spot ({marker_tc} of source content).")
                if CONFIG.cleanup_marker:
                    removed = _safe(lambda: bool(
                        tl.DeleteMarkerByCustomData(SPIKE_MARKER_TAG)), False)
                    print(f"  cleanup DeleteMarkerByCustomData → {removed}")

    # ── Mechanic 2: create a trimmed timeline from source in/out ─────────────
    if CONFIG.create_test_timeline:
        hr("MECHANIC 2 — trimmed timeline creation (the risky one)")
        mp = _safe(lambda: project.GetMediaPool())
        if not mp:
            print("  [stop] no media pool")
            return
        clip_base = tc_to_frames(clip_start_tc, fps) if clip_start_tc else 0
        # Source frames are relative to media start (0). Convert span TC → source frame.
        span_in_src = tc_to_frames(span_in_tc, fps) - clip_base
        span_out_src = tc_to_frames(span_out_tc, fps) - clip_base
        print(f"  source-frame in/out on multicam MPI: {span_in_src} → {span_out_src}")
        new_name = f"{SPIKE_TL_PREFIX}{span_in_tc.replace(':', '-').replace(';', '-')}"
        clip_info = {
            "mediaPoolItem": first_mpi,
            "startFrame": max(0, span_in_src),
            "endFrame": max(0, span_out_src),
        }
        new_tl = _safe(lambda: mp.CreateTimelineFromClips(new_name, [clip_info]))
        if new_tl:
            n = _safe(lambda: new_tl.GetName())
            stc = _safe(lambda: new_tl.GetStartTimecode())
            sf = _safe(lambda: int(new_tl.GetStartFrame()))
            ef = _safe(lambda: int(new_tl.GetEndFrame()))
            dur = (ef - sf) if (sf is not None and ef is not None) else None
            print(f"  ✔ created timeline: {n}")
            print(f"      start TC : {stc}")
            print(f"      duration : {dur} frames  (~{(dur / fps) if dur else '?'}s)")
            print(f"      expected : ~{span_out_src - span_in_src} frames")
            print("  Inspect it: does it hold the right multicam range, and are all")
            print("  angles preserved (so multicam switching still works)? This is the")
            print("  key thing to eyeball — if angles collapse to one, we need a")
            print("  duplicate-and-trim path instead of CreateTimelineFromClips.")
        else:
            print("  �’✗ CreateTimelineFromClips returned falsy. Fallback paths to try:")
            print("     - mp.AppendToTimeline([clipInfo]) onto a fresh empty timeline")
            print("     - duplicate the multicam timeline + trim to in/out")
            print("     Report this so we pick the fallback before wiring.")

    hr("DONE")
    print("Paste this whole report back. Key questions it answers:")
    print("  1. Does clip 'Start TC' read as time-of-day (matches the slate)?")
    print("  2. Did the Cyan marker land at the right place?")
    print("  3. Did CreateTimelineFromClips make a correctly-trimmed timeline")
    print("     with multicam angles intact?")


if __name__ == "__main__":
    main()
else:
    # Pasted into Resolve's console (no __main__): run immediately.
    main()
