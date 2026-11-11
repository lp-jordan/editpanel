#!/usr/bin/env python3
"""
Cut-through: write cut plans as one FCPXML timeline that picks multicam angles itself.

Instead of forcing each clip's angle in Resolve (SmartSwitch, ~5 frames/s), the plans are
written as FCPXML 1.14 the way Resolve exports a multicam edit:
  - picture: <mc-clip> pieces on the main spine with <mc-source srcEnable="video" angleID=…>
  - sound, as connected storylines hanging off the first picture piece:
      A1 lane: the multicam's own audio on the audio angle (the ATEM mix on Camera 1, or the
               angle Prep picked as the camera audio) — <mc-clip> pieces with
               <mc-source srcEnable="audio">, cut with the picture. Using the multicam's audio is
               what makes the imported copy link that angle's sound (plain clips came in red).
               Enabled only on a camera-audio day (plan audio.source = "camera").
      one lane per speaker: the mic WAVs placed under an angle in the multicam, as plain
               <asset-clip>s of the WAV file (Resolve places clips inside an imported multicam by
               timecode, and the recorder's WAVs start at 00:00:00:00, so they can't ride along in
               the copy's angles); a mic recorded into the camera file is an audio <mc-clip>
               instead. A closed mic = a disabled clip; a quieter backchannel gets adjust-volume.
The <resources> (formats, assets, the multicam and its angle IDs) are copied from an FCPXML
that Resolve exported from the same project, so the multicam definition matches exactly.

Usage (any machine with Python 3; build_rough_cut.py calls main() directly):
    python3 write_timeline_xml.py <resolve_export.fcpxml> <out.fcpxml> [role="Camera N" ...] joined=NAME <plan.json[:name]> ...
Resolve's ImportTimelineFromFile only takes the FIRST timeline in a file, and every import
makes a new copy of the multicam. So every video is written back to back in ONE timeline named
NAME (one import, one copy) plus <out>_ranges.json; split_into_videos.py then cuts it into one
timeline per video inside Resolve.
The output names the client's media, so keep it out of git.
"""
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from fractions import Fraction
from xml.sax.saxutils import quoteattr


def _common():
    """common.py from this script's own folder, loaded fresh (see its docstring)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "cut_through_common", os.path.join(os.path.dirname(os.path.abspath(__file__)), "common.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_c = _common()
attrs, secs, cam_no, frame_duration = _c.attrs, _c.secs, _c.cam_no, _c.frame_duration

FD = _c.DEFAULT_FD                     # frame duration; main() resets it from the multicam's own format


def t(frames) -> str:
    v = Fraction(frames) * FD
    return f"{v.numerator}/{v.denominator}s" if v else "0/1s"


def fmt_s(v: Fraction) -> str:
    return f"{v.numerator}/{v.denominator}s" if v else "0/1s"


def atem_out(media_xml: str, atem_angle: str = "Camera 1"):
    """The copy is rebuilt from this description on every import (2026-11-05):
      * angles are written in camera order (Camera 1, 2, 3, 4) so the copy's stack matches the
        original's (Resolve exports them in its own order, e.g. 3, 2, 4, 1);
      * the audio angle (the ATEM mix on Camera 1) is left as exported: the copy only links an
        angle's audio when the importing timeline USES the multicam's audio (mc-source
        srcEnable="audio"/"all"), so A1 is cut from the multicam's audio.
    Returns (media xml, [(angle offset s, duration s, media start s, asset ref, file name)]) —
    the audio angle's clips, so A1 is also cut where that angle's recordings start and end."""
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
        for el in list(ang):
            if el.tag != "asset-clip" or "offset" not in el.attrib:
                continue
            o, d, st = secs(el.get("offset")), secs(el.get("duration", "0s")), secs(el.get("start", "0s"))
            runs.append((o, d, st, el.get("ref"), el.get("name")))
    return ET.tostring(root, encoding="unicode"), runs


LAST_ATEM = None                       # the angle whose multicam audio is on A1 in the last build (for the import)


def camera_audio_refs(resources: str) -> dict:
    """Audio-only assets that are a CAMERA file's own sound (same file as a picture asset) →
    the ids of every picture asset of that file. Resolve exports an angle that way when the
    camera's audio sits on its own track under the picture (Bill Smith mc_1, 2026-11-05) — camera
    audio, not a mic WAV. One file can be the picture of two angles (the punch-in cut from the 4K
    wide: Elevate CAM 1 = Camera 1 and Camera 2, 2026-11-06), so it's a set, matched per angle."""
    pics, auds = {}, {}
    for m in re.finditer(r"<asset ([^>]*)>\s*<media-rep [^>]*src=\"([^\"]+)\"", resources):
        a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        if a.get("hasVideo") == "1":
            pics.setdefault(m.group(2), set()).add(a.get("id"))
        elif a.get("hasAudio") == "1":
            auds[a.get("id")] = m.group(2)
    return {ref: pics[src] for ref, src in auds.items() if src in pics}


