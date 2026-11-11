"""cut_through/common.py for the helper commands (cut_through, create_multicam, slate_span_report).

helper/ and cut_through/ always ship side by side (resources/helper + resources/cut_through when
packaged, the checkout's helper/ + cut_through/ in dev — HELPER_ROOT in main.js), so the copy beside
this helper is the one built with it — not the Cut-through page's pipeline folder setting, which can
point at another checkout.

Loaded on first use, not at import: the workers import every command at start, and a missing
cut_through folder must only break the commands that need it, never the whole worker.
"""
import importlib.util
import os
from typing import Any, Optional

PATH = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "cut_through", "common.py"))
_mod: Optional[Any] = None


def load() -> Any:
    global _mod
    if _mod is None:
        if not os.path.isfile(PATH):
            raise RuntimeError(f"Cut-through helpers missing: {PATH}")
        spec = importlib.util.spec_from_file_location("cut_through_common", PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _mod = mod
    return _mod
