#!/usr/bin/env python3
"""
SPIKE — Can the mic clips go on with the API instead of inside the import file?

ELEVATE_MC_4 (2026-11-16): one import of ~5,900 clips (2,106 multicam + 3,775 mic clips over 54
same-named WAV takes) froze Resolve twice. The lighter plan: import picture + camera audio only,
then put the mic clips on with MediaPool.AppendToTimeline, naming the exact media pool clip.
This answers, on the real footage:
  1. How fast is AppendToTimeline for mic pieces (1, then batches of 50, then 200)?
  2. Do the pieces land where asked, at the length asked (audio frames vs timeline frames)?
  3. Mono WAVs: do they go on the default A1, or need a mono track?
  4. Can a clip's volume be set from the API (which property, if any)?
  5. How fast is muting (SetClipEnabled False) at a few hundred clips?

It makes one scratch timeline "CT SPIKE append mics" (delete it afterwards) and changes nothing
else, except: mic clips still named "<name> [ct <folder>]" from the frozen import get their
names back.

Run in Resolve (project "Elevate Pools" open): Workspace → Console → Py3, then
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_append_mics.py").read())
Report: printed, and saved to Desktop\\spike_append_mics.txt.
Another joined file: set XML = r"...\\X_joined.fcpxml" in the console before the exec line.
"""
import os
import re
import time
from fractions import Fraction
from urllib.parse import unquote

XML = globals().get("XML") or (r"N:\Client AV Assets\[1] ACTIVE\Elevate Pools\Cut-Through"
                                r"\Elevate Pools\ELEVATE_MC_4\ELEVATE_MC_4_joined.fcpxml")
SCRATCH = "CT SPIKE append mics"
REPORT = os.path.join(os.path.expanduser("~"), "Desktop", "spike_append_mics.txt")
_out = []


def say(m=""):
    print(m)
    _out.append(str(m))


def safe(fn, default=None):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        return default if default is not None else f"<error {e}>"


def norm(p):
    return str(p or "").replace("/", "\\").lower()


def secs(v):
    v = str(v or "0s").rstrip("s")
    return Fraction(v) if "/" in v else Fraction(v or "0")


def walk(folder):
    for c in folder.GetClipList() or []:
        yield c
    for s in folder.GetSubFolderList() or []:
        yield from walk(s)


def parse(path):
    """Mic pieces from the joined FCPXML: [(path, start s, duration s, enabled, gain dB or None)]."""
    txt = open(path, encoding="utf-8").read()
    fd = Fraction(re.search(r'<format [^>]*frameDuration="([^"]+)"', txt).group(1).rstrip("s"))
    wav = {}
    for m in re.finditer(r'<asset ([^>]*)>\s*<media-rep[^>]*src="([^"]*)"', txt):
        if ".wav" in m.group(2).lower():
            aid = re.search(r'\bid="([^"]*)"', m.group(1)).group(1)
            wav[aid] = norm(unquote(m.group(2)).replace("file://localhost/", ""))
    pieces = []
    for m in re.finditer(r'<asset-clip ([^>]*?)(/>|>(.*?)</asset-clip>)', txt, re.S):
        a = m.group(1)
        ref = re.search(r'\bref="([^"]*)"', a).group(1)
        if ref not in wav:
            continue
        gain = re.search(r'adjust-volume amount="([^"]+)dB"', m.group(3) or "")
        pieces.append((wav[ref], secs(re.search(r'\bstart="([^"]*)"', a).group(1)),
                       secs(re.search(r'\bduration="([^"]*)"', a).group(1)),
                       'enabled="0"' not in a, float(gain.group(1)) if gain else None))
    return fd, pieces


