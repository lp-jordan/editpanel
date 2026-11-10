#!/usr/bin/env python3
"""
Cut-through step 3 (Plan, second half): place Claude's edit on exact frames from the waveform
(without a Claude edit: a rule-based one-speaker draft).

Input: words_<LABEL>.json + day_<LABEL>.json (transcribe.py / prepare_multicam.py).
Output: plans/<LABEL>_plan.json for build_rough_cut.py (same shape as plan_convo.py's).
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
removals=<file>: Claude's edit (EditPanel's Cut-through, cut_through_claude.js) replaces the
rule-based retake/stutter/count detection; pause trims, picture and audio still run here.
NOT handled by the rules alone (Claude's job): producer notes / off-camera chatter, a retake reworded rather
than repeated, deliberate emphasis repeats ("let me say that again" with no count) — check those.

Usage:
    python place_cuts.py <words.json> <day.json> <out_plan.json> [start=<frame>] [end=<frame>] [removals=<file>]
        [levels=<levels_LABEL.json>] [pause_max=<fr>] [pause_left=<fr>]
        [wide="Camera 1"] [punch="Camera 2"] [extra="Camera 4" ...] [cut=<from>-<to> ...]
        [trim=<from>-<to> ...] [keep=<from>-<to> ...] [skip="Slate" ...] [talker="Camera 2"] [review=<file>]
  talker: plan one person's video on a day with several mics (the others stay closed, tracks kept).
  review: where the review markers go (default review_<LABEL>.json beside the words file).
  skip: an angle never to show (Jordan's "don't use" on the Cut-through page; a Slate always).
  trim / keep: the second pass (EditPanel's Check on this plan, cut_through_check.js): trim = a
  silence to take out (a gap left at a join, a pause over the rule, dead air at the head/tail, a
  wordless sliver) — optional like a pause trim, so it never forces a blink shot; keep = the rest of
  a word a cut went through, given back after every removal is placed.
"""
import json
import os
import math
import re
import sys
from collections import Counter

PAUSE_MAX, PAUSE_LEFT = 30, 11            # frames: silences longer than this are trimmed to this
LEN = {"wide": 228, "punch": 209, "extra": 132}   # 9.5 s / 8.7 s / 5.5 s at 24 fps
MIN_SHOT = 60                              # 2.5 s
OPEN_WIDE = 96                             # the opening wide holds ~4 s
HEAD, TAIL = 18, 24                        # frames kept before the first / after the last word
BEAT = 6                                   # extra air after a finished thought (Claude's `beats`; Jordan: 5–6 fr)
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


def fit_angles(pieces, angles, hold=72, w_short=3, w_cut=24, allowed=None):
    """Claude's shots → the final angles, all at once (2026-11-05). Hard rule: the angle changes at
    every removal join. Flipping only the piece after a join made ping-pong — a 2 s shot of the other
    angle, the splice, straight back: 3–4 cuts in a few seconds. Instead: the cheapest assignment,
    where cost = frames shown on an angle Claude didn't pick + a penalty per frame a shot runs short
    of `hold` + a little per cut that isn't at a join. So a short shot next to a removal is usually
    absorbed (the cut moves onto the join) rather than answered with another cut. `angles` is in order
    of preference for a stand-in (the wide, the close-up, then the rest); the opening and closing
    shots count double (Claude opens and closes on purpose)."""
    INF = float("inf")
    n = len(pieces)
    if n < 2:
        return pieces
    rank = {g: k for k, g in enumerate(angles)}

    def dev(i, g):
        if pieces[i]["angle"] == g:
            return 0
        w = (2 if i in (0, n - 1) else 1) * (1 + 0.1 * rank[g])
        if i + 1 < n and pieces[i + 1]["join"] and not pieces[i]["join"]:
            w *= 1.5                       # change the angle AFTER a removal, not just before it
        return w * (pieces[i]["to"] - pieces[i]["from"])

    def short(r, end):
        return 0 if r is None else w_short * max(0, hold - (end - r))

    def run_key(r, end):
        return None if r is None or end - r >= hold else r

    # layer[i]: {(angle, start of the current shot if it is still short): (cost, previous key)}
    layer = [{} for _ in range(n)]
    # allowed(i, angle): an angle this piece can't use (a slider that isn't moving then); a piece
    # left with no angle at all ignores it rather than break the no-jump-cut rule
    ok = lambda i, g: allowed is None or allowed(i, g)
    for g in angles:
        if ok(0, g) or not any(ok(0, x) for x in angles):
            layer[0][(g, run_key(pieces[0]["from"], pieces[0]["to"]))] = (dev(0, g), None)
    for i in range(1, n):
        p, prev_to = pieces[i], pieces[i - 1]["to"]
        free = not any(ok(i, x) for x in angles)
        for (g, r), (c, _) in layer[i - 1].items():
            for h in angles:
                if h == g and p["join"]:
                    continue                                   # never the same angle across a removal
                if not free and not ok(i, h):
                    continue
                if h == g:
                    key, cc = (h, run_key(r, p["to"])), c
                else:
                    key = (h, run_key(p["from"], p["to"]))
                    cc = c + short(r, prev_to) + (0 if p["join"] else w_cut)
                cc += dev(i, h)
                if cc < layer[i].get(key, (INF,))[0]:
                    layer[i][key] = (cc, (g, r))
    key = min(layer[-1], key=lambda k: layer[-1][k][0] + short(k[1], pieces[-1]["to"]))
    pick = [None] * n
    for i in range(n - 1, -1, -1):
        pick[i] = key[0]
        key = layer[i][key][1]
    out = []
    for p, g in zip(pieces, pick):
        changed = g != p["angle"]
        if out and not p["join"] and out[-1]["angle"] == g:
            out[-1]["to"] = p["to"]
            continue
        out.append({**p, "angle": g, "kind": "forced" if changed else p["kind"]})
    return out


