"""Command handler package for Resolve helper."""
from .connect import handle_connect
from .context import handle_context
from .add_marker import handle_add_marker
from .start_render import handle_start_render
from .stop_render import handle_stop_render
from .create_project_bins import handle_create_project_bins
from .lp_base_export import handle_lp_base_export
from .shutdown import handle_shutdown

# Mapping of command names to handler functions
HANDLERS = {
    "context": handle_context,
    "add_marker": handle_add_marker,
    "start_render": handle_start_render,
    "stop_render": handle_stop_render,
    "create_project_bins": handle_create_project_bins,
    "lp_base_export": handle_lp_base_export,
    "shutdown": handle_shutdown,
    "connect": handle_connect,
}
