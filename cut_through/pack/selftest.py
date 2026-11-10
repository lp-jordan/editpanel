"""Transcription pack check: loads both models the way transcribe.py does and runs each once.

EditPanel runs it after installing the pack (offline: HF_HOME / TORCH_HOME point into the pack).
scripts/build-transcription-pack.mjs runs it online first, which downloads the models into the pack.
Prints one line per check; exits 1 if any fails. GPU missing is a warning, not a failure.
"""
import glob
import os
import sys
import time

ok = True


def line(mark, text):
    print(f"{mark} {text}", flush=True)


def cuda_dlls():
    if os.name != "nt":
        return
    for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(d)
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


line("·", f"Python {sys.version.split()[0]} at {sys.executable}")
try:
    import numpy as np
    import av  # noqa: F401  (transcribe.py decodes camera audio with PyAV)
    line("✓", f"numpy {np.__version__}, PyAV {av.__version__}")
except Exception as exc:  # noqa: BLE001
    ok = False
    line("✗", f"numpy / PyAV: {type(exc).__name__}: {exc}")

try:
    cuda_dlls()
    import ctranslate2
    from faster_whisper import WhisperModel
    gpus = ctranslate2.get_cuda_device_count()
    device = "cuda" if gpus else "cpu"
    if not gpus:
        line("!", "No NVIDIA GPU found: transcription would run on the CPU (very slow)")
    t0 = time.time()
    model = WhisperModel("large-v3", device=device, compute_type="float16" if device == "cuda" else "int8")
    segs, _ = model.transcribe(np.zeros(16000 * 2, dtype=np.float32), language="en")
    list(segs)                                   # runs the model once (loads cuDNN on the GPU)
    line("✓", f"Whisper large-v3 on {device} ({time.time() - t0:.0f}s, ctranslate2 {ctranslate2.__version__})")
except Exception as exc:  # noqa: BLE001
    ok = False
    line("✗", f"Whisper: {type(exc).__name__}: {exc}")

try:
    import torch
    import whisperx
    t0 = time.time()
    whisperx.load_align_model(language_code="en", device="cpu")
    line("✓", f"Word alignment model ({time.time() - t0:.0f}s, torch {torch.__version__})")
except Exception as exc:  # noqa: BLE001
    ok = False
    line("✗", f"Word alignment (WhisperX): {type(exc).__name__}: {exc}")

sys.exit(0 if ok else 1)
