"""Create a day multicam from a media-pool bin, then optionally its timelines.
Called by CreateMulticamOverlay. Needs Resolve 21.1+.

create_multicam
  { "source_bin": "FOOTAGE / ATEM / Session", "multicam_name": "Session", "reuse_existing": false }
  Writes SEQUENCES / MC / <multicam_name>. Returns `day`: the multicam's
  fps, timecode and recordings, which main names from the LPOS slate
  (cut_through_videos.js).

create_multicam_timelines
  { "multicam_name": "Session", "timelines": [{ "name": "H6_raw", "segments": [[from, to], ...] }] }
  Writes SEQUENCES / <multicam_name> / <name>. Segments are multicam frames, `to` exclusive.

Clips get their camera number from the nearest `CAM n` bin, else the filename.
Only CAMERAS are used. Mic WAVs are not handled.
"""
import re
from typing import Any, Dict, List, Optional

from .bin_tree import BIN_PATH_SEPARATOR, resolve_folder_by_path
from .import_media import _find_or_create_path
from .slate_span_report import _is_drop_frame, frames_to_tc, tc_to_frames

CAMERAS = {1, 2, 3, 4, 6}        # 1-4 = angles, 6 = slate
MIN_SPAN_SECONDS = 2.0           # shorter recordings don't get a timeline
MERGE_TOLERANCE = 2              # frames of timecode gap still treated as one recording
CAM_RE = re.compile(r"CAM\s*0*(\d+)", re.IGNORECASE)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _walk_clips(folder: Any, trail: List[str]):
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield clip, trail
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        yield from _walk_clips(sub, trail + [_safe(lambda: sub.GetName(), "?")])


def _camera_number(trail: List[str], name: str) -> Optional[int]:
    for part in reversed(trail):
        m = CAM_RE.search(part)
        if m:
            return int(m.group(1))
    m = CAM_RE.search(name)
    return int(m.group(1)) if m else None


def _merge_ranges(ranges: List[List[int]], tolerance: int) -> List[List[int]]:
    out: List[List[int]] = []
    for r in sorted(ranges):
        if out and r[0] <= out[-1][1] + tolerance:
            out[-1][1] = max(out[-1][1], r[1])
        else:
            out.append(list(r))
    return out


def _gather_clips(source: Any) -> List[Dict[str, Any]]:
    clips: List[Dict[str, Any]] = []
    for clip, trail in _walk_clips(source, []):
        ctype = str(_safe(lambda: clip.GetClipProperty("Type"), "") or "").lower()
        start_tc = _safe(lambda: clip.GetClipProperty("Start TC"))
        if "video" not in ctype or "multicam" in ctype or not start_tc:
            continue
        try:
            frames = int(str(clip.GetClipProperty("Frames")))
            fps = float(clip.GetClipProperty("FPS"))
        except Exception:
            continue
        name = _safe(lambda: clip.GetName(), "?")
        clips.append({
            "clip": clip,
            "cam": _camera_number(trail, name),
            "start_tc": start_tc,
            "frames": frames,
            "fps": fps,
            "camera_meta": _safe(lambda: clip.GetMetadata("Camera #")),
            "session": next((t for t in trail if not CAM_RE.search(t)), None),
        })
    return clips


def _day(mc: Any, mc_name: str, clips: List[Dict[str, Any]], fps: float) -> Optional[Dict[str, Any]]:
    """The multicam as cut_through_videos.js reads a day: times in seconds."""
    start_tc = _safe(lambda: mc.GetClipProperty("Start TC"))
    frames = _safe(lambda: int(str(mc.GetClipProperty("Frames"))))
    if not start_tc or not frames:
        return None
    mc_start = tc_to_frames(start_tc, fps)
    per_cam: Dict[int, List[List[int]]] = {}
    for c in clips:
        per_cam.setdefault(c["cam"], []).append([c["in_f"], c["in_f"] + c["frames"]])
    merged = [s for ranges in per_cam.values() for s in _merge_ranges(ranges, MERGE_TOLERANCE)]
    spans = [s for s in _merge_ranges(merged, MERGE_TOLERANCE)
             if s[1] - s[0] >= int(MIN_SPAN_SECONDS * fps)]
    return {
        "multicam": mc_name,
        "fps": fps,
        "tc_start_sec": mc_start / fps,
        "length_sec": frames / fps,
        "recordings": [{"from_sec": (a - mc_start) / fps, "to_sec": (b - mc_start) / fps}
                       for a, b in spans if a >= mc_start and b - mc_start <= frames],
    }


