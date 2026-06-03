"""Command handler package for Resolve/media workers."""
from .connect import handle_connect
from .context import handle_context
from .add_marker import handle_add_marker
from .start_render import handle_start_render
from .stop_render import handle_stop_render
from .render_status import handle_render_status
from .list_render_jobs import handle_list_render_jobs
from .create_project_bins import handle_create_project_bins
from .lp_base_export import handle_lp_base_export
from .export_preflight import handle_export_preflight
from .shutdown import handle_shutdown
from .spellcheck import handle_spellcheck
from .update_text import handle_update_text
from .goto import handle_goto
from .sync_comment_markers import handle_sync_comment_markers
from .list_timelines import handle_list_timelines
from .flag_timelines import handle_flag_timelines
from .focus_comment import handle_focus_comment
from .delete_comment_marker import handle_delete_comment_marker


RESOLVE_HANDLERS = {
    "context": handle_context,
    "add_marker": handle_add_marker,
    "start_render": handle_start_render,
    "stop_render": handle_stop_render,
    "render_status": handle_render_status,
    "list_render_jobs": handle_list_render_jobs,
    "create_project_bins": handle_create_project_bins,
    "lp_base_export": handle_lp_base_export,
    "export_preflight": handle_export_preflight,
    "shutdown": handle_shutdown,
    "connect": handle_connect,
    "spellcheck": handle_spellcheck,
    "update_text": handle_update_text,
    "goto": handle_goto,
    "sync_comment_markers": handle_sync_comment_markers,
    "list_timelines": handle_list_timelines,
    "flag_timelines": handle_flag_timelines,
    "focus_comment": handle_focus_comment,
    "delete_comment_marker": handle_delete_comment_marker,
}

# Reserved for future media worker commands (audit mode, etc.)
MEDIA_HANDLERS = {}

# Backwards compatibility for older entrypoint.
HANDLERS = {**RESOLVE_HANDLERS, **MEDIA_HANDLERS}
