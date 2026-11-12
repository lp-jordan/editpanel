"""Cut-through (beta) — Resolve-side steps for the Cut-through page.

The pipeline lives in `editpanel/cut_through/` (plain Python scripts, shipped
with EditPanel; Settings can point the page at another pipeline folder); these
handlers run its Resolve-side steps inside the Resolve worker instead of
Resolve's Py3 console.

  ct_list_multicams  {}  → {"multicams": [{name, bin, duplicate}], "audio_timelines": [{name, clips}]}
      Every multicam clip in the open project outside the archive bins
      (MC ORIGINAL / MC QUARANTINE), same walk as the pipeline uses; and every
      timeline with sound and no picture (a narration / audiobook session).

  ct_mark_in_out  {name}  → {in, out, bin, multicams}
      The In/Out marked on that multicam in Resolve's source viewer (working
      bins first, then the archive bins).

  ct_read_timeline  {name}  → {name, fps, track, pieces, start_frame, start_tc}
  ct_set_markers  {name, tag, markers [{frame, color, name, note}]}  → {removed, placed, failed}
      Cut-through Check: read a built rough cut back; replace its Check markers.

  ct_render_audio  {action: "queue", names, target_dir}  → {jobs [{name, job_id}], format, codec}
                   {action: "delete", job_ids}            → {deleted}
      Cut-through Score: queue an audio-only render of each timeline (whole timeline, one file
      per timeline named after it) without starting it; the engine starts the jobs with
      start_render {job_ids}, polls render_status, then deletes the jobs from the queue.

  ct_run_step  {pipeline_dir, script, settings}  → {lines, stopped, error, seconds}
      Exec one allow-listed step script with `settings` as its run-line globals
      (LABEL, MC, SEQ_BIN, …) and the worker's Resolve handle, exactly as the
      console run line does, plus __file__ (the build finds its sibling scripts
      from it). Every print() from the script (and the scripts it runs) is
      streamed back as a log event carrying the request's trace_id.

stdout is the worker's JSON channel, so a step's prints must never reach it
raw: builtins.print is swapped for the run, and only calls made on this
thread are captured (the session-monitor thread keeps writing status events
through sys.stdout, untouched).
"""

from __future__ import annotations

import builtins
import os
import re
import sys
import threading
import time
from typing import Any, Dict, List

from . import ct_common

ALLOWED_STEPS = {"prepare_multicam.py", "build_rough_cut.py", "prepare_audio.py", "build_narration.py"}
_run_lock = threading.Lock()


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _walk(folder: Any, path: List[str]):
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield path, clip
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        name = _safe(lambda: sub.GetName())
        if name in ct_common.load().ARCHIVE_BINS:
            continue
        yield from _walk(sub, path + [name or "?"])


def list_multicams(root: Any) -> List[Dict[str, Any]]:
    found = []
    for path, clip in _walk(root, []):
        if "multicam" not in str(_safe(lambda: clip.GetClipProperty("Type"), "")).lower():
            continue
        found.append({"name": _safe(lambda: clip.GetName()) or "?", "bin": " / ".join(path)})
    names = [m["name"] for m in found]
    for m in found:
        m["duplicate"] = names.count(m["name"]) > 1
    return found


def list_audio_timelines(project: Any) -> List[Dict[str, Any]]:
    """Timelines with clips on an audio track and none on a video track: a narration session
    (audiobook) that Cut-through edits without picture. Cut-through's own narration builds
    ("... rough cut") are left out."""
    found = []
    for i in range(1, int(_safe(lambda: project.GetTimelineCount(), 0) or 0) + 1):
        tl = _safe(lambda: project.GetTimelineByIndex(i))
        if not tl:
            continue
        name = str(_safe(lambda: tl.GetName(), "") or "")
        if not name or name.endswith("(cut-through)"):
            continue
        pics = sum(len(_safe(lambda: tl.GetItemListInTrack("video", t), []) or [])
                   for t in range(1, int(_safe(lambda: tl.GetTrackCount("video"), 0) or 0) + 1))
        if pics:
            continue
        clips = sum(len(_safe(lambda: tl.GetItemListInTrack("audio", t), []) or [])
                    for t in range(1, int(_safe(lambda: tl.GetTrackCount("audio"), 0) or 0) + 1))
        if clips:
            found.append({"name": name, "clips": clips})
    return found


