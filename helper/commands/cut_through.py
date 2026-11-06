"""Cut-through (beta) — Resolve-side steps for the Cut-through page.

The pipeline lives in `editpanel/cut_through/` (plain Python scripts, so a
git pull updates them without an EditPanel rebuild); these handlers run its
Resolve-side steps inside the Resolve worker instead of Resolve's Py3 console.

  ct_list_multicams  {}  → {"multicams": [{name, bin, duplicate}]}
      Every multicam clip in the open project outside the archive bins
      (MC ORIGINAL / MC QUARANTINE), same walk as the pipeline uses.

  ct_run_step  {pipeline_dir, script, settings}  → {lines, stopped, error, seconds}
      Exec one allow-listed step script with `settings` as its run-line globals
      (LABEL, MC, SEQ_BIN, …) and the worker's Resolve handle, exactly as the
      console run line does. Every print() from the script (and the scripts it
      runs) is streamed back as a log event carrying the request's trace_id.

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

ARCHIVE_BINS = {"MC ORIGINAL", "MC QUARANTINE"}
ALLOWED_STEPS = {"prepare_multicam.py", "build_rough_cut.py"}
# The build script hard-codes the LP1 checkout; point it at the pipeline folder
# the page uses so a different checkout location still works.
_REPO_LINE = re.compile(r'^REPO\s*=\s*r?["\'][^"\'\n]*["\']\s*$', re.M)
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
        if name in ARCHIVE_BINS:
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


def handle_ct_list_multicams(_payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No project open in Resolve")
    root = rh.project.GetMediaPool().GetRootFolder()
    t0 = time.time()
    found = list_multicams(root)
    if log_func:
        log_func(f"[cut-through] {len(found)} multicam(s) ({time.time() - t0:.1f}s)")
    return {"project": _safe(lambda: rh.project.GetName()), "multicams": found}


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


def run_step(path: str, settings: Dict[str, Any], resolve: Any, emit, repo_dir: str = None) -> Dict[str, Any]:
    """Exec a step script the way its console run line does and return its report."""
    src = open(path, encoding="utf-8").read()
    if repo_dir:
        src = _REPO_LINE.sub(lambda _m: f"REPO = {repo_dir!r}", src, count=1)
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
        raise RuntimeError(f"Step not found: {path} (git pull on this machine?)")
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
        return run_step(path, settings, rh.resolve, emit, repo_dir=os.path.dirname(os.path.normpath(os.path.abspath(pipeline_dir))))
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
    found.sort(key=lambda pc: any(p in ARCHIVE_BINS for p in pc[0]))
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


def angle_of(item_name: str, mc_name: str) -> str:
    """A multicam piece's active angle, from its item name ("<MC> - Camera 2")."""
    if mc_name and item_name.startswith(mc_name + " - "):
        return item_name[len(mc_name) + 3:]
    return item_name.rsplit(" - ", 1)[-1] if " - " in item_name else "?"


def read_timeline(tl: Any) -> Dict[str, Any]:
    """Every multicam piece on the picture track with the most of them: record start/end, the
    multicam source in/out (multicam frames, the unit the cut plan uses) and the angle. Same read
    as the Z8 comparison (spike_auto_rough_cut.py / spike_scan_past_edits.py)."""
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
    return {"name": _safe(lambda: tl.GetName()), "fps": fps, "track": track, "pieces": pieces}


def handle_ct_read_timeline(payload: Dict[str, Any], log_func=None) -> Dict[str, Any]:
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No project open in Resolve")
    name = str(payload.get("name") or "")
    for i in range(1, int(rh.project.GetTimelineCount() or 0) + 1):
        tl = rh.project.GetTimelineByIndex(i)
        if _safe(lambda: tl.GetName()) == name:
            out = read_timeline(tl)
            if log_func:
                log_func(f"[cut-through] read {len(out['pieces'])} multicam piece(s) from {name!r}")
            return out
    raise RuntimeError(f"No timeline named {name!r}")
