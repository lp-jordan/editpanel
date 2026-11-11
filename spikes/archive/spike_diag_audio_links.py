#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE (read-only) — What is the camera files' audio actually linked to?

The ATEM mix (Camera 1's audio) comes in red in every new multicam copy since the mic WAVs'
timecode was stamped and restored (2026-11-05), while the original multicam still plays it.
This lists, for every media pool clip whose name matches CAM / MIC / .WAV: its bin, unique ID,
start timecode, audio channels, and Resolve's audio mapping (which shows any LINKED audio files
and their paths) — so we can see whether CAM 1's audio points at the WAVs. Changes nothing.

HOW TO RUN (Windows Resolve machine, project open):
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_diag_audio_links.py", encoding="utf-8").read())
Report saved to Desktop\\audio_links.txt.
"""
import json
import os

DESKTOP = os.path.expanduser("~/Desktop")
MATCH = ("CAM", "MIC", ".WAV")
KEYS = ("Type", "Start TC", "End TC", "Audio Ch", "Audio Codec", "Sample Rate", "File Path", "Synced Audio",
        "Clip Color", "Usage")
_lines = []


def say(msg=""):
    print(msg)
    _lines.append(msg)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def walk(folder, path=""):
    here = f"{path} / {folder.GetName()}" if path else folder.GetName()
    for c in _safe(lambda: folder.GetClipList(), []) or []:
        yield here, c
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        yield from walk(sub, here)


def main():
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — audio links")
    for where, c in walk(project.GetMediaPool().GetRootFolder()):
        name = str(_safe(lambda: c.GetName(), ""))
        if not any(m in name.upper() for m in MATCH):
            continue
        props = _safe(lambda: c.GetClipProperty(), {}) or {}
        say(f"\n{name}  [{c.GetUniqueId()[:8]}]  in '{where}'")
        say("   " + "; ".join(f"{k}: {props[k]}" for k in KEYS if props.get(k) not in (None, "")))
        mapping = _safe(lambda: c.GetAudioMapping())
        try:
            m = json.loads(mapping) if mapping else {}
            linked = m.get("linked_audio") or {}
            say(f"   embedded channels {m.get('embedded_audio_channels')}; linked audio: "
                + (", ".join(f"#{k} {v.get('path')} (offset {v.get('offset')}, {v.get('channels')} ch)"
                             for k, v in linked.items()) or "none"))
            for k, tr in (m.get("track_mapping") or {}).items():
                say(f"   track {k}: {tr.get('type')} channels {tr.get('channel_idx')} mute {tr.get('mute')}")
        except Exception:
            say(f"   audio mapping (raw): {mapping!r}")


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    with open(os.path.join(DESKTOP, "audio_links.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(_lines) + "\n")
