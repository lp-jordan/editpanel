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
MODE = "auto"                       # "auto" = build if the plan + export exist, else export
VIDEO = "Z8"                        # finished timeline whose raw section we re-cut
PAD_S = 3                           # seconds of raw kept either side of that section
REPO = r"C:\lp-app-ecosystem\editpanel"
SNAP_FRAMES = 8                     # look this far either side of a planned cut for quiet
CUT_PAD = 3                         # frames of room kept after the last sound / before the next
                                    # at a removal → ~6 frames of silence across the join (Jordan)
FADE_FRAMES = 8                     # audio fade in at the start / fade out at the end
SPEECH_ABOVE_FLOOR_DB = 12          # "speech" = this much louder than the section's quiet floor
CROSSFADE = {"type": "Cross Fade 0 dB", "category": "audio",
             "position": "end", "alignment": "center", "duration": 2}
TIMELINE_BIN = "SEQUENCES"          # optional; falls back to the current bin
DESKTOP = os.path.expanduser("~/Desktop")
# "resolve" or "whisperx" (export + plan in spikes/plans/); spike_auto_rough_cut_whisperx.py
# sets TRANSCRIPT_OVERRIDE so nobody has to edit this file.
TRANSCRIPT = globals().get("TRANSCRIPT_OVERRIDE", "resolve")
_TAG = "" if TRANSCRIPT == "resolve" else f"_{TRANSCRIPT}"
# Exports hold a client's full transcript, so they stay out of git: Desktop only.
EXPORT_PATH = os.path.join(DESKTOP, f"auto_cut_{VIDEO}_export.json" if TRANSCRIPT == "resolve"
                           else f"{VIDEO}{_TAG}_export.json")
PLAN_PATHS = [os.path.join(REPO, "spikes", "plans", f"{VIDEO}{_TAG}_plan.json"),
              os.path.join(DESKTOP, f"{VIDEO}{_TAG}_plan.json")]
if MODE == "auto":
    MODE = "build" if (os.path.exists(EXPORT_PATH) and any(os.path.exists(p) for p in PLAN_PATHS)) else "export"
REPORT_PATH = os.path.join(DESKTOP, f"auto_cut_{VIDEO}{_TAG}_{MODE}.txt")

