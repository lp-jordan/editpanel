#!/usr/bin/env python3
"""
Cut-through: write a cut plan as an FCPXML timeline that picks multicam angles itself.

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
    python3 write_timeline_xml.py <resolve_export.fcpxml> <out.fcpxml> [role="Camera N" ...] [split=N [part=K]] <plan.json[:name]> ...
Resolve's ImportTimelineFromFile only takes the FIRST timeline in a file, and every import
makes a new copy of the multicam. joined=NAME writes all videos back to back in ONE timeline
(one import, one copy) plus <out>_ranges.json; split_into_videos.py then cuts it into one
timeline per video inside Resolve.
e.g. python3 write_timeline_xml.py Info.fcpxml ConvoTest_xml.fcpxml host="Camera 2" guest="Camera 3" \
         "plans/ConvoTest_plan.json:ConvoTest rough cut"
The output names the client's media, so keep it out of git.
"""
import json
import os
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


def camera_audio_refs(resources: str) -> dict:
    """Audio-only assets that are a CAMERA file's own sound (same file as a picture asset) →
    that picture asset's id. Resolve exports an angle that way when the camera's audio sits on its
    own track under the picture (Bill Smith mc_1, 2026-11-05) — camera audio, not a mic WAV."""
    pics, auds = {}, {}
    for m in re.finditer(r"<asset ([^>]*)>\s*<media-rep [^>]*src=\"([^\"]+)\"", resources):
        a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        if a.get("hasVideo") == "1":
            pics[m.group(2)] = a.get("id")
        elif a.get("hasAudio") == "1":
            auds[a.get("id")] = m.group(2)
    return {ref: pics[src] for ref, src in auds.items() if src in pics}


def fold_camera_audio(media_xml: str, cam_refs: dict):
    """Put a camera's own audio back INSIDE its picture clip (<video><audio lane="-1" …/></video>,
    the layout Resolve exports when the audio isn't on its own track). Imported as a separate clip
    of an audio-only asset, Resolve made an EMPTY compound clip of it and the copy's A1 was silent
    (Bill Smith mc_1, 2026-11-05, twice). Only folds when the audio lines up with the picture clip
    (same file, same place, same length). Returns (media xml, set of folded audio asset ids)."""
    if not cam_refs:
        return media_xml, set()
    root = ET.fromstring(media_xml)
    folded = set()
    for ang in root.iter("mc-angle"):
        kids = [el for el in ang if "offset" in el.attrib]
        for el in kids:
            aud = next((x for x in el.iter("audio") if x.get("ref") in cam_refs), None)
            if aud is None or el.find("video") is not None or el.get("ref") in cam_refs.values():
                continue
            pic_ref = cam_refs[aud.get("ref")]
            pic = next((p for p in kids if p is not el and p.find("video") is not None
                        and p.find("video").get("ref") == pic_ref
                        and abs(secs(p.get("offset")) - secs(el.get("offset"))) < FD
                        and abs(secs(p.get("duration")) - secs(el.get("duration"))) < FD), None)
            if pic is None:
                continue
            vid = pic.find("video")
            if any(x.tag == "audio" for x in vid):
                continue
            attrs_ = {k: vid.get(k) for k in ("offset", "duration", "start")}
            ET.SubElement(vid, "audio", {"lane": "-1", "srcCh": aud.get("srcCh") or "1", **attrs_, "ref": pic_ref})
            # the audio's own run (a gap up to it, then the clip) goes; the picture's run stays
            run = list(ang)
            k = run.index(el)
            if k > 0 and run[k - 1].tag == "gap" and run.index(pic) < k - 1:
                ang.remove(run[k - 1])
            ang.remove(el)
            folded.add(aud.get("ref"))
    return ET.tostring(root, encoding="unicode"), folded


def split_off_angle_tracks(media_xml: str, remove: bool = True, keep_refs: set = frozenset()):
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
                refs = {x.get("ref") for x in el.iter() if x.get("ref")}
                if refs & set(keep_refs):
                    continue                           # the camera's own audio: keep it in the angle
                if remove:
                    ang.remove(el)
                if el.tag == "asset-clip" and ang.get("name") not in wavs:
                    wavs[ang.get("name")] = (el.get("ref"), el.get("name"), o, secs(el.get("start", "0s")))
    return ET.tostring(root, encoding="unicode"), wavs


def load_review(plan: dict) -> list:
    """The review markers place_cuts.py left beside the transcript (they quote client words, so
    they never sit in the plan). Missing file = no markers."""
    p = plan.get("review_file")
    if not p:
        return []
    for cand in (p, os.path.join(os.path.expanduser("~/Desktop"), os.path.basename(p.replace("\\", "/")))):
        if os.path.isfile(cand):
            return json.load(open(cand, encoding="utf-8")).get("markers") or []
    return []


