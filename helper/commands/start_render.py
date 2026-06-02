from typing import Any, Dict


def handle_start_render(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Start rendering with current Deliver settings (creates job if necessary).

    Payload (optional): { "job_ids": ["<id>", ...] } — when supplied, ONLY those
    specific render jobs are started. This is how EditPanel scopes a Start to
    the jobs *it* queued so any pre-existing queue entries the operator had
    (completed, aborted, manually added) are left untouched instead of being
    re-rendered by a naked StartRendering() call.

    No job_ids → legacy behavior: queue a default AddRenderJob if the queue is
    empty, then StartRendering() over the whole queue. Used by the manual
    fallback path and any caller that hasn't migrated yet.
    """
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    job_ids_raw = (payload or {}).get("job_ids") or []
    job_ids = [str(j) for j in job_ids_raw if j]

    if job_ids:
        # Only render the IDs EditPanel just queued. Resolve's StartRendering
        # accepts a variadic of job IDs; spreading the list scopes the run to
        # exactly those jobs and leaves the rest of the operator's queue
        # (anything pre-existing, completed, or aborted) alone.
        ok = rh.project.StartRendering(*job_ids)
        return {"result": bool(ok), "started_job_ids": job_ids}

    # Legacy unbounded path — kept for callers that don't pass IDs.
    jobs = rh.project.GetRenderJobList() or []
    if not jobs:
        rh.project.AddRenderJob()
    ok = rh.project.StartRendering()
    return {"result": bool(ok)}
