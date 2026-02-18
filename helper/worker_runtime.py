#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable, Dict

Handler = Callable[[Dict[str, Any]], Any]


def _emit_event(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_worker(handlers: Dict[str, Handler]) -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        req_id = None
        request: Dict[str, Any] = {}
        try:
            request = json.loads(raw)
            req_id = request.get("id")
            cmd = request.get("cmd")
            if cmd == "ping":
                response = {"id": req_id, "ok": True, "data": {"status": "ok"}, "error": None}
            elif not cmd or cmd not in handlers:
                response = {"id": req_id, "ok": False, "data": None, "error": f"unknown command: {cmd!r}"}
            else:
                trace_id = request.get("trace_id")

                def log_func(message: str) -> None:
                    _emit_event({
                        "event": "message",
                        "trace_id": trace_id,
                        "message": f"[{time.strftime('%H:%M:%S')}] {message}",
                    })

                handler = handlers[cmd]
                try:
                    data = handler(request, log_func=log_func)
                except TypeError:
                    data = handler(request)
                response = {"id": req_id, "ok": True, "data": data, "error": None, "trace_id": trace_id}
        except Exception as exc:  # pragma: no cover - defensive worker boundary
            response = {"id": req_id, "ok": False, "data": None, "error": str(exc), "trace_id": request.get("trace_id") if isinstance(request, dict) else None}

        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
