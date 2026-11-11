#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Build Timelines: day multicam + one timeline per recording span.

THROWAWAY probe, not wired into editpanel's command dispatch. Proves on a real
project (Resolve 21.1+) the three mechanics a "Build Timelines" button needs:

  1. CREATE THE DAY MULTICAM with MediaPool.CreateMulticamClip (new in 21.1):
     sync by timecode, same-camera clips stacked on one angle, source clips NOT
     moved into a new bin. Camera number comes from the `CAM n` bin (or the
     filename) and is written into each clip's "Camera #" metadata first, since
     ATEM ISO files probably don't carry one Resolve can read.
  2. FIND THE RECORDING SPANS from the source clips' own timecode (Start TC +
     Frames), merging gapless ATEM chunks and unioning across cameras.
  3. CREATE ONE TIMELINE PER SPAN from the multicam, via CreateTimelineFromClips
     with the span's start/end frames, then report whether each placed piece
     still points at the ONE shared multicam.

It changes the project: tags "Camera #" metadata, creates one multicam clip
(reused on re-run) and up to MAX_TIMELINES timelines named `__SPIKE_…` (skipped
if they already exist). Nothing is deleted.

HOW TO RUN: open the project in Resolve, then Workspace ▸ Console ▸ Py3 and:
    exec(open("/Users/lpos/lp-app-ecosystem/editpanel/spikes/spike_build_timelines.py").read())
The report prints to the console and is saved to ~/Desktop/build_timelines_spike.txt.

