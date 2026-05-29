from typing import Any, Dict, List


# Resolve JobStatus values that mean the job is no longer in flight.
TERMINAL_STATUSES = {"Complete", "Failed", "Cancelled"}


def handle_render_status(payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    """Report render status for the given Resolve render job IDs.

    Quick, non-blocking — meant to be polled from the main process every few
    seconds while a render runs. We deliberately do NOT loop/wait here: blocking
    would tie up the single-threaded resolve worker (and every direct call that
    shares it) for the whole render.

    Payload: { "job_ids": ["<id>", ...] }  — when omitted, reports all jobs
    currently in Resolve's render queue.

    Returns: {
      "jobs": [{ "job_id", "status", "percent", "terminal" }],
      "rendering": bool,        # Resolve actively rendering right now
      "all_terminal": bool      # every reported job has finished/failed/cancelled
    }
    """
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    project = rh.project

    # Build a JobId -> {TargetDir, OutputFilename} map from the render queue so
    # we can hand the caller the exact output path of each finished render
    # (GetRenderJobStatus reports status/percent but not the filename).
    job_list = project.GetRenderJobList() or []
    info_by_id: Dict[str, Dict[str, Any]] = {}
    for j in job_list:
        jid = j.get("JobId")
        if jid is None:
            continue
        info_by_id[str(jid)] = {
            "target_dir": j.get("TargetDir"),
            "output_filename": j.get("OutputFilename") or j.get("OutputFileName"),
        }

    job_ids = payload.get("job_ids")
    if not job_ids:
        job_ids = [j.get("JobId") for j in job_list]
    job_ids = [str(j) for j in job_ids if j]

    statuses: List[Dict[str, Any]] = []
    for jid in job_ids:
        st = project.GetRenderJobStatus(jid) or {}
        job_status = st.get("JobStatus")
        info = info_by_id.get(jid, {})
        statuses.append({
            "job_id": jid,
            "status": job_status,
            "percent": int(st.get("CompletionPercentage", 0) or 0),
            "terminal": job_status in TERMINAL_STATUSES,
            "target_dir": info.get("target_dir"),
            "output_filename": info.get("output_filename"),
        })

    all_terminal = bool(statuses) and all(s["terminal"] for s in statuses)

    return {
        "jobs": statuses,
        "rendering": bool(project.IsRenderingInProgress()),
        "all_terminal": all_terminal,
    }
