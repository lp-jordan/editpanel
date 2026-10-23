"""
Spike: how does this Resolve build actually take a bitrate?

EditPanel's VideoQuality override is rejected on the Windows build in every
form (int kbps, str kbps, bps), and GetCurrentRenderFormatAndCodec reports no
codec straight after LoadRenderPreset. This probe tries the direct route under
every condition we can vary, and also grabs the preset XML for the fallback:

  1. Build + render-related method names the API exposes (dir()).
  2. Format/codec after LoadRenderPreset, and every codec mp4/mov offer.
  3. SetRenderSettings({"VideoQuality": v}) for several value forms, after
     re-selecting each H.264/H.265 codec, on the current page and on Deliver.
  4. A control key (ExportVideo) to show SetRenderSettings works at all.
  5. ExportRenderPreset of the preset to the Desktop (the fallback's input).

Never queues or renders. It only changes the Deliver page's *current*
settings, then reloads the preset at the end so nothing sticks; the saved
preset itself is never modified.

Run with the project open in Resolve:
  - Inside Resolve: Workspace > Console > Py3, then
      exec(open(r"...\\editpanel\\spikes\\spike_video_quality.py").read())
  - Or from a terminal: python spike_video_quality.py

TIP: keep the Deliver page visible while it runs and watch the Quality field.
The report prints and is saved to the Desktop as resolve_bitrate_probe.txt.
"""
import os
import sys
from typing import Any, List

# ── CONFIG ────────────────────────────────────────────────────────────────────
PRESET_NAME = "General LP Export"
TEST_KBPS = 10000
VALUE_FORMS = [
    ("int kbps", TEST_KBPS),
    ("str kbps", str(TEST_KBPS)),
    ("int bps", TEST_KBPS * 1000),
    ("str 'High'", "High"),
    ("int 0 (auto)", 0),
]
FORMATS = ["mp4", "mov"]
# ──────────────────────────────────────────────────────────────────────────────

LINES: List[str] = []


def out(msg: str = "") -> None:
    print(msg)
    LINES.append(msg)


def get_resolve() -> Any:
    # Inside Resolve's Py3 console `resolve` is already a global.
    g = globals().get("resolve")
    if g is not None:
        return g
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        helper_dir = os.path.normpath(os.path.join(here, "..", "helper"))
        if helper_dir not in sys.path:
            sys.path.insert(0, helper_dir)
        from python_get_resolve import GetResolve  # type: ignore
        r = GetResolve()
        if r is not None:
            return r
    except Exception as exc:
        print(f"[attach] bundled loader failed: {exc}")
    try:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
        if r is not None:
            return r
    except Exception as exc:
        print(f"[attach] DaVinciResolveScript failed: {exc}")
    raise RuntimeError("Could not attach to Resolve. Open it, or run this in its Py3 console.")


def safe(fn, *args):
    try:
        return fn(*args)
    except Exception as exc:
        return f"<error: {exc}>"


def interesting_methods(obj: Any) -> List[str]:
    keys = ("render", "quality", "preset", "setting", "codec", "format", "bit")
    try:
        names = dir(obj)
    except Exception:
        return []
    return sorted(n for n in names if not n.startswith("_") and any(k in n.lower() for k in keys))


def is_bitrate_codec(desc: str, name: str) -> bool:
    s = f"{desc} {name}".lower()
    return any(k in s for k in ("264", "265", "hevc", "avc"))


def try_forms(project: Any, label: str) -> None:
    fc = safe(project.GetCurrentRenderFormatAndCodec)
    out(f"    [{label}] current format/codec = {fc!r}")
    for form_label, value in VALUE_FORMS:
        ok = safe(project.SetRenderSettings, {"VideoQuality": value})
        out(f"      VideoQuality {form_label:<14} {value!r:<12} -> {ok}")


def main() -> None:
    resolve = get_resolve()
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if not project:
        raise RuntimeError("No project open.")

    out("=== Resolve bitrate probe ===")
    out(f"Version: {safe(resolve.GetVersionString)}  ({safe(resolve.GetProductName)})")
    out(f"Project: {safe(project.GetName)}   Page: {safe(resolve.GetCurrentPage)}")
    out(f"Timeline: {safe(lambda: project.GetCurrentTimeline().GetName())}")
    out("")

    out("--- 1. API methods mentioning render/quality/preset/setting/codec/format/bit ---")
    out(f"Resolve: {interesting_methods(resolve)}")
    out(f"Project: {interesting_methods(project)}")
    out("")

    out(f"--- 2. Preset '{PRESET_NAME}' ---")
    presets = safe(project.GetRenderPresetList)
    out(f"Preset exists: {isinstance(presets, list) and PRESET_NAME in presets}")
    out(f"LoadRenderPreset -> {safe(project.LoadRenderPreset, PRESET_NAME)}")
    out(f"Format/codec after load: {safe(project.GetCurrentRenderFormatAndCodec)!r}")
    out(f"Render formats: {safe(project.GetRenderFormats)!r}")
    for fmt in FORMATS:
        out(f"Codecs for {fmt}: {safe(project.GetRenderCodecs, fmt)!r}")
    out("")

    out("--- 3. Control: does SetRenderSettings work at all? ---")
    out(f"ExportVideo=True -> {safe(project.SetRenderSettings, {'ExportVideo': True})}")
    out(f"MultiPassEncode=False -> {safe(project.SetRenderSettings, {'MultiPassEncode': False})}")
    out("")

    out("--- 4. VideoQuality straight after LoadRenderPreset ---")
    try_forms(project, "as loaded")
    out("")

    out("--- 5. VideoQuality after explicitly selecting each H.264/H.265 codec ---")
    for fmt in FORMATS:
        codecs = safe(project.GetRenderCodecs, fmt)
        if not isinstance(codecs, dict):
            continue
        for desc, name in codecs.items():
            if not is_bitrate_codec(str(desc), str(name)):
                continue
            safe(project.LoadRenderPreset, PRESET_NAME)
            sel = safe(project.SetCurrentRenderFormatAndCodec, fmt, name)
            out(f"  {fmt} / {desc} ({name}): select -> {sel}")
            if sel is True:
                try_forms(project, f"{fmt}/{name}")
    out("")

    out("--- 6. Same as 4, with the Deliver page open ---")
    out(f"OpenPage('deliver') -> {safe(resolve.OpenPage, 'deliver')}")
    safe(project.LoadRenderPreset, PRESET_NAME)
    try_forms(project, "deliver page")
    out("")

    out("--- 7. Export the preset XML (fallback input) ---")
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    xml_path = os.path.join(desktop, "General_LP_Export_preset.xml")
    if hasattr(resolve, "ExportRenderPreset"):
        out(f"ExportRenderPreset -> {safe(resolve.ExportRenderPreset, PRESET_NAME, xml_path)}  ({xml_path})")
    else:
        out("ExportRenderPreset: not available on this build")
    out(f"ImportRenderPreset available: {hasattr(resolve, 'ImportRenderPreset')}")
    out(f"DeleteRenderPreset available: {hasattr(project, 'DeleteRenderPreset')}")
    out("")

    # Leave the Deliver page as the preset defines it.
    out(f"Restore: LoadRenderPreset -> {safe(project.LoadRenderPreset, PRESET_NAME)}")

    report = os.path.join(desktop, "resolve_bitrate_probe.txt")
    try:
        with open(report, "w", encoding="utf-8") as fh:
            fh.write("\n".join(LINES) + "\n")
        print(f"\nSaved report to {report}")
    except Exception as exc:
        print(f"\nCould not save report: {exc}")


main()
