"""Bitrate override via a temporary copy of the render preset.

Resolve 21.0 rejects SetRenderSettings({"VideoQuality": ...}) in every form and
for every H.264/H.265 encoder (spikes/spike_video_quality.py, 2026-10-23), so
the bitrate is written into the preset itself instead:

  ExportRenderPreset(base) -> XML -> set the bitrate -> ImportRenderPreset(copy)
  -> queue every timeline with the copy -> DeleteRenderPreset(copy)

A preset XML (Resolve 21, DbPrjVer 17) carries the bitrate in two places:
  - ExtraInfoMap  <DbKey>h264_datarate</DbKey><DbVal>50000</DbVal>   (kbps)
  - ExtraInfoMap  encoder_command_param_map: a hex blob of length-prefixed
    UTF-16BE key/value strings that includes ("bitrate", "50000")
Both are rewritten. The XML holds no preset name (Resolve names an import after
the file), and its DbId is replaced so the copy can never collide with the
original. One copy per export batch; the saved preset is never touched.
"""
import glob
import os
import re
import shutil
import struct
import tempfile
import uuid
from typing import Any, List, Optional, Tuple

TEMP_PRESET_NAME = "EditPanel Bitrate"

_DATARATE_RE = re.compile(
    r"(<DbKey>(?:h264|h265|hevc)_datarate</DbKey>\s*<DbVal>)(\d+)(</DbVal>)"
)
_PARAM_MAP_RE = re.compile(
    r"(<DbKey>encoder_command_param_map</DbKey>\s*<DbVal>)([0-9a-fA-F]+)(</DbVal>)"
)
_DBID_RE = re.compile(r'(<SyRecordInfo\s+DbId=")([^"]+)(")')


def _decode_param_map(hex_blob: str) -> List[str]:
    """uint32 pair count, then (uint32 byte length + UTF-16BE string) repeated."""
    raw = bytes.fromhex(hex_blob)
    i = 4
    items: List[str] = []
    while i < len(raw):
        (n,) = struct.unpack(">I", raw[i:i + 4])
        i += 4
        items.append(raw[i:i + n].decode("utf-16-be"))
        i += n
    return items


def _encode_param_map(items: List[str]) -> str:
    out = struct.pack(">I", len(items) // 2)
    for s in items:
        b = s.encode("utf-16-be")
        out += struct.pack(">I", len(b)) + b
    return out.hex()


def rewrite_preset_xml(xml: str, kbps: int) -> Tuple[str, List[str]]:
    """Return (new xml, names of the fields that were changed). An empty list
    means the preset has no bitrate to set (e.g. ProRes/DNx)."""
    changed: List[str] = []

    def datarate(m: "re.Match[str]") -> str:
        changed.append("datarate")
        return f"{m.group(1)}{kbps}{m.group(3)}"

    xml = _DATARATE_RE.sub(datarate, xml)

    def param_map(m: "re.Match[str]") -> str:
        try:
            items = _decode_param_map(m.group(2))
        except Exception:
            return m.group(0)
        hit = False
        for k in range(0, len(items) - 1, 2):
            if items[k] == "bitrate":
                items[k + 1] = str(kbps)
                hit = True
        if not hit:
            return m.group(0)
        changed.append("encoder bitrate")
        return f"{m.group(1)}{_encode_param_map(items)}{m.group(3)}"

    xml = _PARAM_MAP_RE.sub(param_map, xml)

    if changed:
        xml = _DBID_RE.sub(lambda m: f"{m.group(1)}{uuid.uuid4()}{m.group(3)}", xml, count=1)
    return xml, changed


def _preset_names(project: Any) -> List[str]:
    try:
        return list(project.GetRenderPresetList() or [])
    except Exception:
        return []


def make_bitrate_preset(resolve: Any, project: Any, base_preset: str, kbps: int, log: Any) -> Optional[str]:
    """Create the temporary copy of base_preset at kbps. Returns its name, or
    None (and logs why) so the caller queues with the base preset instead."""
    if resolve is None or not hasattr(resolve, "ExportRenderPreset") or not hasattr(resolve, "ImportRenderPreset"):
        log("Warning: this Resolve can't export/import presets; using the preset's bitrate.")
        return None

    # A copy left behind by an earlier run would make the import come back
    # under a different name; clear it first.
    if TEMP_PRESET_NAME in _preset_names(project):
        try:
            project.DeleteRenderPreset(TEMP_PRESET_NAME)
        except Exception:
            pass

    # ExportRenderPreset treats its path as a FOLDER and writes
    # "<preset name>.xml" inside it (seen on Resolve 21.0.0.48), so export into
    # a fresh temp folder and pick up whatever XML lands there.
    work = tempfile.mkdtemp(prefix="editpanel_preset_")
    export_dir = os.path.join(work, "export")
    copy_path = os.path.join(work, f"{TEMP_PRESET_NAME}.xml")
    try:
        os.makedirs(export_dir, exist_ok=True)
        if not resolve.ExportRenderPreset(base_preset, export_dir):
            log(f"Warning: couldn't export preset '{base_preset}'; using the preset's bitrate.")
            return None
        exported = sorted(glob.glob(os.path.join(export_dir, "**", "*.xml"), recursive=True))
        if not exported:
            log(f"Warning: exporting preset '{base_preset}' produced no XML; using the preset's bitrate.")
            return None
        with open(exported[0], "r", encoding="utf-8") as fh:
            xml = fh.read()
        new_xml, changed = rewrite_preset_xml(xml, kbps)
        if not changed:
            log(f"Warning: preset '{base_preset}' has no bitrate setting (not H.264/H.265?); using it as is.")
            return None
        with open(copy_path, "w", encoding="utf-8") as fh:
            fh.write(new_xml)

        before = set(_preset_names(project))
        if not resolve.ImportRenderPreset(copy_path):
            log("Warning: Resolve refused the bitrate preset copy; using the preset's bitrate.")
            return None
        added = [n for n in _preset_names(project) if n not in before]
        if TEMP_PRESET_NAME in added or (not added and TEMP_PRESET_NAME in before):
            name = TEMP_PRESET_NAME
        elif len(added) == 1:
            name = added[0]
        else:
            log(f"Warning: couldn't find the imported bitrate preset (new presets: {added}); using the preset's bitrate.")
            return None
        log(f"Bitrate preset '{name}' created from '{base_preset}' at {kbps} kbps ({', '.join(changed)}).")
        return name
    except Exception as exc:
        log(f"Warning: bitrate preset copy failed ({exc}); using the preset's bitrate.")
        return None
    finally:
        shutil.rmtree(work, ignore_errors=True)


def drop_bitrate_preset(project: Any, name: Optional[str], log: Any) -> None:
    """Delete the temporary copy once every job is queued. Queued jobs keep
    the settings they were added with."""
    if not name:
        return
    try:
        if project.DeleteRenderPreset(name):
            log(f"Bitrate preset '{name}' removed.")
        else:
            log(f"Warning: couldn't remove bitrate preset '{name}'; the next export reuses it.")
    except Exception as exc:
        log(f"Warning: couldn't remove bitrate preset '{name}' ({exc}).")
