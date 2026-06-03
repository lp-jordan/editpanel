from typing import Any, Dict, List


# Mirror render_status.py — keep these in sync if Blackmagic ever adds new
# terminal statuses (e.g., a hypothetical "Stopped" distinct from "Cancelled").
TERMINAL_STATUSES = {"Complete", "Failed", "Cancelled"}


def handle_list_render_jobs(payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    """Enumerate EVERY render job in the active Resolve project, with status.

    Powers Phase 3.5 orphan-export reconciliation. The main-process tracker
    polls this on the same cadence as render_status, then diffs the returned
    JobIds against editpanel's `export_runs.jobs_json` — any JobId Resolve
    knows about that editpanel doesn't is an "orphan" the editor queued
    directly in Resolve. Editpanel inserts an `export_runs` row with
    source='reconciled' so it becomes authoritative for ALL renders, not
    just the ones queued through its overlay.

    Unlike render_status (which polls a caller-specified subset), this
    returns every job in the queue — the caller does not pass `job_ids`.

    Cheap to call: one GetRenderJobList + one GetRenderJobStatus per job.
    Designed to be safe to run on the same ~2.5s tick that render_status
    already uses; we deliberately do NOT loop/wait here.

    The `custom_name` field is significant: editpanel-queued exports prefix
    their CustomName with the editpanel export_id (Phase 3.5 Batch 4),
    giving the reconciler a fast belt-and-suspenders re-attach if an
    export_runs row was lost (e.g., SQLite write failure mid-render).
    Reconciler strips that prefix and re-binds rather than treating the
    job as a new orphan.

    Returns: {
      "project_name": str | None,
      "jobs": [{
        "job_id":          str,
        "status":          str | None,   # JobStatus from GetRenderJobStatus
        "percent":         int,
        "terminal":        bool,         # status in {Complete, Failed, Cancelled}
        "target_dir":      str | None,   # output directory (immutable post-queue)
        "output_filename": str | None,   # resolved file name written to disk
        "custom_name":     str | None,   # user-set or editpanel-tagged
        "render_job_name": str | None,   # Resolve's display name
        "timeline_name":   str | None,   # source timeline
      }, ...]
    }

    Resolve API caveat: the keys on GetRenderJobList items are
    not perfectly documented across versions; we fall back gracefully
    (e.g., OutputFilename / OutputFileName both seen in the wild — same
    fallback pattern render_status.py already uses).
    """
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    project = rh.project

    job_list = project.GetRenderJobList() or []
    out: List[Dict[str, Any]] = []
    for j in job_list:
        jid = j.get("JobId")
        if jid is None:
            continue
        jid = str(jid)
        st = project.GetRenderJobStatus(jid) or {}
        job_status = st.get("JobStatus")
        out.append({
            "job_id":          jid,
            "status":          job_status,
            "percent":         int(st.get("CompletionPercentage", 0) or 0),
            "terminal":        job_status in TERMINAL_STATUSES,
            "target_dir":      j.get("TargetDir"),
            "output_filename": j.get("OutputFilename") or j.get("OutputFileName"),
            "custom_name":     j.get("CustomName"),
            "render_job_name": j.get("RenderJobName"),
            "timeline_name":   j.get("TimelineName"),
        })

    project_name = None
    try:
        project_name = project.GetName()
    except Exception:
        # Defensive: project handle should always answer GetName but
        # we'd rather degrade than crash the tick over a stale handle.
        project_name = None

    return {
        "project_name": project_name,
        "jobs": out,
    }
