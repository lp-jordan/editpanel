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

Several plans (or one plan split=N ways) can go into one file as separate timelines.

Usage (any machine with Python 3):
    python3 make_fcpxml.py <resolve_export.fcpxml> <out.fcpxml> [role="Camera N" ...] [split=N [part=K]] <plan.json[:name]> ...
Resolve's ImportTimelineFromFile only takes the FIRST timeline in a file, and every import
makes a new copy of the multicam. joined=NAME writes all videos back to back in ONE timeline
(one import, one copy) plus <out>_ranges.json; spike_split_batch.py then cuts it into one
timeline per video inside Resolve.
e.g. python3 make_fcpxml.py Info.fcpxml ConvoTest_xml.fcpxml host="Camera 2" guest="Camera 3" \
         plans/ConvoTest_plan.json:__SPIKE_xml_ConvoTest
The output names the client's media, so keep it out of git.
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
from fractions import Fraction
from xml.sax.saxutils import quoteattr

FD = Fraction(1001, 24000)             # 23.976 frame duration


def t(frames) -> str:
    v = Fraction(frames) * FD
    return f"{v.numerator}/{v.denominator}s" if v else "0/1s"


def attrs(tag: str) -> dict:
    """An element's attributes, whatever order Resolve wrote them in (it differs by version)."""
    return dict(re.findall(r'([\w:-]+)="([^"]*)"', tag))


def secs(v: str) -> Fraction:
    v = v.rstrip("s")
    if "/" in v:
        n, d = v.split("/")
        return Fraction(int(n), int(d))
    return Fraction(v)


def fmt_s(v: Fraction) -> str:
    return f"{v.numerator}/{v.denominator}s" if v else "0/1s"


def cam_no(name: str) -> int:
    m = re.search(r"(\d+)\s*$", name or "")
    return int(m.group(1)) if m else 999


def atem_out(media_xml: str, atem_angle: str = "Camera 1", strip_audio: bool = True):
    """The copy is rebuilt from this description on every import (2026-11-05):
      * angles are written in camera order (Camera 1, 2, 3, 4) so the copy's stack matches the
        original's (Resolve exports them in its own order, e.g. 3, 2, 4, 1);
      * the ATEM angle's audio (the mix on Camera 1) comes in red in every copy, so the copy gets
        that angle as picture only and the mix is cut as plain clips of the file, like the mics.
        ROOT CAUSE found later the same day: the copy only links an angle's audio when the importing
        timeline USES the multicam's audio (mc-source srcEnable="audio"/"all"). So the default now
        (atem=mc, strip_audio=False) keeps Camera 1 as exported and cuts A1 from the multicam's audio.
    Returns (media xml, [(angle offset s, duration s, media start s, asset ref, file name)])."""
    root = ET.fromstring(media_xml)
    mc = root.find("multicam")
    angs = sorted(mc.findall("mc-angle"), key=lambda a: cam_no(a.get("name")))
    for a in mc.findall("mc-angle"):
        mc.remove(a)
    for a in angs:
        mc.append(a)
    runs = []
    for ang in mc.findall("mc-angle"):
        if ang.get("name") != atem_angle:
            continue
        for k, el in enumerate(list(ang)):
            if el.tag != "asset-clip" or "offset" not in el.attrib:
                continue
            o, d, st = secs(el.get("offset")), secs(el.get("duration", "0s")), secs(el.get("start", "0s"))
            runs.append((o, d, st, el.get("ref"), el.get("name")))
            if not strip_audio:
                continue
            clip = ET.Element("clip", {x: el.get(x) for x in ("name", "start", "duration", "enabled", "tcFormat",
                                                               "offset", "format") if el.get(x) is not None})
            for child in list(el):
                clip.append(child)
            ET.SubElement(clip, "video", {"start": el.get("start"), "duration": el.get("duration"),
                                          "ref": el.get("ref"), "offset": el.get("start")})
            ang.remove(el)
            ang.insert(k, clip)
    return ET.tostring(root, encoding="unicode"), runs


LAST_ATEM = None                       # file name of the ATEM mix clip in the last build (for the import)


