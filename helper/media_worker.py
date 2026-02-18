#!/usr/bin/env python3
from __future__ import annotations

from helper.commands import MEDIA_HANDLERS
from helper.worker_runtime import run_worker


if __name__ == "__main__":
    run_worker(MEDIA_HANDLERS)