def main():
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    say(f"Resolve {safe(lambda: r.GetVersionString())} — project '{project.GetName()}'")

    # leftover tags from the frozen import
    back = 0
    for c in walk(mp.GetRootFolder()):
        m = re.match(r"^(.*) \[ct [^\]]*\]$", str(safe(lambda: c.GetName(), "")))
        if m and (safe(lambda: c.SetName(m.group(1)), False) or safe(lambda: c.SetClipProperty("Clip Name", m.group(1)), False)):
            back += 1
    say(f"Leftover import tags taken off: {back}")

    fd, pieces = parse(XML)
    fps = float(1 / fd)
    say(f"Joined file: {len(pieces)} mic pieces, {sum(1 for p in pieces if not p[3])} muted, "
        f"{sum(1 for p in pieces if p[4] is not None)} with a volume change; timeline {fps:.3f} fps")

    by_path = {}
    for c in walk(mp.GetRootFolder()):
        p = norm(safe(lambda: c.GetClipProperty("File Path"), ""))
        if p.endswith(".wav"):
            by_path.setdefault(p, c)
    have = [p for p in pieces if p[0] in by_path]
    say(f"Media pool clips found for {len({p[0] for p in have})} of {len({p[0] for p in pieces})} WAV files")
    if not have:
        say("✗ none of the WAVs are in the media pool — stopping")
        return
    c0 = by_path[have[0][0]]
    say(f"Sample WAV clip props: FPS={safe(lambda: c0.GetClipProperty('FPS'))} "
        f"Frames={safe(lambda: c0.GetClipProperty('Frames'))} Duration={safe(lambda: c0.GetClipProperty('Duration'))} "
        f"Audio Ch={safe(lambda: c0.GetClipProperty('Audio Ch'))} Format={safe(lambda: c0.GetClipProperty('Format'))}")

    old = [project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount()) + 1)]
    old = [t for t in old if t.GetName() == SCRATCH]
    if old:
        mp.DeleteTimelines(old)
    tl = mp.CreateEmptyTimeline(SCRATCH)
    if not tl:
        say("✗ could not make the scratch timeline")
        return
    project.SetCurrentTimeline(tl)
    t0 = int(tl.GetStartFrame())
    say(f"Scratch timeline '{SCRATCH}' made; start frame {t0}; audio tracks {tl.GetTrackCount('audio')} "
        f"(A1 type {safe(lambda: tl.GetTrackSubType('audio', 1))})")
    mono = safe(lambda: tl.AddTrack("audio", "mono"), False)
    say(f"AddTrack('audio', 'mono') → {mono}; A2 type {safe(lambda: tl.GetTrackSubType('audio', 2))}")

    rec = [t0]                                   # next free record frame (pieces laid end to end, 12-frame gaps)

    def infos(batch, track):
        out = []
        for p, st, du, _on, _g in batch:
            s = int(round(st * fps))
            n = max(1, int(round(du * fps)))
            out.append({"mediaPoolItem": by_path[p], "startFrame": s, "endFrame": s + n - 1,
                        "mediaType": 2, "trackIndex": track, "recordFrame": rec[0]})
            rec[0] += n + 12
        return out

    def run(batch, track, label):
        ci = infos(batch, track)
        t1 = time.time()
        got = safe(lambda: mp.AppendToTimeline(ci), [])
        dt = time.time() - t1
        got = got if isinstance(got, list) else []
        say(f"{label}: {len(ci)} asked → {len(got)} placed in {dt:.2f}s"
            + (f" ({dt / len(ci) * 1000:.0f} ms/clip)" if ci else ""))
        return ci, got, dt

    # 1. one clip on each track: does mono land on A1 (stereo) or need the mono track, and where
    for track in (1, 2):
        ci, got, _ = run(have[:1], track, f"Single clip → A{track}")
        if got:
            it = got[0]
            say(f"    asked record {ci[0]['recordFrame']} len {ci[0]['endFrame'] - ci[0]['startFrame'] + 1}"
                f" → start {it.GetStart()} dur {it.GetDuration()} track {safe(lambda: it.GetTrackTypeAndIndex())}"
                f" left offset {safe(lambda: it.GetLeftOffset())} (asked in-point {ci[0]['startFrame']})")
    good = 2 if len([x for x in tl.GetItemListInTrack("audio", 2) or []]) else 1
    say(f"Using A{good} for the batches")

    # 2. batches
    times, placed = [], []
    pos = 1
    for size, label in ((50, "Batch of 50 (1)"), (50, "Batch of 50 (2)"), (200, "Batch of 200")):
        batch = have[pos:pos + size]
        pos += size
        if not batch:
            break
        ci, got, dt = run(batch, good, label)
        times.append((len(ci), dt))
        placed += list(zip(ci, got))
    n_all = sum(n for n, _ in times)
    t_all = sum(d for _, d in times)
    if n_all:
        est = t_all / n_all * len(pieces)
        say(f"→ {n_all} clips in {t_all:.1f}s; all {len(pieces)} would take about {est:.0f}s ({est / 60:.1f} min)")
    off = [(c, it) for c, it in placed if it.GetDuration() != c["endFrame"] - c["startFrame"] + 1
           or it.GetStart() != c["recordFrame"]]
    say(f"Placement: {len(placed) - len(off)}/{len(placed)} exactly where and as long as asked"
        + (f"; e.g. asked {off[0][0]['recordFrame']}+{off[0][0]['endFrame'] - off[0][0]['startFrame'] + 1}"
           f" got {off[0][1].GetStart()}+{off[0][1].GetDuration()}" if off else ""))

    # 3. volume
    items = [it for _, it in placed] or list(tl.GetItemListInTrack("audio", good) or [])
    if items:
        it = items[0]
        props = safe(lambda: it.GetProperty(), {}) or {}
        keys = sorted(k for k in (props if isinstance(props, dict) else {}) if re.search(r"vol|gain|level|audio", k, re.I))
        say(f"Audio-ish item properties: {keys or '(none)'} ; all keys: {len(props) if isinstance(props, dict) else props}")
        for key in ["Volume", "AudioVolume", "Gain", "AudioGain", "ClipVolume", "AudioLevel"] + keys:
            before = safe(lambda: it.GetProperty(key))
            ok = safe(lambda: it.SetProperty(key, -6.0), False)
            after = safe(lambda: it.GetProperty(key))
            say(f"    SetProperty({key!r}, -6.0) → {ok}; before {before!r} after {after!r}")

    # 4. mute
    if items:
        t1 = time.time()
        muted = sum(1 for it in items if safe(lambda: it.SetClipEnabled(False), False))
        dt = time.time() - t1
        say(f"Muting: {muted}/{len(items)} in {dt:.2f}s ({dt / len(items) * 1000:.0f} ms/clip); "
            f"first now enabled={safe(lambda: items[0].GetClipEnabled())}")
    say(f"\nDone. Look at '{SCRATCH}' (pieces sit end to end with 12-frame gaps), then delete it.")


_T0 = time.time()
try:
    main()
except Exception as exc:  # noqa: BLE001
    import traceback
    say(f"\n✗ STOPPED: {exc}\n{traceback.format_exc()}")
finally:
    say(f"Total {time.time() - _T0:.1f}s")
    try:
        with open(REPORT, "w", encoding="utf-8") as fh:
            fh.write("\n".join(_out) + "\n")
        print(f"Report saved: {REPORT}")
    except Exception as exc:  # noqa: BLE001
        print(f"(Couldn't save report: {exc})")
