#!/usr/bin/env python3
"""
SPIKE — Transcription speed on this machine (Mac vs the Windows Resolve machine).

Runs faster-whisper large-v3 (the engine inside WhisperX) on the same slice of the same mic
WAV, with the same settings, on the CPU and — when an NVIDIA GPU is usable — on the GPU.
Writes only timings and a word count (no transcript text) to Desktop/bench_whisper_<host>.txt.

Setup on Windows (normal Command Prompt, once; the first run downloads the ~3 GB model):
    py -m venv C:\\wxbench
    C:\\wxbench\\Scripts\\pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*
Run:
    C:\\wxbench\\Scripts\\python C:\\lp-app-ecosystem\\editpanel\\spikes\\bench_whisper.py "N:\\...\\01MIC1.WAV"
Optional: start=<minutes> length=<minutes> (defaults 20 and 5).
"""
import glob
import os
import platform
import sys
import time


def cuda_dlls() -> None:
    """Windows: make the pip-installed CUDA libraries findable by ctranslate2."""
    if os.name != "nt":
        return
    for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(d)
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def main() -> None:
    args = [a for a in sys.argv[1:] if "=" not in a]
    opts = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
    start, length = float(opts.get("start", 20)), float(opts.get("length", 5))
    cuda_dlls()
    import ctranslate2
    from faster_whisper import WhisperModel, decode_audio

    host = platform.node() or "this machine"
    lines = [f"{host} — {platform.system()} {platform.machine()}, {os.cpu_count()} CPU threads; "
             f"ctranslate2 {ctranslate2.__version__}"]
    t0 = time.time()
    audio = decode_audio(args[0], sampling_rate=16000)
    clip = audio[int(start * 60 * 16000):int((start + length) * 60 * 16000)]
    secs = len(clip) / 16000
    lines.append(f"Audio: {secs / 60:.1f} min from minute {start:g} (decoded in {time.time() - t0:.1f}s)")

    runs = [("cpu", "int8")]
    if _gpus(ctranslate2):
        runs.append(("cuda", "float16"))
    else:
        lines.append("GPU: none usable (no NVIDIA GPU, or the CUDA libraries didn't load)")
    for device, ctype in runs:
        try:
            t0 = time.time()
            model = WhisperModel("large-v3", device=device, compute_type=ctype)
            load = time.time() - t0
            t0 = time.time()
            segs, _ = model.transcribe(clip, language="en", beam_size=5, word_timestamps=True, vad_filter=True)
            words = sum(len(s.words or []) for s in segs)
            took = time.time() - t0
            lines.append(f"{device} {ctype}: {took:.0f}s for {secs:.0f}s of audio = {secs / took:.1f}x real time "
                         f"({words} words; model load {load:.0f}s)")
        except Exception as exc:
            lines.append(f"{device} {ctype}: failed — {exc}")
    print("\n".join(lines))
    out = os.path.join(os.path.expanduser("~/Desktop"), f"bench_whisper_{host}.txt")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"Saved {out}")


def _gpus(ct2) -> int:
    try:
        return ct2.get_cuda_device_count()
    except Exception:
        return 0


if __name__ == "__main__":
    main()
