#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Undo the mic WAV timecode stamp from spike_cut_through_batch.py.

Puts each WAV's Start TC back to what Desktop\\wav_timecode_backup_<LABEL>.json recorded
(00:00:00:00 for the Hollyland files), which brings the WAVs placed in the original multicam
back online. Renames the backup to *_restored.json afterwards.

HOW TO RUN (Windows Resolve machine, project open):
    LABEL="ConvoTest"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_restore_wav_tc.py", encoding="utf-8").read())
"""
import json
import os

LABEL = globals().get("LABEL", "ConvoTest")
DESKTOP = os.path.expanduser("~/Desktop")


def _walk(folder):
    for c in folder.GetClipList() or []:
        yield c
    for sub in folder.GetSubFolderList() or []:
        yield from _walk(sub)


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    mp = r.GetProjectManager().GetCurrentProject().GetMediaPool()
    path = os.path.join(DESKTOP, f"wav_timecode_backup_{LABEL}.json")
    backup = json.load(open(path, encoding="utf-8"))
    by_id = {c.GetUniqueId(): c for c in _walk(mp.GetRootFolder())}
    ok_all = True
    for uid, rec in backup.items():
        c = by_id.get(uid)
        if not c:
            print(f"{rec['name']}: ✗ not found in the media pool")
            ok_all = False
            continue
        before = c.GetClipProperty("Start TC")
        c.SetClipProperty("Start TC", rec["start_tc"])
        now = c.GetClipProperty("Start TC")
        ok_all &= now == rec["start_tc"]
        print(f"{rec['name']}: {before} → {now} {'✓' if now == rec['start_tc'] else '✗'}")
    if ok_all:
        os.replace(path, path.replace(".json", "_restored.json"))
        print("Restored. Check the WAVs in the original multicam are back online.")


main()
globals().pop("LABEL", None)
