#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — First automatic rough cut, judged against a real finished edit.

Runs in a project that already has finished multicam edits (Steve Heroux). It
takes the raw section behind one finished video (VIDEO), and in two passes:

  MODE = "export"
    1. Finds the finished timeline VIDEO and the stretch of the day multicam it
       was cut from (plus PAD_S either side).
    2. Transcribes the day multicam if it has no transcript yet (whole day, once).
    3. Renders that stretch's audio to a WAV and measures the level of every frame
       (the "waveform"), so cuts can be snapped to real quiet.
    4. Saves words + levels to Desktop\\auto_cut_<VIDEO>_export.json.
       → Send that file to Claude, who writes the cut plan
         (spikes/plans/<VIDEO>_plan.json) WITHOUT looking at the finished edit.

  MODE = "build"   (after `git pull` brings the plan in)
    1. Snaps every cut in the plan to the quietest frame nearby (audio levels).
    2. Builds `__SPIKE_auto_<VIDEO>_<n>` from the multicam, one piece per kept range.
    3. Forces each piece's angle (per-piece SmartSwitch trick) and checks the names.
    4. Adds a 2-frame "Cross Fade 0 dB" on every audio cut.
    5. Compares against the finished edit: cut points that match, and how much of
       what Jordan removed was also removed.
    → Watch `__SPIKE_auto_<VIDEO>_<n>` next to VIDEO.

