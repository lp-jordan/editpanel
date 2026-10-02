from typing import Any, Dict, List


# Mirror render_status.py — keep these in sync if Blackmagic ever adds new
# terminal statuses (e.g., a hypothetical "Stopped" distinct from "Cancelled").
TERMINAL_STATUSES = {"Complete", "Failed", "Cancelled"}

# Last status seen per JobId, for this worker process. Finished renders stay in
# Resolve's queue until someone clears them, so querying every job each tick
# made this command slower as the queue grew (one GetRenderJobStatus per job).
# A finished job's status can only change while Resolve is rendering ("Render
# Again" re-runs it), so when nothing is rendering we reuse the cached terminal
# status and only ask Resolve about new or still-active jobs.
_status_cache: Dict[str, Dict[str, Any]] = {}


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

    Cost: one GetRenderJobList, plus one GetRenderJobStatus per job that is
    new, still active, or (while Resolve is rendering) any job — see
    _status_cache. We deliberately do NOT loop/wait here.

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
    try:
        rendering = bool(project.IsRenderingInProgress())
    except Exception:
        rendering = True  # unknown → query everything, as before
    out: List[Dict[str, Any]] = []
    seen = set()
    for j in job_list:
        jid = j.get("JobId")
        if jid is None:
            continue
        jid = str(jid)
        seen.add(jid)
        cached = _status_cache.get(jid)
        if (not rendering and cached is not None
                and cached.get("JobStatus") in TERMINAL_STATUSES):
            st = cached
        else:
            st = project.GetRenderJobStatus(jid) or {}
            _status_cache[jid] = st
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

    # Forget jobs that left the queue (cleared, or another project is open).
    for stale in [k for k in _status_cache if k not in seen]:
        del _status_cache[stale]

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