def _find_clip(folder: Any, name: str) -> Optional[Any]:
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        if _safe(lambda: clip.GetName()) == name:
            return clip
    return None


def handle_create_multicam(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.resolve or not rh.project:
        raise RuntimeError("Resolve not connected or no project open")
    # hasattr() is useless on Resolve's API proxies: on 21.0 the constant is None.
    if getattr(rh.resolve, "MULTICAM_ANGLE_SYNC_TIMECODE", None) is None:
        raise RuntimeError("Creating multicams needs Resolve 21.1 or later.")

    source_path = str(payload.get("source_bin") or "").strip()
    multicam_name = str(payload.get("multicam_name") or "").strip()
    if not source_path:
        raise RuntimeError("Choose a source bin.")
    if not multicam_name:
        raise RuntimeError("Enter a multicam name.")
    if "/" in multicam_name:
        raise RuntimeError("Multicam name can't contain /.")

    media_pool = rh.project.GetMediaPool()
    root = media_pool.GetRootFolder()
    source = resolve_folder_by_path(root, source_path)
    if source is None:
        raise RuntimeError(f"Bin not found: {source_path}")

    clips = _gather_clips(source)
    if not clips:
        raise RuntimeError("No timecoded video clips in that bin.")

    warnings: List[str] = []
    sessions = sorted({c["session"] for c in clips if c["session"]})
    if len(sessions) > 1:
        warnings.append(f"{len(sessions)} sessions went into this one multicam.")
    no_cam = sum(1 for c in clips if c["cam"] is None)
    if no_cam:
        warnings.append(f"{no_cam} clip(s) had no CAM number and were left out.")
    left_out = sorted({c["cam"] for c in clips if c["cam"] is not None and c["cam"] not in CAMERAS})
    clips = [c for c in clips if c["cam"] in CAMERAS]
    if not clips:
        raise RuntimeError(f"No clips from cameras {sorted(CAMERAS)} in that bin.")

    fps_set = sorted({c["fps"] for c in clips})
    fps = fps_set[0]
    if len(fps_set) > 1:
        warnings.append(f"Mixed clip frame rates: {fps_set}.")
    for c in clips:
        c["in_f"] = tc_to_frames(c["start_tc"], fps)

    mc_name = multicam_name
    mc_segments = ["SEQUENCES", "MC"]
    mc_path = BIN_PATH_SEPARATOR.join(mc_segments)
    existing_bin = resolve_folder_by_path(root, mc_path)
    mc = _find_clip(existing_bin, mc_name) if existing_bin is not None else None
    if mc is not None and not payload.get("reuse_existing"):
        raise RuntimeError(f"{mc_name} already exists in {mc_path}.")
    reused = mc is not None

    if mc is None:
        mc_bin = _find_or_create_path(media_pool, root, mc_segments)
        if mc_bin is None or not media_pool.SetCurrentFolder(mc_bin):
            raise RuntimeError(f"Could not create bin {mc_path}")

        failed_tags = 0
        for c in clips:
            if str(c["camera_meta"] or "") != str(c["cam"]):
                if not _safe(lambda: c["clip"].SetMetadata("Camera #", str(c["cam"])), False):
                    failed_tags += 1
        if failed_tags:
            warnings.append(f"{failed_tags} clip(s) couldn't be tagged; angle grouping may be wrong.")

        drop = _is_drop_frame(clips[0]["start_tc"])
        ordered = [c["clip"] for c in sorted(clips, key=lambda c: (c["cam"], c["in_f"]))]
        options = {
            "name": mc_name,
            "startTimecode": frames_to_tc(min(c["in_f"] for c in clips), fps, drop),
            "frameRate": fps,
            "angleSyncMode": rh.resolve.MULTICAM_ANGLE_SYNC_TIMECODE,
            "angleNameMode": rh.resolve.MULTICAM_ANGLE_NAME_CAMERA,
            "detectSameCameraClipsMode": rh.resolve.MULTICAM_DETECT_BY_CAMERA_NUMBER,
            "createBinForSourceClips": False,
        }
        rh.log(f"[create_multicam] {len(ordered)} clip(s) from {source_path} → {mc_path}")
        created = _safe(lambda: media_pool.CreateMulticamClip(ordered, options))
        if not created:
            raise RuntimeError("Resolve didn't create the multicam.")
        if len(created) > 1:
            warnings.append(f"Resolve split this into {len(created)} multicams; timelines use the first.")
        mc = created[0]

    day = _day(mc, mc_name, clips, fps)
    if day is None and payload.get("reuse_existing"):
        warnings.append("Couldn't read the multicam's timecode, so no timelines can be built.")

    return {
        "result": True,
        "multicam": mc_name,
        "bin": mc_path,
        "clips": len(clips),
        "cameras": sorted({c["cam"] for c in clips}),
        "cameras_left_out": left_out,
        "reused": reused,
        "day": day,
        "warnings": warnings,
    }


def handle_create_multicam_timelines(payload: Dict[str, Any]) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.resolve or not rh.project:
        raise RuntimeError("Resolve not connected or no project open")
    multicam_name = str(payload.get("multicam_name") or "").strip()
    timelines = payload.get("timelines")
    if not multicam_name or not isinstance(timelines, list):
        raise RuntimeError("Nothing to build.")

    media_pool = rh.project.GetMediaPool()
    root = media_pool.GetRootFolder()
    mc_name = multicam_name
    mc_folder = resolve_folder_by_path(root, BIN_PATH_SEPARATOR.join(["SEQUENCES", "MC"]))
    mc = _find_clip(mc_folder, mc_name) if mc_folder is not None else None
    if mc is None:
        raise RuntimeError(f"Multicam not found: {mc_name}")
    mc_frames = _safe(lambda: int(str(mc.GetClipProperty("Frames"))))

    tl_bin = _find_or_create_path(media_pool, root, ["SEQUENCES", multicam_name])
    if tl_bin is None or not media_pool.SetCurrentFolder(tl_bin):
        raise RuntimeError(f"Could not create bin SEQUENCES / {multicam_name}")

    existing = {_safe(lambda: rh.project.GetTimelineByIndex(i).GetName())
                for i in range(1, int(rh.project.GetTimelineCount() or 0) + 1)}
    built: List[str] = []
    skipped: List[str] = []
    failed = 0
    for t in timelines:
        name = str(t.get("name") or "").strip()
        segments = [(int(a), int(b)) for a, b in t.get("segments") or []]
        outside = any(a < 0 or b <= a or (mc_frames and b > mc_frames) for a, b in segments)
        if not name or not segments or name in existing or outside:
            skipped.append(name)
            rh.log(f"[create_multicam] {name}: skipped (name taken or outside the multicam)")
            continue
        made = _safe(lambda: media_pool.CreateTimelineFromClips(
            name, [{"mediaPoolItem": mc, "startFrame": a, "endFrame": b} for a, b in segments]))
        if made:
            built.append(name)
            existing.add(name)
        else:
            failed += 1
            rh.log(f"[create_multicam] {name}: CreateTimelineFromClips failed ({segments})")
    return {"result": True, "built": built, "skipped": skipped, "failed": failed}