def fold_camera_audio(media_xml: str, cam_refs: dict):
    """Put a camera's own audio back INSIDE the picture clips (<video><audio lane="-1" …/></video>,
    the layout Resolve exports when the audio isn't on its own track). Imported as a separate clip
    of an audio-only asset, Resolve made an EMPTY compound clip of it and the copy's A1 was silent
    (Bill Smith mc_1, 2026-11-05, twice; Elevate ELEVATE_MC_3, 2026-11-10).
    The sound doesn't have to line up with its picture: Elevate's sat 4 frames later than the
    picture (a sync nudge), and the 4K MXF covered most of CAM 1 01's picture. So each sound piece
    is cut at the picture clips it overlaps and each part rides inside that picture clip at the
    same place and source time (still pointing at the sound's own file). Sound over a gap in the
    picture (the slide's last few frames past a recording's end) is dropped. Returns (media xml,
    set of audio asset ids no longer used)."""
    if not cam_refs:
        return media_xml, set()
    root = ET.fromstring(media_xml)
    used_by_unfolded, touched = set(), set()
    for ang in root.iter("mc-angle"):
        run, end, items = 0, Fraction(0), []           # (run no., element), like split_off_angle_tracks
        for el in list(ang):
            if "offset" not in el.attrib:
                continue
            o = secs(el.get("offset"))
            if o < end:
                run += 1
            end = o + secs(el.get("duration", "0s"))
            items.append((run, el))
        pics = [el for _, el in items if el.find("video") is not None]
        angle_pic_refs = {p.find("video").get("ref") for p in pics}
        for k, (rn, el) in enumerate(items):
            aud = next((x for x in el.iter("audio") if x.get("ref") in cam_refs), None)
            if aud is None or el.find("video") is not None:
                continue
            refs = cam_refs[aud.get("ref")]
            file_ref = next(iter(sorted(refs & angle_pic_refs) or sorted(refs)))   # picture asset of the SAME file
            a0 = secs(el.get("offset"))
            a1 = a0 + secs(el.get("duration"))
            src0 = secs(aud.get("start")) + (secs(el.get("start", "0s")) - secs(aud.get("offset", aud.get("start"))))
            parts = 0
            for p in pics:
                p0 = secs(p.get("offset"))
                p1 = p0 + secs(p.get("duration"))
                lo, hi = max(a0, p0), min(a1, p1)
                if hi - lo < FD:                        # under a frame of overlap: nothing to carry
                    continue
                lo = p0 if abs(lo - p0) < FD else lo    # within a frame of the picture's edges = the edges
                hi = p1 if abs(hi - p1) < FD else hi
                vid = p.find("video")
                local = secs(vid.get("offset")) + (lo - p0)   # the picture clip's own time at `lo`
                src = src0 + (lo - a0)
                if vid.get("ref") in refs:              # same file as this picture: within a frame of the
                    pic_src = secs(vid.get("start")) + (lo - p0)   # picture's own time = that time (sample-
                    src = pic_src if abs(src - pic_src) < FD else src  # rounded audio times otherwise)
                ET.SubElement(vid, "audio", {"lane": "-1", "srcCh": aud.get("srcCh") or "1",
                                             "offset": fmt_s(local), "start": fmt_s(src),
                                             "duration": fmt_s(hi - lo), "ref": file_ref})
                parts += 1
            if not parts:
                used_by_unfolded.add(aud.get("ref"))
                continue
            # the sound's own run (a gap up to it, then the clip) goes; the picture's run stays
            if rn and k > 0 and items[k - 1][0] == rn and items[k - 1][1].tag == "gap":
                ang.remove(items[k - 1][1])
            ang.remove(el)
            touched.add(aud.get("ref"))
    return ET.tostring(root, encoding="unicode"), touched - used_by_unfolded


