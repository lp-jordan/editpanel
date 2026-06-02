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

    # Find the EXPORT bin
    export_folder = None
    for folder in (root_folder.GetSubFolderList() or []):
        if folder.GetName() == export_bin_name:
            export_folder = folder
            break
    if not export_folder:
        raise RuntimeError(f"The '{export_bin_name}' bin was not found in the Media Pool")

    media_pool.SetCurrentFolder(export_folder)

    # Collect names in EXPORT bin
    clip_list = export_folder.GetClipList() or []
    if not clip_list:
        rh.log(f"No media pool items found in '{export_bin_name}' bin.")
        return {"result": False}

    export_names: List[str] = []
    for clip in clip_list:
        try:
            clip_name = clip.GetName()
        except Exception:
            clip_name = clip.GetClipProperty("File Name")
        rh.log(f" - {clip_name}")
        export_names.append(clip_name)

    # Map to timelines by name
    matched_timelines = []
    timeline_count = int(project.GetTimelineCount() or 0)
    for idx in range(1, timeline_count + 1):
        tl = project.GetTimelineByIndex(idx)
        if not tl:
            continue
        tl_name = tl.GetName()
        if tl_name in export_names:
            matched_timelines.append(tl)
            rh.log(f"Matched timeline: {tl_name}")

    if not matched_timelines:
        rh.log(f"No matching timelines found based on names in '{export_bin_name}' bin.")
        return {"result": False}

    # Load preset and queue jobs
    project_name = project.GetName() if project else None
    render_jobs: List[Dict[str, Any]] = []

    for timeline in matched_timelines:
        timeline_name = timeline.GetName()
        project.SetCurrentTimeline(timeline)
        time.sleep(1.0)  # brief settle

        preset_loaded = project.LoadRenderPreset(export_preset_name)
        if not preset_loaded:
            rh.log(
                f"Error: Failed to load export preset '{export_preset_name}' for timeline '{timeline_name}'."
            )
            continue

        # Override the destination AFTER the preset loads (the preset restores
        # its own saved TargetDir) but BEFORE AddRenderJob, which snapshots the
        # current render settings into the queued job. Doing it per-timeline
        # means each job carries its own TargetDir + CustomName.
        if target_dir:
            applied = project.SetRenderSettings({
                "TargetDir": target_dir,
                "CustomName": timeline_name,
                "UniqueFilename": bool(unique_filename),
            })
            if applied:
                rh.log(f"Render destination set for '{timeline_name}' -> {target_dir}")
            else:
                rh.log(
                    f"Warning: SetRenderSettings was rejected for timeline "
                    f"'{timeline_name}'; using the preset's saved destination."
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
            rh.log(f"Added timeline '{timeline_name}' to render queue. Job ID: {job_id}.")
            render_jobs.append({
                "name": timeline_name,
                "id": job_id,
                "timeline_uid": metadata["timeline_uid"],
                "start_timecode": metadata["start_timecode"],
                "fps": metadata["fps"],
                "project_name": metadata["project_name"],
            })
        else:
            rh.log(f"Error: Failed to add timeline '{timeline_name}' to the render queue.")

    if render_jobs:
        for entry in render_jobs:
            rh.log(f"Timeline: {entry['name']}, Job ID: {entry['id']}")
    else:
        rh.log("No render jobs were added.")

    rh.log("Finished processing all matched timelines.")
    return {"result": True, "jobs": render_jobs, "target_dir": target_dir or None}
