#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Two-speaker rough cut from a cut plan (the blind conversation test).

Builds `__SPIKE_auto_<LABEL>_<n>` from the day multicam, exactly as the plan says:
  1. Picture: one multicam piece per plan row on V1, back to back.
  2. Sound: one audio track per speaker (A1 = first role in the plan, A2 = second…).
     Each mic is only open where the plan opens it (gating, like Jordan's edits), and
     only inside kept material. Where the source jumps (a removal) the clip is split.
  3. Angles: each picture piece is forced to its planned angle (SmartSwitch trick,
     video only). Each speaker's audio clips are switched to that speaker's mic angle,
     read from `__SPIKE_mics_<LABEL>` (the timeline Jordan set up for the collect run).
     The first audio switch is timed; if it's slow or fails, the rest are left for
     Jordan to switch by hand (select all clips on the track → switch angle).
  4. Finishing: 2-frame "Cross Fade 0 dB" where audio was removed and both sides are
     open; 8-frame audio fades and picture Cross Dissolves at head and tail.

The plan is spikes/plans/<LABEL>_plan.json (frames are multicam-relative, out = exclusive).
The finished edit is never read.

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    LABEL="ConvoTest"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_auto_rough_cut_2spk.py", encoding="utf-8").read())
Report saved to Desktop\\auto_cut_<LABEL>_build.txt.
"""

import json
import os
import time
from typing import Any, Dict, List, Optional

# ──────────────────────────────────────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────────────────────────────────────
LABEL = globals().get("LABEL", "ConvoTest")
REPO = r"C:\lp-app-ecosystem\editpanel"
FADE_FRAMES = 8
CROSSFADE = {"type": "Cross Fade 0 dB", "category": "audio",
             "position": "end", "alignment": "center", "duration": 2}
SWITCH_AUDIO = globals().get("SWITCH_AUDIO", True)   # False = leave every mic for Jordan to switch
SLOW_SWITCH_S = 20                    # first audio switch slower than this → leave the rest by hand
TIMELINE_BIN = "SEQUENCES"
DESKTOP = os.path.expanduser("~/Desktop")
PLAN_PATHS = [os.path.join(REPO, "spikes", "plans", f"{LABEL}_plan.json"),
              os.path.join(DESKTOP, f"{LABEL}_plan.json")]
REPORT_PATH = os.path.join(DESKTOP, f"auto_cut_{LABEL}_build.txt")
BIN_SEP = " / "
_lines: List[str] = []
_T0 = time.time()


def say(msg: str = "") -> None:
    if msg.startswith("\n== "):                      # stamp each step with elapsed time
        msg = f"{msg}  [{time.time() - _T0:.1f}s]"
    print(msg)
    _lines.append(msg)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def get_resolve() -> Any:
    g = globals().get("resolve")
    if g is not None:
        return g
    import DaVinciResolveScript as dvr  # type: ignore
    return dvr.scriptapp("Resolve")


def frames_to_clock(f: int, fps: float) -> str:
    s = f / fps
    return f"{int(s // 60)}:{s % 60:05.2f}"


def find_folder(root: Any, path: str) -> Optional[Any]:
    current = root
    segs = [s.strip() for s in path.split(BIN_SEP) if s.strip()]
    if segs and segs[0].lower() == str(_safe(lambda: root.GetName(), "")).lower():
        segs = segs[1:]
    for seg in segs:
        current = next((c for c in (_safe(lambda: current.GetSubFolderList(), []) or [])
                        if _safe(lambda: c.GetName()) == seg), None)
        if current is None:
            return None
    return current


def all_timelines(project: Any) -> Dict[str, Any]:
    out = {}
    for i in range(1, int(project.GetTimelineCount() or 0) + 1):
        tl = project.GetTimelineByIndex(i)
        out[str(_safe(lambda: tl.GetName(), ""))] = tl
    return out


def unique_name(project: Any, base: str) -> str:
    names = set(all_timelines(project))
    n = 1
    while f"{base}_{n}" in names:
        n += 1
    return f"{base}_{n}"


def _walk(folder: Any):
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield clip
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        yield from _walk(sub)


def angle_of(item: Any) -> str:
    name = str(_safe(lambda: item.GetName(), ""))
    return name.rsplit(" - ", 1)[-1] if " - " in name else "?"


def items(tl: Any, kind: str, track: int) -> List[Any]:
    return sorted(_safe(lambda: tl.GetItemListInTrack(kind, track), []) or [], key=lambda x: x.GetStart())


def force_angle(r: Any, item: Any, angle: str, video_only: bool) -> bool:
    """Per-piece SmartSwitch trick: 'wide' = the wanted angle, no analysis, one long shot."""
    base = {"analysisMode": r.SMART_SWITCH_ANALYSIS_MODE_NONE, "isAutoDetectWideAngle": False,
            "wideAngleID": angle, "wideAngleFrequency": r.SMART_SWITCH_WIDE_ANGLE_FREQ_HIGH,
            "isUseWideAngleForIntroOutro": True, "isUseWideAngleForSilence": True,
            "minEditDuration": 10.0, "switchOnVideoOnly": video_only}
    # Video-only mode refused every piece in the ConvoTest build (as in Z8, where only the
    # plain mode worked); plain mode is safe because the audio clips aren't linked.
    modes = [base, {**base, "switchOnVideoOnly": False}] if video_only else [base]
    for opts in modes:
        for _ in range(2):                            # the first call sometimes returns False
            if _safe(lambda: item.PerformMulticamSmartSwitch(opts), False) and angle_of(item) == angle:
                return True
    return False


# ──────────────────────────────────────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────────────────────────────────────
def build(r: Any, project: Any) -> None:
    mp = project.GetMediaPool()
    plan_path = next((p for p in PLAN_PATHS if os.path.exists(p)), None)
    if not plan_path:
        raise RuntimeError(f"No plan found at {PLAN_PATHS} — git pull first.")
    with open(plan_path, encoding="utf-8") as fh:
        plan = json.load(fh)
    fps = float(plan["fps"])
    pieces = plan["video"]
    roles = list(plan["mics"])
    say(f"Plan {plan_path}: {len(pieces)} picture piece(s), mics {roles}")

    mc = next((c for c in _walk(mp.GetRootFolder())
               if _safe(lambda: c.GetName()) == plan["multicam"]
               and "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()), None)
    if mc is None:
        raise RuntimeError(f"Multicam {plan['multicam']!r} not found in the media pool.")

    # Each speaker's mic angle, as Jordan set it on the collect run's mics timeline.
    mics_tl = all_timelines(project).get(f"__SPIKE_mics_{LABEL}")
    mic_angle: Dict[str, str] = {}
    mic_map: Dict[str, Optional[str]] = {}
    if mics_tl:
        for k in range(1, int(mics_tl.GetTrackCount("audio") or 0) + 1):
            name = _safe(lambda: mics_tl.GetTrackName("audio", k)) or f"A{k}"
            its = items(mics_tl, "audio", k)
            if name in roles and its:
                mic_angle[name] = angle_of(its[0])
                mic_map[name] = _safe(lambda: its[0].GetSourceAudioChannelMapping())
    say(f"Mic angles from __SPIKE_mics_{LABEL}: {mic_angle or 'NOT FOUND — switch the mics by hand'}")

    # ── 1. Picture ────────────────────────────────────────────────────────────
    say("\n== 1. Picture ==")
    tl_bin = find_folder(mp.GetRootFolder(), TIMELINE_BIN)
    if tl_bin:
        mp.SetCurrentFolder(tl_bin)
    name = unique_name(project, f"__SPIKE_auto_{LABEL}")
    tl = mp.CreateEmptyTimeline(name)
    if not tl:
        raise RuntimeError("Couldn't create the timeline.")
    project.SetCurrentTimeline(tl)
    _safe(lambda: r.OpenPage("edit"))
    rec0 = int(tl.GetStartFrame())
    offs, t = [], 0
    for p in pieces:
        offs.append(t)
        t += p["out"] - p["in"]
    placed = mp.AppendToTimeline([{"mediaPoolItem": mc, "startFrame": p["in"], "endFrame": p["out"],
                                   "mediaType": 1, "trackIndex": 1, "recordFrame": rec0 + off}
                                  for p, off in zip(pieces, offs)]) or []
    say(f"{name}: {len(placed)}/{len(pieces)} picture piece(s), {t / fps / 60:.1f} min")

    # ── 2. Sound ──────────────────────────────────────────────────────────────
    say("\n== 2. Sound (one track per speaker, gated) ==")
    # kept source → record: each picture piece maps [in, out) to [off, off + len)
    clips: Dict[str, List[List[int]]] = {}
    for role in roles:
        out: List[List[int]] = []                    # [src_in, src_out, rec_off]
        for s, e in sorted(plan["mics"][role]):
            for p, off in zip(pieces, offs):
                lo, hi = max(s, p["in"]), min(e, p["out"])
                if hi <= lo:
                    continue
                rec = off + (lo - p["in"])
                if out and out[-1][1] == lo and out[-1][2] + (out[-1][1] - out[-1][0]) == rec:
                    out[-1][1] = hi                  # continuous in source AND record: one clip
                else:
                    out.append([lo, hi, rec])
        clips[role] = out
    for k, role in enumerate(roles, 1):
        while int(tl.GetTrackCount("audio") or 0) < k:
            tl.AddTrack("audio", "stereo")
        _safe(lambda: tl.SetTrackName("audio", k, role))
        got = mp.AppendToTimeline([{"mediaPoolItem": mc, "startFrame": s, "endFrame": e, "mediaType": 2,
                                    "trackIndex": k, "recordFrame": rec0 + rec} for s, e, rec in clips[role]]) or []
        say(f"A{k} {role}: {len(got)}/{len(clips[role])} clip(s), mic open "
            f"{sum(e - s for s, e, _ in clips[role]) / fps / 60:.1f} min")

    # ── 3. Angles ─────────────────────────────────────────────────────────────
    say("\n== 3. Angles ==")
    vit = items(tl, "video", 1)
    for p, it in zip(pieces, vit):
        if angle_of(it) != p["angle"]:
            force_angle(r, it, p["angle"], video_only=True)
    vit = items(tl, "video", 1)
    hits = sum(1 for p, it in zip(pieces, vit) if angle_of(it) == p["angle"])
    say(f"Picture: {hits}/{len(pieces)} piece(s) on the planned angle (pieces now {len(vit)})")
    for p, it, off in zip(pieces, vit, offs):
        if angle_of(it) != p["angle"]:
            say(f"  ✗ {frames_to_clock(off, fps)} wanted {p['angle']}, got {angle_of(it)}")

    by_hand = []
    for k, role in enumerate(roles, 1):
        want = mic_angle.get(role)
        its = items(tl, "audio", k)
        if not want or not SWITCH_AUDIO:
            by_hand.append(f"A{k} ({role}) → {want or 'their mic angle'}")
            continue
        todo = [x for x in its if angle_of(x) != want]
        t1 = time.time()
        done = 0
        for i, x in enumerate(todo):
            if force_angle(r, x, want, video_only=False):
                done += 1
            if i == 0 and time.time() - t1 > SLOW_SWITCH_S:
                say(f"  A{k}: first audio switch took {time.time() - t1:.0f}s — leaving the rest by hand")
                break
        its = items(tl, "audio", k)
        ok = sum(1 for x in its if angle_of(x) == want)
        say(f"A{k} {role}: {ok}/{len(its)} clip(s) on {want} ({done} switched in {time.time() - t1:.0f}s)")
        if ok < len(its):
            by_hand.append(f"A{k} ({role}) → {want}")
        m = mic_map.get(role)
        if m:
            _safe(lambda: [x.SetSourceAudioChannelMapping(m) for x in its])
    if by_hand:
        say("  ▶ BY HAND: select all clips on " + "; ".join(by_hand) + " and switch the multicam angle.")
    v_after = items(tl, "video", 1)
    say(f"Picture pieces after the audio switches: {len(v_after)} (should still be {len(pieces)}); "
        f"angles still right: {sum(1 for p, it in zip(pieces, v_after) if angle_of(it) == p['angle'])}")

    # ── 4. Finishing ──────────────────────────────────────────────────────────
    say("\n== 4. Crossfades and fades ==")
    for k, role in enumerate(roles, 1):
        its = items(tl, "audio", k)
        xf = 0
        for a, b in zip(its, its[1:]):
            jump = abs(float(b.GetSourceStartFrame()) - float(a.GetSourceEndFrame())) > 1
            if int(a.GetEnd()) == int(b.GetStart()) and jump:   # a removal join with the mic open
                xf += bool(_safe(lambda: a.AddTransition(CROSSFADE)))
        say(f"  A{k} {role}: {xf} crossfade(s)")
    end = rec0 + t
    for k in range(1, len(roles) + 1):
        its = items(tl, "audio", k)
        if its and int(its[0].GetStart()) == rec0:
            _safe(lambda: its[0].AddTransition({**CROSSFADE, "position": "start", "alignment": "right",
                                                "duration": FADE_FRAMES}))
        if its and int(its[-1].GetEnd()) == end:
            _safe(lambda: its[-1].AddTransition({**CROSSFADE, "position": "end", "alignment": "left",
                                                 "duration": FADE_FRAMES}))
    vit = items(tl, "video", 1)
    if vit:
        def dissolve(item, edge, align):
            for cat in ("simple", None):
                opts = {"type": "Cross Dissolve", "position": edge, "alignment": align, "duration": FADE_FRAMES}
                if cat:
                    opts["category"] = cat
                if _safe(lambda: item.AddTransition(opts)):
                    return "ok"
            return "FAILED"
        say(f"  Picture dissolve from black: {dissolve(vit[0], 'start', 'right')}; "
            f"to black: {dissolve(vit[-1], 'end', 'left')}")
    say(f"\nNow watch {name}. Then send the finished timeline's name for scoring.")


def main() -> None:
    r = get_resolve()
    project = r.GetProjectManager().GetCurrentProject()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — build {LABEL}")
    if getattr(r, "SMART_SWITCH_ANALYSIS_MODE_NONE", None) is None:
        raise RuntimeError("Needs Resolve 21.1+.")
    build(r, project)


try:
    main()
    say(f"\nTotal time: {time.time() - _T0:.1f}s")
except Exception as exc:
    say(f"\n✗ STOPPED after {time.time() - _T0:.1f}s: {exc}")
finally:
    try:
        with open(REPORT_PATH, "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
        print(f"\nReport saved to {REPORT_PATH}")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
