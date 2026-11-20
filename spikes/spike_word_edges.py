#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SPIKE: refine one built cut-through timeline from what its audio really plays, then rebuild it.

Whisper fills chopped or doubled words in from context, so a transcript can't tell you that a cut
clipped "important" to "importa", or that "the | the" plays across a join. This listens to the
RENDERED audio of one timeline (crossfades, gating and import offsets included) with two tools that
can't guess from context:
  * greedy CTC decoding with the pack's wav2vec2 model (letters only, no language model): what is
    actually heard, letter by letter. Finds phantom repeats ("the the", "we need to we need to") —
    including ones the transcript never had (Whisper wrote the word once, or Transcribe marked the
    second copy a "ghost") — and truncated words at joins ("impor" where the transcript has "important").
  * join_check.py's forced alignment + edge loudness at every join (the Score measures).
False repeat cuts: Whisper often writes one spoken word twice and the edit cuts a copy as a flub, taking
the real word with it (Elevate: 115 such cuts). Where the plan cut one copy of a doubled word, the decoder
listens at that join; if the kept copy isn't heard whole, the copy is given back.
Existing markers on the timeline (build review markers, Check markers, your own) are hints: a join near
a "cut off" / "clipped" marker is fixed on one sign instead of two, a "repeat" marker widens the repeat
search there, and the report says for every marker whether the audio confirmed it.

Fixes go into a copy of the video's plan (<plan>__refined.json; the original is never changed):
  * clipped end / start at a join → that piece runs on (or starts earlier) to where the word's sound
    really ends (levels file) + 3 fr, at most 12 fr; the mic opens and removals follow.
  * repeat → the first copy goes (the later take is kept). Across a join: the piece before the join ends
    before copy 1. Inside one shot: that source range is cut out and the shot after the new join changes
    angle (no jump cuts). Legit doubles ("that that", "had had", "very very") are marked, never cut.
Every fix also becomes a Cyan "Refined: …" review marker on the rebuilt timeline; the findings go on the
current timeline as markers tagged ct-word-edges (re-runs replace only those).

Narration timelines (audio only, build_narration.py) work too: A1 clips are matched to the plan by length,
fixes patch the plan's kept spans, no angle rules, and the rebuild runs build_narration.py.

