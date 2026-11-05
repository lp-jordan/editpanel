#!/usr/bin/env python3
"""
SPIKE — Draft a ONE-speaker cut plan from the words file (style guide rules, no LLM).

Input: words_<LABEL>.json + day_<LABEL>.json (transcribe_day.py / spike_day_prep.py).
Output: plans/<LABEL>_plan.json for spike_cut_through_batch.py (same shape as plan_convo.py's).
The removal list with its words goes to stdout only (client words: never into the plan / git).

Rules (docs/ai-rough-cut-style-guide.md, "One speaker, scripted with retakes" + Bryan Brown):
  * Retakes = the repeat: the same words said again shortly after → everything from the earlier
    attempt up to the retake goes, the LAST take stays. That also keeps "the clean start of a
    sentence from one take + the rest from the retake". A repeat = 3 words (2+ not filler/stop
    words) within 8 s with no sentence finished in between, or 5+ words in a row within 60 s; a cue between the takes ("one two three",
    "sorry", "let me start", "one more time", "again") accepts any 3-word repeat within 4 min.
    (Free talk repeats topic phrases, so a long span needs a real re-read.)
  * A count ("one, two, three") with no repeat: the sentence before it through the count goes.
  * Stutters / quick restarts ("so here so here", "the the"): the first copy goes.
  * Pauses longer than 30 fr are trimmed to ~11 fr across the join.
  * Picture: open and close on the wide; wide (~9.5 s) ↔ punch-in (~8.7 s) backbone; extra angles
    (side / slider) as ~5.5 s inserts; every removal sits on an angle change (no jump cuts).
  * Audio: a WAV day keeps its one mic open over everything kept; a camera-audio day (no WAVs)
    marks the plan audio = camera, and the build turns the ATEM mix (Camera 1 audio) on.
NOT handled yet (the LLM pass): producer notes / off-camera chatter, a retake reworded rather
than repeated, deliberate emphasis repeats ("let me say that again" with no count) — check those.

Usage:
    python plan_solo.py <words.json> <day.json> <out_plan.json> [start=<frame>] [end=<frame>]
        [wide="Camera 1"] [punch="Camera 2"] [extra="Camera 4" ...] [cut=<from>-<to> ...]
"""
import json
import math
import re
import sys
from collections import Counter

PAUSE_MAX, PAUSE_LEFT = 30, 11            # frames: silences longer than this are trimmed to this
LEN = {"wide": 228, "punch": 209, "extra": 132}   # 9.5 s / 8.7 s / 5.5 s at 24 fps
MIN_SHOT = 60                              # 2.5 s
OPEN_WIDE = 96                             # the opening wide holds ~4 s
HEAD, TAIL = 18, 24                        # frames kept before the first / after the last word
REPEAT_N = 3
WINDOW_SEC, CUE_WINDOW_SEC = 60, 240
FILLER = {"uh", "um", "umm", "uhm", "er", "ah", "mm", "hmm", "mhm"}
STOP = {"the", "a", "an", "and", "or", "but", "so", "to", "of", "in", "on", "at", "for", "with", "is",
        "it", "its", "it's", "that", "this", "i", "you", "we", "they", "he", "she", "be", "are", "was",
        "were", "as", "if", "then", "just", "like", "my", "your", "our", "me", "do", "not", "what",
        "there", "here", "have", "has", "can", "will", "all", "about", "from", "by", "up", "out", "know",
        "okay", "ok", "yeah", "right", "well", "really", "very", "gonna", "going"}
COUNT = [("one", "1"), ("two", "2"), ("three", "3")]
CUES = [("sorry",), ("let", "me", "start"), ("start", "over"), ("one", "more", "time"), ("again",),
        ("one", "two", "three"), ("1", "2", "3"), ("take", "two")]


def norm(w: str) -> str:
    return re.sub(r"[^a-z0-9'\-]", "", w.lower()).strip("-'")


