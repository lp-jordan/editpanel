"""Simple Resolve bridge communicating over JSON lines.

This helper script connects to DaVinci Resolve via the
``DaVinciResolveScript`` module and exposes a tiny command based
interface over stdin/stdout.  It keeps trying to attach to a running
Resolve instance and once connected it listens for JSON encoded
requests and replies with JSON objects.
"""

from __future__ import annotations

import json
import sys
import time
import logging


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# Try importing the Resolve scripting module.  If it cannot be imported we
# still keep emitting the "No Resolve running" message as requested.
try:  # pragma: no cover - depends on Resolve being installed
    import DaVinciResolveScript as dvr  # type: ignore
    logger.info("DaVinciResolveScript module imported")
except Exception:  # pragma: no cover - best effort logging
    logger.exception("Failed to import DaVinciResolveScript module")
    dvr = None


def _print(obj: dict) -> None:
    """Serialize *obj* to JSON and write it to stdout, flushing immediately."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


import threading


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


def handle_context(_payload: dict) -> dict:
    """Return basic Resolve context information."""

    return {
        "project": project.GetName() if project else None,
        "timeline": timeline.GetName() if timeline else None,
    }


def handle_add_marker(payload: dict) -> dict:
    """Add a marker on the current timeline."""

    if not timeline:
        raise RuntimeError("No timeline")

    frame = int(payload.get("frame", 0))
    color = payload.get("color", "Blue")
    name = payload.get("name", "")
    note = payload.get("note", "")
    duration = int(payload.get("duration", 1))
    custom_data = payload.get("custom_data", "")

    result = timeline.AddMarker(frame, color, name, note, duration, custom_data)
    return {"result": bool(result)}


def handle_start_render(_payload: dict) -> dict:
    """Start rendering the current project."""

    if not project:
        raise RuntimeError("No project")
    return {"result": project.StartRendering()}


def handle_stop_render(_payload: dict) -> dict:
    """Stop the current render job."""

    if not project:
        raise RuntimeError("No project")
    return {"result": project.StopRendering()}


HANDLERS = {
    "context": handle_context,
    "add_marker": handle_add_marker,
    "start_render": handle_start_render,
    "stop_render": handle_stop_render,
}


def _watch_resolve() -> None:
    """Emit status updates about Resolve availability."""

    global resolve
    logger.info("Watching for Resolve availability")
    last_ok = False
    while True:
        new_resolve = None
        if dvr is not None:
            if not last_ok:
                logger.info("Attempting to connect to Resolve...")
            try:  # pragma: no cover - depends on Resolve being available
                new_resolve = dvr.scriptapp("Resolve")
            except Exception:  # pragma: no cover - best effort connection attempt
                logger.exception("Error while attempting to connect to Resolve")
                new_resolve = None
        if new_resolve:
            resolve = new_resolve
            _update_context()
            if not last_ok:
                logger.info("Connected to Resolve")
                _print({
                    "ok": True,
                    "error": None,
                    "data": handle_context({}),
                    "event": "status",
                })
            last_ok = True
        else:
            if last_ok:
                logger.warning("Lost connection to Resolve")
            else:
                logger.warning("Resolve not running")
            resolve = None
            _update_context()
            _print({"ok": False, "error": "No Resolve running", "event": "status"})
            last_ok = False
        time.sleep(1)


threading.Thread(target=_watch_resolve, daemon=True).start()


def main() -> None:
    """Read JSON lines from stdin and dispatch to command handlers."""

    for line in sys.stdin:
        try:
            request = json.loads(line)
            cmd = request.get("cmd")
            handler = HANDLERS.get(cmd)
            if handler is None:
                raise ValueError(f"unknown command: {cmd}")
            data = handler(request)
            response = {"ok": True, "data": data, "error": None}
        except Exception as exc:  # pragma: no cover - best effort error report
            response = {"ok": False, "data": None, "error": str(exc)}
        _print(response)


if __name__ == "__main__":  # pragma: no cover - script entry point
    main()