def split_plan(plan: dict, n: int) -> list:
    """Cut one plan into n consecutive timelines (at picture-piece boundaries)."""
    v = plan["video"]
    size = -(-len(v) // n)
    parts = []
    for k in range(0, len(v), size):
        pv = v[k:k + size]
        lo, hi = min(p["in"] for p in pv), max(p["out"] for p in pv)
        mics = {r: [[max(o[0], lo), min(o[1], hi), *o[2:]] for o in R if min(o[1], hi) > max(o[0], lo)]
                for r, R in plan["mics"].items()}
        marks = [m for m in plan.get("markers") or [] if lo <= m["frame"] < hi]
        parts.append({**plan, "video": pv, "mics": mics, "markers": marks})
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
        plan["markers"] = load_review(plan)
        name = name or f"{plan.get('label', 'cut')} rough cut"
        parts = split_plan(plan, split) if split > 1 else [plan]
        jobs += [(f"{name} {k}" if len(parts) > 1 else name, p) for k, p in enumerate(parts, 1)
                 if not part or k == part]
    resources = re.search(r"<resources>.*?</resources>", xml, re.S).group(0)
    angle_wavs = {}
    cam_refs = camera_audio_refs(resources)
    if cam_refs:
        for block in re.findall(r"<media [^>]*>\s*<multicam .*?</media>", resources, re.S):
            fixed, folded = fold_camera_audio(block, cam_refs)
            resources = resources.replace(block, fixed)
            for ref in folded:                             # the audio-only asset isn't used any more
                resources = re.sub(r'\s*<asset [^>]*id="%s"[^>]*>.*?</asset>' % re.escape(ref), "", resources, flags=re.S)
            if folded:
                print(f"  camera audio on its own track under the picture: folded back into the picture clip "
                      f"({len(folded)} file(s))")
    for block in re.findall(r"<media [^>]*>\s*<multicam .*?</media>", resources, re.S):
        fixed, found = split_off_angle_tracks(block, remove=not keep_tracks, keep_refs=set(cam_refs))
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
    # which angle's own audio goes on A1: the ATEM mix on Camera 1, or — on a day with no mic WAVs —
    # the angle Prep picked as the audio (plan audio.angle; angles may be named "Angle 1", not "Camera 1")
    angle_names = re.findall(r'<mc-angle [^>]*name="([^"]+)"', resources)
    cam_audio = [(p.get("audio") or {}) for _, p in jobs if (p.get("audio") or {}).get("source") == "camera"]
    atem_angle = (cam_audio[0].get("angle") if cam_audio else None) or "Camera 1"
    if cam_audio and atem_angle not in angle_names:
        raise SystemExit(f"the plan's audio is {atem_angle!r}'s camera audio, but the multicam's angles are "
                         f"{angle_names} — the cut would be silent (rerun Prep, then Plan)")
    if atem_mode in ("cut", "mc"):
        for block in re.findall(r"<media [^>]*>\s*<multicam .*?</media>", resources, re.S):
            fixed, runs = atem_out(block, atem_angle=atem_angle, strip_audio=atem_mode == "cut")
            resources = resources.replace(block, fixed)
            atem_runs += runs
        # "mc" reads the audio from the multicam itself, so it doesn't need the angle's clips to be
        # plain asset-clips (an export can wrap them in <clip>) — only the angle has to exist
        if atem_runs or (atem_mode == "mc" and atem_angle in angle_names):
            LAST_ATEM = atem_runs[0][4] if atem_mode == "cut" else atem_angle
            print(f"  {atem_angle} audio on A1 " + ("as plain clips of " + LAST_ATEM if atem_mode == "cut"
                  else "from the multicam (keeps it linked in the copy)") + "; angles in camera order")
        elif cam_audio:
            raise SystemExit(f"no audio found on {atem_angle!r} — the cut would be silent")
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
            # an open is [from, to] or [from, to, gain dB] (a backchannel opened quieter)
            opens = sorted((o[0], o[1], o[2] if len(o) > 2 else None) for o in plan["mics"][role])
            clips = []                                      # [src in, src out, record offset, enabled, gain dB]
            for p, off in zip(pieces, offs):
                marks = sorted({p["in"], p["out"], *(x for a, b, _ in opens for x in (a, b) if p["in"] < x < p["out"])})
                for lo, hi in zip(marks, marks[1:]):
                    hit = next((o for o in opens if o[0] <= lo and hi <= o[1]), None)
                    on, gain = hit is not None, hit[2] if hit else None
                    r0 = off + (lo - p["in"])
                    last = clips[-1] if clips else None
                    if last and last[1] == lo and last[2] + (last[1] - last[0]) == r0 and last[3] == on and last[4] == gain:
                        last[1] = hi                        # angle-only switch: no audio cut
                    else:
                        clips.append([lo, hi, r0, on, gain])
            lanes.append((role, clips))
        if LAST_ATEM:                                       # A1: the ATEM mix / camera audio, cut with the picture
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
                        clips.append([lo, hi, r0, atem_on or (plan.get("audio") or {}).get("source") == "camera", None])
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
                        for s_, e_, r0, on, _g in clips:
                            if r0 > pos:
                                lines.append(f'                                <gap name="Gap" duration="{t(r0 - pos)}" '
                                             f'offset="{t(pos)}" start="3600/1s"/>')
                            sec = Fraction(s_) * FD
                            if atem_mode == "mc":
                                lines.append(f'                                <mc-clip ref="{mc_id}" name={quoteattr(mc_name)} '
                                             f'duration="{t(e_ - s_)}" offset="{t(r0)}" start="{src_t(s_)}" enabled="{int(on)}">')
                                lines.append(f'                                    <mc-source srcEnable="audio" angleID="{angles[atem_angle]}"/>')
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
                    for s, e, r0, on, gain in clips:
                        if r0 > pos:
                            lines.append(f'                                <gap name="Gap" duration="{t(r0 - pos)}" '
                                         f'offset="{t(pos)}" start="3600/1s"/>')
                        vol = (f'                                    <adjust-volume amount="{gain:+.1f}dB"/>'
                               if gain is not None else None)
                        if wav:                                  # multicam frame s → WAV time
                            ref, fname, o, inp = wav
                            head = (f'                                <asset-clip ref="{ref}" name={quoteattr(fname)} '
                                    f'duration="{t(e - s)}" offset="{t(r0)}" '
                                    f'start="{fmt_s(inp + Fraction(s) * FD - o)}" enabled="{int(on)}"')
                            lines += [head + ">", vol, "                                </asset-clip>"] if vol else [head + "/>"]
                        else:                                    # mic recorded into the camera file
                            lines.append(f'                                <mc-clip ref="{mc_id}" name={quoteattr(mc_name)} '
                                         f'duration="{t(e - s)}" offset="{t(r0)}" start="{src_t(s)}" enabled="{int(on)}">')
                            if vol:
                                lines.append(vol)
                            lines.append(f'                                    <mc-source srcEnable="audio" angleID="{angles[angle]}"/>')
                            lines.append("                                </mc-clip>")
                        pos = r0 + (e - s)
                    lines.append("                            </spine>")
            lines.append("                        </mc-clip>")
        summary = ", ".join(f"{role} {len(c)} audio clip(s) ({sum(1 for x in c if x[3])} open)" for role, c in lanes)

        def rec_of(f):                                      # multicam frame → record frame in this video
            for p, off in zip(pieces, offs):
                if p["in"] <= f < p["out"]:
                    return off + f - p["in"]
                if p["in"] > f:
                    return off                               # inside a removal: the splice
            return max(0, rec - 1)
        extras = {
            "markers": [{**m, "frame": rec_of(m["frame"])} for m in plan.get("markers") or []],
            # quieter backchannels: the split step crossfades both ends (2 fr) of these record ranges
            "ducks": [[x[2], x[2] + x[1] - x[0], x[4]] for _, c in lanes for x in c if x[3] and x[4] is not None]
        }
        return lines, rec, f"{len(pieces)} picture clip(s), {summary}", extras

    def project(name: str, body: list, total: int) -> list:
        return [f"            <project name={quoteattr(name)}>",
                f'                <sequence tcFormat="NDF" tcStart="{t(seq_tc)}" duration="{t(total)}" format="{fmt}">',
                "                    <spine>", *body, "                    </spine>",
                "                </sequence>", "            </project>"]

    # Always 1.14: Resolve 21's scripted export is 1.10, and importing a 1.10 file rebuilt the
    # multicam wrong (original nested on angle 1, other angles offline, no mic WAVs — 2026-11-05),
    # while the same description labelled 1.14 imports correctly.
    out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", '<fcpxml version="1.14">',
           "    " + resources, "    <library>", '        <event name="Cut-through">']
    if joined:
        # every video back to back in ONE timeline (one import = one multicam copy); the
        # ranges file tells split_into_videos.py where each video starts and ends
        body, ranges, base = [], [], 0
        for name, plan in jobs:
            lines, total, summary, extras = spine(plan, base)
            body += lines
            ranges.append({"name": name, "start": base, "end": base + total, **extras})
            print(f"  {name}: frames {base}-{base + total}, {summary}, {float(total * FD) / 60:.1f} min")
            base += total
        out += project(joined, body, base)
        rpath = out_path.rsplit(".", 1)[0] + "_ranges.json"
        json.dump({"timeline": joined, "videos": ranges}, open(rpath, "w", encoding="utf-8"), indent=1)
        print(f"{rpath}: {len(ranges)} range(s)")
    else:
        ranges = []
        for name, plan in jobs:
            lines, total, summary, _extras = spine(plan, 0)
            out += project(name, lines, total)
            print(f"  {name}: {summary}, {float(total * FD) / 60:.1f} min")
    out += ["        </event>", "    </library>", "</fcpxml>", ""]
    open(out_path, "w", encoding="utf-8").write("\n".join(out))
    print(f"{out_path}: {1 if joined else len(jobs)} timeline(s)")
    return ranges


if __name__ == "__main__":
    main()
