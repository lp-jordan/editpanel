#!/usr/bin/env python3
"""
SPIKE — Step 2 of the all-in-one test: transcribe the day's person mics on LP1's GPU.

Reads Desktop\\day_<LABEL>.json (written by spike_day_prep.py in Resolve), transcribes every mic
WAV over the stretch it covers in the multicam with faster-whisper large-v3 (WhisperX's engine)
on the NVIDIA GPU, puts every word on the multicam's frame grid, and decides who said it: each
mic hears the other person faintly, so a word belongs to the mic where it's loudest.
Writes (client words — Desktop only, never into git):
  Desktop\\words_<LABEL>.json  — every word: mic angle, multicam start/end frame, probability,
                                level on its own mic and on the loudest other mic, own=True/False
  Desktop\\transcript_<LABEL>.txt — readable turns: [frame | mm:ss] ANGLE: text
  Desktop\\transcribe_<LABEL>.txt — timings only
Send all three (plus day_<LABEL>.json) back to the Mac.

Uses the C:\\wxbench environment from bench_whisper.py (already set up on LP1).
Run (normal Command Prompt):
    C:\\wxbench\\Scripts\\python C:\\lp-app-ecosystem\\editpanel\\spikes\\transcribe_day.py Convo2
Quick test first (first 3 minutes of each mic): add  minutes=3
Days without mic WAVs: the day file lists one angle's camera clips instead (ATEM mix or in-camera
audio); those are decoded with PyAV or ffmpeg (first audio track) and every source on one angle becomes one
track on the multicam clock.
"""
import glob
import json
import math
import os
import sys
import time
import wave

import numpy as np

DESKTOP = os.path.expanduser("~/Desktop")
SR = 16000
OWN_MARGIN_DB = 3.0          # "clear" = its mic is this much louder than any other mic ("own" = just louder)
TURN_GAP_SEC = 1.0           # a new transcript line when the speaker changes or after this pause


def cuda_dlls() -> None:
    if os.name != "nt":
        return
    for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(d)
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def read_wav(path: str) -> np.ndarray:
    """Whole PCM WAV → 16 kHz mono float32 (no PyAV)."""
    with wave.open(path, "rb") as w:
        rate, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if width == 3:
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
        x = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        x = np.where(x >= 1 << 23, x - (1 << 24), x).astype(np.float32) / (1 << 23)
    else:
        dt = {1: np.uint8, 2: np.int16, 4: np.int32}[width]
        x = np.frombuffer(raw, dt).astype(np.float32)
        x = (x - 128) / 128 if width == 1 else x / float(1 << (8 * width - 1))
    x = x.reshape(-1, ch).mean(axis=1)
    if rate != SR:
        m = int(len(x) * SR / rate)
        x = np.interp(np.linspace(0, len(x) - 1, m), np.arange(len(x)), x).astype(np.float32)
    return x


def read_progress(tag: str, pct: int, mb: float, final: bool = False) -> None:
    """`  reading 1/3 CAM1_01.mov  45%  812 MB` — EditPanel's Cut-through page parses this."""
    print(f"\r  reading {tag} {min(100, pct):3d}%  {mb:.0f} MB", end="\n" if final else "", flush=True)


def decode_av(path: str, until: float = None, tag: str = "") -> np.ndarray:
    """First audio track → 16 kHz mono via PyAV, called directly: faster-whisper's own
    decode_audio passes av.open(metadata_errors=…), which newer PyAV (LP1's wxbench) rejects.
    A camera file is read end to end (audio sits between the video), so a long one takes a
    while off the NAS: progress is printed; `until` (file seconds) stops early for quick tests."""
    import av
    parts = []
    size = os.path.getsize(path) if os.path.isfile(path) else 0
    with av.open(path) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SR)
        total = until or (float(stream.duration * stream.time_base) if stream.duration
                          else (container.duration or 0) / 1e6) or 0
        last = 0.0

        def take(frames):
            for f in frames if isinstance(frames, list) else [frames]:
                if f is not None:
                    parts.append(f.to_ndarray().reshape(-1))

        pct = 0
        for frame in container.decode(stream):
            t = float(frame.time or 0)
            frame.pts = None
            take(resampler.resample(frame))
            if time.time() - last > 1:
                last = time.time()
                pct = int(100 * t / total) if total else 0
                read_progress(tag, pct, pct / 100 * size / 1e6)
            if until and t > until:
                break
        take(resampler.resample(None))                      # flush
        read_progress(tag, 100, (pct / 100 if until else 1) * size / 1e6, final=True)
    return (np.concatenate(parts) if parts else np.zeros(0, np.int16)).astype(np.float32) / 32768.0


