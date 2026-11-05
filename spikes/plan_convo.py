#!/usr/bin/env python3
"""
SPIKE — Draft a conversation cut plan from the words file (style guide rules, no LLM).

Input: words_<LABEL>.json + day_<LABEL>.json (transcribe_day.py / spike_day_prep.py).
Output: plans/<LABEL>_plan.json for spike_cut_through_batch.py, plus a readable shot list.

Rules (docs/ai-rough-cut-style-guide.md, "Two speakers … unscripted", + Jordan's rules):
  * Angle = person: the mic under angle N is the person on camera N. Camera 1 = the wide.
  * Open and close on the wide (~4 s). Cut to a new talker ~6 frames after their first word.
  * Long turns are broken up: talker's close-up ~6.5 s, then a cutaway (listener reaction
    ~2.2 s, the wide ~3.6 s, or an extra angle ~5.5 s), back to the talker.
  * Light trim: silences longer than PAUSE_MAX frames are cut back to ~11 frames; every removal
    sits on an angle change (no jump cuts). Editorial removals (flubs, chatter) come from the
    command line: cut=<from>-<to>.
  * Mic gating: each mic is open while its owner talks (opens 5 fr before, closes 8 fr after);
    a short backchannel ("right", "yeah", "mm-hmm") that steps on the other talker stays closed.

Usage:
    python3 plan_convo.py <words.json> <day.json> <out_plan.json> start=<frame> end=<frame>
        [extra="Camera 4"] [cut=<from>-<to> ...]
"""
import json
import re
import sys

PAUSE_MAX = 30          # silences longer than this (frames) are trimmed …
PAUSE_LEFT = 11         # … down to this much silence across the join
CU, REACT, WIDE, EXTRA = 250, 53, 86, 132     # frames: talker CU ~10.5 s between cutaways (→ ~8 cuts/min),
                                              # reaction 2.2 s, wide 3.6 s, extra angle 5.5 s
MIN_SHOT = 48           # 2 s: nothing shorter, and a turn shorter than this doesn't take the picture
OPEN_PRE, CLOSE_POST = 5, 8
CUT_AFTER_WORD = 6
TURN_GAP = 24           # words closer than this (frames) belong to one stretch
BACKCHANNEL = {"right", "yeah", "yes", "mm-hmm", "-hmm", "hmm", "mm", "uh-huh", "okay", "sure", "correct",
               "absolutely", "exactly", "um", "uh", "so", "and", "yep", "wow", "gosh", "agree", "i"}


def stretches(words, gap=TURN_GAP):
    out = []
    for w in words:
        if out and w["s"] - out[-1]["e"] <= gap:
            out[-1]["e"] = max(out[-1]["e"], w["e"])
            out[-1]["w"].append(w["w"])
        else:
            out.append({"s": w["s"], "e": w["e"], "w": [w["w"]]})
    return out


def is_backchannel(st) -> bool:
    toks = [re.sub(r"[^a-z\-']", "", x.lower()) for x in st["w"]]
    return len(toks) <= 3 and all(t in BACKCHANNEL or not t for t in toks)


