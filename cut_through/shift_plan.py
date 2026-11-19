#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cut-through fix-up: move finished plans onto a multicam whose audio was slipped AFTER Prep.

The day's audio (Hollyland) runs ~4 frames ahead of the picture; the fix is a hand slip of the
audio inside the multicam, and it belongs BEFORE Prep. Prep → Transcribe → Plan put every word
and every cut on the multicam clock as the audio sat then, while Build exports the multicam fresh.
So a slip made after Plan reaches the timeline, but every cut lands that many frames off the words.

When every mic was slipped by the same amount, adding that amount to every frame in the plan
gives what re-running Prep → Transcribe → Plan would place, without a new Claude edit. This
script does that for each plan (video in/out, mic spans, removals), its review markers, and the
run's words_ and levels_ files (the Check that runs after Build reads the words against the
built timeline, so they have to move too).

    python shift_plan.py <run folder | plan.json ...> frames=4

  frames: how far the audio moved, in multicam frames; positive = audio moved later (the usual
          fix for audio that runs ahead). Use the amount you slipped by (CedricConvo needed 5).
  A run folder means every *_plan.json in it (solo and per-video plans).

Each file is backed up first as <name>.preshift.json; a plan already shifted (it records
"audio_shift_frames") is refused, so the shift can't be applied twice. With the run's
day_<LABEL>.json beside the plan, frames are kept inside the multicam.

After this, Build (and its Check) runs as normal. The day file and Claude's removals_ file stay
on the old clock: don't re-run Transcribe or Plan on this run — to re-plan, re-run from Prep.
Narration plans (no multicam) are refused.
"""
import glob
import json
import os
import shutil
import sys


def backup(path):
    b = path[:-5] + ".preshift.json" if path.endswith(".json") else path + ".preshift"
    if not os.path.exists(b):
        shutil.copy2(path, b)
    return b


def review_path(plan, plan_path):
    """The plan's review file: its recorded path, or the same file name beside the plan (a run
    folder read from another machine, e.g. the NAS seen from the Mac)."""
    rf = plan.get("review_file")
    if not rf:
        return None
    if os.path.exists(rf):
        return rf
    local = os.path.join(os.path.dirname(os.path.abspath(plan_path)), rf.replace("\\", "/").split("/")[-1])
    return local if os.path.exists(local) else None


def multicam_frames(plan, plan_path):
    """The multicam's length in frames from the run's day file, or None."""
    day = os.path.join(os.path.dirname(os.path.abspath(plan_path)), f"day_{plan.get('label', '').split('__')[0]}.json")
    try:
        d = json.load(open(day, encoding="utf-8"))
        return int(round(d["length_sec"] * d["frame_sec"][1] / d["frame_sec"][0]))
    except Exception:
        return None


def shift_plan(plan, n, length):
    def f(x):
        y = int(x) + n
        return max(0, min(y, length)) if length else max(0, y)

    for v in plan.get("video") or []:
        v["in"], v["out"] = f(v["in"]), f(v["out"])
    plan["video"] = [v for v in plan.get("video") or [] if v["out"] > v["in"]]
    for role, spans in (plan.get("mics") or {}).items():
        out = []
        for s in spans:
            a, b = f(s[0]), f(s[1])
            if b > a:
                out.append([a, b, *s[2:]])
        plan["mics"][role] = out
    for r in plan.get("removals") or []:
        r["from"], r["to"] = f(r["from"]), f(r["to"])
    plan["removals"] = [r for r in plan.get("removals") or [] if r["to"] > r["from"]]
    plan["audio_shift_frames"] = n
    return plan


WORD_TIMES = ("s", "e", "e0", "ws", "we")


def shift_words(d, n):
    for w in (d.get("words") or []) + (d.get("unheard") or []):
        for k in WORD_TIMES:
            if isinstance(w.get(k), (int, float)):
                w[k] = w[k] + n


def main(argv):
    opts = dict(a.split("=", 1) for a in argv if "=" in a)
    targets = [a for a in argv if "=" not in a]
    if "frames" not in opts or not targets:
        sys.exit(__doc__)
    n = int(opts["frames"])
    if n == 0:
        sys.exit("frames=0: nothing to shift")

    plans = []
    for t in targets:
        if os.path.isdir(t):
            plans += sorted(p for p in glob.glob(os.path.join(t, "*_plan.json")) if not p.endswith(".preshift.json"))
        else:
            plans.append(t)
    if not plans:
        sys.exit("No *_plan.json found")

    done_reviews, failed = set(), 0
    for p in plans:
        plan = json.load(open(p, encoding="utf-8"))
        name = os.path.basename(p)
        if "audio_shift_frames" in plan:
            print(f"SKIP {name}: already shifted by {plan['audio_shift_frames']} frame(s)")
            failed += 1
            continue
        if plan.get("narration") or not plan.get("video"):
            print(f"SKIP {name}: a narration plan (no multicam picture) — nothing to re-sync")
            failed += 1
            continue
        length = multicam_frames(plan, p)
        backup(p)
        shift_plan(plan, n, length)
        json.dump(plan, open(p, "w", encoding="utf-8"), indent=1)
        line = f"OK   {name}: {len(plan['video'])} picture piece(s), {len(plan['removals'])} removal(s) moved {n:+d} fr"

        rp = review_path(plan, p)
        if rp and os.path.abspath(rp) not in done_reviews:
            rev = json.load(open(rp, encoding="utf-8"))
            if "audio_shift_frames" not in rev:
                backup(rp)
                for m in rev.get("markers") or []:
                    m["frame"] = max(0, int(m["frame"]) + n)
                rev["audio_shift_frames"] = n
                json.dump(rev, open(rp, "w", encoding="utf-8"), indent=1)
                line += f"; {len(rev.get('markers') or [])} review marker(s)"
            done_reviews.add(os.path.abspath(rp))
        elif not rp and plan.get("review_file"):
            line += "; review file not found (markers left as they were)"
        print(line + ("" if length else "; no day file, not clamped to the multicam length"))

    # The Check that runs after Build reads the words file against the built timeline; levels go with it.
    for folder in sorted({os.path.dirname(os.path.abspath(p)) for p in plans}):
        for wp in sorted(glob.glob(os.path.join(folder, "words_*.json"))) + sorted(glob.glob(os.path.join(folder, "levels_*.json"))):
            if wp.endswith(".preshift.json"):
                continue
            d = json.load(open(wp, encoding="utf-8"))
            if "audio_shift_frames" in d:
                print(f"SKIP {os.path.basename(wp)}: already shifted by {d['audio_shift_frames']} frame(s)")
                continue
            if not any("audio_shift_frames" in json.load(open(p, encoding="utf-8")) for p in plans
                       if os.path.dirname(os.path.abspath(p)) == folder):
                continue                                   # no plan here was shifted (all skipped)
            backup(wp)
            if os.path.basename(wp).startswith("words_"):
                shift_words(d, n)
                what = f"{len(d.get('words') or [])} word(s), {len(d.get('unheard') or [])} unheard stretch(es)"
            else:
                for lv in (d.get("mics") or {}).values():
                    lv["start"] = int(lv["start"]) + n
                what = f"{len(d.get('mics') or {})} mic level track(s)"
            d["audio_shift_frames"] = n
            json.dump(d, open(wp, "w", encoding="utf-8"))
            print(f"OK   {os.path.basename(wp)}: {what} moved {n:+d} fr")

    print("Backups: *.preshift.json beside each file. Build (and its Check) from here — to re-plan, re-run from Prep.")
    sys.exit(1 if failed and failed == len(plans) else 0)


if __name__ == "__main__":
    main(sys.argv[1:])
