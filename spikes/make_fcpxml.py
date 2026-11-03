#!/usr/bin/env python3
"""
SPIKE — Write a cut plan as an FCPXML timeline that picks multicam angles itself.

Instead of forcing each clip's angle in Resolve (SmartSwitch, ~5 frames/s), the plan is
written as FCPXML 1.14 the way Resolve exports a multicam edit:
  - picture: <mc-clip> pieces on the main spine with <mc-source srcEnable="video" angleID=…>
  - sound:   one connected storyline per speaker (lane 1 = first role, lane 2 = second…)
             of <mc-clip> pieces with <mc-source srcEnable="audio" angleID=…>, gaps where the
             mic is closed.
The <resources> (formats, assets, the multicam and its angle IDs) are copied from an FCPXML
that Resolve exported from the same project, so the multicam definition matches exactly.

Several plans (or one plan split=N ways) go into ONE file as separate timelines, so one
import makes one multicam copy for the whole batch.

Usage (any machine with Python 3):
    python3 make_fcpxml.py <resolve_export.fcpxml> <out.fcpxml> [role="Camera N" ...] [split=N] <plan.json[:name]> ...
e.g. python3 make_fcpxml.py Info.fcpxml ConvoTest_xml.fcpxml host="Camera 2" guest="Camera 3" \
         plans/ConvoTest_plan.json:__SPIKE_xml_ConvoTest
The output names the client's media, so keep it out of git.
"""
import json
import re
import sys
from fractions import Fraction
from xml.sax.saxutils import quoteattr

FD = Fraction(1001, 24000)             # 23.976 frame duration


def t(frames) -> str:
    v = Fraction(frames) * FD
    return f"{v.numerator}/{v.denominator}s" if v else "0/1s"


def split_plan(plan: dict, n: int) -> list:
    """Cut one plan into n consecutive timelines (at picture-piece boundaries)."""
    v = plan["video"]
    size = -(-len(v) // n)
    parts = []
    for k in range(0, len(v), size):
        pv = v[k:k + size]
        lo, hi = min(p["in"] for p in pv), max(p["out"] for p in pv)
        mics = {r: [[max(a, lo), min(b, hi)] for a, b in R if min(b, hi) > max(a, lo)]
                for r, R in plan["mics"].items()}
        parts.append({**plan, "video": pv, "mics": mics})
    return parts


def main() -> None:
    args = sys.argv[1:]
    src, out_path = args[0], args[1]
    opts = dict(a.split("=", 1) for a in args[2:] if "=" in a and not a.endswith(".json") and ".json:" not in a)
    plan_args = [a for a in args[2:] if a.endswith(".json") or ".json:" in a]
    split = int(opts.pop("split", "1"))
    mic_angle = opts
    xml = open(src, encoding="utf-8").read()
    jobs = []                                               # (timeline name, plan)
    for a in plan_args:
        path, _, name = a.partition(".json:")
        path = path if path.endswith(".json") else path + ".json"
        plan = json.load(open(path, encoding="utf-8"))
        name = name or f"__SPIKE_xml_{plan.get('label', 'cut')}"
        parts = split_plan(plan, split) if split > 1 else [plan]
        jobs += [(f"{name}_{k}" if len(parts) > 1 else name, p) for k, p in enumerate(parts, 1)]
    resources = re.search(r"<resources>.*?</resources>", xml, re.S).group(0)
    # the multicam: its resource id, start timecode and angle IDs by name
    media = re.search(r'<media name=([\'"])(.*?)\1 id="(r\d+)">\s*<multicam [^>]*tcStart="([^"]+)"', resources)
    if not media or any(media.group(2) != p["multicam"] for _, p in jobs):
        raise SystemExit(f"multicam not found in {src}")
    mc_name, mc_id = media.group(2), media.group(3)
    num, den = media.group(4).rstrip("s").split("/")
    mc_tc = Fraction(int(num), int(den)) / FD               # multicam start, in frames
    angles = dict((n, i) for n, i in re.findall(r'<mc-angle name="([^"]+)" angleID="([^"]+)"', resources))
    fmt = re.search(r'<sequence [^>]*format="(r\d+)"', xml).group(1)
    seq_tc = 86400                                          # 01:00:00:00 at 24 fps timebase
    src_t = lambda f: t(mc_tc + f)                          # multicam-relative frame → source time

    out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", '<fcpxml version="1.14">',
           "    " + resources, "    <library>", '        <event name="__SPIKE_xml batch">']
    for name, plan in jobs:
        pieces = plan["video"]
        offs, rec = [], 0
        for p in pieces:
            offs.append(rec)
            rec += p["out"] - p["in"]
        total = rec
        # each speaker's open mic, mapped from kept source to record (split where the source jumps)
        lanes = []
        for role in plan["mics"]:
            clips = []
            for s, e in sorted(plan["mics"][role]):
                for p, off in zip(pieces, offs):
                    lo, hi = max(s, p["in"]), min(e, p["out"])
                    if hi <= lo:
                        continue
                    r0 = off + (lo - p["in"])
                    if clips and clips[-1][1] == lo and clips[-1][2] + (clips[-1][1] - clips[-1][0]) == r0:
                        clips[-1][1] = hi
                    else:
                        clips.append([lo, hi, r0])
            lanes.append((role, clips))
        first = pieces[0]
        out += [f"            <project name={quoteattr(name)}>",
                f'                <sequence tcFormat="NDF" tcStart="{t(seq_tc)}" duration="{t(total)}" format="{fmt}">',
                "                    <spine>"]
        for k, (p, off) in enumerate(zip(pieces, offs)):
            out.append(f'                        <mc-clip ref="{mc_id}" name={quoteattr(mc_name)} '
                       f'duration="{t(p["out"] - p["in"])}" offset="{t(seq_tc + off)}" start="{src_t(p["in"])}">')
            out.append(f'                            <mc-source srcEnable="video" angleID="{angles[p["angle"]]}"/>')
            if k == 0:                                      # every mic hangs off the first clip
                for lane, (role, clips) in enumerate(lanes, 1):
                    angle = mic_angle.get(role)
                    if not angle:
                        raise SystemExit(f"no mic angle given for {role!r} (add {role}=\"Camera N\")")
                    out.append(f'                            <spine lane="{lane}" offset="{src_t(first["in"])}">')
                    pos = 0
                    for s, e, r0 in clips:
                        if r0 > pos:
                            out.append(f'                                <gap name="Gap" duration="{t(r0 - pos)}" '
                                       f'offset="{t(pos)}" start="3600/1s"/>')
                        out.append(f'                                <mc-clip ref="{mc_id}" name={quoteattr(mc_name)} '
                                   f'duration="{t(e - s)}" offset="{t(r0)}" start="{src_t(s)}">')
                        out.append(f'                                    <mc-source srcEnable="audio" angleID="{angles[angle]}"/>')
                        out.append("                                </mc-clip>")
                        pos = r0 + (e - s)
                    out.append("                            </spine>")
            out.append("                        </mc-clip>")
        out += ["                    </spine>", "                </sequence>", "            </project>"]
        print(f"  {name}: {len(pieces)} picture clip(s), " +
              ", ".join(f"{role} {len(c)} audio clip(s)" for role, c in lanes) + f", {float(total * FD) / 60:.1f} min")
    out += ["        </event>", "    </library>", "</fcpxml>", ""]
    open(out_path, "w", encoding="utf-8").write("\n".join(out))
    print(f"{out_path}: {len(jobs)} timeline(s)")


if __name__ == "__main__":
    main()