def split_off_angle_tracks(media_xml: str, remove: bool = True):
    """Resolve exports an angle's extra tracks (the mic WAV Jordan placed under a camera) as a
    second run in the same list, restarting at offset 0. On import Resolve places those clips by
    TIMECODE, and the recorder's WAVs start at 00:00:00:00, so they land hours before the video
    (stamping timecode instead knocks them offline in the original multicam — 2026-11-05).
    So: take them out of the copy's angles and return where each sat, to cut the mics as plain
    WAV clips. Returns (media xml, {angle: (asset ref, file name, angle offset s, in-point s)})."""
    root = ET.fromstring(media_xml)
    wavs = {}
    for ang in root.iter("mc-angle"):
        run, end = 0, Fraction(0)
        for el in list(ang):
            if "offset" not in el.attrib:
                continue
            o = secs(el.get("offset"))
            if o < end:
                run += 1
            end = o + secs(el.get("duration", "0s"))
            if run:
                if remove:
                    ang.remove(el)
                if el.tag == "asset-clip" and ang.get("name") not in wavs:
                    wavs[ang.get("name")] = (el.get("ref"), el.get("name"), o, secs(el.get("start", "0s")))
    return ET.tostring(root, encoding="unicode"), wavs


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


def main(argv=None) -> list:
    """Returns the video ranges when joined= is used (else [])."""
    args = sys.argv[1:] if argv is None else list(argv)
    src, out_path = args[0], args[1]
    opts = dict(a.split("=", 1) for a in args[2:] if "=" in a and not a.endswith(".json") and ".json:" not in a)
    plan_args = [a for a in args[2:] if a.endswith(".json") or ".json:" in a]
    split = int(opts.pop("split", "1"))
    part = int(opts.pop("part", "0"))                       # keep only the Nth split (1-based)
    joined = opts.pop("joined", "")                         # put every timeline into one, named this
    keep_tracks = opts.pop("angle_tracks", "strip") == "keep"   # leave the mic WAVs in the copy's angles
    mic_angle = opts
    xml = open(src, encoding="utf-8").read()
    jobs = []                                               # (timeline name, plan)
    for a in plan_args:
        path, _, name = a.partition(".json:")
        path = path if path.endswith(".json") else path + ".json"
        plan = json.load(open(path, encoding="utf-8"))
        name = name or f"__SPIKE_xml_{plan.get('label', 'cut')}"
        parts = split_plan(plan, split) if split > 1 else [plan]
        jobs += [(f"{name}_{k}" if len(parts) > 1 else name, p) for k, p in enumerate(parts, 1)
                 if not part or k == part]
    resources = re.search(r"<resources>.*?</resources>", xml, re.S).group(0)
    angle_wavs = {}
    for block in re.findall(r"<media [^>]*>\s*<multicam .*?</media>", resources, re.S):
        fixed, found = split_off_angle_tracks(block, remove=not keep_tracks)
        if found:
            if not keep_tracks:
                resources = resources.replace(block, fixed)
            angle_wavs.update(found)
            print("  mic WAVs placed in the multicam (cut as plain clips): " +
                  ", ".join(f"{n} under {a} at +{float(o):.3f}s" for a, (_, n, o, _) in sorted(angle_wavs.items())))
    atem_mode = opts.pop("atem", "mc")                      # mc = A1 cut from the multicam's Camera 1 audio (the copy
                                                            # then links it: green); cut = plain clips of the file; off
    atem_on = opts.pop("atem_on", "0") == "1"               # the mix is the fallback: clips disabled by default
    atem_runs = []
    global LAST_ATEM
    LAST_ATEM = None
    if atem_mode in ("cut", "mc"):
        for block in re.findall(r"<media [^>]*>\s*<multicam .*?</media>", resources, re.S):
            fixed, runs = atem_out(block, strip_audio=atem_mode == "cut")
            resources = resources.replace(block, fixed)
            atem_runs += runs
        if atem_runs:
            LAST_ATEM = atem_runs[0][4] if atem_mode == "cut" else "Camera 1"
            print(f"  ATEM mix (Camera 1 audio) on A1 " + ("as plain clips of " + LAST_ATEM if atem_mode == "cut"
                  else "from the multicam (keeps it linked in the copy)") + "; angles in camera order")
    # the multicam: its resource id, start timecode and angle IDs by name
    want = {p["multicam"] for _, p in jobs}
    media = next(((attrs(m.group(1)), attrs(m.group(2)))
                  for m in re.finditer(r"<media ([^>]*)>\s*<multicam ([^>]*)>", resources)
                  if attrs(m.group(1)).get("name") in want), None)
    if not media or len(want) != 1:
        raise SystemExit(f"multicam {sorted(want)} not found in {src}")
    mc_name, mc_id = media[0]["name"], media[0]["id"]
    num, den = media[1]["tcStart"].rstrip("s").split("/")
    mc_tc = Fraction(int(num), int(den)) / FD               # multicam start, in frames
    angles = {a["name"]: a["angleID"] for a in map(attrs, re.findall(r"<mc-angle ([^>]*)>", resources))}
    fmt = re.search(r'<sequence [^>]*format="(r\d+)"', xml).group(1)
    seq_tc = 86400                                          # 01:00:00:00 at 24 fps timebase
    src_t = lambda f: t(mc_tc + f)                          # multicam-relative frame → source time

    def spine(plan: dict, base: int):
        """Picture clips (record offset `base`) with the mics hanging off the first one."""
        pieces = plan["video"]
        offs, rec = [], 0
        for p in pieces:
            offs.append(rec)
            rec += p["out"] - p["in"]
        # each speaker's mic runs under the whole cut, split where the source jumps (a removal)
        # and where the mic opens/closes; closed = a disabled clip (Jordan's enable/disable gating)
        lanes = []
        for role in plan["mics"]:
            opens = sorted(plan["mics"][role])
            clips = []                                      # [src in, src out, record offset, enabled]
            for p, off in zip(pieces, offs):
                marks = sorted({p["in"], p["out"], *(x for a, b in opens for x in (a, b) if p["in"] < x < p["out"])})
                for lo, hi in zip(marks, marks[1:]):
                    on = any(a <= lo and hi <= b for a, b in opens)
                    r0 = off + (lo - p["in"])
                    last = clips[-1] if clips else None
                    if last and last[1] == lo and last[2] + (last[1] - last[0]) == r0 and last[3] == on:
                        last[1] = hi                        # angle-only switch: no audio cut
                    else:
                        clips.append([lo, hi, r0, on])
            lanes.append((role, clips))
        if atem_runs:                                       # A1: the ATEM mix, cut with the picture
            clips = []
            for p, off in zip(pieces, offs):
                marks = sorted({p["in"], p["out"], *(x for o, d, *_ in atem_runs
                                                     for x in (round(o / FD), round((o + d) / FD))
                                                     if p["in"] < x < p["out"])})
                for lo, hi in zip(marks, marks[1:]):
                    r0 = off + (lo - p["in"])
                    last = clips[-1] if clips else None
                    if last and last[1] == lo and last[2] + (last[1] - last[0]) == r0:
                        last[1] = hi
                    else:
                        # a day with no mic WAVs (plan audio = camera): the mix IS the audio → on
                        clips.append([lo, hi, r0, atem_on or (plan.get("audio") or {}).get("source") == "camera"])
            lanes.insert(0, ("ATEM", clips))
        first, lines = pieces[0], []
        for k, (p, off) in enumerate(zip(pieces, offs)):
            lines.append(f'                        <mc-clip ref="{mc_id}" name={quoteattr(mc_name)} '
                         f'duration="{t(p["out"] - p["in"])}" offset="{t(seq_tc + base + off)}" start="{src_t(p["in"])}">')
            lines.append(f'                            <mc-source srcEnable="video" angleID="{angles[p["angle"]]}"/>')
            if k == 0:                                      # every mic hangs off the first clip
                for lane, (role, clips) in enumerate(lanes, 1):
                    if role == "ATEM":
                        lines.append(f'                            <spine lane="{-lane}" offset="{src_t(first["in"])}">')
                        pos = 0
                        for s_, e_, r0, on in clips:
                            if r0 > pos:
                                lines.append(f'                                <gap name="Gap" duration="{t(r0 - pos)}" '
                                             f'offset="{t(pos)}" start="3600/1s"/>')
                            sec = Fraction(s_) * FD
                            if atem_mode == "mc":
                                lines.append(f'                                <mc-clip ref="{mc_id}" name={quoteattr(mc_name)} '
                                             f'duration="{t(e_ - s_)}" offset="{t(r0)}" start="{src_t(s_)}" enabled="{int(on)}">')
                                lines.append(f'                                    <mc-source srcEnable="audio" angleID="{angles["Camera 1"]}"/>')
                                lines.append("                                </mc-clip>")
                            else:
                                o, d, st, ref, fname = next((x for x in atem_runs if x[0] <= sec < x[0] + x[1]), atem_runs[0])
                                lines.append(f'                                <asset-clip ref="{ref}" name={quoteattr(fname)} '
                                             f'srcEnable="audio" duration="{t(e_ - s_)}" offset="{t(r0)}" '
                                             f'start="{fmt_s(st + sec - o)}" enabled="{int(on)}"/>')
                            pos = r0 + (e_ - s_)
                        lines.append("                            </spine>")
                        continue
                    angle = mic_angle.get(role)
                    if not angle:
                        raise SystemExit(f"no mic angle given for {role!r} (add {role}=\"Camera N\")")
                    wav = angle_wavs.get(angle)              # Jordan's mic WAV under that angle
                    lines.append(f'                            <spine lane="{-lane}" offset="{src_t(first["in"])}">')
                    pos = 0
                    for s, e, r0, on in clips:
                        if r0 > pos:
                            lines.append(f'                                <gap name="Gap" duration="{t(r0 - pos)}" '
                                         f'offset="{t(pos)}" start="3600/1s"/>')
                        if wav:                                  # multicam frame s → WAV time
                            ref, fname, o, inp = wav
                            lines.append(f'                                <asset-clip ref="{ref}" name={quoteattr(fname)} '
                                         f'duration="{t(e - s)}" offset="{t(r0)}" '
                                         f'start="{fmt_s(inp + Fraction(s) * FD - o)}" enabled="{int(on)}"/>')
                        else:                                    # mic recorded into the camera file
                            lines.append(f'                                <mc-clip ref="{mc_id}" name={quoteattr(mc_name)} '
                                         f'duration="{t(e - s)}" offset="{t(r0)}" start="{src_t(s)}" enabled="{int(on)}">')
                            lines.append(f'                                    <mc-source srcEnable="audio" angleID="{angles[angle]}"/>')
                            lines.append("                                </mc-clip>")
                        pos = r0 + (e - s)
                    lines.append("                            </spine>")
            lines.append("                        </mc-clip>")
        summary = ", ".join(f"{role} {len(c)} audio clip(s) ({sum(1 for x in c if x[3])} open)" for role, c in lanes)
        return lines, rec, f"{len(pieces)} picture clip(s), {summary}"

    def project(name: str, body: list, total: int) -> list:
        return [f"            <project name={quoteattr(name)}>",
                f'                <sequence tcFormat="NDF" tcStart="{t(seq_tc)}" duration="{t(total)}" format="{fmt}">',
                "                    <spine>", *body, "                    </spine>",
                "                </sequence>", "            </project>"]

    # Always 1.14: Resolve 21's scripted export is 1.10, and importing a 1.10 file rebuilt the
    # multicam wrong (original nested on angle 1, other angles offline, no mic WAVs — 2026-11-05),
    # while the same description labelled 1.14 imports correctly.
    out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", '<fcpxml version="1.14">',
           "    " + resources, "    <library>", '        <event name="__SPIKE_xml batch">']
    if joined:
        # every video back to back in ONE timeline (one import = one multicam copy); the
        # ranges file tells spike_split_batch.py where each video starts and ends
        body, ranges, base = [], [], 0
        for name, plan in jobs:
            lines, total, summary = spine(plan, base)
            body += lines
            ranges.append({"name": name, "start": base, "end": base + total})
            print(f"  {name}: frames {base}-{base + total}, {summary}, {float(total * FD) / 60:.1f} min")
            base += total
        out += project(joined, body, base)
        rpath = out_path.rsplit(".", 1)[0] + "_ranges.json"
        json.dump({"timeline": joined, "videos": ranges}, open(rpath, "w", encoding="utf-8"), indent=1)
        print(f"{rpath}: {len(ranges)} range(s)")
    else:
        ranges = []
        for name, plan in jobs:
            lines, total, summary = spine(plan, 0)
            out += project(name, lines, total)
            print(f"  {name}: {summary}, {float(total * FD) / 60:.1f} min")
    out += ["        </event>", "    </library>", "</fcpxml>", ""]
    open(out_path, "w", encoding="utf-8").write("\n".join(out))
    print(f"{out_path}: {1 if joined else len(jobs)} timeline(s)")
    return ranges


if __name__ == "__main__":
    main()