def cam_no(name: str) -> int:
    m = re.search(r"(\d+)\s*$", name or "")
    return int(m.group(1)) if m else 999


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
    # Resolve exports angles in its own order (e.g. 3, 2, 4, 1): sort by the number in the name
    skip = {v for k, v in opts if k == "skip"} | {a for a in day.get("angles") or [] if re.search(r"slate", a, re.I)}
    angles = sorted((a for a in day.get("angles") or [] if a not in skip), key=lambda a: int((re.findall(r"(\d+)\s*$", a) or [999])[0]))
    wide = o.get("wide") or ("Camera 1" if "Camera 1" in angles else angles[0])          # Camera 1 / "Angle 1"
    punch = o.get("punch") or next((a for a in ("Camera 2", *angles) if a in angles and a != wide), wide)
    extra = [v for k, v in opts if k == "extra" and v and v not in (wide, punch)]
    cuts = [tuple(map(int, v.split("-"))) for k, v in opts if k == "cut"]
    trims = [tuple(map(int, v.split("-"))) for k, v in opts if k == "trim"]
    keeps = [tuple(map(int, v.split("-"))) for k, v in opts if k == "keep"]
    # motion=<file>: when each slider angle is actually moving (EditPanel, on trial 2026-11-10):
    # a slider shot only inside a moving stretch, never on the stop / reset before it reverses
    motion = {}
    if o.get("motion") and os.path.isfile(o["motion"]):
        motion = {a: [tuple(x) for x in (v or {}).get("moving") or []]
                  for a, v in json.load(open(o["motion"], encoding="utf-8")).items() if a in angles}

    def moving_ok(angle, a, b):
        win = motion.get(angle)
        return win is None or any(x - 2 <= a and b <= y + 2 for x, y in win)

    # one talker (solo), or — with Claude's edit — a conversation: every mic is a person (angle N =
    # the person on camera N, Jordan's rule) and everyone's words count
    people = list(data.get("mics") or [])
    every_mic = list(people)
    if o.get("talker") in people:                    # one person's video on a conversation day
        people = [o["talker"]]
    multi = bool(o.get("removals")) and len(people) > 1
    talker = people[0] if people else None
    W = sorted((w for w in data["words"] if w.get("own", True) and not w.get("ghost") and
                (talker is None or w["mic"] == talker or (multi and w["mic"] in people))), key=lambda w: w["s"])
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

    # Z8: cuts are placed from the waveform, not from Whisper's word times (which run a few frames
    # early or late). levels=<file> is transcribe.py's per-frame level of the talker's track.
    LV = None
    if o.get("levels"):
        lvj = json.load(open(o["levels"], encoding="utf-8"))
        tracks = [lvj["mics"][p] for p in (people if multi else [talker]) if p in lvj["mics"]] or list(lvj["mics"].values())[:1]
        f0 = min(int(t["start"]) for t in tracks)
        f1 = max(int(t["start"]) + len(t["db"]) for t in tracks)
        comb = [-100] * (f1 - f0)                            # a conversation: the loudest mic per frame
        for t in tracks:
            for i, v in enumerate(t["db"]):
                j = int(t["start"]) + i - f0
                if v > comb[j]:
                    comb[j] = v
        LV = (f0, comb)

    def lvl(f):
        i = int(f) - LV[0]
        return LV[1][i] if 0 <= i < len(LV[1]) else -100

    if LV:
        inside = [lvl(f) for w in W[::3] for f in range(int(w["s"]) + 1, int(w["e"]))]
        speech_db = sorted(inside)[len(inside) // 2] if inside else -30
        floor_db = sorted(LV[1])[len(LV[1]) // 10] if LV[1] else -100
        THR = max(floor_db + 6, speech_db - 24)        # "sound": the talker or anything as loud

    def sound(f):
        return lvl(f) > THR

    def after_sound(prev_end, limit, pad):
        """First frame of the cut after kept audio: `pad` frames after its last sound."""
        last = None
        for f in range(int(prev_end) - 8, int(min(prev_end + 10, limit)) + 1):
            if sound(f):
                last = f
        return (last + 1 if last is not None else int(prev_end)) + pad

    def before_sound(next_start, limit, pad):
        """End of the cut before kept audio: `pad` frames before its first sound."""
        for f in range(int(max(next_start - 10, limit)), int(next_start) + 9):
            if sound(f):
                return f - pad
        return int(next_start) - pad

    def quietest(lo, hi):
        """The quietest frame in [lo, hi], the latest of the near-quietest (cuts just before speech)."""
        lo, hi = int(lo), int(hi)
        if hi < lo:
            return lo
        m = min(lvl(f) for f in range(lo, hi + 1))
        return max(f for f in range(lo, hi + 1) if lvl(f) <= m + 3)

    def quietest_early(lo, hi):
        """The quietest frame in [lo, hi], the earliest of the near-quietest (cuts just after speech)."""
        lo, hi = int(lo), int(hi)
        if hi < lo:
            return lo
        m = min(lvl(f) for f in range(lo, hi + 1))
        return min(f for f in range(lo, hi + 1) if lvl(f) <= m + 3)

    # Removal joins on aligned word times (WhisperX, 2026-11-06): a word's end / start is where it
    # really is, so the waveform only looks a few frames around it. Searching ±10 fr (the Z8 rule,
    # made for Whisper's loose times) grabbed the next word's onset or an untranscribed "uh" as
    # "kept sound" (Elevate: "in", "I", "uh design", mumble before "a pretty").
    def join_after(pe, cs):
        """First frame of a removal after a kept word ending at pe (cs = first removed word)."""
        pe_i = math.ceil(pe)
        if cs - pe < 4:                                  # touching words: the dip between them
            return quietest_early(pe_i, max(pe_i, int(cs)))
        last = next((f for f in range(min(pe_i + 3, int(cs) - 2), pe_i - 3, -1) if sound(f)), None)   # the word's tail
        a = (last + 1 if last is not None else pe_i) + JOIN_AFTER
        if JOIN_AFTER > 3:                               # the extra air stops short of the removed word
            a = min(a, max(pe_i + 3, int(cs) - 2))
        if any(sound(f) for f in range(a - 2, a + 1)):   # still sounding (breath / sound with no word)
            a = quietest_early(pe_i, pe_i + 5)
        return min(a, int(cs) - 1)

    def join_before(ns, ce):
        """End of a removal before a kept word starting at ns (ce = last removed word's end)."""
        ns_i = math.floor(ns)
        if ns - ce < 4:
            return quietest(min(math.ceil(ce), ns_i), ns_i)
        first = next((f for f in range(max(ns_i - 3, math.ceil(ce) + 2), ns_i + 3) if sound(f)), None)   # the word's onset
        b = (first if first is not None else ns_i) - JOIN_BEFORE
        if any(sound(f) for f in range(b - 1, b + 2)):   # sound right before the word: an "uh", a mumble
            b = quietest(ns_i - 5, ns_i - 1)
        return max(b, math.ceil(ce) + 1)

    def snap_removal(r):
        """The removal's two joins from the waveform around the aligned word times. After a finished
        thought (a beat) the join keeps BEAT more frames of air: after the word while there's room
        before the removed words, the rest before the next kept word."""
        if not LV or r.get("prev_end") is None and r.get("next_start") is None:
            return int(r["from"]), int(r["to"])
        a, b = int(r["from"]), int(r["to"])
        if r.get("prev_end") is not None:
            a = join_after(r["prev_end"], r.get("cut_start", r["from"]))
        if r.get("next_start") is not None:
            b = join_before(r["next_start"], r.get("cut_end", r["to"]))
        if b > a and r.get("prev_end") is not None and is_beat(r["prev_end"]):
            room = max(0, int(r.get("cut_start", r["from"])) - 1 - a)
            a += min(BEAT, room)
            if BEAT > room and r.get("next_start") is not None:
                b = max(math.ceil(r.get("cut_end", r["to"])) + 1, b - (BEAT - room))
        return (a, b) if b > a else (int(r["from"]), int(r["to"]))

    removals, floor = [], 0
    # removals=<file>: the edit decisions come from Claude (cut_through_claude.js) as frame
    # spans; the rule-based detection below is skipped and the rest (pauses, picture, audio) runs
    given = json.load(open(o["removals"], encoding="utf-8")) if o.get("removals") else None
    # the delivery's join shape (scripted, Jordan's edits 2026-11-09: ~10 fr after the outgoing word,
    # ~2 before the incoming one); other deliveries keep 3 and 3, and split a pause evenly
    air = (given or {}).get("pauses") or {}
    JOIN_AFTER = int(air.get("join_after", 3))
    JOIN_BEFORE = int(air.get("before", 3))
    beat_ends = sorted(float(x) for x in ((given or {}).get("beats") or []))

    def is_beat(word_end):
        """Claude marked the word ending here as the end of a thought."""
        return any(abs(word_end - x) < 1.5 for x in beat_ends)
    if given:
        start, end = given["start"], given["end"]
    else:
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
    spans += [{"from": a, "to": b, "why": "pause (second pass)", "words": None} for a, b in trims if b > a]
    if given:
        for r in given["removals"]:
            a, b = snap_removal(r)
            if b > a:
                spans.append({"from": a, "to": b, "why": f"claude {r['why']}", "words": None,
                              "reason": r.get("reason") or "", "said": r.get("words") or ""})
    spans.sort(key=lambda r: r["from"])
    merged = []
    for r in spans:
        if merged and r["from"] <= merged[-1]["to"]:
            m = merged[-1]
            m["to"] = max(m["to"], r["to"])
            if r["why"] not in m["why"]:
                m["why"] += " + " + r["why"]
            for k in ("reason", "said"):
                if r.get(k):
                    m[k] = (m.get(k) + " / " if m.get(k) else "") + r[k]
            if r["words"] and m["words"]:
                m["words"] = (min(m["words"][0], r["words"][0]), max(m["words"][1], r["words"][1]))
        else:
            merged.append(dict(r))

    # 4. pauses in what's left
    def removed(f):
        return any(r["from"] <= f < r["to"] for r in merged)

    # loud stretches with no words (laughter, applause, a dropped word) are sound, not dead air
    gp = (given or {}).get("pauses") or {}                # the delivery's pause rule (stage: looser)
    pause_max = int(o.get("pause_max", gp.get("max", PAUSE_MAX)))
    pause_left = int(o.get("pause_left", gp.get("left", PAUSE_LEFT)))
    min_save = int(o.get("pause_min_save", gp.get("min_save", {"stage": 36, "convo": 24}.get((given or {}).get("delivery"), 0))))
    shot_starts = [x.get("start") or x.get("at") for x in (given or {}).get("shots") or []]
    loud = [(int(u["s"]), int(u["e"]) + 1) for u in data.get("unheard") or []
            if (talker is None or u.get("mic") == talker or (multi and u.get("mic") in people)) and start <= u["s"] < end]
    speech = sorted([(int(w["s"]), int(w["e"]) + 1) for w in W if not removed(int(w["s"]))] +
                    [x for x in loud if not removed(x[0])])
    last = None
    for s, e in speech:
        free = any(last is not None and last <= f <= s for f in shot_starts)   # a shot change is here anyway
        if last is not None and s - last > pause_max and (free or s - last - pause_left >= min_save):
            if LV:                                      # leave pause_left frames of air, split around the join
                beat = BEAT if is_beat(last - 1) else 0  # a finished thought keeps its beat
                pad_b = int(gp.get("before", pause_left - pause_left // 2))
                a = after_sound(last, s - 2, pause_left - pad_b + beat)
                b = before_sound(s, a + 1, pad_b)
                if b <= a:
                    last = e if last is None else max(last, e)
                    continue
            else:
                a, b = last + 6, s - (pause_left - 6)
            if not any(r["from"] <= a < r["to"] or r["from"] < b <= r["to"] for r in merged):
                merged.append({"from": a, "to": b, "why": f"pause {s - last} fr → {pause_left}", "words": None})
        last = e if last is None else max(last, e)
    merged.sort(key=lambda r: r["from"])
    # second pass: give back the rest of a word a cut went through
    for ka, kb in keeps:
        out = []
        for r in merged:
            if r["to"] <= ka or r["from"] >= kb:
                out.append(r)
                continue
            if r["from"] < ka:
                out.append({**r, "to": ka})
            if r["to"] > kb:
                out.append({**r, "from": kb})
        merged = sorted((r for r in out if r["to"] > r["from"]), key=lambda r: r["from"])

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

    # head and tail from the waveform (Jordan's rule): the 8-frame fade-in ends 3 frames before the
    # first sound, and the 8-frame fade-out starts at least 3 frames after the last sound
    FADE, AIR = 8, 3
    if LV and kept:
        a0 = kept[0][0]
        first = next((f for f in range(a0, kept[0][1]) if sound(f)), None)
        if first is not None:
            prev = next((f for f in range(first - 1, max(0, first - 120), -1) if sound(f) and removed(f)), None)
            if "head" in gp:                                   # to the first word, past any breath before it
                head = int(next((w["s"] for w in W if a0 <= w["s"] < kept[0][1]), first)) - int(gp["head"])
            else:
                head = first - AIR - FADE
            if prev is not None:
                head = max(head, prev + 1 + AIR)               # never pull in the cut pre-roll's sound
            kept[0][0] = max(0, min(head, kept[0][1] - 1))
        b0 = kept[-1][1]
        last = next((f for f in range(b0 - 1, kept[-1][0], -1) if sound(f)), None)
        if last is not None:
            nxt = next((f for f in range(last + 1, last + 120) if sound(f) and removed(f)), None)
            if "tail" in gp and sum(sound(f) for f in range(last + 1, last + 17)) < 12:
                # the last word's own decay can run on into a removed post-roll: only a new onset
                # (4 quiet frames before it) is the post-roll; 12 of 16 still sounding = it touches
                nxt = next((f for f in range(last + 5, last + 120)
                            if sound(f) and removed(f) and not any(sound(g) for g in range(f - 4, f))), None)
            tail = last + 1 + int(gp.get("tail", AIR + FADE))
            if nxt is not None:
                tail = min(tail, nxt - AIR)                    # never take in the cut post-roll
            gap = next((r["from"] for r in merged if "editorial" in r["why"] and r["from"] > last), None)
            tail = min(tail, gap if gap is not None else end)  # never past the recording
            kept[-1][1] = max(kept[-1][0] + 1, tail)

    # 5. picture. With Claude's shot list (removals file "shots": [{at, angle}]) the cuts are its
    # choices; the code only keeps the hard rules: an angle change at every removal join (no jump
    # cut) and no blink-length shot between two of its own cuts. Without it: the rule rhythm below.
    claude_shots = sorted((given or {}).get("shots") or [], key=lambda x: x["at"])
    if LV:                                              # picture cuts: the quiet before the word
        for x in claude_shots:
            if x.get("start") is not None and x.get("prev_end") is not None:
                x["at"] = quietest(x["prev_end"], x["start"]) if x["start"] - x["prev_end"] >= 2 \
                    else quietest(x["start"] - 4, x["start"] + 1)
    if claude_shots:
        known = set(angles)
        for x in claude_shots:                          # a shot opening right after a removal starts
            if x.get("start") is not None and x.get("prev_end") is None:   # exactly on that join
                seg = next(((a, b) for a, b in kept if a <= x["start"] < b), None)
                if seg and x["start"] - seg[0] < 48:
                    x["at"] = seg[0]
        marks = [x for x in claude_shots if x.get("angle") in known]

        def angle_at(f):
            cur = marks[0]["angle"]
            for x in marks:
                if x["at"] > f:
                    break
                cur = x["angle"]
            return cur

        def breath(lo, hi, late=False):
            """A cut point in (lo, hi): the middle of a gap between kept words (≥ 3 fr)."""
            gaps = [(q["e"] + w["s"]) / 2 for q, w in zip(W, W[1:])
                    if w["s"] - q["e"] >= 3 and lo < (q["e"] + w["s"]) / 2 < hi and not removed(int(w["s"]))]
            return int(gaps[-1] if late else gaps[0]) if gaps else None

        def slider_split(shots, hold):
            """Claude's slider shot that runs past a moving stretch keeps the longest stretch inside
            it (cut at a breath) and gives the rest to the close-up (the slider's usual way in / out)."""
            out = []
            for sh in shots:
                g = sh["angle"]
                if moving_ok(g, sh["from"], sh["to"]):
                    out.append(sh)
                    continue
                alt = punch if punch not in (g, None) else wide
                best = max(((max(x, sh["from"]), min(y, sh["to"])) for x, y in motion[g]),
                           key=lambda r: r[1] - r[0], default=None)
                a = b = None
                if best and best[1] - best[0] >= hold:
                    a = sh["from"] if best[0] <= sh["from"] + 2 else breath(best[0], best[0] + hold)
                    b = sh["to"] if best[1] >= sh["to"] - 2 else breath(best[1] - hold, best[1], late=True)
                if a is None or b is None or b - a < hold:
                    out.append({**sh, "angle": alt, "kind": "slider"})
                    continue
                if a > sh["from"]:
                    out.append({**sh, "to": a, "angle": alt, "kind": "slider"})
                out.append({**sh, "from": a, "to": b, "join": sh["join"] and a == sh["from"]})
                if b < sh["to"]:
                    out.append({**sh, "from": b, "join": False, "angle": alt, "kind": "slider"})
            return out

        shots = []
        for si, (a, b) in enumerate(kept):
            cuts = [a] + [x["at"] for x in marks if a < x["at"] < b]
            for x0, y0 in zip(cuts, cuts[1:] + [b]):
                ang, join = angle_at(x0), x0 == a and si > 0
                if shots and not join and (ang == shots[-1]["angle"] or y0 - x0 < 36):
                    shots[-1]["to"] = y0                   # same angle again, or a <1.5 s blink: hold
                    continue
                shots.append({"from": x0, "to": y0, "angle": ang, "kind": "claude", "join": join})
        if len(known) > 1:
            # shortest comfortable shot, per style: stage holds long (3 s); a studio solo allows the
            # brief's ~2 s beats; a conversation allows ~1.7 s reactions
            hold = 40 if multi else (72 if (given or {}).get("delivery") == "stage" else 48)
            prefer = [wide, punch] + [e for e in extra if e not in (wide, punch)]
            prefer += [a for a in sorted(known, key=cam_no) if a not in prefer]
            if motion:
                shots = slider_split(shots, hold)
            shots = fit_angles(shots, [a for a in prefer if a in known], hold=hold,
                               allowed=(lambda i, g: moving_ok(g, shots[i]["from"], shots[i]["to"])) if motion else None)

            def cut_between(lo, hi):
                """A picture cut in (lo, hi): the first breath before a word (≥ 3 fr gap), else any word."""
                ws = [w for w in W if lo < w["s"] < hi and not removed(int(w["s"]))]
                prev = {id(w): q["e"] for q, w in zip(W, W[1:])}
                best = next((w for w in ws if w["s"] - prev.get(id(w), -99) >= 3), ws[0] if ws else None)
                if not best:
                    return None
                pe = prev.get(id(best), best["s"] - 2)
                return quietest(pe + 1, best["s"]) if LV and best["s"] - pe >= 2 else int(best["s"]) - 1

            # the cover cut goes ON the removal (Jordan, 2026-11-05): X | Y short ‖ X  →  X ‖ Y | X,
            # and a short cover after a join holds a beat:  X ‖ Y short | X  →  X ‖ Y (≥ hold) | X
            k = 1
            while k < len(shots):
                x, y = shots[k - 1], shots[k]
                nxt = shots[k + 1] if k + 1 < len(shots) else None
                ylen = y["to"] - y["from"]
                if (nxt and nxt["join"] and not y["join"] and ylen < hold and x["angle"] == nxt["angle"]
                        and nxt["to"] - nxt["from"] >= 2 * hold):
                    c = cut_between(nxt["from"] + max(ylen, hold), nxt["to"] - hold)
                    if c is not None:                  # X runs to the join, Y covers it, back to X
                        x["to"] = y["to"]
                        y.update({"from": nxt["from"], "to": c, "join": True, "kind": "forced"})
                        nxt.update({"from": c, "join": False})
                        shots[k - 1:k + 2] = [x, y, nxt]
                if (y["join"] and nxt and not nxt["join"] and y["to"] - y["from"] < hold
                        and nxt["to"] - nxt["from"] >= 2 * hold):
                    c = cut_between(y["from"] + hold, nxt["to"] - hold)
                    if c is not None:                  # hold the cover a beat longer
                        y["to"], nxt["from"] = c, c
                k += 1

            # a cover that runs long (a removal forced the change and Claude's next shot is far off):
            # hold it a beat, then back to Claude's angle at a breath — the other angle mostly hides
            # cuts (Bill Smith stage talk, 2026-11-05: 36 s on the wide after a 0.5 s pause trim)
            out = []
            for k, sh in enumerate(shots):
                home = angle_at(sh["from"])
                nxt = shots[k + 1] if k + 1 < len(shots) else None
                if sh["kind"] == "forced" and sh["join"] and home != sh["angle"] and sh["to"] - sh["from"] > 3 * hold:
                    c = cut_between(sh["from"] + hold, sh["from"] + 2 * hold)
                    if c is not None and sh["to"] - c >= hold:
                        # after the cover, Claude's own shots again (its marks inside this stretch)
                        cuts = [c] + [x["at"] for x in marks if c < x["at"] < sh["to"]]
                        segs = [{"from": f0, "to": f1, "angle": angle_at(f0), "kind": "claude", "join": False}
                                for f0, f1 in zip(cuts, cuts[1:] + [sh["to"]])]
                        if not (nxt and nxt["join"] and nxt["angle"] == segs[-1]["angle"]):
                            out += [{**sh, "to": c}] + segs
                            continue
                out.append(sh)
            shots = []
            for sh in out:
                if shots and not sh["join"] and shots[-1]["angle"] == sh["angle"]:
                    shots[-1]["to"] = sh["to"]
                else:
                    shots.append(sh)
    cycle = ["wide", "punch"] * 2 + (["extra"] if extra else [])
    if not claude_shots:
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
    if motion and len(shots) > 1:
        # last guard: a slider shot outside a moving stretch takes another angle (close-up first)
        for k, sh in enumerate(shots):
            if moving_ok(sh["angle"], sh["from"], sh["to"]):
                continue
            prev = shots[k - 1] if k else None
            nxt = shots[k + 1] if k + 1 < len(shots) else None
            cands = [a for a in [punch, wide] + sorted(angles, key=cam_no) if a not in motion]
            clash = lambda a, strict: ((prev and a == prev["angle"] and (strict or sh["join"])) or
                                       (nxt and a == nxt["angle"] and (strict or nxt["join"])))
            pick = next((a for a in cands if not clash(a, True)), None) or next((a for a in cands if not clash(a, False)), None)
            if pick:
                sh.update(angle=pick, kind="slider")
        joined = []
        for sh in shots:
            if joined and not sh["join"] and joined[-1]["angle"] == sh["angle"]:
                joined[-1]["to"] = sh["to"]
            else:
                joined.append(sh)
        shots = joined
    why = {"wide": "wide", "punch": "punch-in", "extra": "insert", "claude": "claude shot",
           "forced": "angle changed around a removal", "slider": "slider not moving here"}
    video = [{"in": s["from"], "out": s["to"], "angle": s["angle"],
              "why": why[s["kind"]] + (" (after a removal)" if s["join"] else "")} for s in shots]
    if not claude_shots:
        video[0]["why"], video[-1]["why"] = "open on the wide", "close on the wide"

    # 6. audio
    camera = day.get("audio_source") == "camera"
    mics = {} if camera else {talker: [[a, b] for a, b in kept]}
    if multi and not camera:
        # conversation mic gating (style guide, measured): each mic is open while its owner talks
        # (5 fr before, 8 after); a short backchannel that steps on the other talker stays closed
        BACK = {"right", "yeah", "yes", "mm-hmm", "-hmm", "hmm", "mm", "uh-huh", "okay", "sure", "correct",
                "absolutely", "exactly", "um", "uh", "so", "and", "yep", "wow", "gosh", "agree", "i"}

        def stretches(ws):
            out = []
            for w in ws:
                if out and w["s"] - out[-1]["e"] <= 24:
                    out[-1]["e"] = max(out[-1]["e"], w["e"])
                    out[-1]["w"].append(w["w"])
                else:
                    out.append({"s": w["s"], "e": w["e"], "w": [w["w"]]})
            return out

        def backchannel(st):
            toks = [re.sub(r"[^a-z\-']", "", x.lower()) for x in st["w"]]
            return len(toks) <= 3 and all(t in BACK or not t for t in toks)

        by = {p: stretches([w for w in W if w["mic"] == p]) for p in people}
        mics = {}
        DUCK = -2.5                                   # Jordan, 2026-11-05: a "yeah" that steps on the
        for p in people:                              # talker is opened, 2-fr crossfaded both ends, -2.5 dB
            others = [x for q in people if q != p for x in by[q] if not backchannel(x)]
            opens, ducks = [], []
            for st in by[p]:
                if backchannel(st) and any(x["s"] < st["e"] and st["s"] < x["e"] for x in others):
                    ducks.append([int(st["s"]) - 3, int(st["e"]) + 4, DUCK])
                    continue
                a, b = int(st["s"]) - 5, int(st["e"]) + 8
                if opens and a <= opens[-1][1] + 12:
                    opens[-1][1] = max(opens[-1][1], b)
                else:
                    opens.append([a, b])
            # a backchannel already inside (or touching) a full open stays at full level
            ducks = [d for d in ducks if not any(a - 2 <= d[1] and d[0] <= b + 2 for a, b in opens)]
            mics[p] = sorted(opens + ducks)
    if not camera and len(every_mic) > 1 and not multi:
        # the day's other mics stay closed, but keep their tracks: every video of a day has the
        # same audio layout, so one joined build puts each person on the same track
        mics = {p: mics.get(p, []) for p in every_mic}
    # 7. review markers (Jordan, 2026-11-05): red = check this, yellow = worth a look. Waveform ones
    # cost nothing; retakes come from Claude's removal reasons; "check" spots from Claude's notes.
    markers = []

    def mark(f, color, name, note):
        markers.append({"frame": int(f), "color": color, "name": name, "note": note})

    for r in merged:
        if r["why"].startswith("pause"):
            continue
        if "retake" in r["why"]:
            said = (r.get("said") or "").strip()
            mark(r["from"], "Yellow", "Retake replaced",
                 (r.get("reason") or "an earlier take") + (f" — removed: {said[:120]}" if said else ""))
        else:
            # a real repeat taken out: its own colour, so repeats can be seen (or hidden) as a group
            gone = [w for w in W if r["from"] <= (w["s"] + w["e"]) / 2 < r["to"]]
            if 1 <= len(gone) <= 3:
                k = W.index(gone[0])
                before = norm(W[k - 1]["w"]) if k else ""
                after = norm(W[k + len(gone)]["w"]) if k + len(gone) < len(W) else ""
                if norm(gone[0]["w"]) in (before, after) or norm(gone[-1]["w"]) in (before, after):
                    mark(r["from"], "Purple", "Repeat removed", f"\"{' '.join(w['w'].strip() for w in gone)}\" taken out — keep it if the repeat was deliberate")
        # a cut inside a kept word (aligned times, 1 fr of slack) — Jordan, 2026-11-06: say which
        # word, in plain words; nothing when the cut sits in the gap between words
        cut_in = [w for w in W if w["s"] + 1 < r["from"] < w["e"] - 1 or w["s"] + 1 < r["to"] < w["e"] - 1]
        for w in cut_in[:1]:
            mark(r["from"], "Red", "Word cut off", f"The cut goes through \"{w['w'].strip()}\" — listen")
        if LV and not cut_in and r["from"] > start:      # the head trim has nothing kept before it
            lv_b = sorted(lvl(f) for f in range(r["from"] - 48, r["from"]) if sound(f))
            lv_a = sorted(lvl(f) for f in range(r["to"], r["to"] + 48) if sound(f))
            if len(lv_b) >= 6 and len(lv_a) >= 6:
                jump = lv_a[len(lv_a) // 2] - lv_b[len(lv_b) // 2]
                if abs(jump) >= 10:
                    mark(r["from"], "Yellow", "Volume jump", f"{'Louder' if jump > 0 else 'Quieter'} by {abs(jump):.0f} dB after the cut")
    # a clipped word only matters where a removal follows it (elsewhere the audio plays on untouched).
    # Pause trims are cut in the quiet, so they never clip a word: on Bill's stage talk they made
    # 37 of 40 markers, all noise (Jordan, 2026-11-05).
    cuts = [r for r in merged if not r["why"].startswith("pause")]
    for w in W:
        if ("e0" in w and not removed(int(w["s"])) and any(a <= w["s"] < b for a, b in kept)
                and any(0 <= r["from"] - w["e"] <= 12 for r in cuts)):
            mark(w["e"], "Yellow", "Clipped word", f"\"{w['w'].strip()}\" ends right at a cut, where it went quiet — listen for the tail")
    for x in (given or {}).get("review") or []:
        if start <= x["frame"] < end:
            mark(x["frame"], "Red", "Check", x["note"])
    markers.sort(key=lambda m: m["frame"])
    combined = []
    for m in markers:                                 # one marker per spot: Resolve keeps one per frame
        c = combined[-1] if combined else None
        if c and m["frame"] - c["frame"] <= 12:
            c["color"] = "Red" if "Red" in (c["color"], m["color"]) else c["color"]
            if m["name"] not in c["name"]:
                c["name"] += " + " + m["name"]
            c["note"] += " / " + m["note"]
        else:
            combined.append(dict(m))
    markers = combined

    # the notes quote client words, so they stay on this machine (beside the transcript), never in
    # the plan (plans can be committed to git)
    review_p = o.get("review") or os.path.join(os.path.dirname(os.path.abspath(words_p)), f"review_{data['label']}.json")
    json.dump({"label": data["label"], "markers": markers}, open(review_p, "w", encoding="utf-8"), indent=1)
    plan = {"label": data["label"], "multicam": data["multicam"], "fps": fps, "review_file": review_p,
            "note": ("Edit by Claude (removals) + place_cuts.py (pauses, picture, audio)." if given else
                     "Draft by place_cuts.py (style-guide solo rules from the words file; no LLM)."),
            "mic_angles": {} if camera else {p: p for p in mics}, "video": video, "mics": mics,
            "audio": {"source": "camera" if camera else "wav", "angle": talker},
            "removals": [{"from": r["from"], "to": r["to"], "why": r["why"]} for r in merged]}
    json.dump(plan, open(out_p, "w", encoding="utf-8"), indent=1)

    kept_f = sum(b - a for a, b in kept)
    raw_f = end - start
    kinds = Counter(r["why"].split(" ")[0] for r in merged)
    print(f"{len(video)} picture pieces, {len(merged)} removals ({', '.join(f'{k} {v}' for k, v in kinds.items())}), "
          f"kept {kept_f / fps / 60:.1f} of {raw_f / fps / 60:.1f} min, {len(video) / max(kept_f / fps / 60, 1e-9):.1f} cuts/min")
    print(f"review markers: {sum(m['color'] == 'Red' for m in markers)} red, {sum(m['color'] == 'Yellow' for m in markers)} yellow"
          + (f"; {sum(len([o for o in v if len(o) > 2]) for v in mics.values())} backchannel(s) opened at -2.5 dB" if multi and not camera else ""))
    print("angles:", dict(Counter(v["angle"] for v in video)), f"| audio: {plan['audio']['source']} ({talker})")
    lens = sorted((v["out"] - v["in"]) / fps for v in video)
    print(f"shots: {'Claude' if claude_shots else 'rule rhythm'}; median {lens[len(lens) // 2]:.1f} s, "
          f"10–90% {lens[len(lens) // 10]:.1f}–{lens[len(lens) * 9 // 10]:.1f} s"
          + (f"; {sum(1 for v in video if v['why'].startswith('angle changed around'))} shot(s) changed around removals"
             if claude_shots else "") + f"; pauses > {pause_max} fr → {pause_left} fr"
          + ("; cuts placed from the waveform" if LV else "; cuts on word times (no levels file)"))

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