def main(argv) -> None:
    words_p, day_p, out_p = [a for a in argv if "=" not in a][:3]
    opts = [a.split("=", 1) for a in argv if "=" in a]
    start = int(dict(opts)["start"])
    end = int(dict(opts)["end"])
    extra = [v for k, v in opts if k == "extra"]
    cuts = [tuple(map(int, v.split("-"))) for k, v in opts if k == "cut"]
    data = json.load(open(words_p, encoding="utf-8"))
    day = json.load(open(day_p, encoding="utf-8"))
    people = sorted(data["mics"], key=lambda a: int(re.sub(r"\D", "", a) or 0))   # angles holding a mic
    wide = "Camera 1"
    own = [w for w in data["words"] if w["own"] and start <= w["s"] < end]

    # 1. who talks when
    by = {p: stretches([w for w in own if w["mic"] == p]) for p in people}
    for p in people:
        for st in by[p]:
            st["who"] = p
            others = [o for q in people if q != p for o in by[q]]
            st["over"] = any(o["s"] < st["e"] and st["s"] < o["e"] and not is_backchannel(o) for o in others)
            st["bc"] = is_backchannel(st)
    real = sorted((st for p in people for st in by[p] if not st["bc"]), key=lambda s: s["s"])
    turns = []                                       # (from frame, talker)
    for st in real:
        if not turns or turns[-1][1] != st["who"]:
            if turns and st["e"] - st["s"] < MIN_SHOT:
                continue                             # a short comment doesn't take the picture
            turns.append((int(st["s"]) + CUT_AFTER_WORD, st["who"]))

    # 2. what stays: start..end minus long silences and editorial cuts
    speech = sorted((int(w["s"]), int(w["e"]) + 1) for w in own)
    removals = [{"from": a, "to": b, "why": "editorial (listed)"} for a, b in cuts]
    last = None
    for s, e in speech:
        if last is not None and s - last > PAUSE_MAX:
            a, b = last + 6, s - (PAUSE_LEFT - 6)
            if not any(ca <= a < cb or ca < b <= cb for ca, cb in cuts):
                removals.append({"from": a, "to": b, "why": f"pause {s - last} fr → {PAUSE_LEFT}"})
        last = e if last is None else max(last, e)
    removals.sort(key=lambda r: r["from"])
    kept, pos = [], start
    for r in removals:
        if r["from"] > pos:
            kept.append([pos, r["from"]])
        pos = max(pos, r["to"])
    if end > pos:
        kept.append([pos, end])

    def talker(f):
        cur = turns[0][1] if turns else people[0]
        for t0, who in turns:
            if t0 > f:
                break
            cur = who
        return cur

    # 3. shots: forced boundaries at removal joins and talker changes, long stretches broken up
    joins = {a for a, _ in kept[1:]}
    ends = {b for _, b in kept[:-1]}                 # where a removal starts
    bounds = sorted({start, end} | joins | ends | {t0 for t0, _ in turns if start < t0 < end})
    other = {p: next(q for q in people if q != p) for p in people}
    pick = {"cu": lambda w: w, "react": lambda w: other[w], "wide": lambda w: wide,
            "extra": lambda w: extra[0] if extra else wide}
    shots = []
    cycle = ["react", "wide", *(["extra"] if extra else []), "react"]
    k = 0
    for a, b in zip(bounds, bounds[1:]):
        if not any(min(b, y) > max(a, x) for x, y in kept):
            continue
        who = talker(a)
        prev = shots[-1]["angle"] if shots else None
        seq = []
        if a in joins and prev == who:               # hide the removal: open this stretch on the wide
            seq.append(("wide", WIDE))
        f, n = a, 0
        while f < b:
            if seq:
                kind, length = seq.pop(0)
            elif n % 2 == 0:
                kind, length = "cu", CU
                n += 1
            else:
                kind = cycle[k % len(cycle)]
                k += 1
                length = {"react": REACT, "wide": WIDE, "extra": EXTRA}[kind]
                n += 1
            g = min(b, f + length)
            if b - g < MIN_SHOT:                      # don't leave a sliver
                g = b
            shots.append({"from": f, "to": g, "who": who, "kind": kind, "angle": pick[kind](who)})
            f = g

    shots[0]["angle"] = shots[-1]["angle"] = wide              # open and close on the wide
    shots[0]["kind"] = shots[-1]["kind"] = "wide"
    merged = []
    for s in shots:
        if merged and merged[-1]["to"] == s["from"] and s["from"] not in joins and (
                merged[-1]["angle"] == s["angle"] or s["to"] - s["from"] < MIN_SHOT):
            merged[-1]["to"] = s["to"]                         # same angle, or too short → absorbed
        else:
            merged.append(dict(s))
    while len(merged) > 1 and merged[0]["to"] - merged[0]["from"] < 96 and merged[1]["from"] not in joins:
        cut = merged[0]["from"] + 96                           # the opening wide holds ~4 s
        if cut > merged[1]["to"] - MIN_SHOT:
            merged[0]["to"] = merged.pop(1)["to"]              # a short greeting stays on the wide
        else:
            merged[0]["to"] = merged[1]["from"] = cut
    for x, y in zip(merged, merged[1:]):                       # last guard: no jump cut at a removal
        if y["from"] in joins and y["angle"] == x["angle"]:
            y["angle"], y["kind"] = (wide, "wide") if x["angle"] != wide else (y["who"], "cu")

    # 4. picture pieces = shots ∩ kept
    video = []
    for s in merged:
        for x, y in kept:
            lo, hi = max(s["from"], x), min(s["to"], y)
            if hi > lo:
                why = {"cu": f"{s['who']} talking", "react": f"reaction while {s['who']} talks",
                       "wide": "wide", "extra": "extra angle"}[s["kind"]]
                video.append({"in": lo, "out": hi, "angle": s["angle"], "why": why})
    video[0]["why"], video[-1]["why"] = "open on the wide", "close on the wide"

    # 5. mic gating
    mics = {}
    for p in people:
        opens = []
        for st in by[p]:
            if st["bc"] and st["over"]:
                continue                                       # backchannel stepping on the talker
            a, b = int(st["s"]) - OPEN_PRE, int(st["e"]) + CLOSE_POST
            if opens and a <= opens[-1][1] + 12:
                opens[-1][1] = max(opens[-1][1], b)
            else:
                opens.append([a, b])
        mics[p] = opens

    plan = {"label": data["label"], "multicam": data["multicam"], "fps": data["fps"],
            "note": "Draft by plan_convo.py (style-guide rules from the words file; blind).",
            "mic_angles": {p: p for p in people}, "video": video, "mics": mics, "removals": removals}
    json.dump(plan, open(out_p, "w", encoding="utf-8"), indent=1)
    kept_f = sum(b - a for a, b in kept)
    fps = data["fps"]
    print(f"{len(video)} picture pieces, {len(removals)} removals, kept {kept_f / fps / 60:.1f} of "
          f"{(end - start) / fps / 60:.1f} min, {len(video) / (kept_f / fps / 60):.1f} cuts/min; "
          + ", ".join(f"{p}: {len(m)} mic openings" for p, m in mics.items()))
    from collections import Counter
    print("angles:", dict(Counter(v["angle"] for v in video)))


if __name__ == "__main__":
    main(sys.argv[1:])
