from typing import Any, Dict, List, Optional
import os
import time

DEFAULT_EXPORT_PRESET_NAME = "General LP Export"
DEFAULT_EXPORT_BIN_NAME = "EXPORT"


def _capture_timeline_metadata(timeline: Any, project_name: Optional[str]) -> Dict[str, Any]:
    """Capture the Phase 5c.1 tether metadata for a timeline.

    Called inside lp_base_export's per-timeline loop *after* SetCurrentTimeline so
    every Resolve call resolves against the right object. Returns a dict shaped
    for direct merge into editpanel's per-job state; falls back to None for any
    field Resolve can't supply (Resolve 18 builds without GetUniqueId, missing
    fps setting, etc.). When timeline_uid is None the upload-time renderMeta
    payload is suppressed editpanel-side so we never send a partial tether.
    """
    timeline_uid: Optional[str] = None
    try:
        # Resolve 19+ — confirmed target per user (2026-06-02).
        timeline_uid = timeline.GetUniqueId()
    except Exception:
        timeline_uid = None

    start_timecode: Optional[str] = None
    try:
        start_timecode = timeline.GetStartTimecode()
    except Exception:
        start_timecode = None

    fps: Optional[float] = None
    try:
        raw_fps = timeline.GetSetting("timelineFrameRate")
        if raw_fps is not None and str(raw_fps).strip():
            fps = float(raw_fps)
    except Exception:
        fps = None

    return {
        "timeline_uid": timeline_uid,
        "start_timecode": start_timecode,
        "fps": fps,
        "project_name": project_name,
    }

