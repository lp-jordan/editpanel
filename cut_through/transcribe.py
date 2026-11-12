#!/usr/bin/env python3
"""
Cut-through step 2 (Transcribe): transcribe the day's mics on LP1's GPU.

Reads <run folder>\\day_<LABEL>.json (written by prepare_multicam.py in Resolve), transcribes every mic
WAV over the stretch it covers in the multicam with faster-whisper large-v3 (WhisperX's engine)
on the NVIDIA GPU, pins every word to the audio (WhisperX alignment), puts it on the multicam's frame grid, and decides who said it: each
mic hears the other person faintly, so a word belongs to the mic where it's loudest.
Writes into the same run folder (client words — never into git):
  words_<LABEL>.json  — every word: mic angle, multicam start/end frame, probability,
                        level on its own mic and on the loudest other mic, own=True/False
  levels_<LABEL>.json — per-frame level of every mic (place_cuts.py places cuts from it)
  transcript_<LABEL>.txt — readable turns: [frame | mm:ss] ANGLE: text
  transcribe_<LABEL>.txt — timings only

EditPanel runs it with the transcription pack's Python (Cut-through page → Transcribe; the pack
carries faster-whisper, WhisperX and the models). By hand, with that Python:
    <pack python> C:\\lp-app-ecosystem\\editpanel\\cut_through\\transcribe.py Convo2 dir=<run folder>
(without dir= it reads and writes the Desktop)
Quick test first (first 3 minutes of each mic): add  minutes=3
Second, verbatim pass (restarts, "uh"s, cut-off words; ~2× the GPU time): add  verbatim=1
Already transcribed, just measure the audio (levels + loud-without-words marks, no Whisper): add  levels_only=1
Already transcribed before alignment existed, pin the words to the audio (no Whisper): add  align_only=1
Every run ends with WhisperX forced alignment (wav2vec2): word times to within a frame or two
instead of Whisper's own (3–25 frames off); align_<LABEL>.txt says it ran.
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

RUN_DIR = os.path.expanduser("~/Desktop")             # main() sets it from dir= (EditPanel: the run folder)
SR = 16000
OWN_MARGIN_DB = 3.0          # "clear" = its mic is this much louder than any other mic ("own" = just louder)
TURN_GAP_SEC = 1.0           # a new transcript line when the speaker changes or after this pause
# verbatim=1: a second pass primed to write disfluencies (Z8's verbatim pass heard the restarts, "uh"s
# and cut-off words the clean pass drops); only words the clean pass missed are added, marked "v"
VERBATIM_PROMPT = "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking. So, uh, I- I mean, you know, we- we did that."


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
    decode_audio passes av.open(metadata_errors=…), which newer PyAV (the transcription pack's) rejects.
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


def unheard_speech(m: dict, words: list, fs: float) -> list:
    """Stretches on this mic that are loud like its words but where Whisper wrote nothing: in a
    solo take these are usually flubs / restarts Whisper dropped (Z8 lesson). Multicam frames."""
    x = m["audio"][m["lo"]:m["hi"]] * m["gain"]
    hop = SR // 50                                             # 20 ms
    n = len(x) // hop
    if n == 0:
        return []
    env = 20 * np.log10(np.sqrt(np.mean(x[:n * hop].reshape(n, hop).astype(np.float64) ** 2, axis=1)) + 1e-9)
    own = [w for w in words if w["mic"] == m["angle"] and w["own"]]
    if len(own) < 10:
        return []
    word_db = np.median([w["db"] + 20 * math.log10(m["gain"]) for w in own])
    loud = env > word_db - 10
    covered = np.zeros(n, bool)
    for w in own:                                              # words (+150 ms each side) are heard
        a = int((w["s"] * fs - m["lo"] / SR - 0.15) * 50)
        b = int((w["e"] * fs - m["lo"] / SR + 0.15) * 50) + 1
        covered[max(0, a):max(0, b)] = True
    out, k = [], 0
    hot = loud & ~covered
    while k < n:
        if not hot[k]:
            k += 1
            continue
        j = k
        gap = 0
        while j < n and (hot[j] or gap < 5):                   # bridge < 100 ms dips
            gap = 0 if hot[j] else gap + 1
            j += 1
        j -= gap
        if (j - k) / 50 >= 0.3:
            s0 = m["lo"] / SR + k / 50
            out.append({"mic": m["angle"], "s": round(s0 / fs, 1), "e": round((m["lo"] / SR + j / 50) / fs, 1)})
        k = j + 1
    return out


def frame_levels(m: dict, fs: float) -> dict:
    """The track's level on every multicam frame (dB after its gain), for placing cuts from the
    waveform the way the Z8 build did: {"start": first frame, "db": [int per frame]}."""
    f0, f1 = int(m["lo"] / SR / fs), int(m["hi"] / SR / fs)
    edges = (np.arange(f0, f1 + 1) * fs * SR).round().astype(np.int64)
    x = (m["audio"].astype(np.float64) * m["gain"]) ** 2
    sums = np.add.reduceat(x, edges[:-1]) if len(edges) > 1 else np.zeros(0)
    n = np.maximum(np.diff(edges), 1)
    db = 10 * np.log10(sums / n + 1e-12)
    return {"start": f0, "db": [int(round(max(-100.0, v))) for v in db]}


def clip_stretched(words: list, m: dict, fs: float, max_frames: int = 24) -> int:
    """Whisper stretches a word over speech it dropped (Z8: "produced." ran on for 2 s). A word
    longer than 1 s is cut back to where its mic goes quiet; anything loud after that then shows
    up as unheard sound. Returns how many words were clipped (the old end is kept as "e0")."""
    lv = frame_levels(m, fs)
    db, f0 = lv["db"], lv["start"]
    own = [w for w in words if w["mic"] == m["angle"] and w["own"]]
    if not own or not db:
        return 0
    inside = sorted(db[int(w["s"]) - f0] for w in own[::5] if 0 <= int(w["s"]) - f0 < len(db))
    thr = (inside[len(inside) // 2] if inside else -30) - 24
    n = 0
    for w in own:
        if w["e"] - w["s"] <= max_frames or "a" in w:     # aligned words already end where the sound does
            continue
        quiet = 0
        for f in range(int(w["s"]) + 6, int(w["e"])):
            i = f - f0
            quiet = quiet + 1 if 0 <= i < len(db) and db[i] < thr else 0
            if quiet >= 4:                                      # 4 quiet frames = the word is over
                w["e0"], w["e"] = w["e"], float(f - 3)
                n += 1
                break
    return n


ALIGN_PAD_SEC = 1.0          # Whisper's own word times run up to ~1 s off: align over a padded slice
ALIGN_GAP_SEC = 1.5          # a new alignment chunk after a pause this long…
ALIGN_MAX_SEC = 25.0         # …or once a chunk would run longer than this (wav2vec2 works on short stretches)
GHOST_SCORE, GHOST_FRAMES = 0.05, 3   # a word the aligner can't find in the audio (score ~0, ≤ 3 fr): never said


def norm_word(t: str) -> str:
    return "".join(c for c in str(t).lower() if c.isalnum() or c == "'")


PHANTOM_P, PHANTOM_GAP = 0.3, 3        # a repeat Whisper doubts this much, this close (frames), was never said


def drop_phantom_doubles(words: list) -> int:
    """Whisper sometimes writes one spoken word twice, the second copy at very low confidence (Chad
    Volkert 2026-11-09: 0.01-0.27; real repeats 0.68+). Left in, alignment splits the one word between
    the two copies and the edit cuts half of it as a stutter. Removed in place, before alignment, so the
    aligner gives the real word all of its sound. Returns how many went."""
    start_of = lambda w: w.get("ws", w["s"])
    end_of = lambda w: w.get("we", w["e"])
    drop, prev = set(), {}
    for w in sorted(words, key=start_of):
        p = prev.get(w["mic"])
        # one-letter words are exempt: "I I I" is a real stumble, and Whisper always doubts those
        if p is not None and len(norm_word(w["w"])) > 1 and norm_word(w["w"]) == norm_word(p["w"]) \
                and w.get("p", 1) < PHANTOM_P and start_of(w) - end_of(p) <= PHANTOM_GAP:
            drop.add(id(w))
            continue
        prev[w["mic"]] = w
    words[:] = [w for w in words if id(w) not in drop]
    return len(drop)


# One said word written twice (2026-11-12, ELEVATE_MC_2: 301 same-word pairs, Whisper fairly sure of both
# copies, so the confidence guard above misses them; Claude then trims one copy as a stumble and cuts into
# the one real word). Each pair is aligned against the mic audio twice — as two words and as one — and a
# copy that the audio doesn't support is marked "ghost" (every later step ignores ghosts); the kept copy
# takes the one-word fit's times, so it owns all of the word's sound. Every verdict goes to doubles_<LABEL>.json.
DOUBLE_GAP = 6               # frames between the copies to count as a pair
DOUBLE_CTX = 12              # a neighbour this close (frames) goes into the text, so the aligner isn't fitting it
DOUBLE_PAD_SEC = 0.25
DOUBLE_WEAK = 0.25           # in the two-word fit, one copy scores under this…
DOUBLE_ONE_OK = 0.05         # …and the one-word fit scores at least the better copy minus this → fake
DOUBLE_FIT_GAIN = 0.15       # or: the whole slice fits this much better as one word (and a copy is under 0.5)


def test_doubles(words: list, by_mic: dict, fs: float, model, meta, device, align) -> dict:
    """The one-vs-two test on every adjacent same-word pair. Returns {"pairs": [...], "fake", "real", "untested"}."""
    out = {"pairs": [], "fake": 0, "real": 0, "untested": 0}
    for mic, m in by_mic.items():
        ws = sorted((w for w in words if w["mic"] == mic and w.get("own", True) and not w.get("ghost")), key=lambda w: w["s"])
        k = 0
        while k + 1 < len(ws):
            a, b = ws[k], ws[k + 1]
            na = norm_word(a["w"])
            if len(na) < 2 or na != norm_word(b["w"]) or b["s"] - a["e"] > DOUBLE_GAP:
                k += 1
                continue
            row = {"mic": mic, "word": str(a["w"]).strip(), "a": [round(a["s"], 1), round(a["e"], 1), a.get("p"), a.get("a")],
                   "b": [round(b["s"], 1), round(b["e"], 1), b.get("p"), b.get("a")]}
            prev = ws[k - 1] if k > 0 and a["s"] - ws[k - 1]["e"] <= DOUBLE_CTX else None
            nxt = ws[k + 2] if k + 2 < len(ws) and ws[k + 2]["s"] - b["e"] <= DOUBLE_CTX else None
            ctx = [w for w in (prev, a, b, nxt) if w is not None]
            lo = max(m["lo"], int(((ctx[0]["s"]) * fs - DOUBLE_PAD_SEC) * SR))
            hi = min(m["hi"], int(((ctx[-1]["e"]) * fs + DOUBLE_PAD_SEC) * SR))
            texts = [str(w["w"]).strip() for w in ctx]
            verdict = None
            if hi - lo < SR // 10 or not all(texts) or any(" " in t for t in texts):
                verdict = "untested: no clean slice"
            else:
                clip = np.clip(m["audio"][lo:hi] * m["gain"], -1, 1).astype(np.float32)
                one_ctx = [w for w in ctx if w is not b]
                two = align(texts, clip)
                one = align([str(w["w"]).strip() for w in one_ctx], clip)
                ia, ib, io = ctx.index(a), ctx.index(b), one_ctx.index(a)
                if not two or not one or any(g.get("score") is None for g in (two[ia], two[ib], one[io])):
                    verdict = "untested: aligner couldn't place it"
                else:
                    sa, sb, s1 = float(two[ia]["score"]), float(two[ib]["score"]), float(one[io]["score"])
                    mean = lambda gs: sum(float(g.get("score") or 0) for g in gs) / len(gs)
                    fit2, fit1 = mean(two), mean(one)
                    row.update({"two": [round(sa, 2), round(sb, 2)], "one": round(s1, 2), "fit_two": round(fit2, 2), "fit_one": round(fit1, 2),
                                "span_two": round((two[ib]["end"] - two[ia]["start"]) / fs, 1),
                                "span_one": round((one[io]["end"] - one[io]["start"]) / fs, 1)})
                    fake = (min(sa, sb) < DOUBLE_WEAK and s1 >= max(sa, sb) - DOUBLE_ONE_OK) or \
                           (fit1 - fit2 >= DOUBLE_FIT_GAIN and min(sa, sb) < 0.5)
                    if fake:
                        ghost, keep = (b, a) if sb <= sa else (a, b)
                        ghost["ghost"] = True
                        g1 = one[io]
                        keep["s"] = round(lo / SR / fs + g1["start"] / fs, 1)
                        keep["e"] = round(max(keep["s"] + 0.5, lo / SR / fs + g1["end"] / fs), 1)
                        keep["a"] = round(s1, 2)
                        verdict = "fake: second copy ghosted" if ghost is b else "fake: first copy ghosted"
                    else:
                        verdict = "real"
            row["verdict"] = verdict
            out["pairs"].append(row)
            key = verdict.split(":")[0]
            out[key] = out.get(key, 0) + 1
            k += 2 if verdict.startswith("fake") else 1
    return out


def align_words(words: list, mics: list, fs: float, progress=None, label: str = None) -> str:
    """WhisperX forced alignment (wav2vec2): pins every word Whisper wrote to the audio. Whisper's
    own word times touch each other and run 3–25 frames off (Elevate, 2026-11-06: "reconnect" cut
    to "re-", "also" to "al-"); aligned times land within a frame or two of where Jordan would cut.
    The text stays Whisper's — only s/e move (Whisper's kept as ws/we, score as "a"). A word the
    aligner can't hear (score ~0, a blink long) sits between its neighbours; one that repeats the next
    word was never said (Whisper invented "show show"): marked "ghost" so the edit never treats it
    as a stutter. Returns a report line."""
    t0 = time.time()
    phantoms = drop_phantom_doubles(words)
    try:
        import torch
        import whisperx
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model, meta = whisperx.load_align_model(language_code="en", device=device)
    except Exception as exc:                            # noqa: BLE001 — never lose a transcription over it
        return f"Words NOT aligned to the audio (WhisperX unavailable: {type(exc).__name__}: {exc}) — cuts will be less exact"
    by_mic = {m["angle"]: m for m in mics}
    todo = [w for w in words if w.get("own", True) and w["mic"] in by_mic]
    ws_of = lambda w: w.get("ws", w["s"])               # Whisper's own times (stable on a re-run)
    we_of = lambda w: w.get("we", w["e"])
    chunks = []                                         # (mic's words, first, past-last index)
    for mic in by_mic:
        ws = sorted((w for w in todo if w["mic"] == mic), key=ws_of)
        i0 = 0
        for i in range(1, len(ws) + 1):
            if i == len(ws) or (ws_of(ws[i]) - we_of(ws[i - 1])) * fs > ALIGN_GAP_SEC or \
                    (we_of(ws[i]) - ws_of(ws[i0])) * fs > ALIGN_MAX_SEC:
                chunks.append((mic, ws, i0, i))
                i0 = i
    done = moved = ghosts = skipped = 0
    last_pct = -1
    for k, (mic, ws, i0, i1) in enumerate(chunks):
        m = by_mic[mic]
        # the slice is padded (Whisper's times can be ~1 s off), so it also holds the neighbours'
        # speech: their words go into the text too (context), and only this chunk's words are taken
        # — otherwise the aligner fits these words onto the neighbours' sound (Elevate "now a third…")
        c0, c1 = i0, i1
        while c0 > 0 and (ws_of(ws[i0]) - we_of(ws[c0 - 1])) * fs < 2 * ALIGN_PAD_SEC:
            c0 -= 1
        while c1 < len(ws) and (ws_of(ws[c1]) - we_of(ws[i1 - 1])) * fs < 2 * ALIGN_PAD_SEC:
            c1 += 1
        ctx = ws[c0:c1]
        a = max(m["lo"], int((ws_of(ctx[0]) * fs - ALIGN_PAD_SEC) * SR))
        b = min(m["hi"], int((we_of(ctx[-1]) * fs + ALIGN_PAD_SEC) * SR))
        texts = [str(w["w"]).strip() for w in ctx]
        if b - a < SR // 10 or not all(texts) or any(" " in t for t in texts):
            skipped += i1 - i0
            continue
        clip = np.clip(m["audio"][a:b] * m["gain"], -1, 1).astype(np.float32)
        try:
            res = whisperx.align([{"text": " ".join(texts), "start": 0.0, "end": (b - a) / SR}], model, meta, clip,
                                 device, return_char_alignments=False)
            got = [x for seg in res.get("segments", []) for x in seg.get("words", [])]
        except Exception:                               # noqa: BLE001 — one bad chunk keeps Whisper's times
            got = []
        if len(got) != len(ctx):
            skipped += i1 - i0
            continue
        placed = []
        for w, g in zip(ctx, got):
            if g.get("start") is None or g.get("end") is None:
                placed.append(None)                     # numbers etc. the aligner can't place: Whisper's times
                continue
            s, e = round((a / SR + g["start"]) / fs, 1), round((a / SR + g["end"]) / fs, 1)
            placed.append((s, max(e, s + 0.5), round(float(g.get("score") or 0), 2)))
        weak = [p is not None and p[2] < GHOST_SCORE and p[1] - p[0] <= GHOST_FRAMES for p in placed]
        for i, (w, p) in enumerate(zip(ctx, placed)):
            if p is None or not (i0 - c0 <= i < i1 - c0):
                continue
            w.setdefault("ws", w["s"])
            w.setdefault("we", w["e"])
            w.pop("e0", None)                           # an aligned end is the real end (no stretch to clip)
            w.pop("ghost", None)
            s, e, score = p
            if weak[i]:
                # the aligner couldn't hear it. Short words ("a", "I") often score ~0 though said, and
                # their aligned spot can be wrong: keep the word, but sit it between its neighbours.
                # Said again right after ("show show") = Whisper doubled it: never said
                nxt = ctx[i + 1] if i + 1 < len(ctx) else None
                if nxt is not None and norm_word(nxt["w"]) == norm_word(w["w"]):
                    w["ghost"] = True
                    ghosts += 1
                prev_e = next((placed[j][1] for j in range(i - 1, -1, -1) if placed[j] and not weak[j]), None)
                next_s = next((placed[j][0] for j in range(i + 1, len(ctx)) if placed[j] and not weak[j]), None)
                lo = prev_e if prev_e is not None else w["ws"]
                hi = next_s if next_s is not None else lo + (w["we"] - w["ws"])
                s = min(max(w["ws"], lo), hi)
                e = max(s + 0.5, min(s + (w["we"] - w["ws"]), hi))
            if abs(s - w["s"]) >= 1 or abs(e - w["e"]) >= 1:
                moved += 1
            w["s"], w["e"], w["a"] = round(s, 1), round(e, 1), score
            done += 1
        pct = int(100 * (k + 1) / len(chunks))
        if progress and pct // 10 != last_pct // 10:
            last_pct = pct
            progress(pct)
    # the one-vs-two test on every same-word pair (after alignment: real times to slice by)
    def one_slice(texts, clip):
        try:
            res = whisperx.align([{"text": " ".join(texts), "start": 0.0, "end": len(clip) / SR}], model, meta, clip,
                                 device, return_char_alignments=False)
            got = [x for seg in res.get("segments", []) for x in seg.get("words", [])]
        except Exception:                               # noqa: BLE001 — that pair stays untested
            return None
        return got if len(got) == len(texts) else None
    dbl = test_doubles(words, by_mic, fs, model, meta, device, one_slice)
    if label:
        with open(os.path.join(RUN_DIR, f"doubles_{label}.json"), "w", encoding="utf-8") as fh:
            json.dump({"rules": {"gap": DOUBLE_GAP, "weak": DOUBLE_WEAK, "one_ok": DOUBLE_ONE_OK, "fit_gain": DOUBLE_FIT_GAIN}, **dbl}, fh, indent=1)
    words.sort(key=lambda w: (w["s"], w["mic"]))
    return (f"Aligned {done} of {len(todo)} words to the audio on {device} in {time.time() - t0:.0f}s "
            f"({moved} moved ≥ 1 fr; {phantoms + ghosts} doubled word(s) Whisper invented, ignored; {skipped} kept Whisper's times); "
            f"doubled words: {len(dbl['pairs'])} pair(s) tested, {dbl['fake']} said once (copy ignored), {dbl['real']} real, "
            f"{dbl.get('untested', 0)} untested")


def write_align_note(label: str, line: str) -> None:
    """align_<LABEL>.txt: says the words were aligned (EditPanel aligns an older transcript before Plan)."""
    with open(os.path.join(RUN_DIR, f"align_{label}.txt"), "w", encoding="utf-8") as fh:
        fh.write(line + "\n")


def write_levels(label: str, mics: list, fs: float) -> str:
    p = os.path.join(RUN_DIR, f"levels_{label}.json")
    json.dump({"label": label, "frame_sec": fs, "mics": {m["angle"]: frame_levels(m, fs) for m in mics}},
              open(p, "w", encoding="utf-8"))
    return p


def mmss(sec: float) -> str:
    return f"{int(sec // 60):02d}:{sec % 60:04.1f}"


def main() -> None:
    args = [a for a in sys.argv[1:] if "=" not in a]
    opts = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
    label = args[0] if args else "Convo2"
    global RUN_DIR
    RUN_DIR = opts.get("dir", RUN_DIR)                     # dir=<folder> reads/writes there instead
    limit = float(opts.get("minutes", 0)) * 60 * SR        # minutes=N: quick test on the first N minutes
    day = json.load(open(os.path.join(RUN_DIR, f"day_{label}.json"), encoding="utf-8"))
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

    def align_progress(pct: int) -> None:
        print(f"Aligning words to the audio {pct}%…", flush=True)

    if opts.get("align_only") == "1":
        # an already transcribed day (before alignment was added): pin its words to the audio,
        # then re-measure what depends on word times — no Whisper, the text stays as it was
        wp = os.path.join(RUN_DIR, f"words_{label}.json")
        data = json.load(open(wp, encoding="utf-8"))
        print("Aligning words to the audio…", flush=True)
        line = align_words(data["words"], mics, fs, align_progress, label)
        if not line.startswith("Aligned"):
            raise SystemExit(line)
        clipped = sum(clip_stretched(data["words"], m, fs) for m in mics)
        data["unheard"] = [u for m in mics for u in unheard_speech(m, data["words"], fs)]
        data["aligned"] = True
        json.dump(data, open(wp, "w", encoding="utf-8"))
        write_levels(label, mics, fs)
        write_align_note(label, line)
        print(f"{line}; {clipped} stretched word(s) clipped; {len(data['unheard'])} loud stretch(es) with no words. "
              f"Updated words_{label}.json", flush=True)
        return

    if opts.get("levels_only") == "1":
        # an already transcribed day: measure the audio only (no Whisper) — per-frame levels for
        # cutting from the waveform, plus the loud-without-words marks — and keep the words
        wp = os.path.join(RUN_DIR, f"words_{label}.json")
        data = json.load(open(wp, encoding="utf-8"))
        print("Measuring loudness frame by frame (for cut placement)…", flush=True)
        clipped = sum(clip_stretched(data["words"], m, fs) for m in mics)
        data["unheard"] = [u for m in mics for u in unheard_speech(m, data["words"], fs)]
        json.dump(data, open(wp, "w", encoding="utf-8"))
        write_levels(label, mics, fs)
        print(f"Measured levels for {len(mics)} track(s); {clipped} stretched word(s) clipped; "
              f"{len(data['unheard'])} loud stretch(es) with no words. "
              f"Saved levels_{label}.json, updated words_{label}.json", flush=True)
        return

    cuda_dlls()
    import ctranslate2
    from faster_whisper import WhisperModel
    device = "cuda" if ctranslate2.get_cuda_device_count() else "cpu"
    print(f"Loading the model on {device}…", flush=True)
    t0 = time.time()
    model = WhisperModel("large-v3", device=device, compute_type="float16" if device == "cuda" else "int8")
    report.append(f"Model on {device} loaded in {time.time() - t0:.0f}s")

    verbatim = opts.get("verbatim") == "1"

    def whisper_pass(m: dict, prompt: str = None, tag: str = "") -> list:
        clip = m["audio"][m["lo"]:m["hi"]]
        clip = np.clip(clip * m["gain"], -1, 1).astype(np.float32)
        print(f"Finding speech in {m['angle']}{tag} ({len(clip) / SR / 60:.1f} min)…", flush=True)
        t0 = time.time()
        segs, _ = model.transcribe(clip, language="en", beam_size=5, word_timestamps=True, vad_filter=True,
                                   condition_on_previous_text=False, initial_prompt=prompt)
        out = []
        total = (m["hi"] - m["lo"]) / SR
        for s in segs:
            pct = min(100, int(100 * s.end / total)) if total else 100
            bar = "#" * (pct // 4) + "-" * (25 - pct // 4)
            print(f"\r  {m['angle']}{tag} [{bar}] {pct:3d}%  {s.end / 60:.1f}/{total / 60:.1f} min  "
                  f"{time.time() - t0:.0f}s", end="", flush=True)
            for w in s.words or []:
                a, b = w.start + m["lo"] / SR, w.end + m["lo"] / SR
                # levels after each mic's own gain, so a quieter-recorded mic isn't always the loser
                mine = level_db(m["audio"], a, b) + 20 * math.log10(m["gain"])
                other = max([level_db(o["audio"], a, b) + 20 * math.log10(o["gain"])
                             for o in mics if o is not m] or [-120.0])
                out.append({"mic": m["angle"], "w": w.word.strip(), "s": round(a / fs, 1), "e": round(b / fs, 1),
                            "p": round(w.probability, 2), "db": round(mine, 1), "other_db": round(other, 1),
                            "own": mine > other, "clear": mine >= other + OWN_MARGIN_DB})
        print(flush=True)
        took = time.time() - t0
        report.append(f"  {m['angle']}{tag}: {len(out)} words, {total / 60:.1f} min in {took:.0f}s = "
                      f"{total / max(took, 1e-6):.1f}x real time (raised {20 * math.log10(m['gain']):.0f} dB)")
        return out

    words = []
    for m in mics:
        base = whisper_pass(m)
        words += base
        if verbatim:
            extra = []
            for w in whisper_pass(m, VERBATIM_PROMPT, " (verbatim)"):
                # a word the clean pass didn't write: no clean word overlaps more than 40% of it
                if not any(min(w["e"], b["e"]) - max(w["s"], b["s"]) > 0.4 * min(w["e"] - w["s"], b["e"] - b["s"] or 1)
                           for b in base if b["e"] > w["s"] - 30 and b["s"] < w["e"] + 30):
                    extra.append({**w, "v": True})
            words += extra
            report.append(f"  {m['angle']}: verbatim pass added {len(extra)} word(s) the clean pass missed")

    words.sort(key=lambda w: (w["s"], w["mic"]))
    print("Aligning words to the audio…", flush=True)
    align_line = align_words(words, mics, fs, align_progress, label)
    report.append(align_line)
    print("Measuring loudness frame by frame (for cut placement)…", flush=True)
    clipped = sum(clip_stretched(words, m, fs) for m in mics)
    report.append(f"{clipped} stretched word(s) clipped where the audio goes quiet")
    unheard = [u for m in mics for u in unheard_speech(m, words, fs)]
    report.append(f"{len(unheard)} loud stretch(es) with no words (possible dropped flubs)")
    write_levels(label, mics, fs)
    own = [w for w in words if w["own"]]
    report.append(f"{len(words)} words, {len(own)} owned (rest = the other person heard on that mic)")
    json.dump({"label": label, "multicam": day["multicam"], "fps": day["fps"], "frame_sec": day["frame_sec"],
               "angles": day["angles"], "mics": [m["angle"] for m in mics], "words": words, "unheard": unheard,
               "aligned": align_line.startswith("Aligned")},
              open(os.path.join(RUN_DIR, f"words_{label}.json"), "w", encoding="utf-8"))
    if align_line.startswith("Aligned"):
        write_align_note(label, align_line)
    elif os.path.exists(os.path.join(RUN_DIR, f"align_{label}.txt")):
        os.remove(os.path.join(RUN_DIR, f"align_{label}.txt"))     # an older run's note: no longer true

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
    with open(os.path.join(RUN_DIR, f"transcript_{label}.txt"), "w", encoding="utf-8") as fh:
        for ln in lines:
            fh.write(f"[{int(ln['s'])}–{int(ln['e'])} | {mmss(ln['s'] * fs)}] {ln['mic']}: {' '.join(ln['text'])}\n")
    report.append(f"{len(lines)} transcript lines")
    with open(os.path.join(RUN_DIR, f"transcribe_{label}.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(report) + "\n")
    print("\n".join(report))
    print(f"Saved words_{label}.json, levels_{label}.json, transcript_{label}.txt, transcribe_{label}.txt in {RUN_DIR}")


if __name__ == "__main__":
    main()
