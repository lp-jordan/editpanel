#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — ATEM footage → Resolve media-pool import feasibility probe.

THROWAWAY diagnostic, NOT wired into editpanel's command dispatch
(helper/commands/HANDLERS). Its only job is to prove — on a REAL open Resolve
project, against REAL ingested ATEM clips already on disk — the mechanics the
planned "Import into Resolve" toggle (Phase 6) depends on:

  1. NESTED SUB-BIN CREATION: find-or-create a nested bin structure that mirrors
     the on-disk ingest layout — <ParentBin> / <Session> / CAM <n> — via
     MediaPool.AddSubFolder + SetCurrentFolder, and confirm SetCurrentFolder
     actually targets the leaf so imported clips land in the right bin.

  2. IMPORT: MediaPool.ImportMedia([paths]) on the multicam .mp4 ISO clips —
     does it accept them, return MediaPoolItem handles, and land them in the
     current folder? How long does importing several large clips block?

  3. METADATA READBACK: for each imported MediaPoolItem, read the properties the
     rest of the toolchain assumes exist on ATEM footage — Clip Name, Resolution,
     FPS, Start TC (the ATEM jams time-of-day TC), Duration. This tells us whether
     imported clips are immediately usable by slate/marker features downstream.

WHAT IT DOES NOT DO: talk to LPOS, talk to FTP, or run the real ingest. It only
imports files you ALREADY pulled to disk. It creates one clearly-tagged bin
(__SPIKE_atem_import) and attempts to delete it at the end.

HOW TO RUN (on the Windows/Resolve machine):

  A) Easiest — inside Resolve's own console:
     Workspace > Console > switch to "Py3", then:
         exec(open(r"C:\\path\\to\\editpanel\\spikes\\spike_import_media.py").read())
     The console injects a global `resolve`, so no attach step is needed.

  B) External — from a terminal, with Resolve already open:
         python spike_import_media.py

BEFORE RUNNING:
  1. Open (in Resolve) the project you want to import into. Import can ONLY
     target the currently-open project's media pool — there is no import into a
     closed project.
  2. Point CONFIG.source below at a folder OR an explicit list of clips that you
     already ingested with the ATEM FTP flow. Leave it at the default and edit
     the path.