def handle_lp_base_export(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Queue render jobs for timelines matching items in EXPORT bin."""
    from .. import resolve_helper as rh
    from .bin_tree import resolve_folder_by_path
    from ..timeline_index import find_timelines, is_timeline_clip
    from .preset_bitrate import make_bitrate_preset, drop_bitrate_preset

    t0 = time.time()
    if not rh.project:
        raise RuntimeError("No active project")

    project = rh.project
    media_pool = project.GetMediaPool()
    root_folder = media_pool.GetRootFolder()
    if not root_folder:
        raise RuntimeError("Could not retrieve the root folder of the Media Pool")

    export_preset_name = payload.get("preset_name") or DEFAULT_EXPORT_PRESET_NAME
    export_bin_name = payload.get("export_bin_name") or DEFAULT_EXPORT_BIN_NAME

    # Optional destination override. When EditPanel passes a target_dir, we push
    # it (plus a per-timeline CustomName) into Resolve's render settings so the
    # operator no longer has to set the Deliver-page location by hand. When it's
    # absent we leave the preset's saved destination untouched (back-compat).
    target_dir = (payload.get("target_dir") or "").strip()
    unique_filename = payload.get("unique_filename", True)

    # Optional Deliver-page toggles. None = keep what the preset saved.
    export_video = payload.get("export_video")
    export_audio = payload.get("export_audio")
    if export_video is False and export_audio is False:
        raise RuntimeError("Video and audio are both off; nothing to export.")
    # Optional bitrate override in kbps. Resolve 21 rejects VideoQuality, so it
    # is written into a temporary copy of the preset (see preset_bitrate.py).
    # Only H.264/H.265 presets carry a bitrate. Absent = the preset's own.
    try:
        video_bitrate_kbps = int(payload.get("video_bitrate_kbps") or 0) or None
    except (TypeError, ValueError):
        video_bitrate_kbps = None

    # Optional custom output name. Only honoured when the bin resolves to a
    # single timeline (checked after matching below); otherwise every job
    # would render to the same name.
    custom_name = (payload.get("custom_name") or "").strip() or None

    if target_dir:
        # Resolve silently falls back / fails if TargetDir doesn't exist. The
        # folder picker only yields existing paths, but create it defensively
        # in case a saved/typed path no longer resolves.
        try:
            os.makedirs(target_dir, exist_ok=True)
        except OSError as exc:
            raise RuntimeError(
                f"Could not create or access target directory '{target_dir}': {exc}"
            )

    # Find the EXPORT bin. export_bin_name may be a bare top-level name
    # ("EXPORT") or a nested path ("SEQUENCES / MC") — resolve_folder_by_path
    # handles both (bare-name match first, then a segment-by-segment walk).
    export_folder = resolve_folder_by_path(root_folder, export_bin_name)
    if not export_folder:
        raise RuntimeError(f"The '{export_bin_name}' bin was not found in the Media Pool")

    rh.log(f"[queue] Found bin '{export_bin_name}' ({time.time() - t0:.1f}s).")
    t1 = time.time()
    media_pool.SetCurrentFolder(export_folder)

    # Collect names in EXPORT bin
    clip_list = export_folder.GetClipList() or []
    if not clip_list:
        rh.log(f"No media pool items found in '{export_bin_name}' bin.")
        return {"result": False}

    export_names: List[str] = []
    timeline_names: List[str] = []
    for clip in clip_list:
        try:
            clip_name = clip.GetName()
        except Exception:
            clip_name = clip.GetClipProperty("File Name")
        rh.log(f" - {clip_name}")
        export_names.append(clip_name)
        if is_timeline_clip(clip):
            timeline_names.append(clip_name)

    rh.log(f"[queue] Read {len(export_names)} clip names ({time.time() - t1:.1f}s).")

    # Map to timelines by name (index-backed; see helper/timeline_index.py)
    matched_timelines = []
    for tl_name, tl in find_timelines(project, export_names, rh.log, required=timeline_names):
        matched_timelines.append(tl)
        rh.log(f"Matched timeline: {tl_name}")
    rh.log(f"[queue] Ready to queue {len(matched_timelines)} timelines ({time.time() - t0:.1f}s since start).")

    if not matched_timelines:
        rh.log(f"No matching timelines found based on names in '{export_bin_name}' bin.")
        return {"result": False}

    use_custom_name = bool(custom_name) and len(matched_timelines) == 1
    if custom_name and not use_custom_name:
        rh.log(f"Custom name ignored: the bin has {len(matched_timelines)} timelines, so each uses its own name.")

    # Load preset and queue jobs
    project_name = project.GetName() if project else None
    render_jobs: List[Dict[str, Any]] = []

    # One temporary bitrate copy of the preset for the whole batch; every
    # timeline queues with it, and it's deleted once all jobs are queued.
    bitrate_preset = None
    if video_bitrate_kbps and export_video is not False:
        bitrate_preset = make_bitrate_preset(rh.resolve, project, export_preset_name, video_bitrate_kbps, rh.log)
    queue_preset = bitrate_preset or export_preset_name

    try:
        for timeline in matched_timelines:
            t_tl = time.time()
            timeline_name = timeline.GetName()
            project.SetCurrentTimeline(timeline)
            time.sleep(1.0)  # brief settle

            preset_loaded = project.LoadRenderPreset(queue_preset)
            if not preset_loaded and queue_preset != export_preset_name:
                rh.log(f"Warning: couldn't load '{queue_preset}' for '{timeline_name}'; using '{export_preset_name}' at its own bitrate.")
                preset_loaded = project.LoadRenderPreset(export_preset_name)
                bitrate_result = {"requested_kbps": video_bitrate_kbps, "applied": False, "via": "preset_copy"}
            else:
                bitrate_result = (
                    {"requested_kbps": video_bitrate_kbps, "applied": queue_preset != export_preset_name, "via": "preset_copy"}
                    if video_bitrate_kbps and export_video is not False else None
                )
            if not preset_loaded:
                rh.log(
                    f"Error: Failed to load export preset '{export_preset_name}' for timeline '{timeline_name}'."
                )
                continue

            # Video/audio toggles in their own call so a rejection can't void the
            # destination override below.
            av: Dict[str, Any] = {}
            if export_video is not None:
                av["ExportVideo"] = bool(export_video)
            if export_audio is not None:
                av["ExportAudio"] = bool(export_audio)
            if av:
                if project.SetRenderSettings(av):
                    rh.log(f"Output for '{timeline_name}': video {'on' if av.get('ExportVideo', True) else 'off'}, audio {'on' if av.get('ExportAudio', True) else 'off'}")
                else:
                    rh.log(f"Warning: Resolve rejected the video/audio toggles for '{timeline_name}'; using the preset's.")

            # Override the destination/name AFTER the preset loads (the preset
            # restores its own saved TargetDir) but BEFORE AddRenderJob, which
            # snapshots the current render settings into the queued job. Doing it
            # per-timeline means each job carries its own TargetDir + CustomName.
            out_name = custom_name if use_custom_name else timeline_name
            dest: Dict[str, Any] = {}
            if target_dir:
                dest.update({
                    "TargetDir": target_dir,
                    "CustomName": out_name,
                    "UniqueFilename": bool(unique_filename),
                })
            elif use_custom_name:
                dest["CustomName"] = out_name
            if dest:
                if project.SetRenderSettings(dest):
                    rh.log(f"Render output set for '{timeline_name}' -> {target_dir or 'preset location'} / {out_name}")
                else:
                    rh.log(
                        f"Warning: SetRenderSettings was rejected for timeline "
                        f"'{timeline_name}'; using the preset's saved destination and name."
                    )

            job_id = project.AddRenderJob()
            if job_id:
                # Phase 5c.1 (2026-06-02): capture timeline tether metadata at job
                # creation so the upload-time renderMeta payload can be assembled
                # without re-querying Resolve. timeline_uid is the stable key
                # (rename-safe); name/start_tc/fps drive marker placement math.
                metadata = _capture_timeline_metadata(timeline, project_name)
                if metadata.get("timeline_uid") is None:
                    rh.log(
                        f"Warning: Timeline.GetUniqueId() unavailable for '{timeline_name}'; "
                        f"comment-marker tether will not be persisted for this job."
                    )
                rh.log(f"Added timeline '{timeline_name}' to render queue. Job ID: {job_id}. ({time.time() - t_tl:.1f}s)")
                render_jobs.append({
                    "name": timeline_name,
                    "id": job_id,
                    "timeline_uid": metadata["timeline_uid"],
                    "start_timecode": metadata["start_timecode"],
                    "fps": metadata["fps"],
                    "project_name": metadata["project_name"],
                    "output_name": out_name,
                    "bitrate": bitrate_result,
                })
            else:
                rh.log(f"Error: Failed to add timeline '{timeline_name}' to the render queue.")
    finally:
        drop_bitrate_preset(project, bitrate_preset, rh.log)

    if render_jobs:
        for entry in render_jobs:
            rh.log(f"Timeline: {entry['name']}, Job ID: {entry['id']}")
    else:
        rh.log("No render jobs were added.")

    rh.log(f"Finished processing all matched timelines ({time.time() - t0:.1f}s total).")
    return {"result": True, "jobs": render_jobs, "target_dir": target_dir or None}