MANUAL CHECKS AFTER IT RUNS (the API can't answer these):
  a. Open a `__SPIKE_` timeline. Right-click the clip: can you switch angles?
  b. Grade one angle of the multicam (Open in Timeline). Does it show in every
     `__SPIKE_` timeline?
  c. Do the timeline's in/out points match the start/end of that recording?
"""

import os
import re
from typing import Any, Dict, List, Optional

# ──────────────────────────────────────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────────────────────────────────────
# Bin holding the ingested camera folders (searched recursively). None = the bin
# currently selected in the media pool.
SOURCE_BIN: Optional[str] = "FOOTAGE / ATEM"
MC_BIN = "SEQUENCES / MC"            # where the multicam clip goes (created if missing)
MC_NAME: Optional[str] = None        # None = "<source bin name> MC"
TIMELINE_BIN = "SEQUENCES"           # where the test timelines go
TIMELINE_PREFIX = "__SPIKE_"
CAMERAS = {1, 2, 3, 4, 6}            # 1-4 = angles, 6 = slate; others left out. None = all
MAX_TIMELINES: Optional[int] = 3     # None = one timeline for every span
MIN_SPAN_SECONDS = 2.0               # shorter spans are reported but not built
MERGE_TOLERANCE = 2                  # frames of TC gap still treated as one recording
REPORT_PATH = os.path.expanduser("~/Desktop/build_timelines_spike.txt")

BIN_SEP = " / "
CAM_RE = re.compile(r"CAM\s*0*(\d+)", re.IGNORECASE)

_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


# ──────────────────────────────────────────────────────────────────────────────
# Resolve attach
# ──────────────────────────────────────────────────────────────────────────────
def get_resolve() -> Any:
    g = globals().get("resolve")
    if g is not None:
        return g
    try:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
        if r is not None:
            return r
    except Exception as exc:
        say(f"[attach] DaVinciResolveScript failed: {exc}")
    raise RuntimeError("Could not attach to Resolve. Run this from Resolve's Py3 console.")


# ──────────────────────────────────────────────────────────────────────────────
# Timecode (same helpers as helper/commands/slate_span_report.py)
# ──────────────────────────────────────────────────────────────────────────────
def _is_drop_frame(tc: str) -> bool:
    return ";" in tc


def tc_to_frames(tc: str, fps: float) -> int:
    drop = _is_drop_frame(tc)
    hh, mm, ss, ff = (int(p) for p in tc.strip().replace(";", ":").split(":"))
    nominal = int(round(fps))
    total = (hh * 3600 + mm * 60 + ss) * nominal + ff
    if drop:
        drop_frames = 2 if nominal == 30 else (4 if nominal == 60 else 0)
        minutes = 60 * hh + mm
        total -= drop_frames * (minutes - minutes // 10)
    return total


def frames_to_tc(frame: int, fps: float, drop: bool = False) -> str:
    nominal = int(round(fps))
    if drop:
        drop_frames = 2 if nominal == 30 else (4 if nominal == 60 else 0)
        per_min = nominal * 60 - drop_frames
        per_10 = per_min * 10 + drop_frames
        tens, rem = divmod(frame, per_10)
        rem_min = 0 if rem < drop_frames else (rem - drop_frames) // per_min
        minutes = tens * 10 + rem_min
        frame = frame + drop_frames * (minutes - minutes // 10)
    ff = frame % nominal
    ss = (frame // nominal) % 60
    mm = (frame // (nominal * 60)) % 60
    hh = frame // (nominal * 3600)
    return f"{hh:02d}:{mm:02d}:{ss:02d}{';' if drop else ':'}{ff:02d}"


# ──────────────────────────────────────────────────────────────────────────────
# Media pool helpers
# ──────────────────────────────────────────────────────────────────────────────
def find_folder(root: Any, path: str) -> Optional[Any]:
    current = root
    for seg in [s.strip() for s in path.split(BIN_SEP) if s.strip()]:
        nxt = None
        for child in _safe(lambda: current.GetSubFolderList(), []) or []:
            if _safe(lambda: child.GetName()) == seg:
                nxt = child
                break
        if nxt is None:
            return None
        current = nxt
    return current


def find_or_create_folder(mp: Any, root: Any, path: str) -> Optional[Any]:
    current = root
    for seg in [s.strip() for s in path.split(BIN_SEP) if s.strip()]:
        nxt = None
        for child in _safe(lambda: current.GetSubFolderList(), []) or []:
            if _safe(lambda: child.GetName()) == seg:
                nxt = child
                break
        if nxt is None:
            nxt = mp.AddSubFolder(current, seg)
            if nxt is None:
                return None
        current = nxt
    return current


def walk_clips(folder: Any, trail: List[str]):
    """Yield (clip, [folder names from the source bin down]) recursively."""
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield clip, trail
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        yield from walk_clips(sub, trail + [_safe(lambda: sub.GetName(), "?")])


def camera_number(trail: List[str], name: str) -> Optional[int]:
    for part in reversed(trail):
        m = CAM_RE.search(part)
        if m:
            return int(m.group(1))
    m = CAM_RE.search(name)
    return int(m.group(1)) if m else None


def merge_ranges(ranges: List[List[int]], tolerance: int) -> List[List[int]]:
    """Merge [in, out) ranges that overlap or sit within `tolerance` frames."""
    out: List[List[int]] = []
    for r in sorted(ranges):
        if out and r[0] <= out[-1][1] + tolerance:
            out[-1][1] = max(out[-1][1], r[1])
        else:
            out.append(list(r))
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────
def main() -> None:
    r = get_resolve()
    project = r.GetProjectManager().GetCurrentProject()
    if not project:
        raise RuntimeError("No project open.")
    mp = project.GetMediaPool()
    root = mp.GetRootFolder()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}'")
    # hasattr() is useless on Resolve's API proxies (any name resolves), so test
    # the 21.1 constants instead: on 21.0 they come back None.
    if getattr(r, "MULTICAM_ANGLE_SYNC_TIMECODE", None) is None:
        raise RuntimeError("This Resolve has no multicam scripting API — update to 21.1 or later.")

    # ── 1. Gather source clips ────────────────────────────────────────────────
    src = find_folder(root, SOURCE_BIN) if SOURCE_BIN else mp.GetCurrentFolder()
    if src is None:
        raise RuntimeError(f"Source bin not found: {SOURCE_BIN}")
    src_label = _safe(lambda: src.GetName(), "source")
    say(f"\n== 1. Source clips under '{SOURCE_BIN or src_label}' ==")

    clips: List[Dict[str, Any]] = []
    skipped = 0
    for clip, trail in walk_clips(src, []):
        ctype = str(_safe(lambda: clip.GetClipProperty("Type"), "") or "")
        name = _safe(lambda: clip.GetName(), "?")
        start_tc = _safe(lambda: clip.GetClipProperty("Start TC"))
        if "video" not in ctype.lower() or "multicam" in ctype.lower() or not start_tc:
            skipped += 1
            continue
        try:
            frames = int(str(clip.GetClipProperty("Frames")))
            fps = float(clip.GetClipProperty("FPS"))
        except Exception:
            skipped += 1
            continue
        clips.append({
            "clip": clip, "name": name, "cam": camera_number(trail, name),
            "start_tc": start_tc, "frames": frames, "fps": fps,
            "camera_meta": _safe(lambda: clip.GetMetadata("Camera #")),
            "session": next((t for t in trail if not CAM_RE.search(t)), None),
        })
    say(f"{len(clips)} video clip(s), {skipped} other item(s) skipped.")
    if not clips:
        raise RuntimeError("No timecoded video clips found.")
    sessions = sorted({c["session"] for c in clips if c["session"]})
    say(f"Session bin(s): {sessions or '(none)'}")
    if len(sessions) > 1:
        say("⚠ More than one session — all of them go into ONE multicam. "
            "Point SOURCE_BIN at a single session to keep them apart.")
    src_name = sessions[0] if len(sessions) == 1 else src_label

    fps_set = sorted({c["fps"] for c in clips})
    fps = fps_set[0]
    proj_fps = _safe(lambda: float(project.GetSetting("timelineFrameRate")))
    say(f"Clip frame rate(s): {fps_set}; project timeline frame rate: {proj_fps}")
    if len(fps_set) > 1:
        say("⚠ Mixed clip frame rates — results below may be off.")
    if proj_fps and abs(proj_fps - fps) > 0.01:
        say("⚠ Project frame rate differs from the footage; timelines will conform.")

    no_cam = [c for c in clips if c["cam"] is None]
    if no_cam:
        say(f"⚠ {len(no_cam)} clip(s) with no CAM number in bin or name (left out): "
            + ", ".join(c["name"] for c in no_cam[:5]))
        clips = [c for c in clips if c["cam"] is not None]
    if CAMERAS is not None:
        left_out = sorted({c["cam"] for c in clips if c["cam"] not in CAMERAS})
        clips = [c for c in clips if c["cam"] in CAMERAS]
        say(f"Using cameras {sorted(CAMERAS)}; left out: {left_out or 'none'}")
        if not clips:
            raise RuntimeError("No clips left after the camera filter.")

    by_cam: Dict[int, List[Dict[str, Any]]] = {}
    for c in clips:
        c["in_f"] = tc_to_frames(c["start_tc"], fps)
        c["out_f"] = c["in_f"] + c["frames"]
        by_cam.setdefault(c["cam"], []).append(c)
    drop = _is_drop_frame(clips[0]["start_tc"])
    for cam in sorted(by_cam):
        cs = sorted(by_cam[cam], key=lambda c: c["in_f"])
        say(f"  CAM {cam}: {len(cs)} clip(s), "
            f"{frames_to_tc(cs[0]['in_f'], fps, drop)} → {frames_to_tc(cs[-1]['out_f'], fps, drop)}, "
            f"existing Camera # metadata: {sorted({str(c['camera_meta']) for c in cs})}")

    # ── 2. Find recording spans ───────────────────────────────────────────────
    say("\n== 2. Recording spans (from source timecode) ==")
    per_cam = {cam: merge_ranges([[c["in_f"], c["out_f"]] for c in cs], MERGE_TOLERANCE)
               for cam, cs in by_cam.items()}
    spans = merge_ranges([s for ranges in per_cam.values() for s in ranges], MERGE_TOLERANCE)
    min_frames = int(MIN_SPAN_SECONDS * fps)
    for i, (a, b) in enumerate(spans, 1):
        covering = [cam for cam, ranges in per_cam.items()
                    if any(x < b and y > a for x, y in ranges)]
        flag = "" if (b - a) >= min_frames else "  (too short — won't build)"
        say(f"  span {i:02d}: {frames_to_tc(a, fps, drop)} → {frames_to_tc(b, fps, drop)}  "
            f"{(b - a) / fps:7.1f}s  cams {sorted(covering)}{flag}")
    buildable = [(a, b) for a, b in spans if (b - a) >= min_frames]
    say(f"{len(spans)} span(s), {len(buildable)} long enough to build.")

    # ── 3. Day multicam ───────────────────────────────────────────────────────
    say("\n== 3. Day multicam ==")
    mc_name = MC_NAME or f"{src_name} MC"
    mc_bin = find_or_create_folder(mp, root, MC_BIN)
    if mc_bin is None:
        raise RuntimeError(f"Could not create bin {MC_BIN}")
    mc = None
    for clip in _safe(lambda: mc_bin.GetClipList(), []) or []:
        if _safe(lambda: clip.GetName()) == mc_name:
            mc = clip
            say(f"Reusing existing multicam '{mc_name}' in {MC_BIN} (delete it to test creation again).")
            break

    if mc is None:
        tagged = failed = 0
        for c in clips:
            if str(c["camera_meta"] or "") == str(c["cam"]):
                continue
            if _safe(lambda: c["clip"].SetMetadata("Camera #", str(c["cam"])), False):
                tagged += 1
            else:
                failed += 1
        say(f"Camera # metadata: set on {tagged} clip(s), {failed} failed, "
            f"{len(clips) - tagged - failed} already correct.")
        if failed:
            say("⚠ Some clips couldn't be tagged; angle grouping may be wrong.")

        earliest = min(c["in_f"] for c in clips)
        options = {
            "name": mc_name,
            "startTimecode": frames_to_tc(earliest, fps, drop),
            "frameRate": fps,
            "angleSyncMode": r.MULTICAM_ANGLE_SYNC_TIMECODE,
            "angleNameMode": r.MULTICAM_ANGLE_NAME_CAMERA,
            "detectSameCameraClipsMode": r.MULTICAM_DETECT_BY_CAMERA_NUMBER,
            "createBinForSourceClips": False,
        }
        say(f"CreateMulticamClip options: { {k: v for k, v in options.items()} }")
        mp.SetCurrentFolder(mc_bin)
        ordered = [c["clip"] for c in sorted(clips, key=lambda c: (c["cam"], c["in_f"]))]
        result = _safe(lambda: mp.CreateMulticamClip(ordered, options))
        if not result:
            raise RuntimeError("CreateMulticamClip returned nothing — multicam not created.")
        say(f"CreateMulticamClip returned {len(result)} clip(s): "
            + ", ".join(_safe(lambda: m.GetName(), "?") for m in result))
        if len(result) > 1:
            say("⚠ More than one multicam — the day was split. Building from the first only.")
        mc = result[0]

    mc_id = _safe(lambda: mc.GetUniqueId())
    mc_start_tc = _safe(lambda: mc.GetClipProperty("Start TC"))
    mc_frames = _safe(lambda: int(str(mc.GetClipProperty("Frames"))))
    say(f"Multicam '{_safe(lambda: mc.GetName())}': type={_safe(lambda: mc.GetClipProperty('Type'))}, "
        f"start TC={mc_start_tc}, end TC={_safe(lambda: mc.GetClipProperty('End TC'))}, "
        f"frames={mc_frames}, angles={_safe(lambda: mc.GetClipProperty('Angles'))}")
    in_bin = [_safe(lambda: c.GetName()) for c in (_safe(lambda: src.GetClipList(), []) or [])]
    say(f"Source bin root still holds {len(in_bin)} loose clip(s); no 'Original Clips' bin expected.")
    if not mc_start_tc:
        raise RuntimeError("Couldn't read the multicam's start TC — can't map spans.")
    mc_start_f = tc_to_frames(mc_start_tc, fps)

    # ── 4. One timeline per span ──────────────────────────────────────────────
    say("\n== 4. Timelines ==")
    tl_bin = find_or_create_folder(mp, root, TIMELINE_BIN)
    existing = {_safe(lambda: project.GetTimelineByIndex(i).GetName())
                for i in range(1, int(project.GetTimelineCount() or 0) + 1)}
    todo = buildable if MAX_TIMELINES is None else buildable[:MAX_TIMELINES]
    for i, (a, b) in enumerate(todo, 1):
        tl_name = f"{TIMELINE_PREFIX}{src_name}_{i:02d}"
        if tl_name in existing:
            say(f"  {tl_name}: exists, skipped")
            continue
        # endFrame is EXCLUSIVE (21.1.2 run: passing last-frame-inclusive came out 1 short)
        start, end = a - mc_start_f, b - mc_start_f
        if start < 0 or (mc_frames and end > mc_frames):
            say(f"  {tl_name}: span falls outside the multicam ({start}..{end} of {mc_frames}), skipped")
            continue
        mp.SetCurrentFolder(tl_bin)
        tl = _safe(lambda: mp.CreateTimelineFromClips(
            tl_name, [{"mediaPoolItem": mc, "startFrame": start, "endFrame": end}]))
        if not tl:
            say(f"  {tl_name}: ✗ CreateTimelineFromClips failed (frames {start}..{end})")
            continue
        items = _safe(lambda: tl.GetItemListInTrack("video", 1), []) or []
        say(f"  {tl_name}: {frames_to_tc(a, fps, drop)} → {frames_to_tc(b, fps, drop)}, "
            f"expected {b - a} frames; V tracks={tl.GetTrackCount('video')}, "
            f"A tracks={tl.GetTrackCount('audio')}, V1 items={len(items)}")
        for it in items:
            it_mpi = _safe(lambda: it.GetMediaPoolItem())
            say(f"      item '{_safe(lambda: it.GetName())}': type={_safe(lambda: it.GetType())}, "
                f"duration={_safe(lambda: it.GetDuration())}, "
                f"source {_safe(lambda: it.GetSourceStartFrame())}..{_safe(lambda: it.GetSourceEndFrame())}, "
                f"same multicam={_safe(lambda: it_mpi.GetUniqueId()) == mc_id}")
    if MAX_TIMELINES is not None and len(buildable) > MAX_TIMELINES:
        say(f"(Built the first {MAX_TIMELINES} of {len(buildable)}; set MAX_TIMELINES = None for all.)")

    say("\nNow check by hand: angle switching on a __SPIKE_ clip, a multicam grade "
        "showing in every __SPIKE_ timeline, and in/out points matching each recording.")


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(REPORT_PATH, "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
        print(f"\nReport saved to {REPORT_PATH}")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
