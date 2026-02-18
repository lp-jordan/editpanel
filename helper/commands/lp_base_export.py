from typing import Any, Dict, List, Tuple
import time

DEFAULT_EXPORT_PRESET_NAME = "General LP Export"
DEFAULT_EXPORT_BIN_NAME = "EXPORT"

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
    render_jobs: List[Tuple[str, int]] = []

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

        job_id = project.AddRenderJob()
        if job_id:
            rh.log(f"Added timeline '{timeline_name}' to render queue. Job ID: {job_id}.")
            render_jobs.append((timeline_name, job_id))
        else:
            rh.log(f"Error: Failed to add timeline '{timeline_name}' to the render queue.")

    if render_jobs:
        for t_name, j_id in render_jobs:
            rh.log(f"Timeline: {t_name}, Job ID: {j_id}")
    else:
        rh.log("No render jobs were added.")

    rh.log("Finished processing all matched timelines.")
    return {"result": True, "jobs": render_jobs}
