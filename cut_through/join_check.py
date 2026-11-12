#!/usr/bin/env python3
"""
Cut-through Score (test, 2026-11-12): check every join of a built rough cut on its RENDERED audio,
i.e. what the project actually plays (crossfades, fades, mic gating, import offsets included).

Two measures at every join where the source jumps (an angle change on continuous source is not a join):
  * forced alignment (WhisperX / wav2vec2, the pack's aligner) of the words that should be heard
    around the join, on the rendered audio. The aligner is TOLD the words, so it can't fill a
    chopped word in from context the way Whisper transcription does: a missing last (or first)
    sound shows as a squashed word (much shorter than in the source) and / or weak letter scores.
  * loudness at the cut edge (10 ms steps) against the speaker's own speech level in this video:
    sound still going right at the cut = the cut went into a sound.
Plus the plan's own fact: the cut sits inside the word in the source (what Check calls "word cut off").

Every measure is written for every join (to tune later); flags are a first guess at the rules.

Usage (the pack's Python):
    python join_check.py <job.json>
job.json: {"words": <words_LABEL.json>, "out": <join_LABEL.json>,
           "timelines": [{"name", "audio": <rendered file>, "fps", "start_frame", "pieces": [...]}]}
pieces: ct_read_timeline's picture pieces (record start/end, multicam src_in/src_out).
"""
import importlib.util
import json
import math
import os
import sys
import time

import numpy as np

SR = 16000
HOP = SR // 100                 # 10 ms loudness steps
WINDOW_SEC = 1.6                # audio aligned around each join (each side)
EDGE_SEC = 0.04                 # loudness measured this close to the cut
SQUASH = 0.65                   # aligned length under this share of the source length = squashed
TAIL_SCORE = 0.2                # mean aligner score of the word's last / first two letters under this = weak
LOUD_REL_DB = -12               # sound at the cut louder than the speaker's median speech minus this


