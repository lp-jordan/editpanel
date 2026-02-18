#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from typing import Any, Callable, Dict

Handler = Callable[[Dict[str, Any]], Any]


def run_worker(handlers: Dict[str, Handler]) -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        req_id = None
        try:
            request = json.loads(raw)
            req_id = request.get("id")
            cmd = request.get("cmd")
            if cmd == "ping":
                response = {"id": req_id, "ok": True, "data": {"status": "ok"}, "error": None}
            elif not cmd or cmd not in handlers:
                response = {"id": req_id, "ok": False, "data": None, "error": f"unknown command: {cmd!r}"}
            else:
                data = handlers[cmd](request)
                response = {"id": req_id, "ok": True, "data": data, "error": None}
        except Exception as exc:  # pragma: no cover - defensive worker boundary
            response = {"id": req_id, "ok": False, "data": None, "error": str(exc)}

        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
