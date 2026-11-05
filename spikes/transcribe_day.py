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

    # every mic on the multicam's clock (sample 0 = multicam 0:00), raw level kept for ownership
    t0 = time.time()
    mics = []
    print(f"Reading {len(day['mics'])} mic file(s)…", flush=True)
    for m in day["mics"]:
        x = read_wav(m["path"])
        shift = int(round(m["file_zero_sec"] * SR))             # file 0:00 sits here in the multicam
        lo, hi = int(m["from_sec"] * SR), int(m["to_sec"] * SR)
        mc = np.zeros(int(day["length_sec"] * SR) + SR, np.float32)
        src_lo, src_hi = max(0, lo - shift), min(len(x), hi - shift)
        if src_hi > src_lo:
            mc[src_lo + shift:src_hi + shift] = x[src_lo:src_hi]
        if limit:
            hi = min(hi, lo + int(limit))
        peak = float(np.percentile(np.abs(mc[lo:hi]), 99.99)) or 1.0   # recorded low; ignore single spikes
        mics.append({**m, "audio": mc, "lo": lo, "hi": hi, "gain": 0.9 / peak})
        report.append(f"  {m['name']} under {m['angle']}: {len(x) / SR / 60:.1f} min file, "
                      f"multicam {m['from_sec'] / 60:.1f}–{m['to_sec'] / 60:.1f} min")
    report.append(f"Read audio in {time.time() - t0:.0f}s")

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