def _transcribe():
    """transcribe.py from this folder, for its audio readers (WAV / PyAV / ffmpeg)."""
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("ct_transcribe", os.path.join(here, "transcribe.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def envelope(x: np.ndarray) -> np.ndarray:
    n = len(x) // HOP
    if n == 0:
        return np.zeros(0)
    frames = x[:n * HOP].reshape(n, HOP).astype(np.float64)
    return 20 * np.log10(np.sqrt(np.mean(frames ** 2, axis=1)) + 1e-9)


def kept_words(words: list, pieces: list) -> list:
    """Every word heard on the timeline: which piece, where it sits on the record, how much of it is kept."""
    out = []
    for k, p in enumerate(pieces):
        for w in words:
            mid = (w["s"] + w["e"]) / 2
            if p["src_in"] <= mid < p["src_out"]:
                out.append({"w": str(w["w"]).strip(), "s": w["s"], "e": w["e"], "piece": k,
                            "rec_s": p["start"] + (w["s"] - p["src_in"]), "rec_e": p["start"] + (w["e"] - p["src_in"]),
                            "kept": min(w["e"], p["src_out"]) - max(w["s"], p["src_in"])})
    out.sort(key=lambda x: x["rec_s"])
    return out


def side_measures(word: dict, got: dict, win_rec0: float, fps: float, cut: float, end_side: bool, env, speech_db, t0):
    """The measures for the word just before (end_side) or just after the cut."""
    m = {"w": word["w"], "full": round(word["e"] - word["s"], 1), "kept": round(word["kept"], 1)}
    if got and got.get("start") is not None and got.get("end") is not None:
        s = win_rec0 + got["start"] * fps
        e = win_rec0 + got["end"] * fps
        m["aligned"] = round((got["end"] - got["start"]) * fps, 1)
        m["squash"] = round(m["aligned"] / max(1.0, m["full"]), 2)
        m["gap"] = round((cut - e) if end_side else (s - cut), 1)
        chars = [c for c in (got.get("chars") or []) if c.get("score") is not None and str(c.get("char", "")).strip()]
        edge = chars[-2:] if end_side else chars[:2]
        m["edge_score"] = round(float(np.mean([c["score"] for c in edge])), 2) if edge else None
        m["score"] = round(float(got.get("score") or 0), 2)
    i = int(round((cut - t0) / fps * 100))           # cut in 10 ms steps from the render's start
    n = max(1, int(EDGE_SEC * 100))
    seg = env[max(0, i - n):i] if end_side else env[i:i + n]
    if len(seg):
        m["edge_db"] = round(float(np.max(seg)), 1)
        m["rel_db"] = round(m["edge_db"] - speech_db, 1)
    return m


def side_flags(m: dict, src_cut: bool):
    """A first guess at the rule: the plan's cut inside the word, or two of the three audio signs."""
    signs = []
    if m.get("squash") is not None and m["squash"] < SQUASH and (m.get("gap") or 0) <= 1.5:
        signs.append(f"squashed to {m['squash']:.0%}")
    if m.get("edge_score") is not None and m["edge_score"] < TAIL_SCORE:
        signs.append(f"weak edge {m['edge_score']}")
    if m.get("rel_db") is not None and m["rel_db"] > LOUD_REL_DB:
        signs.append(f"sound at the cut {m['rel_db']:+.0f} dB")
    return signs, (src_cut or len(signs) >= 2)


def check_timeline(t: dict, words: list, model, meta, device, tr) -> dict:
    import whisperx

    fps = float(t.get("fps") or 24)
    t0 = int(t.get("start_frame") or 0)
    pieces = sorted(t["pieces"], key=lambda p: p["start"])
    x = tr.read_audio(t["audio"])
    env = envelope(x)
    heard = kept_words(words, pieces)
    if not heard:
        return {"name": t["name"], "joins": [], "error": "no words on this timeline"}

    def level(a, b):
        i, j = int((a - t0) / fps * 100), int((b - t0) / fps * 100)
        seg = env[max(0, i):max(0, j)]
        return seg
    lv = np.concatenate([level(w["rec_s"] + 1, w["rec_e"] - 1) for w in heard[::3]] or [np.zeros(0)])
    speech_db = float(np.median(lv)) if len(lv) else -30.0

    joins = []
    for k in range(len(pieces) - 1):
        a, b = pieces[k], pieces[k + 1]
        if abs(b["src_in"] - a["src_out"]) <= 1:
            continue                                   # continuous source: an angle change, not a join
        cut = a["end"]
        left = [w for w in heard if w["piece"] == k]
        right = [w for w in heard if w["piece"] == k + 1]
        row = {"rec": cut - t0, "src_end": a["src_out"], "src_start": b["src_in"], "flags": []}
        lo = cut - WINDOW_SEC * fps
        hi = cut + WINDOW_SEC * fps
        win = [w for w in heard if lo <= (w["rec_s"] + w["rec_e"]) / 2 < hi]
        if left and left[-1] not in win:
            win.append(left[-1])
        if right and right[0] not in win:
            win.append(right[0])
        win.sort(key=lambda w: w["rec_s"])
        if win:
            lo = min(lo, win[0]["rec_s"] - 4)
            hi = max(hi, win[-1]["rec_e"] + 4)
        s0 = max(0, int((lo - t0) / fps * SR))
        s1 = min(len(x), int((hi - t0) / fps * SR))
        win_rec0 = t0 + s0 / SR * fps
        got = []
        texts = [w["w"] for w in win]
        if win and s1 - s0 > SR // 10 and all(texts) and not any(" " in s for s in texts):
            try:
                res = whisperx.align([{"text": " ".join(texts), "start": 0.0, "end": (s1 - s0) / SR}], model, meta,
                                     x[s0:s1].astype(np.float32), device, return_char_alignments=True)
                got = [g for seg in res.get("segments", []) for g in seg.get("words", [])]
            except Exception as exc:                   # noqa: BLE001 — one join failing never stops the run
                row["align_error"] = f"{type(exc).__name__}: {exc}"
        aligned = len(got) == len(win)
        row["aligned"] = aligned
        if not aligned and not row.get("align_error"):
            row["align_error"] = f"aligner returned {len(got)} of {len(win)} words"
        # chars per word: WhisperX puts them on the segment; split them by the word boundaries
        if aligned and got and not got[0].get("chars"):
            chars = [c for seg in res.get("segments", []) for c in (seg.get("chars") or [])]
            for g in got:
                if g.get("start") is None:
                    continue
                g["chars"] = [c for c in chars if c.get("start") is not None and g["start"] - 1e-3 <= c["start"] < g["end"] + 1e-3]
        by = {id(w): (got[i] if aligned else None) for i, w in enumerate(win)}
        if left:
            w = left[-1]
            m = side_measures(w, by.get(id(w)), win_rec0, fps, cut, True, env, speech_db, t0)
            src_cut = a["src_out"] < w["e"] - 1
            m["src_cut"] = round(w["e"] - a["src_out"], 1) if src_cut else 0
            signs, flag = side_flags(m, src_cut)
            row["before"] = m
            if flag:
                row["flags"].append({"kind": "clipped_end", "src": a["src_out"], "rec": cut - t0,
                                     "why": "; ".join((["plan cuts into it"] if src_cut else []) + signs) + f' — "{w["w"]}"'})
        if right:
            w = right[0]
            m = side_measures(w, by.get(id(w)), win_rec0, fps, cut, False, env, speech_db, t0)
            src_cut = b["src_in"] > w["s"] + 1
            m["src_cut"] = round(b["src_in"] - w["s"], 1) if src_cut else 0
            signs, flag = side_flags(m, src_cut)
            row["after"] = m
            if flag:
                row["flags"].append({"kind": "clipped_start", "src": b["src_in"], "rec": cut - t0,
                                     "why": "; ".join((["plan cuts into it"] if src_cut else []) + signs) + f' — "{w["w"]}"'})
        joins.append(row)
    return {"name": t["name"], "fps": fps, "speech_db": round(speech_db, 1), "joins": joins,
            "flags": [f for j in joins for f in j["flags"]]}


def main() -> None:
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    tr = _transcribe()
    tr.cuda_dlls()
    import torch
    import whisperx
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, meta = whisperx.load_align_model(language_code="en", device=device)
    wf = json.load(open(job["words"], encoding="utf-8"))
    words = [w for w in wf.get("words", []) if w.get("own", True) and not w.get("ghost")
             and isinstance(w.get("s"), (int, float)) and isinstance(w.get("e"), (int, float))]
    words.sort(key=lambda w: w["s"])
    out = {"madeAt": time.time(), "device": device, "rules": {"squash": SQUASH, "edge_score": TAIL_SCORE, "loud_rel_db": LOUD_REL_DB},
           "timelines": []}
    tls = job["timelines"]
    for i, t in enumerate(tls):
        print(f"▸ Join check {i + 1}/{len(tls)}: {t['name']}", flush=True)
        t_start = time.time()
        try:
            r = check_timeline(t, words, model, meta, device, tr)
        except Exception as exc:                       # noqa: BLE001 — report it, go on with the next
            r = {"name": t["name"], "joins": [], "flags": [], "error": f"{type(exc).__name__}: {exc}"}
        out["timelines"].append(r)
        print(f"  {t['name']}: {len(r.get('joins', []))} joins, {len(r.get('flags', []))} flagged"
              + (f" — {r['error']}" if r.get("error") else "") + f" ({time.time() - t_start:.0f}s)", flush=True)
    with open(job["out"], "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)
    print(f"Wrote {job['out']}", flush=True)


if __name__ == "__main__":
    main()