def decode_ffmpeg(path: str) -> np.ndarray:
    """Fallback: an ffmpeg binary (EditPanel passes its bundled one as FFMPEG_PATH)."""
    import subprocess
    exe = os.environ.get("FFMPEG_PATH") or "ffmpeg"
    raw = subprocess.run([exe, "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(SR),
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


def read_audio(path: str, until: float = None, tag: str = "") -> np.ndarray:
    """Any source → 16 kHz mono float32: PCM WAVs directly, camera files (mov/mp4/mxf…) through
    PyAV, else ffmpeg (first audio track, channels mixed down)."""
    if path.lower().endswith(".wav"):
        try:
            x = read_wav(path)
            read_progress(tag, 100, os.path.getsize(path) / 1e6, final=True)
            return x
        except (wave.Error, KeyError):
            pass                                         # not plain PCM — decode it
    try:
        return decode_av(path, until, tag)
    except Exception as exc:
        print(f"  PyAV couldn't decode {os.path.basename(path)} ({type(exc).__name__}: {exc}); trying ffmpeg", flush=True)
        return decode_ffmpeg(path)


def level_db(x: np.ndarray, a: float, b: float) -> float:
    seg = x[max(0, int(a * SR)):max(0, int(b * SR))]
    if len(seg) == 0:
        return -120.0
    return 20 * math.log10(float(np.sqrt(np.mean(seg.astype(np.float64) ** 2))) + 1e-9)


def mmss(sec: float) -> str:
    return f"{int(sec // 60):02d}:{sec % 60:04.1f}"


def main() -> None:
    args = [a for a in sys.argv[1:] if "=" not in a]
    opts = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
    label = args[0] if args else "Convo2"
    global DESKTOP
    DESKTOP = opts.get("dir", DESKTOP)                     # dir=<folder> reads/writes there instead
    limit = float(opts.get("minutes", 0)) * 60 * SR        # minutes=N: quick test on the first N minutes
    day = json.load(open(os.path.join(DESKTOP, f"day_{label}.json"), encoding="utf-8"))
    fs = day["frame_sec"][0] / day["frame_sec"][1]
    report = [f"Transcribe {label} — multicam '{day['multicam']}', {day['length_sec'] / 60:.1f} min, "
              f"{len(day['mics'])} mic(s)"]

    # every mic on the multicam's clock (sample 0 = multicam 0:00), raw level kept for ownership;
    # all sources under one angle (camera clips, split recorder files) share one track
    t0 = time.time()
    tracks = {}
    track_lo = {}
    for m in day["mics"]:
        track_lo[m["angle"]] = min(track_lo.get(m["angle"], m["from_sec"]), m["from_sec"])
    print(f"Reading {len(day['mics'])} audio file(s)…", flush=True)
    for i, m in enumerate(day["mics"], 1):
        tag = f"{i}/{len(day['mics'])} {m['name']}"
        until = None
        if limit:                                            # quick test: only what the window needs
            until = track_lo[m["angle"]] + limit / SR - m["file_zero_sec"] + 1
            if track_lo[m["angle"]] + limit / SR <= m["from_sec"]:
                read_progress(tag, 100, 0, final=True)       # starts after the window: skip the file
                continue
        x = read_audio(m["path"], until, tag)
        shift = int(round(m["file_zero_sec"] * SR))             # file 0:00 sits here in the multicam
        lo, hi = int(m["from_sec"] * SR), int(m["to_sec"] * SR)
        t = tracks.get(m["angle"])
        if t is None:
            t = tracks[m["angle"]] = {**m, "audio": np.zeros(int(day["length_sec"] * SR) + SR, np.float32),
                                      "lo": lo, "hi": hi}
        src_lo, src_hi = max(0, lo - shift), min(len(x), hi - shift)
        if src_hi > src_lo:
            t["audio"][src_lo + shift:src_hi + shift] = x[src_lo:src_hi]
        t["lo"], t["hi"] = min(t["lo"], lo), max(t["hi"], hi)
        report.append(f"  {m['name']} under {m['angle']}: {len(x) / SR / 60:.1f} min file, "
                      f"multicam {m['from_sec'] / 60:.1f}–{m['to_sec'] / 60:.1f} min")
        del x
    mics = []
    for t in tracks.values():
        if limit:
            t["hi"] = min(t["hi"], t["lo"] + int(limit))
        peak = float(np.percentile(np.abs(t["audio"][t["lo"]:t["hi"]]), 99.99)) or 1.0   # recorded low; ignore single spikes
        mics.append({**t, "gain": 0.9 / peak})
    report.append(f"Read audio in {time.time() - t0:.0f}s ({day.get('audio_source', 'wav')} audio, "
                  f"{len(mics)} track(s))")

    cuda_dlls()
    import ctranslate2
    from faster_whisper import WhisperModel
    device = "cuda" if ctranslate2.get_cuda_device_count() else "cpu"
    print(f"Loading the model on {device}…", flush=True)
    t0 = time.time()
    model = WhisperModel("large-v3", device=device, compute_type="float16" if device == "cuda" else "int8")
    report.append(f"Model on {device} loaded in {time.time() - t0:.0f}s")

    words = []
    for m in mics:
        clip = m["audio"][m["lo"]:m["hi"]]
        clip = np.clip(clip * m["gain"], -1, 1).astype(np.float32)
        t0 = time.time()
        print(f"Finding speech in {m['angle']} ({len(clip) / SR / 60:.1f} min)…", flush=True)
        segs, _ = model.transcribe(clip, language="en", beam_size=5, word_timestamps=True, vad_filter=True,
                                   condition_on_previous_text=False)
        n = 0
        total = (m["hi"] - m["lo"]) / SR
        for s in segs:
            pct = min(100, int(100 * s.end / total)) if total else 100
            bar = "#" * (pct // 4) + "-" * (25 - pct // 4)
            print(f"\r  {m['angle']} [{bar}] {pct:3d}%  {s.end / 60:.1f}/{total / 60:.1f} min  "
                  f"{time.time() - t0:.0f}s", end="", flush=True)
            for w in s.words or []:
                a, b = w.start + m["lo"] / SR, w.end + m["lo"] / SR
                # levels after each mic's own gain, so a quieter-recorded mic isn't always the loser
                mine = level_db(m["audio"], a, b) + 20 * math.log10(m["gain"])
                other = max([level_db(o["audio"], a, b) + 20 * math.log10(o["gain"])
                             for o in mics if o is not m] or [-120.0])
                words.append({"mic": m["angle"], "w": w.word.strip(), "s": round(a / fs, 1), "e": round(b / fs, 1),
                              "p": round(w.probability, 2), "db": round(mine, 1), "other_db": round(other, 1),
                              "own": mine > other, "clear": mine >= other + OWN_MARGIN_DB})
                n += 1
        print(flush=True)
        secs = (m["hi"] - m["lo"]) / SR
        took = time.time() - t0
        report.append(f"  {m['angle']}: {n} words, {secs / 60:.1f} min in {took:.0f}s = {secs / took:.1f}x real time "
                      f"(raised {20 * math.log10(m['gain']):.0f} dB)")

    words.sort(key=lambda w: (w["s"], w["mic"]))
    own = [w for w in words if w["own"]]
    report.append(f"{len(words)} words, {len(own)} owned (rest = the other person heard on that mic)")
    json.dump({"label": label, "multicam": day["multicam"], "fps": day["fps"], "frame_sec": day["frame_sec"],
               "angles": day["angles"], "mics": [m["angle"] for m in mics], "words": words},
              open(os.path.join(DESKTOP, f"words_{label}.json"), "w", encoding="utf-8"))

    lines, cur = [], None
    for w in own:
        if cur and cur["mic"] == w["mic"] and (w["s"] - cur["e"]) * fs <= TURN_GAP_SEC:
            cur["text"].append(w["w"])
            cur["e"] = w["e"]
            continue
        if cur:
            lines.append(cur)
        cur = {"mic": w["mic"], "s": w["s"], "e": w["e"], "text": [w["w"]]}
    if cur:
        lines.append(cur)
    with open(os.path.join(DESKTOP, f"transcript_{label}.txt"), "w", encoding="utf-8") as fh:
        for ln in lines:
            fh.write(f"[{int(ln['s'])}–{int(ln['e'])} | {mmss(ln['s'] * fs)}] {ln['mic']}: {' '.join(ln['text'])}\n")
    report.append(f"{len(lines)} transcript lines")
    with open(os.path.join(DESKTOP, f"transcribe_{label}.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(report) + "\n")
    print("\n".join(report))
    print(f"Saved words_{label}.json, transcript_{label}.txt, transcribe_{label}.txt on the Desktop")


if __name__ == "__main__":
    main()