HOW TO RUN (Windows Resolve machine, Steve Heroux open, after `git pull`):
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_auto_rough_cut.py", encoding="utf-8").read())
Report saved to Desktop\\auto_cut_<VIDEO>_<mode>.txt.
"""

import json
import math
import os
import time
import wave
from typing import Any, Dict, List, Optional, Tuple

# ──────────────────────────────────────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────────────────────────────────────
MODE = "export"                     # "export" first, then "build"
VIDEO = "Z8"                        # finished timeline whose raw section we re-cut
PAD_S = 3                           # seconds of raw kept either side of that section
REPO = r"C:\lp-app-ecosystem\editpanel"
SNAP_FRAMES = 8                     # look this far either side of a planned cut for quiet
CROSSFADE = {"type": "Cross Fade 0 dB", "category": "audio",
             "position": "end", "alignment": "center", "duration": 2}
TIMELINE_BIN = "SEQUENCES"          # optional; falls back to the current bin
DESKTOP = os.path.expanduser("~/Desktop")
EXPORT_PATH = os.path.join(DESKTOP, f"auto_cut_{VIDEO}_export.json")
PLAN_PATHS = [os.path.join(REPO, "spikes", "plans", f"{VIDEO}_plan.json"),
              os.path.join(DESKTOP, f"{VIDEO}_plan.json")]
REPORT_PATH = os.path.join(DESKTOP, f"auto_cut_{VIDEO}_{MODE}.txt")

BIN_SEP = " / "
SILENCE = "(...)"
_lines: List[str] = []


def say(msg: str = "") -> None:
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


def tc_to_frames(tc: str, fps: float) -> int:
    hh, mm, ss, ff = (int(p) for p in tc.strip().replace(";", ":").split(":"))
    return (hh * 3600 + mm * 60 + ss) * int(round(fps)) + ff


def frames_to_clock(f: int, fps: float) -> str:
    s = f / fps
    return f"{int(s // 60)}:{s % 60:05.2f}"


def find_folder(root: Any, path: str) -> Optional[Any]:
    current = root
    for seg in [s.strip() for s in path.split(BIN_SEP) if s.strip()]:
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


def multicam_pieces(tl: Any) -> List[Dict[str, Any]]:
    pieces = []
    for it in _safe(lambda: tl.GetItemListInTrack("video", 1), []) or []:
        mpi = _safe(lambda: it.GetMediaPoolItem())
        if not mpi or "multicam" not in str(_safe(lambda: mpi.GetClipProperty("Type"), "")).lower():
            continue
        pieces.append({"item": it, "mc": mpi, "name": str(_safe(lambda: it.GetName(), "")),
                       "start": int(it.GetStart()), "end": int(it.GetEnd()),
                       "src_in": int(round(float(it.GetSourceStartFrame()))),
                       "src_out": int(round(float(it.GetSourceEndFrame())))})
    return sorted(pieces, key=lambda p: p["start"])


def angle_of(name: str) -> str:
    return name.rsplit(" - ", 1)[-1] if " - " in name else "?"


# ──────────────────────────────────────────────────────────────────────────────
# Audio levels
# ──────────────────────────────────────────────────────────────────────────────
def render_audio(r: Any, project: Any, tl: Any, name: str) -> str:
    """Audio-only WAV render of `tl` to the Desktop (21.1: AudioFormat/AudioCodec settings)."""
    project.SetCurrentTimeline(tl)
    fmts = _safe(lambda: project.GetAudioRenderFormats(), {}) or {}
    ext = next((e for f, e in fmts.items() if "wav" in f"{f} {e}".lower()), "wav")
    codecs = _safe(lambda: project.GetAudioRenderCodecs(ext), {}) or {}
    codec = next((c for d, c in codecs.items() if "pcm" in f"{d} {c}".lower()), next(iter(codecs.values()), None))
    say(f"Audio formats: {fmts}; '{ext}' codecs: {codecs} → {codec}")
    settings = {"SelectAllFrames": True, "TargetDir": DESKTOP, "CustomName": name,
                "ExportVideo": False, "ExportAudio": True, "AudioFormat": ext,
                "AudioBitDepth": 16, "AudioSampleRate": 48000}
    if codec:
        settings["AudioCodec"] = codec
    ok = project.SetRenderSettings(settings)
    say(f"Render settings accepted: {ok}; now {_safe(lambda: project.GetCurrentRenderFormatAndCodec())}")
    if not ok:
        raise RuntimeError("Audio-only WAV render settings were rejected.")
    for f in os.listdir(DESKTOP):          # never measure a stale file from an earlier run
        if f.startswith(name) and f.lower().endswith(".wav"):
            _safe(lambda: os.remove(os.path.join(DESKTOP, f)))
    job = project.AddRenderJob()
    if not job:
        raise RuntimeError("AddRenderJob failed.")
    # Job IDs go in as separate arguments (same as helper/commands/start_render.py);
    # passing a list returned without rendering (run 2: "Ready in 0s").
    started = _safe(lambda: project.StartRendering(job), "raised")
    say(f"StartRendering({job}) → {started}")
    t0 = time.time()
    while not _safe(lambda: project.IsRenderingInProgress(), False) and time.time() - t0 < 10:
        time.sleep(0.5)                    # give the job a moment to actually begin
    while _safe(lambda: project.IsRenderingInProgress(), False) and time.time() - t0 < 900:
        time.sleep(1)
    st = _safe(lambda: project.GetRenderJobStatus(job), {}) or {}
    _safe(lambda: project.DeleteRenderJob(job))
    say(f"Audio render: {st.get('JobStatus')} in {int(time.time() - t0)}s")
    path = next((os.path.join(DESKTOP, f) for f in os.listdir(DESKTOP)
                 if f.startswith(name) and f.lower().endswith(".wav")), None)
    if not path:
        raise RuntimeError(f"Rendered WAV not found on the Desktop ({name}*.wav).")
    return path


def frame_levels(path: str, fps: float, stride: int = 8) -> List[float]:
    """RMS level (dBFS) of every video frame of the WAV, first channel."""
    with wave.open(path, "rb") as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        data = w.readframes(n)
    say(f"WAV: {rate} Hz, {ch} ch, {8 * width}-bit, {n / rate:.1f}s")
    step = ch * width
    full = float(1 << (8 * width - 1))
    per_frame = rate / fps
    levels = []
    f = 0
    while True:
        a, b = int(f * per_frame), int((f + 1) * per_frame)
        if b > n:
            break
        acc = cnt = 0
        for i in range(a, b, stride):
            o = i * step
            v = int.from_bytes(data[o:o + width], "little", signed=(width > 1))
            acc += v * v
            cnt += 1
        rms = math.sqrt(acc / cnt) if cnt else 0
        levels.append(round(20 * math.log10(rms / full), 1) if rms > 0 else -100.0)
        f += 1
    return levels


# ──────────────────────────────────────────────────────────────────────────────
# Export
# ──────────────────────────────────────────────────────────────────────────────
def do_export(r: Any, project: Any) -> None:
    mp = project.GetMediaPool()
    tls = all_timelines(project)
    if VIDEO not in tls:
        raise RuntimeError(f"No timeline named {VIDEO}")
    pieces = multicam_pieces(tls[VIDEO])
    if not pieces:
        raise RuntimeError(f"{VIDEO} has no multicam pieces on V1")
    mc = pieces[0]["mc"]
    fps = float(mc.GetClipProperty("FPS") or project.GetSetting("timelineFrameRate"))
    mc_start = tc_to_frames(mc.GetClipProperty("Start TC"), fps)
    mc_frames = int(str(mc.GetClipProperty("Frames")))
    pad = int(PAD_S * fps)
    a = max(0, min(p["src_in"] for p in pieces) - pad)
    b = min(mc_frames, max(p["src_out"] for p in pieces) + pad)
    angles = sorted({angle_of(p["name"]) for p in pieces})
    say(f"Found {VIDEO}: {len(pieces)} piece(s). (Resolve's console may only show output when the script ends.)")
    say(f"{VIDEO}: multicam '{mc.GetName()}' @ {fps}, raw section {frames_to_clock(a, fps)}–"
        f"{frames_to_clock(b, fps)} of the day ({(b - a) / fps:.0f}s); angles seen: {angles}")

    say("\n== Transcript ==")
    tr = _safe(lambda: mc.GetTranscription())
    if not (tr and tr.get("segments")):
        say("No transcript on this multicam yet — transcribing the whole day once…")
        if mc.TranscribeAudio() is not True:
            raise RuntimeError("TranscribeAudio failed")
        t0 = time.time()
        while time.time() - t0 < 3 * 3600:
            st = _safe(lambda: project.GetTranscribeAudioStatus(), {}) or {}
            if st.get("JobStatus") in ("Complete", "Cancelled") or \
                    (st.get("JobStatus") in ("Inactive", None) and time.time() - t0 > 15):
                break
            say(f"  {int(time.time() - t0)}s: {st.get('JobStatus')} {st.get('CompletionPercentage', '')}%")
            time.sleep(10)
        tr = mc.GetTranscription()
    words = []
    for seg in tr.get("segments") or []:
        for w in seg.get("words") or []:
            s = tc_to_frames(w["start"], fps) - mc_start
            e = tc_to_frames(w["end"], fps) - mc_start
            if a <= s < b:
                words.append({"t": w.get("text", "").strip(), "s": s, "e": e})
    spoken = [w for w in words if w["t"] != SILENCE]
    say(f"{len(spoken)} word(s) in the section: {' '.join(w['t'] for w in spoken[:30])} …")

    say("\n== Audio levels ==")
    tl_bin = find_folder(mp.GetRootFolder(), TIMELINE_BIN)
    if tl_bin:
        mp.SetCurrentFolder(tl_bin)
    raw_name = unique_name(project, f"__SPIKE_raw_{VIDEO}")
    raw = mp.CreateTimelineFromClips(raw_name, [{"mediaPoolItem": mc, "startFrame": a, "endFrame": b}])
    if not raw:
        raise RuntimeError("Couldn't create the raw section timeline.")
    wav = render_audio(r, project, raw, f"auto_cut_{VIDEO}_audio")
    levels = frame_levels(wav, fps)
    say(f"{len(levels)} frame level(s) (expected {b - a}); quietest {min(levels)} dB, "
        f"median {sorted(levels)[len(levels) // 2]} dB")

    with open(EXPORT_PATH, "w", encoding="utf-8") as fh:
        json.dump({"video": VIDEO, "multicam": mc.GetName(), "fps": fps, "mc_start_tc": mc.GetClipProperty("Start TC"),
                   "section": [a, b], "angles": angles, "words": words,
                   "levels": {"start": a, "db": levels}}, fh, ensure_ascii=False)
    say(f"\nSaved {EXPORT_PATH} — send it over for the cut plan.")


# ──────────────────────────────────────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────────────────────────────────────
def snap(f: int, levels: Dict[str, Any], lo: int, hi: int) -> int:
    """Quietest frame within ±SNAP_FRAMES of f (3-frame smoothing), kept inside [lo, hi]."""
    db, base = levels["db"], levels["start"]

    def level(x: int) -> float:
        vals = [db[i - base] for i in (x - 1, x, x + 1) if 0 <= i - base < len(db)]
        return sum(vals) / len(vals) if vals else 0.0
    cands = range(max(lo, f - SNAP_FRAMES), min(hi, f + SNAP_FRAMES) + 1)
    return min(cands, key=lambda x: (level(x), abs(x - f))) if cands else f


def do_build(r: Any, project: Any) -> None:
    mp = project.GetMediaPool()
    with open(EXPORT_PATH, encoding="utf-8") as fh:
        exp = json.load(fh)
    plan_path = next((p for p in PLAN_PATHS if os.path.exists(p)), None)
    if not plan_path:
        raise RuntimeError(f"No plan found at {PLAN_PATHS} — git pull first.")
    with open(plan_path, encoding="utf-8") as fh:
        plan = json.load(fh)
    fps, levels = exp["fps"], exp["levels"]
    pieces = plan["pieces"]
    say(f"Plan {plan_path}: {len(pieces)} piece(s)")

    # ── Snap cut points to quiet ──────────────────────────────────────────────
    say("\n== 1. Snap cuts to the quietest nearby frame ==")
    for i, p in enumerate(pieces):
        p["in0"], p["out0"] = p["in"], p["out"]
    for i in range(len(pieces) - 1):
        cur, nxt = pieces[i], pieces[i + 1]
        if cur["out"] == nxt["in"]:                       # angle switch, picture continues
            f = snap(cur["out"], levels, cur["in"] + 1, nxt["out"] - 1)
            cur["out"] = nxt["in"] = f
        else:                                             # removal: snap both edges
            cur["out"] = snap(cur["out"], levels, cur["in"] + 1, nxt["in"])
            nxt["in"] = snap(nxt["in"], levels, cur["out"], nxt["out"] - 1)
    pieces[0]["in"] = snap(pieces[0]["in"], levels, levels["start"], pieces[0]["out"] - 1)
    pieces[-1]["out"] = snap(pieces[-1]["out"], levels, pieces[-1]["in"] + 1,
                             levels["start"] + len(levels["db"]))
    moves = [abs(p["in"] - p["in0"]) for p in pieces] + [abs(p["out"] - p["out0"]) for p in pieces]
    say(f"Snapping moved cut edges by: max {max(moves)} fr, avg {sum(moves) / len(moves):.1f} fr")

    # ── Build ─────────────────────────────────────────────────────────────────
    say("\n== 2. Build ==")
    mc = next((c for _, c in _walk(mp.GetRootFolder())
               if _safe(lambda: c.GetName()) == exp["multicam"]
               and "multicam" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower()), None)
    if mc is None:
        raise RuntimeError(f"Multicam '{exp['multicam']}' not found in the media pool.")
    tl_bin = find_folder(mp.GetRootFolder(), TIMELINE_BIN)
    if tl_bin:
        mp.SetCurrentFolder(tl_bin)
    name = unique_name(project, f"__SPIKE_auto_{VIDEO}")
    tl = mp.CreateEmptyTimeline(name)
    project.SetCurrentTimeline(tl)
    _safe(lambda: r.OpenPage("edit"))
    appended = mp.AppendToTimeline([{"mediaPoolItem": mc, "startFrame": p["in"], "endFrame": p["out"]}
                                    for p in pieces]) or []
    items = [p for p in multicam_pieces(tl)]
    say(f"{name}: {len(appended)} appended, {len(items)} video piece(s), "
        f"{sum(p['out'] - p['in'] for p in pieces) / fps:.1f}s long")

    # ── Force angles ──────────────────────────────────────────────────────────
    say("\n== 3. Angles ==")
    for p, it in zip(pieces, items):
        if angle_of(it["name"]) == p["angle"]:
            continue
        base = {"analysisMode": r.SMART_SWITCH_ANALYSIS_MODE_NONE, "isAutoDetectWideAngle": False,
                "wideAngleID": p["angle"], "wideAngleFrequency": r.SMART_SWITCH_WIDE_ANGLE_FREQ_HIGH,
                "isUseWideAngleForIntroOutro": True, "isUseWideAngleForSilence": True,
                "minEditDuration": 10.0}
        ok = False
        for extra in ({"switchOnVideoOnly": True}, {}, {}):   # video-only first, then plain (+retry)
            ok = _safe(lambda: it["item"].PerformMulticamSmartSwitch({**base, **extra}), False)
            if ok:
                p["video_only"] = bool(extra)
                break
    items = multicam_pieces(tl)
    hits = sum(1 for p, it in zip(pieces, items) if angle_of(it["name"]) == p["angle"])
    say(f"{hits}/{len(pieces)} piece(s) on the planned angle; video pieces now {len(items)}")
    for p, it in zip(pieces, items):
        if angle_of(it["name"]) != p["angle"]:
            say(f"  ✗ {frames_to_clock(it['start'] - items[0]['start'], fps)} wanted {p['angle']}, got {angle_of(it['name'])}")
    audio_names = [str(_safe(lambda: a.GetName(), "")) for a in
                   (_safe(lambda: tl.GetItemListInTrack("audio", 1), []) or [])]
    say(f"Audio track 1 pieces: {len(audio_names)}; angles their names show: "
        f"{sorted({angle_of(n) for n in audio_names})} (should stay one source if audio didn't follow the picture)")

    # ── Crossfades ────────────────────────────────────────────────────────────
    say("\n== 4. 2-frame audio crossfades ==")
    for t in range(1, int(tl.GetTrackCount("audio") or 0) + 1):
        aitems = sorted(_safe(lambda: tl.GetItemListInTrack("audio", t), []) or [], key=lambda x: x.GetStart())
        done = sum(1 for x in aitems[:-1] if _safe(lambda: x.AddTransition(CROSSFADE)))
        say(f"  A{t}: {done}/{max(0, len(aitems) - 1)} crossfade(s) added")

    # ── Compare with the finished edit ────────────────────────────────────────
    say(f"\n== 5. Compared with the finished '{VIDEO}' ==")
    ref = multicam_pieces(all_timelines(project)[VIDEO])
    ref_cuts = [p["src_out"] for p in ref[:-1]]
    our_cuts = [p["out"] for p in pieces[:-1]]
    near = sum(1 for c in our_cuts if any(abs(c - x) <= int(fps) for x in ref_cuts))
    say(f"Length: ours {sum(p['out'] - p['in'] for p in pieces) / fps:.1f}s vs finished "
        f"{(ref[-1]['end'] - ref[0]['start']) / fps:.1f}s")
    say(f"Cuts: ours {len(our_cuts)}, finished {len(ref_cuts)}; {near} of ours within 1 s of one of Jordan's")
    kept_ref = set()
    for p in ref:
        kept_ref.update(range(p["src_in"], p["src_out"]))
    kept_ours = set()
    for p in pieces:
        kept_ours.update(range(p["in"], p["out"]))
    lo, hi = min(kept_ref), max(kept_ref)
    span = set(range(lo, hi))
    removed_ref, removed_ours = span - kept_ref, span - kept_ours
    if removed_ref:
        say(f"Within the finished section, Jordan removed {len(removed_ref) / fps:.1f}s; we removed "
            f"{len(removed_ours) / fps:.1f}s; overlap {len(removed_ref & removed_ours) / fps:.1f}s "
            f"({100 * len(removed_ref & removed_ours) / len(removed_ref):.0f}% of his removals)")
    say(f"\nNow watch {name} next to {VIDEO}.")


def _walk(folder: Any):
    for clip in _safe(lambda: folder.GetClipList(), []) or []:
        yield folder, clip
    for sub in _safe(lambda: folder.GetSubFolderList(), []) or []:
        yield from _walk(sub)


def main() -> None:
    r = get_resolve()
    project = r.GetProjectManager().GetCurrentProject()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — {MODE} {VIDEO}")
    if getattr(r, "SMART_SWITCH_ANALYSIS_MODE_NONE", None) is None:
        raise RuntimeError("Needs Resolve 21.1+.")
    if MODE == "export":
        do_export(r, project)
    elif MODE == "build":
        do_build(r, project)
    else:
        raise RuntimeError(f"MODE must be 'export' or 'build', not {MODE!r}")


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(REPORT_PATH, "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
        print(f"\nReport saved to {REPORT_PATH}")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