def split_off_angle_tracks(media_xml: str, keep_refs: set = frozenset()):
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


def main(argv=None) -> list:
    """Returns the video ranges (also written to <out>_ranges.json)."""
    global FD
    args = sys.argv[1:] if argv is None else list(argv)
    src, out_path = args[0], args[1]
    opts = dict(a.split("=", 1) for a in args[2:] if "=" in a and not a.endswith(".json") and ".json:" not in a)
    plan_args = [a for a in args[2:] if a.endswith(".json") or ".json:" in a]
    joined = opts.pop("joined", "")                         # every video goes into one timeline, named this
    if not joined:
        raise SystemExit("joined=NAME is required (every video goes into one timeline)")
    mic_angle = opts                                        # role → the angle carrying that person's mic
    xml = open(src, encoding="utf-8").read()
    jobs = []                                               # (timeline name, plan)
    for a in plan_args:
        path, _, name = a.partition(".json:")
        path = path if path.endswith(".json") else path + ".json"
        plan = json.load(open(path, encoding="utf-8"))
        plan["markers"] = load_review(plan)
        jobs.append((name or f"{plan.get('label', 'cut')} rough cut", plan))
    FD = frame_duration(xml, {p["multicam"] for _, p in jobs})
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
        fixed, found = split_off_angle_tracks(block, keep_refs=set(cam_refs))
        if found:
            resources = resources.replace(block, fixed)
            angle_wavs.update(found)
            print("  mic WAVs placed in the multicam (cut as plain clips): " +
                  ", ".join(f"{n} under {a} at +{float(o):.3f}s" for a, (_, n, o, _) in sorted(angle_wavs.items())))
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
    for block in re.findall(r"<media [^>]*>\s*<multicam .*?</media>", resources, re.S):
        fixed, runs = atem_out(block, atem_angle=atem_angle)
        resources = resources.replace(block, fixed)
        atem_runs += runs
    # A1 reads the audio from the multicam itself, so it doesn't need the angle's clips to be
    # plain asset-clips (an export can wrap them in <clip>) — only the angle has to exist
    if atem_angle in angle_names:
        LAST_ATEM = atem_angle
        print(f"  {atem_angle} audio on A1 from the multicam (keeps it linked in the copy); angles in camera order")
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
    seq_tc = 3600 * round(1 / FD)                           # 01:00:00:00 in the multicam's timebase (NDF)
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
        if LAST_ATEM:                                       # A1: the multicam's audio angle, cut with the picture
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
                        clips.append([lo, hi, r0, (plan.get("audio") or {}).get("source") == "camera", None])
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
                            lines.append(f'                                <mc-clip ref="{mc_id}" name={quoteattr(mc_name)} '
                                         f'duration="{t(e_ - s_)}" offset="{t(r0)}" start="{src_t(s_)}" enabled="{int(on)}">')
                            lines.append(f'                                    <mc-source srcEnable="audio" angleID="{angles[atem_angle]}"/>')
                            lines.append("                                </mc-clip>")
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
    out += ["        </event>", "    </library>", "</fcpxml>", ""]
    open(out_path, "w", encoding="utf-8").write("\n".join(out))
    print(f"{out_path}: 1 timeline(s)")
    return ranges


if __name__ == "__main__":
    main()
