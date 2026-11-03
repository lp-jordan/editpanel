#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE — Collect a raw-vs-finished example for the style guide (read-only on the edit).

For each finished timeline in TIMELINES it:
  1. Reads the edit: every multicam piece on V1 (source in/out, angle), and every
     multicam audio item on every audio track (source in/out, enabled or disabled,
     channel mapping). Other items (graphics, b-roll, music) are only counted.
  2. Finds the raw section of the day multicam the edit was cut from (+ PAD_S).
  3–4. One speaker: builds `__SPIKE_raw_<timeline>_<n>` and renders its sound.
     Two or more speakers, in TWO runs of the same line:
       run 1 builds `__SPIKE_mics_<timeline>` (raw picture + one audio track per speaker,
             named by role) and stops — set each track to that person's mic by hand;
       run 2 renders one audio-only WAV per track.
     Each WAV's level is measured on every frame.
  5. Adds Resolve's transcript of that section (transcribes the multicam once if needed).
  6. Saves Desktop\\collect_<timeline>_export.json (+ the WAVs) — copy them to the Mac.
     They hold client speech: keep them out of git.

The finished timelines are never changed.

HOW TO RUN (Windows Resolve machine, project open, after `git pull`):
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_collect_example.py", encoding="utf-8").read())
That runs every timeline in PROFILES found in the open project. For another project,
give the facts in the run line instead. TIMELINE can be one name, a list, or "*"
(lists every finished multicam timeline, or only those in BIN="A / B"; add GO=True to
collect them all), e.g.:
    TIMELINE="Ep 12 Final"; SPEAKERS=2; ROLES={"host":"host","guest":"guest"}; ANGLES={1:"wide",2:"CU guest",3:"CU host"}; RETAKES=False; AUDIENCE=False; NOTES="..."; exec(open(...).read())
Or skip the finished edit entirely and give the multicam timecodes (TIMELINE is then just a label):
    TIMELINE="Convo test"; MULTICAM="DAY_MC"; SECTION=("14:02:10:00","14:21:40:00"); SPEAKERS=2; ...
