#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LeaderPass Resolve Helper (JSON-over-stdio)

A tiny bridge that attaches to a running DaVinci Resolve instance using
`python_get_resolve.GetResolve` and exposes a minimal command interface
over stdin/stdout. One JSON object per line in, one per line out.

Inbound message shape (id is optional but recommended):
  { "id": 123, "cmd": "add_marker", "frame": 100, "color": "Blue", ... }

Outbound message shapes:
  - Response to a request:
      { "id": 123, "ok": true,  "data": {...}, "error": null }
      { "id": 123, "ok": false, "data": null, "error": "Human readable" }
  - Async status events (no id):
      { "event": "status", "code": "CONNECTED", "ok": true, "data": {...}, "error": null }
      { "event": "status", "code": "NO_SESSION", "ok": false, "error": "No Resolve running" }
      { "event": "status", "code": "NO_PYTHON_GET_RESOLVE", "ok": false, "error": "Helper missing" }

Supported commands (MVP):
  - "context"         -> project/timeline info
  - "add_marker"      -> add marker at playhead / timecode / frame
  - "start_render"    -> start rendering current project (uses current Deliver settings)
  - "stop_render"     -> stop current render
  - "connect"         -> manually connect to Resolve
  - "shutdown"        -> (optional) gracefully exit helper
"""

from __future__ import annotations

import json
import sys
import time
import logging
import threading
from typing import Any, Dict, Optional

# ---------- Logging ----------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("lp_resolve_helper")

# ---------- JSON I/O ----------
def _print(obj: Dict[str, Any]) -> None:
    """Serialize *obj* to JSON and write it to stdout, flushing immediately."""
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception as e:
        # If stdout is gone, exit quietly.
        logger.exception("Failed to write to stdout: %s", e)
        try:
            sys.exit(0)
        except SystemExit:
            pass


def log(msg: str) -> None:
    """Send a log message to the Electron app."""
    timestamp = time.strftime("%H:%M:%S")
    _print({"event": "message", "message": f"[{timestamp}] {msg}"})

# ---------- Resolve attach mechanism ----------
try:
    # Prefer the bundled helper first.
    from .python_get_resolve import GetResolve
    _get_resolve_available = True
    logger.info("python_get_resolve available (bundled)")
except Exception:
    try:
        # Fallback to the external package if the local one is missing.
        from python_get_resolve import GetResolve  # type: ignore
        _get_resolve_available = True
        logger.info("python_get_resolve available (external)")
    except Exception:
        _get_resolve_available = False
        logger.exception("python_get_resolve not importable")

# Global Resolve context
resolve = None
project_manager = None
project = None
timeline = None

def _update_context() -> None:
    """Refresh global project and timeline references."""
    global project_manager, project, timeline
    project_manager = resolve.GetProjectManager() if resolve else None
    project = project_manager.GetCurrentProject() if project_manager else None
    timeline = project.GetCurrentTimeline() if project else None

def _status_event(ok: bool, code: str, msg: Optional[str] = None) -> None:
    """Emit an async status event (no id)."""
    payload: Dict[str, Any] = {
        "event": "status",
        "ok": ok,
        "code": code,
        "error": None if ok else (msg or code),
    }
    if ok:
        payload["data"] = {
            "project": project.GetName() if project else None,
            "timeline": timeline.GetName() if timeline else None,
        }
    _print(payload)

def _monitor_resolve(poll_seconds: float = 1.5) -> None:
    """Background thread: monitor Resolve and emit status on disconnect."""
    global resolve, project_manager, project, timeline
    logger.info("Monitoring Resolve session")
    prev_project = project.GetName() if project else None
    prev_timeline = timeline.GetName() if timeline else None
    while True:
        time.sleep(poll_seconds)
        if not resolve:
            break
        try:
            pm = resolve.GetProjectManager()
        except Exception:
            pm = None
        if not pm:
            logger.warning("Lost Resolve session")
            resolve = None
            project_manager = project = timeline = None
            _status_event(False, "NO_SESSION", "Resolve closed or session lost")
            break
        else:
            _update_context()
            curr_project = project.GetName() if project else None
            curr_timeline = timeline.GetName() if timeline else None
            if curr_project != prev_project or curr_timeline != prev_timeline:
                _status_event(True, "CONNECTED")
                prev_project, prev_timeline = curr_project, curr_timeline

# Emit initial disconnected status
_status_event(False, "NO_SESSION", "Not connected")

# ---------- Response helpers ----------
def _resp_ok(req_id: Any, data: Any) -> Dict[str, Any]:
    return {"id": req_id, "ok": True, "data": data, "error": None}


def _resp_err(req_id: Any, msg: str) -> Dict[str, Any]:
    return {"id": req_id, "ok": False, "data": None, "error": msg}


from helper.commands import HANDLERS
from helper.commands.transcribe import configure_cuda_dll_directories, _ensure_cuda_runtime_packages


# ---------- Main loop ----------
def main() -> None:
    """Read JSON lines from stdin and dispatch to command handlers."""
    _ensure_cuda_runtime_packages(log)
    cuda_env = configure_cuda_dll_directories(log)
    log(f"Transcribe: CUDA DLL directories added={len(cuda_env.get('dll_directories_added', []))}")
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        req_id: Any = None
        try:
            request = json.loads(raw)
            req_id = request.get("id")
            cmd = request.get("cmd")
            if not cmd or cmd not in HANDLERS:
                raise ValueError(f"unknown command: {cmd!r}")

            handler = HANDLERS[cmd]
            # Handlers receive the entire request so they can read params freely.
            data = handler(request)
            _print(_resp_ok(req_id, data))
        except Exception as exc:
            # Best-effort error response; include id if present so caller can match it.
            _print(_resp_err(req_id, str(exc)))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