def handle_ct_list_multicams(_payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No project open in Resolve")
    root = rh.project.GetMediaPool().GetRootFolder()
    t0 = time.time()
    found = list_multicams(root)
    audio = list_audio_timelines(rh.project)
    if log_func:
        log_func(f"[cut-through] {len(found)} multicam(s), {len(audio)} audio timeline(s) ({time.time() - t0:.1f}s)")
    return {"project": _safe(lambda: rh.project.GetName()), "multicams": found, "audio_timelines": audio}


class _PrintCapture:
    """Replacement for builtins.print while a step runs. Calls from the
    owning thread become log events; any other thread prints as normal."""

    def __init__(self, emit):
        self.owner = threading.get_ident()
        self.emit = emit
        self.buf = ""
        self.real = builtins.print

    def __call__(self, *args, sep=" ", end="\n", file=None, flush=False):
        if threading.get_ident() != self.owner or (file is not None and file not in (sys.stdout, sys.__stdout__)):
            return self.real(*args, sep=sep, end=end, file=file, flush=flush)
        self.buf += (sep if sep is not None else " ").join(str(a) for a in args) + ("\n" if end is None else end)
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            self.emit(line.rstrip("\r"))

    def close(self):
        if self.buf.strip():
            self.emit(self.buf)
        self.buf = ""


def run_step(path: str, settings: Dict[str, Any], resolve: Any, emit) -> Dict[str, Any]:
    """Exec a step script the way its console run line does and return its report."""
    src = open(path, encoding="utf-8").read()
    g: Dict[str, Any] = {"__name__": "__main__", "__file__": path, "resolve": resolve, **settings}
    capture = _PrintCapture(emit)
    t0 = time.time()
    error = None
    builtins.print = capture
    try:
        exec(compile(src, path, "exec"), g)
    except (Exception, SystemExit) as exc:          # the scripts catch their own; this is a backstop
        error = f"{type(exc).__name__}: {exc}"
        capture.emit(f"✗ {error}")
    finally:
        builtins.print = capture.real
        capture.close()
    lines = [str(x) for x in g.get("_lines", [])]
    stopped = next((x.strip() for x in lines if x.strip().startswith("✗ STOPPED")), None)
    return {"lines": lines, "stopped": stopped, "error": error or stopped,
            "seconds": round(time.time() - t0, 1)}


def handle_ct_run_step(payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    script = os.path.basename(str(payload.get("script") or ""))
    if script not in ALLOWED_STEPS:
        raise RuntimeError(f"Not a cut-through step: {script!r}")
    pipeline_dir = str(payload.get("pipeline_dir") or "")
    path = os.path.join(pipeline_dir, script)
    if not os.path.isfile(path):
        raise RuntimeError(f"Step not found: {path} (check the pipeline folder in Cut-through settings)")
    if not rh.resolve or not rh.project:
        raise RuntimeError("Resolve not connected or no project open")
    settings = payload.get("settings") or {}
    if not isinstance(settings, dict):
        raise RuntimeError("settings must be an object")
    settings = {str(k): v for k, v in settings.items() if re.fullmatch(r"[A-Z][A-Z0-9_]*", str(k))}

    trace_id = payload.get("trace_id")

    def emit(line: str) -> None:
        rh._print({"event": "message", "trace_id": trace_id, "message": line})

    if not _run_lock.acquire(blocking=False):
        raise RuntimeError("A cut-through step is already running")
    try:
        return run_step(path, settings, rh.resolve, emit)
    finally:
        _run_lock.release()


def _walk_all(folder: Any, path: List[str]):
    """Every clip, archive bins included."""
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield path, clip
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        yield from _walk_all(sub, path + [_safe(lambda: sub.GetName()) or "?"])


def mark_in_out(root: Any, name: str) -> Dict[str, Any]:
    """The In/Out Jordan marked on the multicam in Resolve's source viewer. Copies and the original
    share one clock, so any multicam of that name will do: working bins first, then the archive
    bins (MC ORIGINAL). Values are as Resolve returns them; the page converts to multicam frames."""
    found = [(path, clip) for path, clip in _walk_all(root, [])
             if _safe(lambda: clip.GetName()) == name
             and "multicam" in str(_safe(lambda: clip.GetClipProperty("Type"), "")).lower()]
    archive = ct_common.load().ARCHIVE_BINS
    found.sort(key=lambda pc: any(p in archive for p in pc[0]))
    for path, clip in found:
        marks = _safe(lambda: clip.GetMarkInOut(), {}) or {}
        m = marks.get("video") or marks.get("audio") or {}
        if "in" in m or "out" in m:
            return {"in": m.get("in"), "out": m.get("out"), "bin": " / ".join(path), "multicams": len(found)}
    return {"in": None, "out": None, "bin": None, "multicams": len(found)}


def handle_ct_mark_in_out(payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No project open in Resolve")
    name = str(payload.get("name") or "")
    out = mark_in_out(rh.project.GetMediaPool().GetRootFolder(), name)
    if not out["multicams"]:
        raise RuntimeError(f"No multicam named {name!r}")
    return out


def read_audio(tl: Any) -> List[Dict[str, Any]]:
    """Every audio clip: where it sits on the timeline, and for a multicam clip which multicam
    frames it plays (src_in/src_out, the unit of the plan and the words) — so Compare can measure
    what is heard, not only what is seen."""
    out: List[Dict[str, Any]] = []
    for t in range(1, int(_safe(lambda: tl.GetTrackCount("audio"), 0) or 0) + 1):
        for it in _safe(lambda: tl.GetItemListInTrack("audio", t), []) or []:
            row = {"track": t, "name": str(_safe(lambda: it.GetName(), "")),
                   "start": int(_safe(lambda: it.GetStart(), 0)), "end": int(_safe(lambda: it.GetEnd(), 0))}
            mpi = _safe(lambda: it.GetMediaPoolItem())
            if mpi and "multicam" in str(_safe(lambda: mpi.GetClipProperty("Type"), "") or "").lower():
                row["mc"] = _safe(lambda: mpi.GetName(), "") or ""
                src_in = _safe(lambda: it.GetSourceStartFrame())
                src_out = _safe(lambda: it.GetSourceEndFrame())
                if src_in is not None and src_out is not None:
                    row["src_in"] = int(round(float(src_in)))
                    row["src_out"] = int(round(float(src_out)))
            out.append(row)
    return out


def read_timeline(tl: Any) -> Dict[str, Any]:
    """Every multicam piece on the picture track with the most of them: record start/end, the
    multicam source in/out (multicam frames, the unit the cut plan uses) and the angle. Same read
    as the Z8 comparison (spike_auto_rough_cut.py / spike_scan_past_edits.py)."""
    angle_of = ct_common.load().angle_of
    fps = float(_safe(lambda: tl.GetSetting("timelineFrameRate"), 0) or 0) or 24.0
    by_track: Dict[int, List[Dict[str, Any]]] = {}
    for t in range(1, int(_safe(lambda: tl.GetTrackCount("video"), 0) or 0) + 1):
        for it in _safe(lambda: tl.GetItemListInTrack("video", t), []) or []:
            mpi = _safe(lambda: it.GetMediaPoolItem())
            if not mpi or "multicam" not in str(_safe(lambda: mpi.GetClipProperty("Type"), "") or "").lower():
                continue
            mc = _safe(lambda: mpi.GetName(), "") or ""
            by_track.setdefault(t, []).append({
                "mc": mc, "angle": angle_of(str(_safe(lambda: it.GetName(), "")), mc),
                "start": int(_safe(lambda: it.GetStart(), 0)), "end": int(_safe(lambda: it.GetEnd(), 0)),
                "src_in": int(round(float(_safe(lambda: it.GetSourceStartFrame(), 0)))),
                "src_out": int(round(float(_safe(lambda: it.GetSourceEndFrame(), 0)))),
            })
    track = max(by_track, key=lambda k: len(by_track[k])) if by_track else None
    pieces = sorted(by_track.get(track, []), key=lambda p: p["start"])
    return {"name": _safe(lambda: tl.GetName()), "fps": fps, "track": track, "pieces": pieces,
            # markers are placed relative to the timeline's first frame; the report quotes its timecode
            "start_frame": int(_safe(lambda: tl.GetStartFrame(), 0) or 0),
            "start_tc": _safe(lambda: tl.GetStartTimecode()) or None}


def _timeline_named(name: str):
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No project open in Resolve")
    for i in range(1, int(rh.project.GetTimelineCount() or 0) + 1):
        tl = rh.project.GetTimelineByIndex(i)
        if _safe(lambda: tl.GetName()) == name:
            return tl
    raise RuntimeError(f"No timeline named {name!r}")


def handle_ct_read_timeline(payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    name = str(payload.get("name") or "")
    tl = _timeline_named(name)
    out = read_timeline(tl)
    if payload.get("audio"):
        out["audio"] = read_audio(tl)
    if log_func:
        log_func(f"[cut-through] read {len(out['pieces'])} multicam piece(s) from {name!r}")
    return out


def _audio_format(project: Any):
    """(format, codec) for an audio-only render: WAV / linear PCM when Resolve offers it, else a
    QuickTime with its first PCM-ish audio codec (Score reads either)."""
    formats = _safe(lambda: project.GetRenderFormats(), {}) or {}
    pick = None
    for label, ext in formats.items():
        if str(ext).lower() == "wav" or "wav" in str(label).lower():
            pick = ext
            break
    if pick is None:
        pick = "mov" if "mov" in [str(v).lower() for v in formats.values()] else None
    if pick is None:
        raise RuntimeError(f"No WAV or QuickTime render format in Resolve ({sorted(formats.values())})")
    codecs = _safe(lambda: project.GetRenderCodecs(pick), {}) or {}
    codec = None
    for label, val in codecs.items():
        if "pcm" in str(label).lower() or "pcm" in str(val).lower():
            codec = val
            break
    if codec is None and codecs:
        codec = list(codecs.values())[0]
    return pick, codec


def render_audio_queue(project: Any, names: List[str], target_dir: str, emit=None) -> Dict[str, Any]:
    os.makedirs(target_dir, exist_ok=True)
    fmt, codec = _audio_format(project)
    jobs, failed = [], []
    for name in names:
        tl = _timeline_named(name)
        if not _safe(lambda: project.SetCurrentTimeline(tl), False):
            failed.append(f"{name}: could not open the timeline")
            continue
        time.sleep(0.5)
        if codec is not None and not _safe(lambda: project.SetCurrentRenderFormatAndCodec(fmt, codec), False):
            failed.append(f"{name}: Resolve rejected {fmt}/{codec}")
            continue
        settings = {"SelectAllFrames": True, "ExportVideo": False, "ExportAudio": True,
                    "TargetDir": target_dir, "CustomName": name, "UniqueFilename": False}
        if not _safe(lambda: project.SetRenderSettings(settings), False):
            # some keys are refused on some formats: the ones that matter, one by one
            for k, v in settings.items():
                _safe(lambda: project.SetRenderSettings({k: v}), False)
        job_id = _safe(lambda: project.AddRenderJob())
        if not job_id:
            failed.append(f"{name}: AddRenderJob failed")
            continue
        jobs.append({"name": name, "job_id": str(job_id)})
        if emit:
            emit(f"queued audio render: {name}")
    return {"jobs": jobs, "failed": failed, "format": fmt, "codec": codec}


def handle_ct_render_audio(payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No project open in Resolve")
    action = str(payload.get("action") or "queue")
    if action == "delete":
        deleted = 0
        for jid in payload.get("job_ids") or []:
            deleted += bool(_safe(lambda: rh.project.DeleteRenderJob(str(jid)), False))
        return {"deleted": deleted}
    names = [str(n) for n in (payload.get("names") or []) if n]
    target_dir = str(payload.get("target_dir") or "")
    if not names or not target_dir:
        raise RuntimeError("names and target_dir are required")
    out = render_audio_queue(rh.project, names, target_dir, log_func)
    if log_func:
        log_func(f"[cut-through] queued {len(out['jobs'])} audio render(s) as {out['format']}/{out['codec']}")
    return out


def set_markers(tl: Any, markers: List[Dict[str, Any]], tag: str) -> Dict[str, Any]:
    """Replace this tool's markers on a timeline: every marker carrying `tag` as its custom data
    goes (a re-run never piles up), then the new ones are added. Other markers — the build's
    review markers, Jordan's own — are left alone; a new marker on a frame that already has one
    moves a frame or two later."""
    removed = 0
    for frame, m in list((_safe(lambda: tl.GetMarkers(), {}) or {}).items()):
        if (m or {}).get("customData") == tag and _safe(lambda: tl.DeleteMarkerAtFrame(frame)):
            removed += 1
    taken = set((_safe(lambda: tl.GetMarkers(), {}) or {}).keys())
    placed, failed = 0, 0
    for m in markers:
        ok = False
        for nudge in (0, 1, 2, 3):
            f = int(m["frame"]) + nudge
            if f in taken:
                continue
            if _safe(lambda: tl.AddMarker(f, m["color"], str(m["name"])[:60], str(m.get("note") or "")[:500], 1, tag)):
                taken.add(f)
                ok = True
                break
        placed += ok
        failed += not ok
    return {"removed": removed, "placed": placed, "failed": failed}


def handle_ct_set_markers(payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    name = str(payload.get("name") or "")
    out = set_markers(_timeline_named(name), list(payload.get("markers") or []), str(payload.get("tag") or "cut-through"))
    if log_func:
        log_func(f"[cut-through] markers on {name!r}: {out}")
    return out