def main(argv) -> None:
    words_p, day_p, out_p = [a for a in argv if "=" not in a][:3]
    opts = [a.split("=", 1) for a in argv if "=" in a]
    o = dict(opts)
    data = json.load(open(words_p, encoding="utf-8"))
    day = json.load(open(day_p, encoding="utf-8"))
    fps = data["fps"]
    frame_sec = day["frame_sec"][0] / day["frame_sec"][1]
    total = int(day["length_sec"] / frame_sec)
    angles = day.get("angles") or []
    wide = o.get("wide") or ("Camera 1" if "Camera 1" in angles else angles[0])
    punch = o.get("punch") or next((a for a in ("Camera 2", *angles) if a in angles and a != wide), wide)
    extra = [v for k, v in opts if k == "extra" and v and v not in (wide, punch)]
    cuts = [tuple(map(int, v.split("-"))) for k, v in opts if k == "cut"]

    talker = (data.get("mics") or [None])[0]
    W = sorted((w for w in data["words"] if w.get("own", True) and (talker is None or w["mic"] == talker)),
               key=lambda w: w["s"])
    lo_req, hi_req = int(o.get("start", 0)), int(o.get("end", total))
    W = [w for w in W if lo_req <= w["s"] < hi_req]
    if not W:
        raise SystemExit("No words in that range")
    start = max(lo_req, int(W[0]["s"]) - HEAD)
    end = min(hi_req, int(W[-1]["e"]) + TAIL)
    T = [norm(w["w"]) for w in W]

    def secs(i, j):
        return (W[j]["s"] - W[i]["s"]) * frame_sec

    def has_cue(i, j):
        seq = T[i:j]
        return any(tuple(seq[k:k + len(c)]) == c for c in CUES for k in range(len(seq) - len(c) + 1))

    def cut_span(i, j):
        """Remove words i..j-1: from just after the word before i to just before word j."""
        # ~6 fr of air after the word before, ~5 fr before the word after (≈11 fr across the
        # join, the pause rule); tighter when the words themselves sit closer than that
        if i > 0:
            pe = W[i - 1]["e"]
            a = int(pe + min(6, max(0, W[i]["s"] - pe)))
        else:
            a = start
        if j < len(W):
            b = min(math.ceil(W[j]["s"] - min(5, max(0, W[j]["s"] - W[j - 1]["e"]))), int(W[j]["s"]))
        else:
            b = end
        return a, max(a, b)

    removals, floor = [], 0
    # 1. the repeat (+ cue words widen the look-back)
    content = [k for k, t in enumerate(T) if t and t not in FILLER]
    key_at = {}
    for n, k in enumerate(content[:len(content) - REPEAT_N + 1]):
        key = tuple(T[x] for x in content[n:n + REPEAT_N])
        if sum(1 for t in key if t not in STOP) < 2:
            continue
        hits = key_at.setdefault(key, [])
        for i in hits:                                    # earliest earlier attempt in the window
            if i < floor:
                continue
            cue = has_cue(i, k)
            win = CUE_WINDOW_SEC if cue else WINDOW_SEC
            if not 0 < secs(i, k) <= win:
                continue
            # free talk repeats its topic phrases: a long span needs a real re-read (5+ words
            # in a row again) or a cue between the takes
            ci, ck = content.index(i), n
            run = 0
            while ck + run < len(content) and ci + run < ck and T[content[ci + run]] == T[content[ck + run]]:
                run += 1
            # a quick restart breaks off mid-sentence; a finished sentence in between = a callback
            ended = any(re.search(r"[.?!]$", W[x]["w"].strip()) for x in range(i, k))
            if cue or run >= 5 or (secs(i, k) <= 8 and run >= REPEAT_N and not ended):
                removals.append((i, k, "retake (repeat)"))
                floor = k
                break
        hits.append(k)
    # 2. stutters / quick restarts: "the the", "so here so here"
    for k in range(1, len(T)):
        for n in (1, 2):
            if k - 2 * n + 1 < 0 or k + 1 < 2 * n:
                continue
            a, b = T[k - 2 * n + 1:k - n + 1], T[k - n + 1:k + 1]
            if a == b and all(a) and not any(t in FILLER or t.isdigit() for t in a) and \
                    (W[k - n + 1]["s"] - W[k - n]["e"]) * frame_sec < 1.5:
                removals.append((k - 2 * n + 1, k - n + 1, "stutter"))
    # 3. a count with no repeat after it: the sentence before it through the count
    for k in range(len(T) - 2):
        if all(T[k + x] in COUNT[x] for x in range(3)):
            if any(i <= k < j for i, j, _ in removals):
                continue
            s = k
            while s > 0 and not re.search(r"[.?!]$", W[s - 1]["w"].strip()) and secs(s - 1, k) < 60:
                s -= 1
            removals.append((s, k + 3, "count"))

    spans = []
    for i, j, why in removals:
        a, b = cut_span(i, j)
        if b > a:
            spans.append({"from": a, "to": b, "why": why, "words": (i, j)})
    spans += [{"from": a, "to": b, "why": "editorial (listed)", "words": None} for a, b in cuts]
    spans.sort(key=lambda r: r["from"])
    merged = []
    for r in spans:
        if merged and r["from"] <= merged[-1]["to"]:
            m = merged[-1]
            m["to"] = max(m["to"], r["to"])
            if r["why"] not in m["why"]:
                m["why"] += " + " + r["why"]
            if r["words"] and m["words"]:
                m["words"] = (min(m["words"][0], r["words"][0]), max(m["words"][1], r["words"][1]))
        else:
            merged.append(dict(r))

    # 4. pauses in what's left
    def removed(f):
        return any(r["from"] <= f < r["to"] for r in merged)

    speech = [(int(w["s"]), int(w["e"]) + 1) for w in W if not removed(int(w["s"]))]
    last = None
    for s, e in speech:
        if last is not None and s - last > PAUSE_MAX:
            a, b = last + 6, s - (PAUSE_LEFT - 6)
            if not any(r["from"] <= a < r["to"] or r["from"] < b <= r["to"] for r in merged):
                merged.append({"from": a, "to": b, "why": f"pause {s - last} fr → {PAUSE_LEFT}", "words": None})
        last = e if last is None else max(last, e)
    merged.sort(key=lambda r: r["from"])

    def kept_of(rs):
        out, pos = [], start
        for r in rs:
            if r["from"] > pos:
                out.append([pos, r["from"]])
            pos = max(pos, r["to"])
        if end > pos:
            out.append([pos, end])
        return out

    # every removal costs an angle change, so a scrap of speech shorter than a shot between two
    # removals would flash on screen: give back the optional removal (stutter / pause) beside it
    optional = lambda r: r["why"].startswith(("stutter", "pause"))
    changed = True
    while changed:
        changed = False
        for a, b in kept_of(merged)[1:-1]:
            if b - a >= MIN_SHOT:
                continue
            side = [r for r in merged if (r["to"] == a or r["from"] == b) and optional(r)]
            if side:
                merged.remove(min(side, key=lambda r: r["to"] - r["from"]))
                changed = True
                break
    kept = [k for k in kept_of(merged) if k[1] - k[0] >= 6]          # crumbs between two removals

    # 5. picture: wide ↔ punch-in backbone, inserts, an angle change at every join
    cycle = ["wide", "punch"] * 2 + (["extra"] if extra else [])
    pick = {"wide": wide, "punch": punch}
    shots, n, ex = [], 0, 0
    for si, (a, b) in enumerate(kept):
        f = a
        while f < b:
            kind = cycle[n % len(cycle)]
            ang = pick.get(kind) or extra[ex % len(extra)]
            length = OPEN_WIDE if not shots else LEN[kind]
            if not shots:
                kind, ang = "wide", wide
            elif f == a and shots[-1]["angle"] == ang and len({wide, punch, *extra}) > 1:   # a join: never the same angle
                n += 1
                continue
            g = min(b, f + length)
            if b - g < MIN_SHOT:
                g = b                                      # don't leave a sliver before the join
            if shots and f != a and g - f < MIN_SHOT:
                shots[-1]["to"] = g                        # too short and not at a join: absorb
            else:
                shots.append({"from": f, "to": g, "angle": ang, "kind": kind, "join": f == a and si > 0})
            if kind == "extra":
                ex += 1
            n += 1
            f = g
    # close on the wide
    last = shots[-1]
    if last["angle"] != wide:
        prev_wide = len(shots) > 1 and shots[-2]["angle"] == wide
        if prev_wide and not last["join"]:
            shots.pop()
            shots[-1]["to"] = last["to"]                   # the wide before it runs to the end
        elif not prev_wide:
            last.update(angle=wide, kind="wide")
        elif last["to"] - last["from"] >= 2 * MIN_SHOT:
            # after a removal it has to stay off the wide: split, and close on the wide (~4 s)
            cut = last["to"] - max(MIN_SHOT, min(OPEN_WIDE, (last["to"] - last["from"]) // 2))
            shots.append({"from": cut, "to": last["to"], "angle": wide, "kind": "wide", "join": False})
            last["to"] = cut
        elif len(shots) < 3 or shots[-3]["angle"] != punch:
            shots[-2].update(angle=punch, kind="punch")    # short last shot after a removal: swap
            last.update(angle=wide, kind="wide")
    # last guard: no jump cut at a join, no same-angle neighbours
    for x, y in zip(shots, shots[1:]):
        if y["angle"] == x["angle"] and punch != wide:
            y["angle"], y["kind"] = (punch, "punch") if x["angle"] == wide else (wide, "wide")
    why = {"wide": "wide", "punch": "punch-in", "extra": "insert"}
    video = [{"in": s["from"], "out": s["to"], "angle": s["angle"],
              "why": why[s["kind"]] + (" (after a removal)" if s["join"] else "")} for s in shots]
    video[0]["why"], video[-1]["why"] = "open on the wide", "close on the wide"

    # 6. audio
    camera = day.get("audio_source") == "camera"
    mics = {} if camera else {talker: [[a, b] for a, b in kept]}
    plan = {"label": data["label"], "multicam": data["multicam"], "fps": fps,
            "note": "Draft by plan_solo.py (style-guide solo rules from the words file; no LLM).",
            "mic_angles": {} if camera else {talker: talker}, "video": video, "mics": mics,
            "audio": {"source": "camera" if camera else "wav", "angle": talker},
            "removals": [{"from": r["from"], "to": r["to"], "why": r["why"]} for r in merged]}
    json.dump(plan, open(out_p, "w", encoding="utf-8"), indent=1)

    kept_f = sum(b - a for a, b in kept)
    raw_f = end - start
    kinds = Counter(r["why"].split(" ")[0] for r in merged)
    print(f"{len(video)} picture pieces, {len(merged)} removals ({', '.join(f'{k} {v}' for k, v in kinds.items())}), "
          f"kept {kept_f / fps / 60:.1f} of {raw_f / fps / 60:.1f} min, {len(video) / max(kept_f / fps / 60, 1e-9):.1f} cuts/min")
    print("angles:", dict(Counter(v["angle"] for v in video)), f"| audio: {plan['audio']['source']} ({talker})")
    if camera and talker != "Camera 1":
        print(f"⚠ audio is {talker}'s camera audio, but the build only carries Camera 1's (the ATEM mix) — "
              f"rerun Prep with Camera 1 audio, or the cut will be silent")
    print("Removed (check these):")
    for r in merged:
        if not r["words"]:
            continue
        i, j = r["words"]
        text = " ".join(w["w"] for w in W[i:j])
        mm = r["from"] * frame_sec
        print(f"  [{r['from']}–{r['to']} | {int(mm // 60):02d}:{mm % 60:04.1f}] {r['why']}: {text[:160]}{'…' if len(text) > 160 else ''}")


if __name__ == "__main__":
    main(sys.argv[1:])
