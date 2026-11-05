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
removals=<file>: Claude's edit (EditPanel's Cut-through, cut_through_claude.js) replaces the
rule-based retake/stutter/count detection; pause trims, picture and audio still run here.
NOT handled by the rules alone (Claude's job): producer notes / off-camera chatter, a retake reworded rather
than repeated, deliberate emphasis repeats ("let me say that again" with no count) — check those.

Usage:
    python plan_solo.py <words.json> <day.json> <out_plan.json> [start=<frame>] [end=<frame>] [removals=<file>]
        [levels=<levels_LABEL.json>] [pause_max=<fr>] [pause_left=<fr>]
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
    # Resolve exports angles in its own order (e.g. 3, 2, 4, 1): sort by the number in the name
    angles = sorted(day.get("angles") or [], key=lambda a: int((re.findall(r"(\d+)\s*$", a) or [999])[0]))
    wide = o.get("wide") or ("Camera 1" if "Camera 1" in angles else angles[0])          # Camera 1 / "Angle 1"
    punch = o.get("punch") or next((a for a in ("Camera 2", *angles) if a in angles and a != wide), wide)
    extra = [v for k, v in opts if k == "extra" and v and v not in (wide, punch)]
    cuts = [tuple(map(int, v.split("-"))) for k, v in opts if k == "cut"]

    # one talker (solo), or — with Claude's edit — a conversation: every mic is a person (angle N =
    # the person on camera N, Jordan's rule) and everyone's words count
    people = list(data.get("mics") or [])
    multi = bool(o.get("removals")) and len(people) > 1
    talker = people[0] if people else None
    W = sorted((w for w in data["words"] if w.get("own", True) and
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
    # early or late). levels=<file> is transcribe_day.py's per-frame level of the talker's track.
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

    def snap_removal(r):
        """Z8 join: 3 frames after the last kept sound, 3 before the next (~6 fr of air across)."""
        if not LV or r.get("prev_end") is None and r.get("next_start") is None:
            return int(r["from"]), int(r["to"])
        a, b = int(r["from"]), int(r["to"])
        if r.get("prev_end") is not None:
            pe, cs = r["prev_end"], r.get("cut_start", r["from"])
            a = after_sound(pe, cs - 2, 3) if cs - pe >= 4 else quietest(pe - 2, cs + 2)
        if r.get("next_start") is not None:
            ns, ce = r["next_start"], r.get("cut_end", r["to"])
            b = before_sound(ns, ce + 2, 3) if ns - ce >= 4 else quietest(ce - 2, ns + 2)
        return (a, b) if b > a else (int(r["from"]), int(r["to"]))

    removals, floor = [], 0
    # removals=<file>: the edit decisions come from Claude (cut_through_claude.js) as frame
    # spans; the rule-based detection below is skipped and the rest (pauses, picture, audio) runs
    given = json.load(open(o["removals"], encoding="utf-8")) if o.get("removals") else None
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
    if given:
        for r in given["removals"]:
            a, b = snap_removal(r)
            if b > a:
                spans.append({"from": a, "to": b, "why": f"claude {r['why']}", "words": None})
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

    # loud stretches with no words (laughter, applause, a dropped word) are sound, not dead air
    gp = (given or {}).get("pauses") or {}                # the delivery's pause rule (stage: looser)
    pause_max = int(o.get("pause_max", gp.get("max", PAUSE_MAX)))
    pause_left = int(o.get("pause_left", gp.get("left", PAUSE_LEFT)))
    loud = [(int(u["s"]), int(u["e"]) + 1) for u in data.get("unheard") or []
            if (talker is None or u.get("mic") == talker or (multi and u.get("mic") in people)) and start <= u["s"] < end]
    speech = sorted([(int(w["s"]), int(w["e"]) + 1) for w in W if not removed(int(w["s"]))] +
                    [x for x in loud if not removed(x[0])])
    last = None
    for s, e in speech:
        if last is not None and s - last > pause_max:
            if LV:                                      # leave pause_left frames of air, split around the join
                a = after_sound(last, s - 2, pause_left // 2)
                b = before_sound(s, a + 1, pause_left - pause_left // 2)
                if b <= a:
                    last = e if last is None else max(last, e)
                    continue
            else:
                a, b = last + 6, s - (pause_left - 6)
            if not any(r["from"] <= a < r["to"] or r["from"] < b <= r["to"] for r in merged):
                merged.append({"from": a, "to": b, "why": f"pause {s - last} fr → {pause_left}", "words": None})
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

    # head and tail from the waveform (Jordan's rule): the 8-frame fade-in ends 3 frames before the
    # first sound, and the 8-frame fade-out starts at least 3 frames after the last sound
    FADE, AIR = 8, 3
    if LV and kept:
        a0 = kept[0][0]
        first = next((f for f in range(a0, kept[0][1]) if sound(f)), None)
        if first is not None:
            prev = next((f for f in range(first - 1, max(0, first - 120), -1) if sound(f) and removed(f)), None)
            head = first - AIR - FADE
            if prev is not None:
                head = max(head, prev + 1 + AIR)               # never pull in the cut pre-roll's sound
            kept[0][0] = max(0, min(head, kept[0][1] - 1))
        b0 = kept[-1][1]
        last = next((f for f in range(b0 - 1, kept[-1][0], -1) if sound(f)), None)
        if last is not None:
            nxt = next((f for f in range(last + 1, last + 120) if sound(f) and removed(f)), None)
            tail = last + 1 + AIR + FADE
            if nxt is not None:
                tail = min(tail, nxt - AIR)                    # never take in the cut post-roll
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

        shots = []
        for si, (a, b) in enumerate(kept):
            cuts = [a] + [x["at"] for x in marks if a < x["at"] < b]
            for x0, y0 in zip(cuts, cuts[1:] + [b]):
                ang, join = angle_at(x0), x0 == a and si > 0
                if shots and not join and (ang == shots[-1]["angle"] or y0 - x0 < 36):
                    shots[-1]["to"] = y0                   # same angle again, or a <1.5 s blink: hold
                    continue
                shots.append({"from": x0, "to": y0, "angle": ang, "kind": "claude", "join": join})
        for x, y in zip(shots, shots[1:]):                 # a removal must sit on an angle change
            if y["angle"] == x["angle"] and len(known) > 1:
                y["angle"] = punch if x["angle"] == wide else wide
                y["kind"] = "forced"
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
    why = {"wide": "wide", "punch": "punch-in", "extra": "insert", "claude": "claude shot",
           "forced": "angle change forced at a removal"}
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
        for p in people:
            others = [x for q in people if q != p for x in by[q] if not backchannel(x)]
            opens = []
            for st in by[p]:
                if backchannel(st) and any(x["s"] < st["e"] and st["s"] < x["e"] for x in others):
                    continue
                a, b = int(st["s"]) - 5, int(st["e"]) + 8
                if opens and a <= opens[-1][1] + 12:
                    opens[-1][1] = max(opens[-1][1], b)
                else:
                    opens.append([a, b])
            mics[p] = opens
    plan = {"label": data["label"], "multicam": data["multicam"], "fps": fps,
            "note": ("Edit by Claude (removals) + plan_solo.py (pauses, picture, audio)." if given else
                     "Draft by plan_solo.py (style-guide solo rules from the words file; no LLM)."),
            "mic_angles": {} if camera else {p: p for p in mics}, "video": video, "mics": mics,
            "audio": {"source": "camera" if camera else "wav", "angle": talker},
            "removals": [{"from": r["from"], "to": r["to"], "why": r["why"]} for r in merged]}
    json.dump(plan, open(out_p, "w", encoding="utf-8"), indent=1)

    kept_f = sum(b - a for a, b in kept)
    raw_f = end - start
    kinds = Counter(r["why"].split(" ")[0] for r in merged)
    print(f"{len(video)} picture pieces, {len(merged)} removals ({', '.join(f'{k} {v}' for k, v in kinds.items())}), "
          f"kept {kept_f / fps / 60:.1f} of {raw_f / fps / 60:.1f} min, {len(video) / max(kept_f / fps / 60, 1e-9):.1f} cuts/min")
    print("angles:", dict(Counter(v["angle"] for v in video)), f"| audio: {plan['audio']['source']} ({talker})")
    lens = sorted((v["out"] - v["in"]) / fps for v in video)
    print(f"shots: {'Claude' if claude_shots else 'rule rhythm'}; median {lens[len(lens) // 2]:.1f} s, "
          f"10–90% {lens[len(lens) // 10]:.1f}–{lens[len(lens) * 9 // 10]:.1f} s"
          + (f"; {sum(1 for v in video if v['why'].startswith('angle change forced'))} angle(s) forced at removals"
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
