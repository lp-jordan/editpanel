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

Usage (any machine with Python 3):
    python3 make_fcpxml.py <resolve_export.fcpxml> <plan.json> <out.fcpxml> [timeline name] [role=Camera N ...]
e.g. python3 make_fcpxml.py Info.fcpxml plans/ConvoTest_plan.json ConvoTest_xml.fcpxml \
         __SPIKE_xml_ConvoTest host="Camera 2" guest="Camera 3"
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


def main() -> None:
    src, plan_path, out_path = sys.argv[1:4]
    name = sys.argv[4] if len(sys.argv) > 4 else "__SPIKE_xml"
    mic_angle = dict(a.split("=", 1) for a in sys.argv[5:])
    xml = open(src, encoding="utf-8").read()
    plan = json.load(open(plan_path, encoding="utf-8"))
    resources = re.search(r"<resources>.*?</resources>", xml, re.S).group(0)
    # the multicam: its resource id, start timecode and angle IDs by name
    media = re.search(r'<media name=([\'"])(.*?)\1 id="(r\d+)">\s*<multicam [^>]*tcStart="([^"]+)"', resources)
    if not media or media.group(2) != plan["multicam"]:
        raise SystemExit(f"multicam {plan['multicam']!r} not found in {src}")
    mc_id = media.group(3)
    num, den = media.group(4).rstrip("s").split("/")
    mc_tc = Fraction(int(num), int(den)) / FD               # multicam start, in frames
    angles = dict((n, i) for n, i in re.findall(r'<mc-angle name="([^"]+)" angleID="([^"]+)"', resources))
    fmt = re.search(r'<sequence [^>]*format="(r\d+)"', xml).group(1)
    seq_tc = 86400                                          # 01:00:00:00 at 24 fps timebase

    src_t = lambda f: t(mc_tc + f)                          # multicam-relative frame → source time
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
    out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", '<fcpxml version="1.14">',
           "    " + resources, "    <library>", f"        <event name={quoteattr(name)}>",
           f"            <project name={quoteattr(name)}>",
           f'                <sequence tcFormat="NDF" tcStart="{t(seq_tc)}" duration="{t(total)}" format="{fmt}">',
           "                    <spine>"]
    for k, (p, off) in enumerate(zip(pieces, offs)):
        out.append(f'                        <mc-clip ref="{mc_id}" name={quoteattr(plan["multicam"])} '
                   f'duration="{t(p["out"] - p["in"])}" offset="{t(seq_tc + off)}" start="{src_t(p["in"])}">')
        out.append(f'                            <mc-source srcEnable="video" angleID="{angles[p["angle"]]}"/>')
        if k == 0:                                          # every mic hangs off the first clip
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
                    out.append(f'                                <mc-clip ref="{mc_id}" name={quoteattr(plan["multicam"])} '
                               f'duration="{t(e - s)}" offset="{t(r0)}" start="{src_t(s)}">')
                    out.append(f'                                    <mc-source srcEnable="audio" angleID="{angles[angle]}"/>')
                    out.append("                                </mc-clip>")
                    pos = r0 + (e - s)
                out.append("                            </spine>")
        out.append("                        </mc-clip>")
    out += ["                    </spine>", "                </sequence>", "            </project>",
            "        </event>", "    </library>", "</fcpxml>", ""]
    open(out_path, "w", encoding="utf-8").write("\n".join(out))
    print(f"{out_path}: {len(pieces)} picture clip(s), " +
          ", ".join(f"{role} {len(c)} audio clip(s) on {mic_angle[role]}" for role, c in lanes) +
          f", {float(total * FD) / 60:.1f} min")


if __name__ == "__main__":
    main()