Run in Resolve (project open; the timeline as Build left it — a reviewed one won't match its plan):
Workspace → Console → Py3:
    TIMELINE="J1234"; RUN_DIR=r"<run folder>"; exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_word_edges.py", encoding="utf-8").read())
Optional before exec:
    PLAN=r"<run folder>\\<LABEL>__v3_plan.json"   which plan (default: the one in RUN_DIR whose shots match the timeline)
    REBUILD=True       rebuild straight away as "<TIMELINE> refined" (else the report prints the exec line)
    SEQ_BIN="MASTER / SEQUENCES"   where the rebuilt timeline goes
    FIX=False          findings + markers only, no refined plan
    KEEP_RENDER=True   keep the rendered WAV in <RUN_DIR>\\word_edges\\ (default: deleted at the end)
The rebuild imports a new multicam copy (every import does); ARCHIVE is off, so the copy the timeline
uses now stays where it is. Delete the extra copy + whichever timeline loses after comparing.

The analysis half runs in the transcription pack's Python (torch + WhisperX), started from the console:
    <pack python> spike_word_edges.py analyze <job.json>
Report: <RUN_DIR>\\word_edges\\word_edges_<TIMELINE>.txt / .json.
"""
import difflib
import glob
import importlib.util
import json
import os
import re
import subprocess
import sys
import time

CHECKOUT = r"C:\lp-app-ecosystem\editpanel"
TAG = "ct-word-edges"

PAD = 3                     # frames of air kept after / before a word at a moved join (place_cuts' non-scripted pad)
MAX_MOVE = 12               # a join never moves more than this to save a word
MIN_SHOT = 12               # frames: a fix never leaves a shot shorter than this
GIVE_BACK = 36              # frames: a false repeat cut gives back at most this (a whole word)
DOUBLE_GAP_FR = 24          # frames: two same words this close in the transcript count as a doubled word
MIN_ANGLE_SHOT = 36         # frames: a shot given a new angle (to avoid a jump cut) is at least this long
REPEAT_GAP_SEC = 1.2        # copies further apart than this aren't a repeat …
REPEAT_GAP_HINT_SEC = 2.5   # … unless a "repeat" marker sits there
HINT_REACH = 12             # frames: a marker this close to a join / repeat counts as its hint
LEGIT_DOUBLES = {"that", "had", "very", "no", "yeah", "really", "bye", "is"}
EDGE_HINT = re.compile(r"cut off|clipped|word|tail|chopped", re.I)
REPEAT_HINT = re.compile(r"repeat|twice|double|stutter|again", re.I)


# ───────────────────────────── shared ─────────────────────────────

def norm(w):
    return re.sub(r"[^a-z']", "", str(w).lower()).strip("'")


def same_word(a, b):
    """Copy 1 (a) against copy 2 (b). CTC spelling is rough ("becaus", "importent") and copy 1 may be cut
    short ("importa" … "important"): a match is equal, copy 1 a 3+ letter start of copy 2, or close spelling
    on 5+ letters of about the same length. Not "then"/"the", "we"/"were", "ground"/"background"."""
    if not a or not b:
        return False
    if a == b:
        return True
    if len(a) >= 3 and len(b) > len(a) and b.startswith(a):
        return True
    return min(len(a), len(b)) >= 5 and abs(len(a) - len(b)) <= 1 and difflib.SequenceMatcher(None, a, b).ratio() >= 0.8


def narration_pieces(plan, day):
    """A narration plan's kept spans (session clock) → the clips build_narration.py appends, in order:
    split at file edges. [{src_in, src_out}] on the session clock (the words' clock)."""
    fsec = day["frame_sec"][0] / day["frame_sec"][1]
    talker = (plan.get("audio") or {}).get("angle") or next(iter(plan.get("mics") or {}), None)
    out = []
    for a, b in [list(map(int, k[:2])) for k in (plan.get("mics") or {}).get(talker) or []]:
        for c in day["mics"]:
            cf, ct = int(round(c["from_sec"] / fsec)), int(round(c["to_sec"] / fsec))
            x, y = max(a, cf), min(b, ct)
            if y > x:
                out.append({"src_in": x, "src_out": y})
    return out


# ─────────────────────── analysis (pack Python) ───────────────────────

def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def greedy_words(x, model, meta, device, sr=16000, chunk_sec=20.0, overlap_sec=1.0):
    """Letters the acoustic model hears, no language model: [{w, s, e, p}] in seconds from the render start."""
    import numpy as np
    import torch

    d = meta["dictionary"]
    inv = {i: c for c, i in d.items()}
    blank = d.get("[pad]", d.get("<pad>", 0))
    sep = "|" if "|" in d else " "
    out = []
    step = int((chunk_sec - 2 * overlap_sec) * sr)
    n = len(x)
    pos = 0
    while pos < n:
        a = max(0, pos - int(overlap_sec * sr))
        b = min(n, pos + step + int(overlap_sec * sr))
        wav = torch.from_numpy(np.ascontiguousarray(x[a:b], dtype=np.float32)).unsqueeze(0).to(device)
        with torch.inference_mode():
            if meta.get("type") == "huggingface":
                em = model(wav).logits
            else:
                em, _ = model(wav)
            em = torch.log_softmax(em, dim=-1)[0].cpu()
        prob, ids = em.max(dim=-1)
        prob, ids = prob.exp().numpy(), ids.numpy()
        T = len(ids)
        sec = (b - a) / sr / max(1, T)
        got, cur, prev = [], None, None
        for t in range(T):
            i = int(ids[t])
            if i == blank:
                prev = i
                continue
            ch = inv.get(i, "")
            if ch == sep or ch == " ":
                if cur:
                    got.append(cur)
                    cur = None
                prev = i
                continue
            if i == prev and cur is not None:          # CTC: a held letter, not a new one
                cur["e"] = a / sr + (t + 1) * sec
                cur["ps"].append(float(prob[t]))
                continue
            if cur is None:
                cur = {"w": "", "s": a / sr + t * sec, "e": a / sr + (t + 1) * sec, "ps": []}
            cur["w"] += ch
            cur["e"] = a / sr + (t + 1) * sec
            cur["ps"].append(float(prob[t]))
            prev = i
        if cur:
            got.append(cur)
        # the overlaps are decoded twice: keep the words that start in this chunk's own stretch
        lo = pos / sr if pos else 0.0
        hi = (pos + step) / sr if pos + step < n else 1e9
        out += [w for w in got if lo <= w["s"] < hi]
        pos += step
    words = []
    for w in out:
        t = norm(w["w"])
        if t:
            words.append({"w": t, "s": w["s"], "e": w["e"], "p": round(sum(w["ps"]) / max(1, len(w["ps"])), 2)})
    words.sort(key=lambda w: w["s"])
    return words


def analyze(job_path):
    job = json.load(open(job_path, encoding="utf-8"))
    here = os.path.dirname(os.path.abspath(__file__))
    pipe = job.get("pipeline") or os.path.join(os.path.dirname(here), "cut_through")
    jc = _load(os.path.join(pipe, "join_check.py"), "ct_join_check")
    tr = jc._transcribe()
    tr.cuda_dlls()
    import numpy as np  # noqa: F401
    import torch
    import whisperx
    device = "cuda" if torch.cuda.is_available() else "cpu"
    t_start = time.time()
    print(f"▸ Loading the aligner ({device})", flush=True)
    model, meta = whisperx.load_align_model(language_code="en", device=device)

    fps = float(job["fps"])
    t0 = int(job["start_frame"])
    pieces = sorted(job["pieces"], key=lambda p: p["start"])
    plan = json.load(open(job["plan"], encoding="utf-8"))
    video = plan["video"]
    wf = json.load(open(job["words"], encoding="utf-8"))
    all_words = [w for w in wf.get("words", []) if isinstance(w.get("s"), (int, float)) and isinstance(w.get("e"), (int, float))]
    words = sorted((w for w in all_words if w.get("own", True) and not w.get("ghost")), key=lambda w: w["s"])
    ghosts = [w for w in all_words if w.get("ghost")]

    # levels of the plan's mics (loudest per frame), as place_cuts.py reads them
    lvj = json.load(open(job["levels"], encoding="utf-8")) if job.get("levels") and os.path.exists(job["levels"]) else None
    LV = None
    if lvj:
        roles = list(plan.get("mics") or {}) or [(plan.get("audio") or {}).get("angle")]
        tracks = [lvj["mics"][r] for r in roles if r in lvj["mics"]] or list(lvj["mics"].values())[:1]
        f0 = min(int(t["start"]) for t in tracks)
        f1 = max(int(t["start"]) + len(t["db"]) for t in tracks)
        comb = [-100.0] * (f1 - f0)
        for t in tracks:
            for i, v in enumerate(t["db"]):
                j = int(t["start"]) + i - f0
                comb[j] = max(comb[j], v)
        LV = (f0, comb)

    def lvl(f):
        if not LV:
            return -100.0
        i = int(f) - LV[0]
        return LV[1][i] if 0 <= i < len(LV[1]) else -100.0

    THR = -100.0
    if LV:
        inside = [lvl(f) for w in words[::3] for f in range(int(w["s"]) + 1, int(w["e"]))]
        speech = sorted(inside)[len(inside) // 2] if inside else -30.0
        floor = sorted(LV[1])[len(LV[1]) // 10] if LV[1] else -100.0
        THR = max(floor + 6, speech - 24)

    def sound(f):
        return lvl(f) > THR

    # timeline piece ↔ plan piece (the console half checked they match)
    def piece_at(rec):
        for k, p in enumerate(pieces):
            if p["start"] <= rec < p["end"]:
                return k
        return len(pieces) - 1 if rec >= pieces[-1]["end"] else 0

    def src_of(rec):
        k = piece_at(rec)
        p = pieces[k]
        return k, p["src_in"] + (rec - p["start"])

    joins = [k for k in range(len(pieces) - 1) if abs(pieces[k + 1]["src_in"] - pieces[k]["src_out"]) > 1]
    markers = [{**m, "abs": t0 + int(m["rec"])} for m in job.get("markers") or []]

    def hint_near(rec_abs, rx, reach=HINT_REACH):
        return [m for m in markers if abs(m["abs"] - rec_abs) <= reach and rx.search(f"{m.get('name', '')} {m.get('note', '')}")]

    # 1. forced alignment + edge loudness at every join (Score's measures)
    print("▸ Join check (forced alignment) on the render", flush=True)
    jt = jc.check_timeline({"name": job["name"], "audio": job["render"], "fps": fps, "start_frame": t0, "pieces": pieces},
                           words, model, meta, device, tr)
    by_cut = {t0 + int(j["rec"]): j for j in jt.get("joins", [])}

    # 2. what is heard, no context
    print("▸ Decoding the render letter by letter (no language model)", flush=True)
    x = tr.read_audio(job["render"])
    heard = greedy_words(x, model, meta, device)
    for h in heard:
        h["rs"] = t0 + h["s"] * fps
        h["re"] = t0 + h["e"] * fps
    expected = jc.kept_words(words, pieces)          # rec_s/rec_e absolute record frames

    findings = []

    # 3a. edges at joins
    for k in joins:
        a, b = pieces[k], pieces[k + 1]
        cut = a["end"]
        row = by_cut.get(cut) or {}
        left = [w for w in expected if w["piece"] == k]
        right = [w for w in expected if w["piece"] == k + 1]
        edge_hint = hint_near(cut, EDGE_HINT)
        for side in ("before", "after"):
            m = row.get(side)
            w = (left[-1] if left else None) if side == "before" else (right[0] if right else None)
            if not m or not w:
                continue
            src_cut = bool(m.get("src_cut"))
            signs, flagged = jc.side_flags(m, src_cut)
            # what the decoder heard nearest the cut on this side
            if side == "before":
                near = [h for h in heard if cut - 30 <= h["re"] <= cut + 2]
            else:
                near = [h for h in heard if cut - 2 <= h["rs"] <= cut + 30]
            got = (near[-1] if side == "before" else near[0]) if near else None
            want = norm(w["w"])
            trunc = bool(got and want and len(got["w"]) < len(want) and
                         (want.startswith(got["w"]) if side == "before" else want.endswith(got["w"])) and len(want) - len(got["w"]) >= 1)
            if trunc:
                signs.append(f"heard \"{got['w']}\" for \"{want}\"")
            fix = flagged or (trunc and len(signs) >= 2) or (edge_hint and len(signs) >= 1)
            if not (fix or signs or edge_hint):
                continue
            findings.append({"kind": "clipped_end" if side == "before" else "clipped_start", "rec": cut, "piece": k,
                             "word": w["w"].strip(), "w_s": w["s"], "w_e": w["e"], "signs": signs, "fix": bool(fix),
                             "hints": [h["name"] for h in edge_hint], "measures": m})

    # 3b. repeats in what is heard
    i = 0
    while i < len(heard):
        hit = None
        for n in (3, 2, 1):
            A, B = heard[i:i + n], heard[i + n:i + 2 * n]
            if len(B) < n:
                continue
            if n == 1 and len(A[0]["w"]) < 2 and A[0]["w"] not in ("i", "a"):
                continue
            if not all(same_word(p["w"], q["w"]) for p, q in zip(A, B)):
                continue
            gap = (B[0]["s"] - A[-1]["e"])
            hint = hint_near(int(A[0]["rs"]), REPEAT_HINT, reach=48) or hint_near(int(B[-1]["re"]), REPEAT_HINT, reach=48)
            if gap > (REPEAT_GAP_HINT_SEC if hint else REPEAT_GAP_SEC):
                continue
            hit = (n, A, B, hint)
            break
        if not hit:
            i += 1
            continue
        n, A, B, hint = hit
        s1, e1, s2, e2 = A[0]["rs"], A[-1]["re"], B[0]["rs"], B[-1]["re"]
        text = " ".join(h["w"] for h in A)
        # does the transcript have both copies here? (if not, it's a phantom: nobody planning saw it)
        exp = [norm(w["w"]) for w in expected if s1 - 4 <= (w["rec_s"] + w["rec_e"]) / 2 <= e2 + 4]
        firsts = [j for j in range(len(exp)) if same_word(exp[j], A[0]["w"])]
        in_tx = any(all(j + n + t < len(exp) and same_word(exp[j + t], A[t]["w"]) and same_word(exp[j + n + t], B[t]["w"])
                        for t in range(n)) for j in firsts)
        across = [k for k in joins if s1 - 3 <= pieces[k]["end"] <= e2 + 3]
        k1, src1 = src_of(int(s1))
        _, src2 = src_of(int(s2))
        ghost = [g for g in ghosts if src1 - 4 <= g["s"] <= src2 + 24 and same_word(norm(g["w"]), A[0]["w"])]
        legit = n == 1 and A[0]["w"] in LEGIT_DOUBLES
        findings.append({"kind": "repeat", "rec": int(s1), "rec2": int(s2), "rec_end": int(e2), "n": n,
                         "text": f"{text} {' '.join(h['w'] for h in B)}", "phantom": not in_tx, "across_join": bool(across),
                         "ghost_marked": bool(ghost), "fix": not legit, "legit": legit,
                         "hints": [h["name"] for h in hint], "conf": round(min(h["p"] for h in A + B), 2)})
        i += 2 * n

    # 3c. false repeat cuts: Whisper often writes one spoken word twice, and the edit cuts a copy as a flub
    # (Elevate: 115 such cuts, 2026-11-20) — which takes the real word with it. Where the plan cut one copy
    # of a doubled word, listen at that join: if the kept copy doesn't come out whole, it was never said twice.
    def is_kept(w):
        mid = (w["s"] + w["e"]) / 2
        return any(p["src_in"] <= mid < p["src_out"] for p in pieces)

    def whole_word(h, want):
        return h == want or (len(want) >= 5 and abs(len(h) - len(want)) <= 1
                             and difflib.SequenceMatcher(None, h, want).ratio() >= 0.8)

    seen = set()
    for a, b in zip(words, words[1:]):
        if norm(a["w"]) != norm(b["w"]) or len(norm(a["w"])) < 2 or b["s"] - a["e"] > DOUBLE_GAP_FR:
            continue
        ka, kb = is_kept(a), is_kept(b)
        if ka == kb:
            continue
        gone, kept_w = (a, b) if kb else (b, a)
        gm = (gone["s"] + gone["e"]) / 2
        k = next((k for k in joins if pieces[k]["src_out"] <= gm < pieces[k + 1]["src_in"]), None)
        if k is None or k in seen:
            continue
        side = "after" if kb else "before"           # where the kept copy sits against the join
        kp = pieces[k + 1] if side == "after" else pieces[k]
        if not kp["src_in"] <= (kept_w["s"] + kept_w["e"]) / 2 < kp["src_out"]:
            continue
        seen.add(k)
        cut = pieces[k]["end"]
        want = norm(kept_w["w"])
        # where the kept copy plays on the timeline; only what is heard right there counts
        ks = kp["start"] + (kept_w["s"] - kp["src_in"])
        ke = kp["start"] + (kept_w["e"] - kp["src_in"])
        near = [h for h in heard if h["re"] > ks - 6 and h["rs"] < ke + 6]
        whole = any(whole_word(h["w"], want) for h in near)
        part = next((h["w"] for h in near if len(h["w"]) < len(want) and (want.startswith(h["w"]) or want.endswith(h["w"]))), None)
        m = (by_cut.get(cut) or {}).get(side) or {}
        signs = jc.side_flags(m, False)[0] if m else []
        hint = hint_near(cut, EDGE_HINT) + hint_near(cut, REPEAT_HINT)
        if whole and not hint:
            continue                                   # the kept copy plays whole: the cut was fine
        weak = min(a.get("p", 1), b.get("p", 1)) < 0.8
        close = b["s"] - a["e"] <= 6
        reasons = ([] if whole else [f"heard \"{part}\" for \"{want}\"" if part else f"\"{want}\" not heard whole at the join"]) \
            + signs + (["a copy Whisper doubted"] if weak else []) + (["copies touch"] if close else [])
        rem = next((r for r in plan.get("removals") or [] if r["from"] - 3 <= gm <= r["to"] + 3), None)
        findings.append({"kind": "false_repeat_cut", "rec": cut, "piece": k, "side": side, "word": kept_w["w"].strip(),
                         "gone_s": gone["s"], "gone_e": gone["e"], "kept_s": kept_w["s"], "kept_e": kept_w["e"],
                         "p": [a.get("p"), b.get("p")], "gap": round(b["s"] - a["e"], 1), "why_cut": (rem or {}).get("why", ""),
                         "heard": " ".join(h["w"] for h in near), "signs": reasons, "whole": whole,
                         "fix": (not whole) and bool(part or signs or weak or close or hint), "hints": [h["name"] for h in hint]})

    # 4. the refined plan
    fixes = []
    narr = bool(plan.get("narration"))
    talker = (plan.get("audio") or {}).get("angle") or next(iter(plan.get("mics") or {}), None)
    if narr:                                         # sound only: the kept spans are the "shots", one "angle" —
        video = []                                   # read off the timeline as it is now (your edits included)
        for p in pieces:
            if video and abs(p["src_in"] - video[-1]["out"]) <= 0:
                video[-1]["out"] = p["src_out"]      # a file edge, not a cut
            else:
                video.append({"in": int(p["src_in"]), "out": int(p["src_out"]), "angle": talker})
    new_video = [dict(v) for v in video]
    mics = {r: [list(o) for o in opens] for r, opens in (plan.get("mics") or {}).items()}
    removals = [dict(r) for r in plan.get("removals") or []]
    angles_used = []
    for v in video:
        if v["angle"] not in angles_used:
            angles_used.append(v["angle"])

    def first_sound_end(f_end, reach=MAX_MOVE):
        """Last frame with sound in [f_end-2, f_end+reach] (the word's real tail), else the word end."""
        last = None
        for f in range(int(f_end) - 2, int(f_end) + reach + 1):
            if sound(f):
                last = f
            elif last is not None and f - last > 2:
                break
        return (last + 1) if last is not None else int(round(f_end))

    def first_sound_start(f_start, reach=MAX_MOVE):
        first = None
        for f in range(int(f_start) + 2, int(f_start) - reach - 1, -1):
            if sound(f):
                first = f
            elif first is not None and first - f > 2:
                break
        return first if first is not None else int(round(f_start))

    def quiet_before(f, back=6):
        """The quietest frame in the few before f (where to cut before a word)."""
        cands = list(range(int(f) - back, int(f) + 1))
        return min(cands, key=lambda c: (lvl(c), -c)) if LV else int(f) - 1

    def move_mic(old, new, end_side):
        if narr:
            return                                   # narration: the spans ARE the shots, written at the end
        for opens in mics.values():
            for o in opens:
                if end_side and abs(o[1] - old) <= 3 and new > o[1]:
                    o[1] = new
                if not end_side and abs(o[0] - old) <= 3 and new < o[0]:
                    o[0] = new

    def move_removal(old, new, end_side):
        for r in removals:
            if end_side and abs(r["from"] - old) <= 1 and new > r["from"]:
                r["from"] = min(new, r["to"])
            if not end_side and abs(r["to"] - old) <= 1 and new < r["to"]:
                r["to"] = max(new, r["from"])

    by_use = sorted(angles_used, key=lambda x: -sum(v["out"] - v["in"] for v in video if v["angle"] == x))

    def jump(x, y):
        return abs(y["in"] - x["out"]) > 1 and x["angle"] == y["angle"]

    def no_jumps(vs, fresh):
        """Re-angle a new part (one of `fresh`, long enough) wherever a source jump has the same angle on
        both sides. Returns (shots, notes) or None when a jump can't be cleared without a flash shot."""
        vs = [dict(v) for v in vs]
        notes = []
        for i in range(len(vs) - 1):
            if not jump(vs[i], vs[i + 1]):
                continue
            done = False
            for j in (i + 1, i):                       # the part after the join first, then the one before
                if vs[j]["in"] not in fresh or vs[j]["out"] - vs[j]["in"] < MIN_ANGLE_SHOT:
                    continue
                bad = {vs[j]["angle"]}
                if j > 0 and abs(vs[j]["in"] - vs[j - 1]["out"]) > 1:
                    bad.add(vs[j - 1]["angle"])
                if j + 1 < len(vs) and abs(vs[j + 1]["in"] - vs[j]["out"]) > 1:
                    bad.add(vs[j + 1]["angle"])
                alt = next((x for x in by_use if x not in bad), None)
                if alt:
                    vs[j] = {**vs[j], "angle": alt, "why": "refine: angle changed at a cut-out repeat"}
                    notes.append(alt)
                    done = True
                    break
            if not done:
                return None
        return vs, notes

    def cut_out(a, b, why):
        """Remove source [a, b) from the plan's shots, keeping the no-jump-cut and no-flash-shot rules."""
        nonlocal new_video
        out, fresh = [], set()
        for v in new_video:
            if v["out"] <= a or v["in"] >= b:
                out.append(v)
                continue
            if v["in"] < a:
                out.append({**v, "out": a})
            if v["out"] > b:
                out.append({**v, "in": b})
                fresh.add(b)
            if v["in"] < a:
                fresh.add(v["in"])
        if any(v["out"] - v["in"] < MIN_SHOT for v in out if v not in new_video):
            return "not fixed (would leave a shot under %d fr)" % MIN_SHOT
        got = (out, []) if narr else no_jumps(out, fresh)   # narration: no picture, no jump cuts
        if got is None:
            return "not fixed (no angle change without a jump cut or a flash shot)"
        new_video, notes = got
        removals.append({"from": int(a), "to": int(b), "why": why})
        return f"cut {b - a} fr" + (f", re-angled to {', '.join(notes)}" if notes else "")

    def shot_with(src):
        return next((v for v in new_video if v["in"] <= src < v["out"]), None)

    # repeats first (the later copy is kept), from the end so earlier source frames stay put
    fixed_joins = set()
    for f in sorted((f for f in findings if f["fix"] and f["kind"] == "repeat"), key=lambda f: -f["rec"]):
        k1, s1 = src_of(f["rec"])
        _, s2 = src_of(f["rec2"])
        a = quiet_before(s1)
        jk = next((k for k in joins if f["rec"] - 3 <= pieces[k]["end"] <= f["rec_end"] + 3), None)
        if jk is not None and k1 <= jk:
            # copy 1 is before the join: the shot before the join ends before it
            v = shot_with(s1)
            b = v["out"] if v else pieces[jk]["src_out"]
            fixed_joins.add(jk)
        else:
            b = quiet_before(s2)                       # both copies in one run of source: cut copy 1 out
        if b - a < 2:
            f["result"] = "not fixed (copies overlap)"
            continue
        f["result"] = cut_out(a, b, f"refine: repeat \"{f['text']}\"")
        if f["result"].startswith("cut"):
            fixes.append({"kind": "repeat", "src": a, "to": b, "text": f["text"]})
        else:
            fixed_joins.discard(jk)

    # then false repeat cuts: the copy the plan cut goes back (the join opens to the whole word's sound)
    for f in sorted((f for f in findings if f["fix"] and f["kind"] == "false_repeat_cut"), key=lambda f: f["rec"]):
        k = f["piece"]
        if k in fixed_joins:
            f["result"] = "left (a repeat cut moved this join)"
            continue
        if f["side"] == "after":                       # copy 1 was cut: the shot after the join starts earlier
            old = pieces[k + 1]["src_in"]
            v = next((x for x in new_video if x["in"] == old), None)
            pv = next((x for x in new_video if x["out"] == pieces[k]["src_out"]), None)
            # back to where the kept word's own sound starts (one run of sound: a real earlier word
            # after a silence stays out)
            # copies that touch are one word split in two: back to the cut copy's start; apart, the kept
            # copy is the word and its start runs at most MAX_MOVE early (else a removed redo comes back)
            lim = f["gone_s"] if f["gap"] <= 6 else f["kept_s"] - MAX_MOVE
            target = max(first_sound_start(f["kept_s"], GIVE_BACK) - PAD, int(lim) - PAD, old - GIVE_BACK)
            if pv and target <= pv["out"] <= old:       # meets the shot before: plays on as one take
                target = pv["out"]
            ok = v is not None and target < old
            if ok:
                v["in"] = target
        else:                                          # copy 2 was cut: the shot before the join ends later
            old = pieces[k]["src_out"]
            v = next((x for x in new_video if x["out"] == old), None)
            nv = next((x for x in new_video if x["in"] == pieces[k + 1]["src_in"]), None)
            lim = f["gone_e"] if f["gap"] <= 6 else f["kept_e"] + MAX_MOVE
            target = min(first_sound_end(f["kept_e"], GIVE_BACK) + PAD, int(lim + 0.999) + PAD, old + GIVE_BACK)
            if nv and old <= nv["in"] <= target:
                target = nv["in"]
            ok = v is not None and target > old
            if ok:
                v["out"] = target
        if not ok:
            f["result"] = "not fixed (shot not found or no room)"
            continue
        move_mic(old, target, f["side"] == "before")
        move_removal(old, target, f["side"] == "before")
        fixed_joins.add(k)
        f["result"] = f"copy given back ({abs(target - old)} fr)"
        fixes.append({"kind": "false_repeat_cut", "src": old, "to": target, "word": f["word"]})

    # then words clipped at a join: the join moves to the word's real edge
    for f in sorted((f for f in findings if f["fix"] and f["kind"].startswith("clipped")), key=lambda f: f["rec"]):
        k = f["piece"]
        if k in fixed_joins:
            f["result"] = "left (this join already moved)"
            continue
        if f["kind"] == "clipped_end":
            old = pieces[k]["src_out"]
            v = next((x for x in new_video if x["out"] == old), None)
            nv = next((x for x in new_video if x["in"] == pieces[k + 1]["src_in"]), None)
            if not v:
                f["result"] = "not fixed (shot not found)"
                continue
            target = min(max(first_sound_end(f["w_e"]) + PAD, old + 2), old + MAX_MOVE)
            if nv and old < nv["in"] < target:            # never run into the source the next shot plays
                target = nv["in"]
            if target <= old:
                f["result"] = "not fixed (no room)"
                continue
            v["out"] = target
            move_mic(old, target, True)
            move_removal(old, target, True)
            f["result"] = f"shot ends {target - old} fr later"
        else:
            old = pieces[k + 1]["src_in"]
            v = next((x for x in new_video if x["in"] == old), None)
            pv = next((x for x in new_video if x["out"] == pieces[k]["src_out"]), None)
            if not v:
                f["result"] = "not fixed (shot not found)"
                continue
            target = max(min(first_sound_start(f["w_s"]) - PAD, old - 2), old - MAX_MOVE)
            if pv and target < pv["out"] <= old:
                target = pv["out"]
            if target >= old:
                f["result"] = "not fixed (no room)"
                continue
            v["in"] = target
            move_mic(old, target, False)
            move_removal(old, target, False)
            f["result"] = f"shot starts {old - target} fr earlier"
        fixes.append({"kind": f["kind"], "src": old, "to": target, "word": f["word"]})

    # 5. markers: what happened to each
    for m in markers:
        near = [f for f in findings if abs(f["rec"] - m["abs"]) <= HINT_REACH
                or (f["kind"] == "repeat" and f["rec"] - HINT_REACH <= m["abs"] <= f.get("rec_end", f["rec"]) + HINT_REACH)]
        m["status"] = ("; ".join(f"{f['kind']} {f.get('result', 'flag only')}" for f in near) if near else "nothing heard here")

    out_dir = job["out_dir"]
    name = job["name"]
    result = {"name": name, "plan": job["plan"], "device": device, "seconds": round(time.time() - t_start, 1),
              "joins": len(joins), "heard_words": len(heard), "findings": findings, "fixes": fixes,
              "markers": [{k: m[k] for k in ("rec", "name", "color", "note", "status") if k in m} for m in markers]}

    if job.get("fix", True) and fixes:
        stem = job["plan"][:-5] if job["plan"].endswith(".json") else job["plan"]
        refined = f"{stem}__refined.json"
        rp = dict(plan)
        if narr:
            spans = []
            for v in new_video:                      # back to kept spans, continuous ones joined
                if spans and abs(v["in"] - spans[-1][1]) <= 0:
                    spans[-1][1] = v["out"]
                else:
                    spans.append([v["in"], v["out"]])
            rp["mics"] = {**mics, talker: spans}
        else:
            rp["video"] = new_video
            rp["mics"] = mics
        rp["removals"] = sorted((r for r in removals if r["to"] > r["from"]), key=lambda r: r["from"])
        rp["refined_from"] = os.path.basename(job["plan"])
        rp["refine"] = fixes
        # review markers: the plan's own + one Cyan per fix (source frames, as Build reads them)
        rv = {"markers": []}
        if plan.get("review_file") and os.path.exists(plan["review_file"]):
            rv = json.load(open(plan["review_file"], encoding="utf-8"))
        else:
            local = os.path.join(os.path.dirname(job["plan"]), os.path.basename(str(plan.get("review_file") or "")))
            if plan.get("review_file") and os.path.exists(local):
                rv = json.load(open(local, encoding="utf-8"))
        for fx in fixes:
            label = fx.get("text") or fx.get("word") or ""
            what = {"repeat": "repeat cut", "clipped_end": "word end given back", "clipped_start": "word start given back",
                    "false_repeat_cut": "false repeat given back"}[fx["kind"]]
            rv["markers"].append({"frame": int(min(fx["src"], fx["to"])), "color": "Cyan",
                                  "name": f"Refined: {what}", "note": f"\"{label}\" ({fx['src']} → {fx['to']})"})
        rv["markers"].sort(key=lambda m: m["frame"])
        rv_path = os.path.join(out_dir, f"review_{os.path.basename(stem)}__refined.json")
        json.dump(rv, open(rv_path, "w", encoding="utf-8"), indent=1)
        rp["review_file"] = rv_path
        json.dump(rp, open(refined, "w", encoding="utf-8"), indent=1)
        result["refined_plan"] = refined
    json.dump(result, open(os.path.join(out_dir, f"word_edges_{_safe_name(name)}.json"), "w", encoding="utf-8"), indent=1)
    print(f"✓ {len(findings)} finding(s), {len(fixes)} fix(es) in {result['seconds']}s", flush=True)


class Stop(RuntimeError):
    """A reason the console run stops (Resolve's console swallows SystemExit silently)."""


def _safe_name(s):
    return re.sub(r"[^\w.-]+", "_", str(s))


# ─────────────────────── Resolve console half ───────────────────────

def _console():
    g = globals()
    r = g.get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    run_dir = g.get("RUN_DIR")
    if not run_dir or not os.path.isdir(run_dir):
        raise Stop("Set RUN_DIR to the Cut-through run folder first (the one with words_<LABEL>.json)")
    project = r.GetProjectManager().GetCurrentProject()
    tl = None
    want = g.get("TIMELINE")
    for i in range(1, int(project.GetTimelineCount() or 0) + 1):
        t = project.GetTimelineByIndex(i)
        if want and t.GetName() == want:
            tl = t
    tl = tl or (None if want else project.GetCurrentTimeline())
    if tl is None:
        raise Stop(f"No timeline named {want!r}")
    name = tl.GetName()
    out_dir = os.path.join(run_dir, "word_edges")
    os.makedirs(out_dir, exist_ok=True)
    lines = []

    def say(m=""):
        print(m)
        lines.append(str(m))

    # the timeline's picture pieces (same read as ct_read_timeline)
    fps = float(tl.GetSetting("timelineFrameRate") or 24)
    by_track = {}
    for t in range(1, int(tl.GetTrackCount("video") or 0) + 1):
        for it in tl.GetItemListInTrack("video", t) or []:
            mpi = it.GetMediaPoolItem()
            if not mpi or "multicam" not in str(mpi.GetClipProperty("Type") or "").lower():
                continue
            by_track.setdefault(t, []).append({"mc": mpi.GetName(), "start": int(it.GetStart()), "end": int(it.GetEnd()),
                                               "src_in": int(round(float(it.GetSourceStartFrame()))),
                                               "src_out": int(round(float(it.GetSourceEndFrame())))})
    narr = not by_track
    t0 = int(tl.GetStartFrame() or 0)
    plan_path = g.get("PLAN")
    note = ""
    if narr:
        # no multicam picture: a narration timeline (build_narration.py). Each A1 clip is a stretch of one
        # session WAV; the day file says where each WAV sits on the session clock (the words' clock), so the
        # timeline is read as it is now, edits included, and the plan is only where the fixes are written.
        items = sorted(tl.GetItemListInTrack("audio", 1) or [], key=lambda it: it.GetStart())
        if not items:
            raise Stop(f"{name}: no multicam pieces on a video track and no clips on A1")
        nrm = lambda x: os.path.normcase(os.path.normpath(str(x or "")))
        day, day_path = None, None
        for dp in glob.glob(os.path.join(glob.escape(run_dir), "day_*.json")):
            try:
                d = json.load(open(dp, encoding="utf-8"))
            except Exception:
                continue
            if d.get("source") == "audio_timeline":
                day, day_path = d, dp
                break
        if not day:
            raise Stop(f"No narration day_<LABEL>.json in {run_dir}")
        fsec = day["frame_sec"][0] / day["frame_sec"][1]
        files = {nrm(m["path"]): m for m in day["mics"]}
        files.update({os.path.basename(nrm(m["path"])): m for m in day["mics"]})
        pieces, skipped, ratios = [], [], []
        for it in items:
            mpi = it.GetMediaPoolItem()
            fp = nrm(mpi.GetClipProperty("File Path")) if mpi else ""
            m = files.get(fp) or files.get(os.path.basename(fp))
            st, en = int(it.GetStart()), int(it.GetEnd())
            si, so = it.GetSourceStartFrame(), it.GetSourceEndFrame()
            if not m or si is None or en <= st:
                skipped.append(str(it.GetName()))
                continue
            if so is not None and float(so) > float(si):
                ratios.append((float(so) - float(si)) / (en - st))
            pieces.append({"start": st, "end": en, "_si": float(si), "_zero": m["file_zero_sec"] / fsec})
        if not pieces:
            raise Stop(f"{name}: none of the A1 clips is a file from {os.path.basename(day_path)}")
        ratio = sorted(ratios)[len(ratios) // 2] if ratios else 1.0
        unit = 1.0 if abs(ratio - 1) < 0.05 else ratio      # source frames, or samples per timeline frame
        for p in pieces:
            p["src_in"] = int(round(p.pop("_zero") + p.pop("_si") / unit))
            p["src_out"] = p["src_in"] + (p["end"] - p["start"])
        if skipped:
            note = f"{len(skipped)} A1 clip(s) not from the session files, left out: {', '.join(skipped[:5])}"
        label = str(day.get("label") or os.path.basename(day_path)[4:-5])
        if not plan_path:                                   # the narration plan this timeline covers most of
            best = (0.0, None)
            kept_f = sum(p["src_out"] - p["src_in"] for p in pieces)
            for pth in glob.glob(os.path.join(glob.escape(run_dir), f"{glob.escape(label)}*_plan.json")) \
                    + glob.glob(os.path.join(glob.escape(run_dir), f"{glob.escape(label)}*__refined.json")):
                try:
                    pl = json.load(open(pth, encoding="utf-8"))
                except Exception:
                    continue
                if not pl.get("narration"):
                    continue
                spans = narration_pieces(pl, day)
                inside = sum(max(0, min(p["src_out"], q["src_out"]) - max(p["src_in"], q["src_in"])) for p in pieces for q in spans
                             if q["src_in"] < p["src_out"] and p["src_in"] < q["src_out"])
                sc = inside / max(1, kept_f)
                if sc > best[0]:
                    best = (sc, pth)
            if best[0] < 0.5:
                raise Stop(f"No narration plan in {run_dir} covers {name} ({best[0]:.0%} at best). Set PLAN=r\"…\" to force one.")
            plan_path = best[1]
        plan = json.load(open(plan_path, encoding="utf-8"))
        as_built = narration_pieces(plan, day)
        same = len(as_built) == len(pieces) and all(abs(p["src_in"] - q["src_in"]) <= 1 and abs(p["src_out"] - q["src_out"]) <= 1
                                                     for p, q in zip(pieces, as_built))
        say(f"Word edges — {name} — plan {os.path.basename(plan_path)} — {len(pieces)} clips (narration"
            + (", as built)" if same else f", edited since Build: {len(as_built)} clips then; the refined plan starts from the timeline as it is now)")
            + ("" if unit == 1.0 else f" [source in units of {unit:.0f}/frame]"))
        if note:
            say("  " + note)
    else:
        pieces = sorted(by_track[max(by_track, key=lambda k: len(by_track[k]))], key=lambda p: p["start"])

        def match(plan):
            vid = plan.get("video") or []
            if plan.get("narration") or len(vid) != len(pieces):
                return 0.0
            return sum(abs(v["in"] - p["src_in"]) <= 1 and abs(v["out"] - p["src_out"]) <= 1 for v, p in zip(vid, pieces)) / len(pieces)
        if not plan_path:
            best = (0.0, None)
            for pth in glob.glob(os.path.join(glob.escape(run_dir), "*_plan.json")) + glob.glob(os.path.join(glob.escape(run_dir), "*__refined.json")):
                try:
                    sc = match(json.load(open(pth, encoding="utf-8")))
                except Exception:
                    continue
                if sc > best[0]:
                    best = (sc, pth)
            plan_path = best[1] if best[0] >= 0.9 else None
            if not plan_path:
                raise Stop(f"No plan in {run_dir} matches {name}'s shots (edited after Build?). Set PLAN=r\"…\" to force one.")
        plan = json.load(open(plan_path, encoding="utf-8"))
        sc = match(plan)
        if sc < 0.9:
            raise Stop(f"{name} doesn't match {os.path.basename(plan_path)} ({sc:.0%} of shots) — run on the timeline as Build left it")
        label = str(plan.get("label") or "").split("__")[0]
        say(f"Word edges — {name} — plan {os.path.basename(plan_path)} — {len(pieces)} shots")
    words = os.path.join(run_dir, f"words_{label}.json")
    levels = os.path.join(run_dir, f"levels_{label}.json")
    if not os.path.exists(words):
        raise Stop(f"No words_{label}.json in {run_dir}")

    # markers already on it (ours from an earlier run are dropped first)
    for fr, m in list((tl.GetMarkers() or {}).items()):
        if (m or {}).get("customData") == TAG:
            tl.DeleteMarkerAtFrame(fr)
    markers = [{"rec": int(fr), "name": m.get("name", ""), "color": m.get("color", ""), "note": m.get("note", ""),
                "custom": m.get("customData", "")} for fr, m in (tl.GetMarkers() or {}).items()]
    say(f"Markers on it: {len(markers)}")

    # render the audio
    project.SetCurrentTimeline(tl)
    time.sleep(0.5)
    formats = project.GetRenderFormats() or {}
    fmt = next((e for l_, e in formats.items() if str(e).lower() == "wav" or "wav" in str(l_).lower()), None) or "mov"
    codecs = project.GetRenderCodecs(fmt) or {}
    codec = next((v for l_, v in codecs.items() if "pcm" in str(l_).lower() or "pcm" in str(v).lower()), None) \
        or (list(codecs.values())[0] if codecs else None)
    if codec:
        project.SetCurrentRenderFormatAndCodec(fmt, codec)
    rname = f"word_edges_{_safe_name(name)}"
    for old in glob.glob(os.path.join(glob.escape(out_dir), rname + ".*")):
        try:
            os.remove(old)
        except OSError:
            pass
    settings = {"SelectAllFrames": True, "ExportVideo": False, "ExportAudio": True, "TargetDir": out_dir,
                "CustomName": rname, "UniqueFilename": False}
    if not project.SetRenderSettings(settings):
        for k, v in settings.items():
            project.SetRenderSettings({k: v})
    job_id = project.AddRenderJob()
    if not job_id:
        raise Stop("AddRenderJob failed (Deliver page settings?)")
    say(f"Rendering audio ({fmt}/{codec}) …")
    t_r = time.time()
    try:
        project.StartRendering([job_id], False)
        while project.IsRenderingInProgress():
            time.sleep(1)
        st = project.GetRenderJobStatus(job_id) or {}
    finally:
        project.DeleteRenderJob(job_id)
    if st.get("JobStatus") != "Complete":
        raise Stop(f"Render ended: {st}")
    render = next(iter(glob.glob(os.path.join(glob.escape(out_dir), rname + ".*"))), None)
    if not render:
        raise Stop(f"Render finished but no {rname}.* in {out_dir}")
    say(f"  {os.path.basename(render)} ({time.time() - t_r:.0f}s)")

    # the analysis, in the transcription pack's Python
    root = os.path.join(os.environ.get("LOCALAPPDATA", ""), "EditPanel", "transcription")
    cur = {}
    try:
        cur = json.load(open(os.path.join(root, "current.json"), encoding="utf-8"))
    except Exception:
        pass
    py = g.get("PACK_PYTHON") or (os.path.join(root, str(cur.get("version")), cur.get("python") or os.path.join("python", "python.exe"))
                                  if cur.get("version") else r"C:\wxbench\Scripts\python.exe")
    if not os.path.exists(py):
        raise Stop(f"No transcription-pack Python at {py} (install it from EditPanel's Cut-through Setup, or set PACK_PYTHON)")
    env = dict(os.environ)
    if cur.get("version"):
        models = os.path.join(root, str(cur["version"]), "models")
        env.update({"HF_HOME": os.path.join(models, "hf"), "TORCH_HOME": os.path.join(models, "torch"),
                    "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "PYTHONNOUSERSITE": "1"})
    spike = g.get("SPIKE_FILE") or os.path.join(CHECKOUT, "spikes", "spike_word_edges.py")
    job = {"name": name, "render": render, "fps": fps, "start_frame": t0, "pieces": pieces, "markers": markers,
           "plan": plan_path, "words": words, "levels": levels, "out_dir": out_dir, "fix": g.get("FIX", True) is not False,
           "pipeline": os.path.join(os.path.dirname(os.path.dirname(spike)), "cut_through")}
    job_path = os.path.join(out_dir, f"job_{_safe_name(name)}.json")
    json.dump(job, open(job_path, "w", encoding="utf-8"), indent=1)
    say("Analysing (pack Python) …")
    proc = subprocess.Popen([py, spike, "analyze", job_path], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
                            text=True, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    tail = []
    for line in proc.stdout:
        line = line.rstrip()
        tail = (tail + [line])[-30:]
        if line.startswith(("▸", "✓")):
            say("  " + line)
    proc.wait()
    res_path = os.path.join(out_dir, f"word_edges_{_safe_name(name)}.json")
    if proc.returncode != 0 or not os.path.exists(res_path):
        say("✗ Analysis failed:")
        for l_ in tail:
            say("    " + l_)
        raise Stop("analysis failed")
    res = json.load(open(res_path, encoding="utf-8"))

    # the findings as markers on this timeline
    def tc(rec):
        f = int(rec) - t0
        s = f / fps
        return f"{int(s // 60):02d}:{s % 60:05.2f}"
    color = {"repeat": "Pink", "clipped_end": "Lavender", "clipped_start": "Lavender", "false_repeat_cut": "Yellow"}
    taken = set((tl.GetMarkers() or {}).keys())
    placed = 0
    say("")
    say("Findings:")
    for f in sorted(res["findings"], key=lambda f: f["rec"]):
        if f["kind"] == "repeat":
            head = (f"{'PHANTOM ' if f['phantom'] else ''}repeat \"{f['text']}\""
                    + (" across a join" if f["across_join"] else " inside a shot")
                    + (" — Transcribe marked a copy as a ghost" if f["ghost_marked"] else "")
                    + (" — legit double, left" if f["legit"] else ""))
        elif f["kind"] == "false_repeat_cut":
            head = (f"false repeat cut: \"{f['word']}\" said once, a copy cut"
                    + (f" ({f['why_cut']})" if f.get("why_cut") else "") + f" — {', '.join(f['signs']) or 'marker only'}")
        else:
            head = f"{'end' if f['kind'] == 'clipped_end' else 'start'} of \"{f['word']}\" — {', '.join(f['signs']) or 'marker only'}"
        res_txt = f.get("result") or ("flag only" if not f["fix"] else "")
        say(f"  {tc(f['rec'])}  {head}" + (f"  → {res_txt}" if res_txt else "") + (f"  [marker: {', '.join(f['hints'])}]" if f.get("hints") else ""))
        fr = int(f["rec"]) - t0
        for nudge in range(4):
            if fr + nudge in taken:
                continue
            if tl.AddMarker(fr + nudge, color[f["kind"]], ("Edges: " + head)[:60], f"{head} {res_txt}"[:500], 1, TAG):
                taken.add(fr + nudge)
                placed += 1
                break
    say(f"  ({placed} marker(s) placed, tag {TAG})")
    if res["markers"]:
        say("")
        say("Existing markers:")
        for m in sorted(res["markers"], key=lambda m: m["rec"]):
            say(f"  {tc(int(m['rec']) + t0)}  {m.get('color', '')} {m.get('name', '')!s:.40} → {m['status']}")

    seq_bin = g.get("SEQ_BIN") or "MASTER / SEQUENCES"
    day_file = os.path.join(run_dir, f"day_{label}.json")
    if narr:                                         # build_narration adds " (cut-through)" itself
        base = name[:-len(" (cut-through)")] if name.endswith(" (cut-through)") else name
        new_name = f"{base} refined"
        build_args = {"LABEL": label, "OUT_DIR": out_dir, "DAY_FILE": day_file, "SEQ_BIN": seq_bin}
        build_file = "build_narration.py"
    else:
        new_name = f"{name} refined"
        build_args = {"LABEL": label, "OUT_DIR": out_dir, "SEQ_BIN": seq_bin, "ARCHIVE": False}
        build_file = "build_rough_cut.py"
    if res.get("refined_plan"):
        rp = res["refined_plan"]
        line = "; ".join([f'PLAN_FILES=[[r"{rp}", "{new_name}"]]'] + [
            f'{k}=r"{v}"' if isinstance(v, str) and k.endswith(("DIR", "FILE")) else f"{k}={v!r}" for k, v in build_args.items()]
            + [f'exec(open(r"{os.path.join(CHECKOUT, "cut_through", build_file)}", encoding="utf-8").read())'])
        say("")
        say(f"Refined plan: {rp}  ({len(res['fixes'])} fix(es))")
        say("Rebuild line:")
        say("  " + line)
    else:
        say("\nNothing to fix — no refined plan written.")
    say(f"\n{res['joins']} joins, {res['heard_words']} words heard, analysis {res['seconds']}s ({res['device']})")
    if not g.get("KEEP_RENDER"):
        try:
            os.remove(render)
        except OSError:
            pass
    rep = os.path.join(out_dir, f"word_edges_{_safe_name(name)}.txt")
    open(rep, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print(f"Report: {rep}")

    if g.get("REBUILD") and res.get("refined_plan"):
        print(f"\nRebuilding as '{new_name}' …")
        build = os.path.join(job["pipeline"], build_file)
        ns = {"__name__": "__main__", "__file__": build, "resolve": r, "PLAN_FILES": [[res["refined_plan"], new_name]], **build_args}
        exec(compile(open(build, encoding="utf-8").read(), build, "exec"), ns)


if __name__ == "__main__" and len(sys.argv) > 2 and sys.argv[1] == "analyze":
    analyze(sys.argv[2])
elif "resolve" in globals() or globals().get("RUN_DIR"):
    try:
        _console()
    except Stop as exc:
        print(f"✗ STOPPED: {exc}")
    except Exception:
        import traceback
        print("✗ STOPPED with an error:")
        traceback.print_exc()
    finally:
        for _k in ("TIMELINE", "RUN_DIR", "PLAN", "REBUILD", "SEQ_BIN", "FIX", "KEEP_RENDER", "PACK_PYTHON", "SPIKE_FILE"):
            globals().pop(_k, None)
