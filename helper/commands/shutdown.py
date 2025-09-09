from typing import Any, Dict
import threading
import time
import sys


def handle_shutdown(_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Gracefully exit the helper."""
    threading.Thread(target=lambda: (time.sleep(0.05), sys.exit(0)), daemon=True).start()
    return {"result": True}