Two or more speakers (or one speaker whose mic isn't the multicam's default sound):
run the same line twice, setting each speaker's track by hand in between.
Report saved to Desktop\\collect_report.txt.
"""

import json
import math
import os
import time
import wave
from typing import Any, Dict, List, Optional

# ──────────────────────────────────────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────────────────────────────────────
PAD_S = 3                            # seconds of raw kept either side of the edit
TIMELINE_BIN = "SEQUENCES"           # optional; falls back to the current bin
RESOLVE_TRANSCRIPT = True            # also save Resolve's words (fast; WhisperX runs on the Mac)
DESKTOP = os.path.expanduser("~/Desktop")

# Facts per finished timeline (Jordan, 2026-11-03). MICS = the audio track number in the
# finished timeline, or the multicam sound angle ("Camera 2"), that carries that person's mic. Speakers are named by role, not by name.
PROFILES: Dict[str, Dict[str, Any]] = {
    "Aug Solo Episode": {
        "speakers": 1, "roles": {"host": "host"}, "mics": {"host": 1},
        "angles": {1: "wide", 2: "punch-in (from 1)", 3: "side", 4: "slider"},
        "retakes": True, "audience": False,
        "notes": "Mostly retakes and flubs, some tangent trimming. Graphics on V2 (ignore).",
    },
    "CedricConvo": {
        "speakers": 2, "roles": {"host": "host", "guest": "guest"}, "mics": {"host": "Camera 2", "guest": "Camera 3"},   # sound angle (run 3: edit A1 = Camera 2 sound, A2 = Camera 3)
        "angles": {1: "wide two-shot", 2: "CU guest", 3: "CU host", 4: "slider (on guest)"},
        "retakes": False, "audience": False,
        "notes": "Free-flowing conversation, still edited. Both mic tracks used; sections of each "
                 "disabled where that person isn't talking (bleed). Short b-roll on V2 (ignore).",
    },
}
COMMON = {"audio_fix_in_multicam": "yes (5 frames, done inside the multicam)"}

if "TIMELINE" in globals():           # facts given in the run line
    _facts = {
        "speakers": globals().get("SPEAKERS"), "roles": globals().get("ROLES", {}),
        "mics": globals().get("MICS", {}), "angles": globals().get("ANGLES", {}),
        "retakes": globals().get("RETAKES"), "audience": globals().get("AUDIENCE"),
        "notes": globals().get("NOTES", ""),
    }
    if globals().get("SECTION"):          # SECTION=("HH:MM:SS:FF","HH:MM:SS:FF"), MULTICAM="name"
        _facts.update({"section": list(globals()["SECTION"]), "multicam": globals().get("MULTICAM")})
    _tl = globals()["TIMELINE"]          # a name, a list of names, or "*" = every finished edit
    PROFILES = {n: dict(_facts) for n in ([_tl] if isinstance(_tl, str) else list(_tl))}

BIN_SEP = " / "
SILENCE = "(...)"
_lines: List[str] = []
_T0 = time.time()
BLIND = bool(globals().get("BLIND"))   # blind test: the edit goes to a separate KEY file, never in the report


def say(msg: str = "") -> None:
    if msg.startswith("\n== "):                      # stamp each step with elapsed time
        msg = f"{msg}  [{time.time() - _T0:.1f}s]"
    print(msg)
    _lines.append(msg)


def edit_say(msg: str = "") -> None:
    """Report lines that describe the finished edit — left out of a blind run."""
    if not BLIND:
        say(msg)


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
    segs = [s.strip() for s in path.split(BIN_SEP) if s.strip()]
    if segs and segs[0].lower() == str(_safe(lambda: root.GetName(), "")).lower():
        segs = segs[1:]                                # "MASTER / ..." = the root bin itself
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


def is_multicam(it: Any, item: bool = True) -> Optional[Any]:
    mpi = _safe(lambda: it.GetMediaPoolItem()) if item else it
    if mpi and "multicam" in str(_safe(lambda: mpi.GetClipProperty("Type"), "")).lower():
        return mpi
    return None


def angle_of(name: str) -> str:
    return name.rsplit(" - ", 1)[-1] if " - " in name else "?"


def safe_name(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in s)


# ──────────────────────────────────────────────────────────────────────────────
# Audio
# ──────────────────────────────────────────────────────────────────────────────
def render_audio(project: Any, tl: Any, name: str) -> str:
    """Audio-only WAV render of `tl` to the Desktop (same settings as spike_auto_rough_cut)."""
    project.SetCurrentTimeline(tl)
    fmts = _safe(lambda: project.GetAudioRenderFormats(), {}) or {}
    ext = next((e for f, e in fmts.items() if "wav" in f"{f} {e}".lower()), "wav")
    codecs = _safe(lambda: project.GetAudioRenderCodecs(ext), {}) or {}
    codec = next((c for d, c in codecs.items() if "pcm" in f"{d} {c}".lower()), next(iter(codecs.values()), None))
    settings = {"SelectAllFrames": True, "TargetDir": DESKTOP, "CustomName": name,
                "ExportVideo": False, "ExportAudio": True, "AudioFormat": ext,
                "AudioBitDepth": 16, "AudioSampleRate": 48000}
    if codec:
        settings["AudioCodec"] = codec
    if not project.SetRenderSettings(settings):
        raise RuntimeError("Audio-only WAV render settings were rejected.")
    for f in os.listdir(DESKTOP):          # never measure a stale file from an earlier run
        if f.startswith(name) and f.lower().endswith(".wav"):
            _safe(lambda: os.remove(os.path.join(DESKTOP, f)))
    job = project.AddRenderJob()
    if not job:
        raise RuntimeError("AddRenderJob failed.")
    project.StartRendering(job)
    t0 = time.time()
    while not _safe(lambda: project.IsRenderingInProgress(), False) and time.time() - t0 < 10:
        time.sleep(0.5)
    while _safe(lambda: project.IsRenderingInProgress(), False) and time.time() - t0 < 3600:
        time.sleep(1)
    st = _safe(lambda: project.GetRenderJobStatus(job), {}) or {}
    _safe(lambda: project.DeleteRenderJob(job))
    path = next((os.path.join(DESKTOP, f) for f in os.listdir(DESKTOP)
                 if f.startswith(name) and f.lower().endswith(".wav")), None)
    say(f"  {name}: {st.get('JobStatus')} in {int(time.time() - t0)}s → {path}")
    if not path:
        raise RuntimeError(f"Rendered WAV not found on the Desktop ({name}*.wav).")
    return path


def frame_levels(path: str, fps: float, stride: int = 8) -> List[float]:
    """RMS level (dBFS) of every video frame of the WAV, first channel."""
    with wave.open(path, "rb") as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        data = w.readframes(n)
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


def one_track_mapping(raw_json: Optional[str]) -> Optional[str]:
    """SetSourceAudioChannelMapping takes exactly one track in 'track_mapping'."""
    m = _safe(lambda: json.loads(raw_json)) if raw_json else None
    tm = (m or {}).get("track_mapping") or {}
    if not tm:
        return None
    k = sorted(tm, key=lambda x: int(x) if str(x).isdigit() else 0)[0]
    return json.dumps({"track_mapping": {k: tm[k]}})


# ──────────────────────────────────────────────────────────────────────────────
# Collect one timeline
# ──────────────────────────────────────────────────────────────────────────────
def collect(r: Any, project: Any, tl_name: str, profile: Dict[str, Any]) -> None:
    mp = project.GetMediaPool()
    if profile.get("section"):
        # Section given as multicam timecodes: the finished edit is never read.
        mc = next((c for c in _walk(mp.GetRootFolder())
                   if is_multicam(c, item=False) and _safe(lambda: c.GetName()) == profile.get("multicam")), None)
        if mc is None:
            raise RuntimeError(f"No multicam named {profile.get('multicam')!r} in the media pool")
        fps = float(mc.GetClipProperty("FPS") or project.GetSetting("timelineFrameRate"))
        mc_start = tc_to_frames(mc.GetClipProperty("Start TC"), fps)
        mc_frames = int(str(mc.GetClipProperty("Frames")))
        a = max(0, tc_to_frames(profile["section"][0], fps) - mc_start)
        b = min(mc_frames, tc_to_frames(profile["section"][1], fps) - mc_start)
        if b <= a:
            raise RuntimeError(f"Section {profile['section']} is outside multicam {mc.GetName()!r} "
                               f"(starts {mc.GetClipProperty('Start TC')})")
        video, audio, ignored = [], {}, {}
        say(f"\n== {tl_name}: section {profile['section'][0]}–{profile['section'][1]} of '{mc.GetName()}' ==")
        say(f"Raw section {frames_to_clock(a, fps)}–{frames_to_clock(b, fps)} of the day ({(b - a) / fps:.0f}s raw)")
    else:
        tl = all_timelines(project).get(tl_name)
        if tl is None:
            raise RuntimeError(f"No timeline named {tl_name!r}")
        t_start = int(tl.GetStartFrame())

        say(f"\n== {tl_name}: the edit ==")
        video, ignored = [], {}
        for t in range(1, int(tl.GetTrackCount("video") or 0) + 1):
            for it in _safe(lambda: tl.GetItemListInTrack("video", t), []) or []:
                if t == 1 and is_multicam(it):
                    name = str(_safe(lambda: it.GetName(), ""))
                    video.append({"rec_in": int(it.GetStart()) - t_start, "rec_out": int(it.GetEnd()) - t_start,
                                  "src_in": int(round(float(it.GetSourceStartFrame()))),
                                  "src_out": int(round(float(it.GetSourceEndFrame()))),
                                  "angle": angle_of(name), "enabled": bool(_safe(lambda: it.GetClipEnabled(), True))})
                else:
                    ignored[f"V{t}"] = ignored.get(f"V{t}", 0) + 1
        video.sort(key=lambda p: p["rec_in"])
        if not video:
            raise RuntimeError(f"{tl_name} has no multicam pieces on V1")
        mc = next(m for m in (is_multicam(i) for i in tl.GetItemListInTrack("video", 1)) if m)
        fps = float(mc.GetClipProperty("FPS") or project.GetSetting("timelineFrameRate"))
        mc_start = tc_to_frames(mc.GetClipProperty("Start TC"), fps)
        mc_frames = int(str(mc.GetClipProperty("Frames")))
        angles: Dict[str, int] = {}
        for p in video:
            angles[p["angle"]] = angles.get(p["angle"], 0) + 1
        edit_say(f"Video: {len(video)} multicam piece(s) on V1, angles {angles}; multicam '{mc.GetName()}' @ {fps}")

        audio: Dict[int, Dict[str, Any]] = {}
        for t in range(1, int(tl.GetTrackCount("audio") or 0) + 1):
            items, mappings, mangles = [], {}, {}
            for it in _safe(lambda: tl.GetItemListInTrack("audio", t), []) or []:
                if not is_multicam(it):
                    ignored[f"A{t}"] = ignored.get(f"A{t}", 0) + 1
                    continue
                mapping = _safe(lambda: it.GetSourceAudioChannelMapping())
                if mapping:
                    mappings[mapping] = mappings.get(mapping, 0) + 1
                ang = angle_of(str(_safe(lambda: it.GetName(), "")))   # the multicam audio angle in use
                mangles[ang] = mangles.get(ang, 0) + 1
                items.append({"rec_in": int(it.GetStart()) - t_start, "rec_out": int(it.GetEnd()) - t_start,
                              "src_in": int(round(float(it.GetSourceStartFrame()))),
                              "src_out": int(round(float(it.GetSourceEndFrame()))),
                              "angle": ang, "enabled": bool(_safe(lambda: it.GetClipEnabled(), True))})
            if not items:
                continue
            items.sort(key=lambda x: x["rec_in"])
            main_map = max(mappings, key=mappings.get) if mappings else None
            audio[t] = {"subtype": _safe(lambda: tl.GetTrackSubType("audio", t)),
                        "track_enabled": bool(_safe(lambda: tl.GetIsTrackEnabled("audio", t), True)),
                        "angle": max(mangles, key=mangles.get), "angles": mangles,
                        "mapping": main_map, "distinct_mappings": len(mappings), "items": items}
            off = sum(1 for x in items if not x["enabled"])
            edit_say(f"A{t} ({audio[t]['subtype']}): {len(items)} multicam audio item(s), {off} disabled; "
                f"audio angle(s) {mangles}; "
                f"{len(mappings)} channel mapping(s); track {'on' if audio[t]['track_enabled'] else 'OFF'}")
            if main_map:
                edit_say(f"  mapping: {main_map}")
        if ignored:
            edit_say(f"Ignored (not multicam): {ignored}")
        for who, t in (profile.get("mics") or {}).items():
            found = (t in audio) if isinstance(t, int) else any(x["angle"] == t for x in audio.values())
            if not found:
                say(f"⚠ {who}'s mic ({t}) isn't used by any multicam audio in the edit — check the report above")

        pad = int(PAD_S * fps)
        srcs = [p["src_in"] for p in video] + [x["src_in"] for a in audio.values() for x in a["items"]]
        ends = [p["src_out"] for p in video] + [x["src_out"] for a in audio.values() for x in a["items"]]
        a, b = max(0, min(srcs) - pad), min(mc_frames, max(ends) + pad)
        kept = sum(p["src_out"] - p["src_in"] for p in video)
        say(f"Raw section {frames_to_clock(a, fps)}–{frames_to_clock(b, fps)} of the day ({(b - a) / fps:.0f}s raw)")
        edit_say(f"  → {kept / fps:.0f}s finished")

    # ── Raw audio, one file per speaker ───────────────────────────────────────
    # Multi-speaker: two runs. Run 1 builds `__SPIKE_mics_<tl>` (raw picture + one audio
    # track per speaker, named by role) and stops; Jordan sets each track to that person's
    # mic by hand (angle, channels — however the edit did it). Run 2 renders each track
    # from its own copy of that timeline with the other tracks' clips deleted.
    # (Runs 3–4: the ATEM camera files all carry the same audio, so picking a mic
    # automatically from the edit's audio angles didn't work.)
    tl_bin = find_folder(mp.GetRootFolder(), TIMELINE_BIN)
    if tl_bin:
        mp.SetCurrentFolder(tl_bin)
    roles = list((profile.get("roles") or {}).keys()) or \
        [f"speaker{i}" for i in range(1, int(profile.get("speakers") or 1) + 1)]
    mics_name = f"__SPIKE_mics_{safe_name(tl_name)}"
    mics = all_timelines(project).get(mics_name)
    levels: Dict[str, List[float]] = {}
    wavs: Dict[str, str] = {}

    def build(name: str, n_tracks: int) -> Any:
        t = mp.CreateEmptyTimeline(name)
        if not t:
            raise RuntimeError(f"Couldn't create {name}.")
        project.SetCurrentTimeline(t)
        rec0 = int(t.GetStartFrame())
        if not mp.AppendToTimeline([{"mediaPoolItem": mc, "startFrame": a, "endFrame": b,
                                     "mediaType": 1, "trackIndex": 1, "recordFrame": rec0}]):
            raise RuntimeError("Couldn't place the raw picture.")
        for k in range(1, n_tracks + 1):
            while int(t.GetTrackCount("audio") or 0) < k:
                t.AddTrack("audio", "stereo")
            if not mp.AppendToTimeline([{"mediaPoolItem": mc, "startFrame": a, "endFrame": b,
                                         "mediaType": 2, "trackIndex": k, "recordFrame": rec0}]):
                raise RuntimeError(f"Couldn't place the raw audio on A{k}.")
        return t

    def measure(key: str, wav: str) -> None:
        lv = frame_levels(wav, fps)
        levels[key], wavs[key] = lv, os.path.basename(wav)
        say(f"  {key}: {len(lv)} frame level(s) (expected {b - a}); quietest {min(lv)} dB, "
            f"median {sorted(lv)[len(lv) // 2]} dB")

    solo_raw = None
    if len(roles) == 1 and mics is None:
        # One speaker is automatic only when the edit used the multicam's default sound;
        # otherwise it falls back to the by-hand mic setup below.
        solo_raw = build(unique_name(project, f"__SPIKE_raw_{safe_name(tl_name)}"), 1)
        default = angle_of(str(_safe(lambda: solo_raw.GetItemListInTrack("audio", 1)[0].GetName(), "")))
        edit_snd = next((audio[t]["angle"] for t in sorted(audio)), default)
        if edit_snd != default:
            say(f"The edit's sound is {edit_snd}, not the multicam default ({default}) — set the mic by hand")
            _safe(lambda: mp.DeleteTimelines([solo_raw]))
            solo_raw = None
    if solo_raw is not None:
        say(f"\n== {tl_name}: raw audio (one speaker) ==")
        raw = solo_raw
        want = one_track_mapping(next((audio[t]["mapping"] for t in sorted(audio)), None))
        if want:
            item = (raw.GetItemListInTrack("audio", 1) or [None])[0]
            say(f"Channel mapping copied from the edit → {_safe(lambda: item.SetSourceAudioChannelMapping(want), False)}")
        measure(roles[0], render_audio(project, raw, f"collect_{safe_name(tl_name)}_{roles[0]}"))
    elif mics is None:
        say(f"\n== {tl_name}: PART 1 — set the mics by hand ==")
        mics = build(mics_name, len(roles))
        for k, role in enumerate(roles, 1):
            mics.SetTrackName("audio", k, role)
        say(f"Built {mics_name}: raw picture + {len(roles)} audio track(s): "
            + ", ".join(f"A{k} = {role}" for k, role in enumerate(roles, 1)))
        say("Now set each track so it plays ONLY that person's mic (multicam audio angle,")
        say("channels — whatever you did in the edit). Don't move or trim the clips.")
        say("Then run the same line again: part 2 renders one WAV per track.")
        return
    else:
        say(f"\n== {tl_name}: PART 2 — one WAV per speaker from {mics_name} ==")
        n = int(mics.GetTrackCount("audio") or 0)
        names = {k: (_safe(lambda: mics.GetTrackName("audio", k)) or f"A{k}") for k in range(1, n + 1)}
        for k in range(1, n + 1):
            if not (_safe(lambda: mics.GetItemListInTrack("audio", k), []) or []):
                continue
            project.SetCurrentTimeline(mics)
            dup = mics.DuplicateTimeline(unique_name(project, f"__SPIKE_render_{safe_name(tl_name)}_{names[k]}"))
            if not dup:
                raise RuntimeError("DuplicateTimeline failed.")
            for u in range(1, n + 1):                  # keep only track k's sound
                if u != k:
                    gone = _safe(lambda: dup.GetItemListInTrack("audio", u), []) or []
                    if gone:
                        dup.DeleteClips(gone)
            try:
                measure(names[k], render_audio(project, dup, f"collect_{safe_name(tl_name)}_{names[k]}"))
            finally:
                _safe(lambda: mp.DeleteTimelines([dup]))
        if len(levels) > 1:                            # the run-3/4 failure, caught again if it recurs
            ks = list(levels)
            same = sum(1 for x, y in zip(levels[ks[0]], levels[ks[1]]) if x == y)
            say(f"  {ks[0]} vs {ks[1]}: {same}/{len(levels[ks[0]])} frames identical"
                + ("  ⚠ same audio — the mics were NOT separated" if same > 0.9 * len(levels[ks[0]]) else ""))
    raw_names = {"mics": mics_name} if mics is not None else {}

    words = []
    if RESOLVE_TRANSCRIPT:
        say(f"\n== {tl_name}: Resolve transcript ==")
        tr = _safe(lambda: mc.GetTranscription())
        if not (tr and tr.get("segments")):
            say("No transcript on this multicam yet — transcribing the whole day once…")
            if mc.TranscribeAudio() is True:
                t0 = time.time()
                while time.time() - t0 < 3 * 3600:
                    st = _safe(lambda: project.GetTranscribeAudioStatus(), {}) or {}
                    if st.get("JobStatus") in ("Complete", "Cancelled") or \
                            (st.get("JobStatus") in ("Inactive", None) and time.time() - t0 > 15):
                        break
                    time.sleep(10)
                tr = _safe(lambda: mc.GetTranscription())
            else:
                say("⚠ TranscribeAudio failed — continuing without Resolve's words")
        for seg in (tr or {}).get("segments") or []:
            for w in seg.get("words") or []:
                s = tc_to_frames(w["start"], fps) - mc_start
                e = tc_to_frames(w["end"], fps) - mc_start
                if a <= s < b:
                    words.append({"t": w.get("text", "").strip(), "s": s, "e": e})
        say(f"{sum(1 for w in words if w['t'] != SILENCE)} word(s) in the raw section")

    out = os.path.join(DESKTOP, f"collect_{safe_name(tl_name)}_export.json")
    edit = {"video": video, "audio": {str(k): v for k, v in audio.items()}, "ignored": ignored}
    data = {"timeline": tl_name, "project": project.GetName(), "profile": {**COMMON, **profile},
            "multicam": mc.GetName(), "fps": fps, "mc_start_tc": mc.GetClipProperty("Start TC"),
            "section": [a, b], "raw_timelines": raw_names, "wavs": wavs,
            "levels": {"start": a, "db_by_sound": levels}, "resolve_words": words}
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data if BLIND else {**data, **edit}, fh, ensure_ascii=False)
    say(f"Saved {out}")
    if BLIND:                                          # the answer key: keep it on this machine for now
        key = os.path.join(DESKTOP, f"collect_{safe_name(tl_name)}_KEY.json")
        with open(key, "w", encoding="utf-8") as fh:
            json.dump({"timeline": tl_name, **edit}, fh, ensure_ascii=False)
        say(f"Answer key saved to {key} — DON'T send it until the cut plan is committed.")
    say(f"Copy to the Mac: {os.path.basename(out)} + {', '.join(wavs.values())}")


def main() -> None:
    r = get_resolve()
    project = r.GetProjectManager().GetCurrentProject()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}'")
    present = all_timelines(project)
    global PROFILES
    if "*" in PROFILES:                                # every timeline cut from a multicam
        facts = PROFILES.pop("*")
        found = []
        in_bin = None
        if globals().get("BIN"):                       # e.g. BIN="SEQUENCES / Finals" (and its sub-bins)
            folder = find_folder(project.GetMediaPool().GetRootFolder(), globals()["BIN"])
            if folder is None:
                raise RuntimeError(f"No bin {globals()['BIN']!r}")
            in_bin = set()
            stack = [folder]
            while stack:
                f = stack.pop()
                stack += _safe(lambda: f.GetSubFolderList(), []) or []
                for c in _safe(lambda: f.GetClipList(), []) or []:
                    if "timeline" in str(_safe(lambda: c.GetClipProperty("Type"), "")).lower():
                        in_bin.add(str(_safe(lambda: c.GetName(), "")))
        for n, t in present.items():
            if n.startswith("__SPIKE_") or (in_bin is not None and n not in in_bin):
                continue
            v1 = _safe(lambda: t.GetItemListInTrack("video", 1), []) or []
            if any(is_multicam(i) for i in v1[:5]):
                found.append((n, (int(t.GetEndFrame()) - int(t.GetStartFrame())) / float(
                    project.GetSetting("timelineFrameRate") or 24)))
        say(f"{len(found)} finished multicam timeline(s), {sum(d for _, d in found) / 60:.0f} min in all:")
        for n, d in sorted(found):
            say(f"  {n}  ({d / 60:.1f} min)")
        if not globals().get("GO"):
            say("\nNothing collected yet. Add GO=True to the run line to collect all of these "
                "(or pass TIMELINE=[...] with the ones you want).")
            return
        PROFILES.update({n: dict(facts) for n, _ in found})
    only = globals().get("ONLY")                       # e.g. ONLY=["CedricConvo"]
    todo = [n for n in PROFILES if (n in present or PROFILES[n].get("section")) and (not only or n in only)]
    missing = [n for n in PROFILES if n not in present and not PROFILES[n].get("section")]
    if missing:
        say(f"Not in this project (skipped): {missing}")
    if not todo:
        raise RuntimeError("None of the timelines to collect are in the open project.")
    _safe(lambda: r.OpenPage("edit"))
    for name in todo:
        try:
            collect(r, project, name, PROFILES[name])
        except Exception as exc:
            say(f"\n✗ {name} stopped: {exc}")


try:
    main()
    say(f"\nTotal time: {time.time() - _T0:.1f}s")
except Exception as exc:
    say(f"\n✗ STOPPED after {time.time() - _T0:.1f}s: {exc}")
finally:
    try:
        with open(os.path.join(DESKTOP, "collect_report.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
        print(f"\nReport saved to {os.path.join(DESKTOP, 'collect_report.txt')}")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
