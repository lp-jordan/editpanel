from typing import Any, Dict

from .spellcheck import _get_fusion_comps, _tool_unique_name


def handle_update_text(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Update the text of a Fusion tool identified by timeline position."""
    from .. import resolve_helper as rh

    if not rh.timeline:
        raise RuntimeError("No active timeline")

    # Project/timeline scope guard. The renderer captures the project +
    # timeline at the time a result run is created (e.g. the spellcheck scan)
    # and passes them back on every apply-action. If Resolve has been switched
    # to a different project/timeline since, refuse rather than silently
    # writing into the wrong project. The result item stays pending so the
    # user can switch back and retry. See lp-app-ecosystem CLAUDE.md scoping
    # notes (task 2026-05-27).
    expect_project  = payload.get("expect_project")
    expect_timeline = payload.get("expect_timeline")
    if expect_project or expect_timeline:
        current_project  = rh.project.GetName()  if rh.project  else None
        current_timeline = rh.timeline.GetName() if rh.timeline else None
        if expect_project and current_project and expect_project != current_project:
            raise RuntimeError(
                f"Project mismatch: this change was queued against "
                f"“{expect_project}” but Resolve is on “{current_project}”. "
                f"Switch back to apply."
            )
        if expect_timeline and current_timeline and expect_timeline != current_timeline:
            raise RuntimeError(
                f"Timeline mismatch: this change was queued against "
                f"“{expect_timeline}” but Resolve is on “{current_timeline}”. "
                f"Switch back to apply."
            )

    track = int(payload.get("track", 0))
    start_frame = int(payload.get("start_frame", 0))
    tool_name = payload.get("tool_name")
    text = payload.get("text", "")

    get_items = getattr(rh.timeline, "GetItemListInTrack", None)
    if not callable(get_items):
        return {"result": False, "reason": "Timeline does not expose GetItemListInTrack"}
    items = get_items("video", track) or []
    target = None
    for item in items:
        get_start = getattr(item, "GetStart", None)
        if callable(get_start) and int(get_start() or 0) == start_frame:
            target = item
            break
    if not target:
        return {
            "result": False,
            "reason": (
                f"No clip on track {track} starts at frame {start_frame}. "
                "The clip may have been moved, trimmed, or deleted since "
                "the spellcheck scan ran. Re-run the scan and try again."
            ),
        }

    # GetToolList(False) gives ALL tools (True = selected-only, almost
    # always empty from the Edit page). The dict's keys are 1-indexed
    # INTEGERS in current Resolve builds, not tool names — so we must
    # iterate the values and match each tool's GetAttrs()["TOOLS_Name"]
    # against the target name. The earlier code did `tools.get(tool_name)`
    # which never matched anything, and treated the iteration key as a
    # name fallback which also never matched (key was "12", target was
    # "Text1").
    comps = _get_fusion_comps(target)
    seen_names = []
    for comp in comps:
        # Prefer the dedicated lookup API when available — fewer surface
        # paths to go wrong.
        find_tool = getattr(comp, "FindTool", None)
        if callable(find_tool):
            try:
                tool = find_tool(tool_name)
                if tool:
                    set_input = getattr(tool, "SetInput", None)
                    if callable(set_input):
                        res = set_input("StyledText", text)
                        return {"result": bool(res) if res is not None else True}
            except Exception:
                pass

        get_tool_list = getattr(comp, "GetToolList", None)
        if not callable(get_tool_list):
            continue
        try:
            tools = get_tool_list(False) or {}
            tool_iterable = list(tools.values()) if hasattr(tools, "values") else list(tools)
            for t in tool_iterable:
                name = _tool_unique_name(t)
                if name:
                    seen_names.append(name)
                if name == tool_name:
                    set_input = getattr(t, "SetInput", None)
                    if callable(set_input):
                        res = set_input("StyledText", text)
                        return {"result": bool(res) if res is not None else True}
        except Exception:
            continue
    return {
        "result": False,
        "reason": (
            f"Tool '{tool_name}' not found in any Fusion comp on this clip. "
            f"Available tools: {', '.join(seen_names) or '(none)'}"
        ),
    }
