#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE (read-only) — Where did Resolve actually put the cut's picture and mic clips?

The Convo2 cut came in with the mics far out of sync (2026-11-05), although the FCPXML's mic
positions match the multicam's description and the real sync (cross-correlation, within ~5 fr).
This reads the cut timeline and compares, for a sample of clips on V1 / A1 / A2, what Resolve
placed (record position, source position, enabled) with what the plan asked for, and lists each
multicam copy's Start/End TC next to the original's (does the copy still start at the multicam's
tcStart, or at the first media after the 68-minute gap?). Changes nothing.

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    LABEL="Convo2"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_diag_sync.py", encoding="utf-8").read())
Optional: TL="timeline name" (default __SPIKE_split_<LABEL>).
Needs Desktop\\day_<LABEL>.json (from spike_day_prep.py). Report: Desktop\\diag_sync_<LABEL>.txt.
"""
import json
import os
from typing import Any, List

LABEL = globals().get("LABEL", "Convo2")
TL = globals().get("TL") or f"__SPIKE_split_{LABEL}"
REPO = r"C:\lp-app-ecosystem\editpanel"
DESKTOP = os.path.expanduser("~/Desktop")
FD = 1001 / 24000
_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def walk(folder: Any, path=""):
    here = f"{path} / {folder.GetName()}" if path else folder.GetName()
    for c in _safe(lambda: folder.GetClipList(), []) or []:
        yield here, c
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        yield from walk(sub, here)


def sample(items: list) -> list:
    n = len(items)
    idx = sorted({0, 1, 2, n // 2, n // 2 + 1, n - 2, n - 1} & set(range(n)))
    return [(i, items[i]) for i in idx]


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    plan = json.load(open(os.path.join(REPO, "cut_through", "plans", f"{LABEL}_plan.json"), encoding="utf-8"))
    day = json.load(open(os.path.join(DESKTOP, f"day_{LABEL}.json"), encoding="utf-8"))
    zero = {m["angle"]: m["file_zero_sec"] for m in day["mics"]}
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — sync diagnostic {TL}")
    say(f"Multicam description (export): tcStart {day['tc_start_sec']:.3f}s; mic file 0:00 at "
        + ", ".join(f"{m['name']} {m['file_zero_sec']:.3f}s ({m['angle']})" for m in day["mics"]))

    say(f"\nMulticams named {plan['multicam']!r}:")
    for where, c in walk(mp.GetRootFolder()):
        if _safe(lambda: c.GetName()) != plan["multicam"]:
            continue
        p = _safe(lambda: c.GetClipProperty(), {}) or {}
        say(f"   [{c.GetUniqueId()[:8]}] in '{where}': Start TC {p.get('Start TC')}, End TC {p.get('End TC')}, "
            f"Duration {p.get('Duration')}, Frames {p.get('Frames')}, Type {p.get('Type')}")

    tl = next((project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount()) + 1)
               if project.GetTimelineByIndex(i).GetName() == TL), None)
    if not tl:
        raise RuntimeError(f"No timeline {TL!r}")
    t0 = int(tl.GetStartFrame())
    say(f"\nTimeline {TL}: start frame {t0}, start TC {_safe(lambda: tl.GetStartTimecode())}")

    # plan: record frame → multicam frame
    pieces, rec = [], 0
    for v in plan["video"]:
        pieces.append((rec, v["in"], v["out"] - v["in"]))
        rec += v["out"] - v["in"]

    def mc_at(rf):
        for r0, i0, d in pieces:
            if r0 <= rf < r0 + d:
                return i0 + (rf - r0)
        return None

    roles = list(plan["mics"])
    angles = plan.get("mic_angles") or {}
    for kind, idx in (("video", 1), ("audio", 1), ("audio", 2), ("audio", 3)):
        items = _safe(lambda: tl.GetItemListInTrack(kind, idx), []) or []
        if not items:
            continue
        tag = f"{'V' if kind == 'video' else 'A'}{idx}"
        enabled = [_safe(lambda: it.GetClipEnabled()) for it in items]
        say(f"\n{tag}: {len(items)} item(s); GetClipEnabled False on {enabled.count(False)}, None on {enabled.count(None)}")
        for i, it in sample(items):
            rf = int(it.GetStart()) - t0
            src_f = _safe(lambda: it.GetSourceStartFrame())
            src_t = _safe(lambda: it.GetSourceStartTime())
            mpi = _safe(lambda: it.GetMediaPoolItem())
            name = _safe(lambda: mpi.GetName(), "?")
            want_mc = mc_at(rf)
            line = (f"   #{i} '{name}' rec {rf} dur {_safe(lambda: int(it.GetDuration()))}; source frame {src_f}, "
                    f"source time {src_t}, left offset {_safe(lambda: it.GetLeftOffset())}")
            if kind == "video" and want_mc is not None:
                line += (f" | plan: mc frame {want_mc} (= {want_mc * FD:.3f}s into the multicam, "
                         f"TC-based {day['tc_start_sec'] + want_mc * FD:.3f}s)")
            elif kind == "audio" and want_mc is not None and idx - 1 < len(roles):
                ang = angles.get(roles[idx - 1], roles[idx - 1])
                if ang in zero:
                    want = want_mc * FD - zero[ang]
                    line += f" | plan: WAV time {want:.3f}s"
                    if isinstance(src_t, (int, float)):
                        line += f" → off by {src_t - want:+.3f}s"
            say(line)


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(os.path.join(DESKTOP, f"diag_sync_{LABEL}.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("LABEL", "TL"):
        globals().pop(_k, None)