BIN_SEP = " / "
SILENCE = "(...)"
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

    # ── Place cut points from the audio ───────────────────────────────────────
    say("\n== 1. Cut points from the audio ==")
    db, base = levels["db"], levels["start"]
    floor = sorted(db)[len(db) // 10]
    thr = floor + SPEECH_ABOVE_FLOOR_DB
    say(f"Quiet floor {floor} dB → speech above {thr} dB")

    def loud(x: int) -> bool:
        return 0 <= x - base < len(db) and db[x - base] > thr

    def speech_end(x: int) -> int:
        """First quiet frame after the speech that ends near x."""
        y = x
        while loud(y) and y < x + SNAP_FRAMES:      # planned cut sat inside the tail
            y += 1
        while y > x - 2 * SNAP_FRAMES and not loud(y - 1):
            y -= 1
        return y

    def speech_start(x: int) -> int:
        """First loud frame of the speech that starts near x."""
        y = x
        while loud(y - 1) and y > x - SNAP_FRAMES:  # planned cut sat inside the onset
            y -= 1
        while y < x + 2 * SNAP_FRAMES and not loud(y):
            y += 1
        return y

    # Word edges guard the cuts only for a transcript with real word timing; Resolve's
    # stretches words over pauses (Robin Bone + Z8), which would loosen every join.
    spoken = ([] if TRANSCRIPT == "resolve"
              else [w for w in exp["words"] if w["t"] != SILENCE and w["e"] > w["s"]])
    say(f"Transcript: {TRANSCRIPT}, {len(spoken)} word(s) used as cut guards")
    for p in pieces:
        p["in0"], p["out0"] = p["in"], p["out"]
    for i in range(len(pieces) - 1):
        cur, nxt = pieces[i], pieces[i + 1]
        if cur["out"] == nxt["in"]:                       # angle switch: picture only, sound runs on
            f = snap(cur["out"], levels, cur["in"] + 1, nxt["out"] - 1)
            cur["out"] = nxt["in"] = f
        else:                                             # removal: ~CUT_PAD of room each side
            # Never inside a word: the kept side must reach past the last kept word's end
            # (and start before the first kept word), and must not reach into a removed word.
            kept_end = max([w["e"] for w in spoken if cur["in0"] <= w["s"] < cur["out0"]] or [cur["in"]])
            kept_start = min([w["s"] for w in spoken if nxt["in0"] <= w["s"] < nxt["out0"]] or [nxt["out"]])
            cut_word_after = min([w["s"] for w in spoken if kept_end <= w["s"] < nxt["in0"]] or [nxt["in"]])
            cut_word_before = max([w["e"] for w in spoken if cur["out0"] <= w["e"] <= kept_start] or [cur["out"]])
            out = max(speech_end(cur["out"]), kept_end) + CUT_PAD
            inn = min(speech_start(nxt["in"]), kept_start) - CUT_PAD
            cur["out"] = min(out, cut_word_after)
            nxt["in"] = max(inn, cut_word_before, cur["out"])
            if cur["out"] < out or nxt["in"] > inn:
                say(f"  ⚠ tight join near {frames_to_clock(cur['out'] - base, fps)}: a removed word sits "
                    f"within {CUT_PAD} fr of the kept speech — check by ear")
    head = speech_start(pieces[0]["in"])
    pieces[0]["in"] = max(base, head - CUT_PAD - FADE_FRAMES)     # fade done before the first word
    tail = speech_end(pieces[-1]["out"])
    pieces[-1]["out"] = min(base + len(db), tail + CUT_PAD + FADE_FRAMES)  # silence, then fade
    moves = [abs(p["in"] - p["in0"]) for p in pieces] + [abs(p["out"] - p["out0"]) for p in pieces]
    say(f"Cut edges moved by: max {max(moves)} fr, avg {sum(moves) / len(moves):.1f} fr")
    t = 0
    for p in pieces:                                   # where each piece sits, for ear checks
        say(f"  {frames_to_clock(t, fps):>8} {p['angle']:9} source {p['in'] - base}–{p['out'] - base} "
            f"(planned {p['in0'] - base}–{p['out0'] - base})")
        t += p["out"] - p["in"]
    for cur, nxt in zip(pieces, pieces[1:]):
        if cur["out"] != nxt["in"]:
            gap = (speech_start(nxt["in"]) - nxt["in"]) + (cur["out"] - speech_end(cur["out"]))
            say(f"  removal join: {gap} fr of silence kept across the cut")

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
    name = unique_name(project, f"__SPIKE_auto_{VIDEO}{_TAG}")
    tl = mp.CreateEmptyTimeline(name)
    project.SetCurrentTimeline(tl)
    _safe(lambda: r.OpenPage("edit"))
    # Picture and sound are placed separately (run 1: the audio followed every angle
    # switch and went silent on angles with no audio). Video: one piece per plan row.
    # Audio: one piece per KEPT RANGE — rows whose picture continues are merged, so
    # the sound is only cut where material was actually removed.
    rec0 = int(tl.GetStartFrame())
    offs, t = [], 0
    for p in pieces:
        offs.append(t)
        t += p["out"] - p["in"]
    ranges = []                                     # [src_in, src_out, record offset]
    for p, off in zip(pieces, offs):
        if ranges and ranges[-1][1] == p["in"]:
            ranges[-1][1] = p["out"]
        else:
            ranges.append([p["in"], p["out"], off])
    vids = mp.AppendToTimeline([{"mediaPoolItem": mc, "startFrame": p["in"], "endFrame": p["out"],
                                 "mediaType": 1, "trackIndex": 1, "recordFrame": rec0 + off}
                                for p, off in zip(pieces, offs)]) or []
    auds = mp.AppendToTimeline([{"mediaPoolItem": mc, "startFrame": a, "endFrame": b,
                                 "mediaType": 2, "trackIndex": 1, "recordFrame": rec0 + off}
                                for a, b, off in ranges]) or []
    items = multicam_pieces(tl)
    aitems = sorted(_safe(lambda: tl.GetItemListInTrack("audio", 1), []) or [], key=lambda x: x.GetStart())
    say(f"{name}: {len(vids)} video piece(s) (planned {len(pieces)}), {len(auds)} audio piece(s) "
        f"(planned {len(ranges)} = one per kept range), {t / fps:.1f}s long")
    starts_v = [int(it["start"]) for it in items]
    misaligned = [int(x.GetStart()) for x in aitems if int(x.GetStart()) not in starts_v]
    say(f"Audio pieces starting where no video piece starts: {misaligned or 'none'}; "
        f"timeline ends — video {items[-1]['end'] if items else '?'}, audio {int(aitems[-1].GetEnd()) if aitems else '?'}")

    # ── Force angles (video only) ─────────────────────────────────────────────
    say("\n== 3. Angles ==")
    for p, it in zip(pieces, items):
        if angle_of(it["name"]) == p["angle"]:
            continue
        base = {"analysisMode": r.SMART_SWITCH_ANALYSIS_MODE_NONE, "isAutoDetectWideAngle": False,
                "wideAngleID": p["angle"], "wideAngleFrequency": r.SMART_SWITCH_WIDE_ANGLE_FREQ_HIGH,
                "isUseWideAngleForIntroOutro": True, "isUseWideAngleForSilence": True,
                "minEditDuration": 10.0}
        for extra in ({"switchOnVideoOnly": True}, {}, {}):   # video-only first, then plain (+retry)
            if _safe(lambda: it["item"].PerformMulticamSmartSwitch({**base, **extra}), False):
                p["video_only"] = bool(extra)
                break
    items = multicam_pieces(tl)
    hits = sum(1 for p, it in zip(pieces, items) if angle_of(it["name"]) == p["angle"])
    say(f"{hits}/{len(pieces)} piece(s) on the planned angle; video pieces now {len(items)}; "
        f"switched with video-only mode: {sum(1 for p in pieces if p.get('video_only'))}")
    for p, it in zip(pieces, items):
        if angle_of(it["name"]) != p["angle"]:
            say(f"  ✗ {frames_to_clock(it['start'] - items[0]['start'], fps)} wanted {p['angle']}, got {angle_of(it['name'])}")
    aitems = sorted(_safe(lambda: tl.GetItemListInTrack("audio", 1), []) or [], key=lambda x: x.GetStart())
    say(f"Audio after angle switching: {len(aitems)} piece(s) (should still be {len(ranges)}), angles: "
        f"{sorted({angle_of(str(_safe(lambda: x.GetName(), ''))) for x in aitems})} (should be the angle carrying sound)")

    # ── Crossfades: only where audio was actually cut ─────────────────────────
    say("\n== 4. 2-frame audio crossfades (removal cuts only) ==")
    done = sum(1 for x in aitems[:-1] if _safe(lambda: x.AddTransition(CROSSFADE)))
    say(f"  A1: {done}/{max(0, len(aitems) - 1)} crossfade(s) added")
    if aitems:
        fade_in = _safe(lambda: aitems[0].AddTransition({**CROSSFADE, "position": "start",
                                                         "alignment": "right", "duration": FADE_FRAMES}))
        fade_out = _safe(lambda: aitems[-1].AddTransition({**CROSSFADE, "position": "end",
                                                           "alignment": "left", "duration": FADE_FRAMES}))
        say(f"  {FADE_FRAMES}-frame fade in: {'ok' if fade_in else 'FAILED'}; fade out: {'ok' if fade_out else 'FAILED'}")
    vitems = sorted(_safe(lambda: tl.GetItemListInTrack("video", 1), []) or [], key=lambda x: x.GetStart())
    if vitems:
        def dissolve(item, edge, align):
            for cat in ("simple", None):              # category name for built-in video transitions
                opts = {"type": "Cross Dissolve", "position": edge, "alignment": align, "duration": FADE_FRAMES}
                if cat:
                    opts["category"] = cat
                if _safe(lambda: item.AddTransition(opts)):
                    return f"ok ({cat or 'no category'})"
            return "FAILED"
        say(f"  {FADE_FRAMES}-frame picture Cross Dissolve from black: {dissolve(vitems[0], 'start', 'right')}; "
            f"to black: {dissolve(vitems[-1], 'end', 'left')}")

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