Paste the printed report back and we lock the import path + bin scheme before
wiring anything into editpanel.
"""

from __future__ import annotations

import os
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple


# ──────────────────────────────────────────────────────────────────────────────
# CONFIG — tweak here, no CLI parsing so it also works pasted into the console
# ──────────────────────────────────────────────────────────────────────────────
class CONFIG:
    # WHERE the already-ingested clips live. Either:
    #   - a folder that will be walked recursively for *.mp4 / *.mov, OR
    #   - an explicit list of file paths (set source_files instead).
    source: Optional[str] = r"CHANGE_ME\path\to\ingested\SessionName"
    source_files: Optional[List[str]] = None   # e.g. [r"C:\...\clip1.mp4", ...]

    # Parent bin the footage imports UNDER. Mirrors the editpanel dropdown value;
    # nested path segments are joined with " / " (see bin_tree.BIN_PATH_SEPARATOR).
    # The default matches create_project_bins' FOOTAGE > ATEM bin.
    parent_bin: str = "FOOTAGE / ATEM"

    # If parent_bin doesn't exist, create it? (The real feature will require the
    # editor to have run project-setup first; for the spike we allow creation so
    # it runs on a bare project.)
    create_parent_if_missing: bool = True

    # Cap how many files we actually import, to keep the probe fast on a big
    # session. None = import everything found.
    max_files: Optional[int] = 6

    # Delete the __SPIKE bin (and everything imported into it) at the end?
    cleanup: bool = True


BIN_PATH_SEPARATOR = " / "
SPIKE_BIN = "__SPIKE_atem_import"
VIDEO_EXT_RE = re.compile(r"\.(mov|mp4)$", re.IGNORECASE)
APPLE_DOUBLE_RE = re.compile(r"^\._")
# Same camera-parse regex the JS ingest uses (atem_ftp.parseCameraInfo):
#   "...CAM 1 01.mp4" -> cam 1, take 1
CAM_RE = re.compile(r"[\s_]CAM (\d+) (\d+)\.", re.IGNORECASE)


# ──────────────────────────────────────────────────────────────────────────────
# Resolve attach — try every path so this runs pasted-in OR external
# ──────────────────────────────────────────────────────────────────────────────
def get_resolve() -> Any:
    g = globals().get("resolve")
    if g is not None:
        return g
    try:
        return resolve  # type: ignore[name-defined]  # noqa: F821
    except NameError:
        pass

    here = os.path.dirname(os.path.abspath(__file__))
    helper_dir = os.path.normpath(os.path.join(here, "..", "helper"))
    if helper_dir not in sys.path:
        sys.path.insert(0, helper_dir)
    try:
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

    raise RuntimeError("Could not attach to Resolve — is it running with a project open?")


# ──────────────────────────────────────────────────────────────────────────────
# Bin helpers (mirror bin_tree.py / create_project_bins.py so the spike proves
# the SAME calls the real command would make)
# ──────────────────────────────────────────────────────────────────────────────
def _subfolders(folder: Any) -> List[Any]:
    try:
        return folder.GetSubFolderList() or []
    except Exception:
        return []


def _name(folder: Any) -> Optional[str]:
    try:
        return folder.GetName()
    except Exception:
        return None


def resolve_folder_by_path(root: Any, bin_path: str) -> Optional[Any]:
    # Top-level exact match first (back-compat with bare names).
    for f in _subfolders(root):
        if _name(f) == bin_path:
            return f
    if BIN_PATH_SEPARATOR not in bin_path:
        return None
    current = root
    for seg in bin_path.split(BIN_PATH_SEPARATOR):
        nxt = None
        for child in _subfolders(current):
            if _name(child) == seg:
                nxt = child
                break
        if nxt is None:
            return None
        current = nxt
    return current


def find_or_create(media_pool: Any, parent: Any, name: str) -> Optional[Any]:
    for child in _subfolders(parent):
        if _name(child) == name:
            return child
    return media_pool.AddSubFolder(parent, name)


def find_or_create_path(media_pool: Any, root: Any, segments: List[str]) -> Optional[Any]:
    current = root
    for seg in segments:
        current = find_or_create(media_pool, current, seg)
        if current is None:
            return None
    return current


# ──────────────────────────────────────────────────────────────────────────────
# File discovery + camera/session parse (mirrors atem_ftp.js)
# ──────────────────────────────────────────────────────────────────────────────
def parse_cam(filename: str) -> Optional[Tuple[int, int]]:
    m = CAM_RE.search(filename)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def discover_files() -> List[str]:
    if CONFIG.source_files:
        return list(CONFIG.source_files)
    root = CONFIG.source or ""
    found: List[str] = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if VIDEO_EXT_RE.search(fn) and not APPLE_DOUBLE_RE.match(fn):
                found.append(os.path.join(dirpath, fn))
    found.sort()
    return found


def target_segments_for(path: str) -> List[str]:
    """Build the nested bin path segments UNDER the spike parent that mirror the
    on-disk layout: <Session> / CAM <n>. Session = the folder two levels up from
    the file when ingested as <dest>/<Session>/CAM n/<file>; falls back to the
    immediate parent folder name."""
    fn = os.path.basename(path)
    cam = parse_cam(fn)
    parent_dir = os.path.basename(os.path.dirname(path))            # e.g. "CAM 1"
    session_dir = os.path.basename(os.path.dirname(os.path.dirname(path)))
    session = session_dir or "UnknownSession"
    cam_folder = f"CAM {cam[0]}" if cam else (parent_dir or "Unknown")
    return [session, cam_folder]


# ──────────────────────────────────────────────────────────────────────────────
# Main probe
# ──────────────────────────────────────────────────────────────────────────────
def main() -> None:
    print("=" * 72)
    print("SPIKE — ATEM footage -> Resolve media-pool import")
    print("=" * 72)

    resolve = get_resolve()
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if not project:
        print("[fatal] No project open. Open the target project in Resolve first.")
        return
    print(f"[ok] Project open: {project.GetName()}")

    media_pool = project.GetMediaPool()
    root = media_pool.GetRootFolder()

    files = discover_files()
    if not files:
        print(f"[fatal] No .mp4/.mov files found under CONFIG.source: {CONFIG.source!r}")
        print("        Edit CONFIG.source (or CONFIG.source_files) to a real ingested folder.")
        return
    if CONFIG.max_files:
        files = files[: CONFIG.max_files]
    print(f"[ok] {len(files)} clip(s) to import (capped at {CONFIG.max_files}).")

    # ── Mechanic 1: resolve/create the parent bin, then nested sub-bins ────────
    parent = resolve_folder_by_path(root, CONFIG.parent_bin)
    if parent is None:
        if CONFIG.create_parent_if_missing:
            parent = find_or_create_path(media_pool, root, CONFIG.parent_bin.split(BIN_PATH_SEPARATOR))
            print(f"[ok] Created parent bin path: {CONFIG.parent_bin}")
        else:
            print(f"[fatal] Parent bin not found: {CONFIG.parent_bin}")
            return
    else:
        print(f"[ok] Resolved parent bin: {CONFIG.parent_bin}")

    # Everything the spike creates lives under one clearly-tagged bin so cleanup
    # is a single DeleteFolders call.
    spike_root = find_or_create(media_pool, parent, SPIKE_BIN)
    print(f"[ok] Spike root bin: {CONFIG.parent_bin} {BIN_PATH_SEPARATOR} {SPIKE_BIN}")

    # Group files by their nested target so we set the current folder once per bin.
    by_bin: Dict[Tuple[str, ...], List[str]] = {}
    for p in files:
        segs = tuple(target_segments_for(p))
        by_bin.setdefault(segs, []).append(p)

    imported: List[Any] = []
    for segs, paths in by_bin.items():
        leaf = find_or_create_path(media_pool, spike_root, list(segs))
        if leaf is None:
            print(f"[warn] could not create bin {' / '.join(segs)} — skipping {len(paths)} file(s)")
            continue
        ok = media_pool.SetCurrentFolder(leaf)
        cur = _name(media_pool.GetCurrentFolder())
        print(f"[bin] {' / '.join(segs)}  (SetCurrentFolder ok={ok}, current='{cur}')  <- {len(paths)} file(s)")

        # ── Mechanic 2: import ────────────────────────────────────────────────
        t0 = time.time()
        items = media_pool.ImportMedia(paths)
        dt = time.time() - t0
        n = len(items) if items else 0
        print(f"      ImportMedia -> {n} item(s) in {dt:.1f}s")
        if items:
            imported.extend(items)

    # ── Mechanic 3: metadata readback ─────────────────────────────────────────
    print("-" * 72)
    print(f"IMPORTED {len(imported)} MediaPoolItem(s) — metadata readback:")
    for it in imported:
        try:
            name = it.GetName()
        except Exception:
            name = "?"
        def prop(k: str) -> str:
            try:
                v = it.GetClipProperty(k)
                return str(v) if v not in (None, "") else "-"
            except Exception:
                return "?"
        print(f"  • {name}")
        print(f"      Resolution={prop('Resolution')}  FPS={prop('FPS')}  "
              f"StartTC={prop('Start TC')}  Duration={prop('Duration')}")

    # ── Cleanup ───────────────────────────────────────────────────────────────
    if CONFIG.cleanup:
        try:
            ok = media_pool.DeleteFolders([spike_root])
            print("-" * 72)
            print(f"[cleanup] DeleteFolders({SPIKE_BIN}) ok={ok}")
        except Exception as exc:
            print(f"[cleanup] DeleteFolders failed ({exc}) — delete '{SPIKE_BIN}' manually.")
    else:
        print(f"[cleanup] skipped — delete the '{SPIKE_BIN}' bin manually when done.")

    print("=" * 72)
    print("DONE. Paste this whole report back.")
    print("Key questions answered above:")
    print("  1. Did SetCurrentFolder report ok and target the right leaf bin?")
    print("  2. Did ImportMedia return one item per file, and how slow was it?")
    print("  3. Do Resolution/FPS/StartTC/Duration read correctly on the ATEM clips?")
    print("=" * 72)


if __name__ == "__main__":
    main()
else:
    # Pasted into Resolve's console (no __main__): run immediately.
    main()
