#!/usr/bin/env python3
"""
SPIKE: why does the cut-through unlink fail, and what call does work?

split_into_videos.py `unlink()` calls Timeline.SetClipsLinked(<every clip>, False) on each
finished timeline. It has failed on every video since 1.2.150 (ELEVATE_MC_2 22/22, ELEVATE_MC_4
26/26); the clips still linked always equal the A1 (camera audio) count. The API exists in
21.x (DaVinciResolveScript.pyi: Timeline.SetClipsLinked, TimelineItem.GetLinkedItems).
This answers, on a real cut-through timeline:
  0. Which clips are linked, and to what (V1 multicam ↔ A1 multicam? anything else?)
  1. Does ONE linked pair unlink (both items in the list)? Does passing only the picture work?
  2. Do all LINKED clips (picture + partners, no mic clips) unlink in one call?
  3. Does the current call (every clip, mics included) fail here too?
  4. Picture clips only (V1) in one call?
  5. One call per pair, timed (the fallback if no batch works)

Every test runs on its own scratch copy of TIMELINE ("CT SPIKE unlink 1".."5"); the timeline
itself is never changed. The copies are deleted at the end (set KEEP = True before the exec
line to keep them for a look). If no copy can be made, set ON_SOURCE = True first: the clips
are then unlinked on TIMELINE itself, smallest step first (unlinked is how it should end up anyway).

Run in Resolve (project "Elevate Pools" open): Workspace → Console → Py3, then
    exec(open(r"C:\\lp-app-ecosystem\\editpanel\\spikes\\spike_unlink.py", encoding="utf-8").read())
Another timeline: set TIMELINE = "D6_Convo" in the console first (default: B1_Convo, else the
current timeline). Report: printed, and saved to the NAS spike-report folder
(N:\\Client AV Assets\\[1] ACTIVE\\Elevate Pools\\Cut-Through\\spike reports\\spike_unlink_<date>_<time>.txt;
the Desktop if N: isn't there).
"""
import os
import time
from collections import Counter

TIMELINE = globals().get("TIMELINE") or "B1_Convo"
KEEP = bool(globals().get("KEEP"))
ON_SOURCE = bool(globals().get("ON_SOURCE"))   # if no scratch copy can be made, unlink on TIMELINE itself
# Reports go to the NAS so they can be read from the Mac without copying (Jordan, 2026-11-20).
# Dated names: each run is kept.
REPORT_DIR = r"N:\Client AV Assets\[1] ACTIVE\Elevate Pools\Cut-Through\spike reports"
_name = f"spike_unlink_{time.strftime('%Y-%m-%d_%H%M%S')}.txt"
try:
    os.makedirs(REPORT_DIR, exist_ok=True)
    REPORT = os.path.join(REPORT_DIR, _name)
except OSError:
    REPORT = os.path.join(os.path.expanduser("~"), "Desktop", _name)
_out = []


def say(m=""):
    print(m)
    _out.append(str(m))


def safe(fn, default=None):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        say(f"    (error: {e})")
        return default


def where(it):
    tr = safe(lambda: it.GetTrackTypeAndIndex(), None) or ["?", "?"]
    return f"{str(tr[0])[:1].upper()}{tr[1]}"


def items(tl):
    out = []
    for kind in ("video", "audio"):
        for k in range(1, int(tl.GetTrackCount(kind) or 0) + 1):
            out += list(tl.GetItemListInTrack(kind, k) or [])
    return out


def links(it):
    return safe(lambda: it.GetLinkedItems(), None)


def linked_count(tl):
    return sum(1 for it in items(tl) if links(it))


def describe(tl):
    its = items(tl)
    per = Counter(where(it) for it in its)
    lk = [(it, links(it)) for it in its]
    none = sum(1 for _, x in lk if x is None)
    pairs = Counter((where(it), tuple(sorted(where(o) for o in x))) for it, x in lk if x)
    say(f"  {len(its)} clips {dict(per)}; linked: {sum(1 for _, x in lk if x)}"
        + (f"; GetLinkedItems returned None for {none}" if none else ""))
    for (a, b), n in sorted(pairs.items()):
        say(f"    {a} → {list(b)}: {n}")
    return lk


r = globals().get("resolve")
if r is None:
    import DaVinciResolveScript as dvr  # type: ignore
    r = dvr.scriptapp("Resolve")
project = r.GetProjectManager().GetCurrentProject()
mp = project.GetMediaPool()
say(f"Resolve {safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — spike_unlink")

src = None
for i in range(1, int(project.GetTimelineCount()) + 1):
    t = project.GetTimelineByIndex(i)
    if t.GetName() == TIMELINE:
        src = t
        break
if src is None:
    src = project.GetCurrentTimeline()
    say(f"(no timeline named {TIMELINE!r}; using the current one)")
say(f"Timeline: {src.GetName()}")
project.SetCurrentTimeline(src)
say("\n0. What's linked on the timeline (read only)")
describe(src)

copies = []


def _bin_of(name):
    """(path, folder) of the media pool bin holding the timeline clip called `name`."""
    def walk(f, path):
        here = f"{path} / {f.GetName()}" if path else f.GetName()
        yield here, f
        for sub in f.GetSubFolderList() or []:
            yield from walk(sub, here)
    for here, f in walk(mp.GetRootFolder(), ""):
        for c in f.GetClipList() or []:
            if c.GetName() == name and "timeline" in str(safe(lambda: c.GetClipProperty("Type"), "")).lower():
                return here, f
    return None, None


_how = []                                              # the way of copying that worked, reused after


def _try_dup(name):
    """Try DuplicateTimeline with different current bins; logs every try (run 2026-11-20: the
    plain call returned nothing on B1_Convo)."""
    home, home_f = _bin_of(src.GetName())
    cur = safe(lambda: mp.GetCurrentFolder().GetName(), "?")
    ways = [("as is (current bin '" + str(cur) + "')", None),
            (f"current bin = the timeline's own bin '{home}'", home_f),
            ("current bin = root", mp.GetRootFolder())]
    if _how:
        ways = [w for w in ways if w[0] == _how[0]] + [w for w in ways if w[0] != _how[0]]
    for label, folder in ways:
        if folder is not None and not safe(lambda: mp.SetCurrentFolder(folder), False):
            say(f"    copy: couldn't select bin for '{label}'")
            continue
        project.SetCurrentTimeline(src)
        d = safe(lambda: src.DuplicateTimeline(name), None)
        if d:
            if not _how:
                say(f"    copy: DuplicateTimeline worked with {label}")
                _how.append(label)
            return d
        say(f"    copy: DuplicateTimeline returned nothing with {label}")
    return None


def copy(n):
    name = f"CT SPIKE unlink {n}"
    old = [project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount()) + 1)]
    old = [t for t in old if t.GetName() == name]
    if old:
        say(f"    copy: deleting a leftover '{name}': {safe(lambda: mp.DeleteTimelines(old), False)}")
    if not copies and not _how:
        names = [project.GetTimelineByIndex(i).GetName() for i in range(1, int(project.GetTimelineCount()) + 1)]
        say(f"    copy: {len(names)} timelines in the project; current timeline "
            f"'{safe(lambda: project.GetCurrentTimeline().GetName(), '?')}'")
    d = _try_dup(name)
    if not d:
        raise RuntimeError(f"DuplicateTimeline({name!r}) failed every way: can't make a scratch copy"
                           + ("" if ON_SOURCE else " (set ON_SOURCE = True to test on the timeline itself)"))
    copies.append(d)
    project.SetCurrentTimeline(d)
    return d


def on_source():
    """No copies possible: unlink on the timeline itself, smallest step first. Unlinked is what
    the finished timeline should be anyway (the build's own last step)."""
    say("\nON_SOURCE: testing on the timeline itself")
    project.SetCurrentTimeline(src)
    lk = [(it, links(it)) for it in items(src) if links(it)]
    if not lk:
        say("  nothing linked")
        return
    v, partners = lk[0]
    say(f"  clip: {where(v)} '{v.GetName()}' ↔ {len(partners)} partner(s) on {sorted({where(o) for o in partners})}")
    rest = [it for it, _ in lk[1:2]]
    if rest:
        attempt(src, "one clip alone", rest)
    attempt(src, "clip + its partners", [v] + list(partners))
    left = [it for it in items(src) if links(it)]
    if left:
        attempt(src, "A1 only", list(src.GetItemListInTrack("audio", 1) or []))
    left = [it for it in items(src) if links(it)]
    if left:
        attempt(src, "every clip", items(src))
    say(f"  {src.GetName()}: {linked_count(src)} linked at the end")


def attempt(tl, label, its):
    before = linked_count(tl)
    t0 = time.time()
    ok = safe(lambda: tl.SetClipsLinked(its, False), "error")
    secs = time.time() - t0
    after = linked_count(tl)
    say(f"  {label}: {len(its)} item(s) → returned {ok} in {secs:.2f}s; linked clips {before} → {after}")
    return ok, after


try:
    say("\n1. One linked clip with its partners (any track: on B1_Convo only A1 clips are linked, to each other)")
    d = copy(1)
    lk = [(it, links(it)) for it in items(d) if links(it)]
    if not lk:
        say("  no linked clip: nothing to test")
    else:
        v, partners = lk[0]
        say(f"  clip: {where(v)} '{v.GetName()}' ↔ {len(partners)} partner(s) on {sorted({where(o) for o in partners})}")
        attempt(d, "clip + its partners", [v] + list(partners))
        say(f"    that clip now linked to: {[where(o) for o in (links(v) or [])]}")
        rest = [(it, x) for it, x in ((it, links(it)) for it in items(d)) if x]
        if rest:
            v2, _ = rest[0]
            attempt(d, "one clip alone (a still-linked one)", [v2])
            say(f"    that clip now linked to: {[where(o) for o in (links(v2) or [])]}")

    say("\n1b. A1 clips only in one call")
    d = copy("1b")
    attempt(d, "A1 only", list(d.GetItemListInTrack("audio", 1) or []))

    say("\n2. All linked clips in one call (no mic clips)")
    d = copy(2)
    attempt(d, "linked only", [it for it in items(d) if links(it)])

    say("\n3. Every clip in one call (what the build does now)")
    d = copy(3)
    attempt(d, "every clip", items(d))

    say("\n4. Picture clips (V1) only in one call")
    d = copy(4)
    attempt(d, "V1 only", list(d.GetItemListInTrack("video", 1) or []))

    say("\n5. One call per linked picture clip (with its partners)")
    d = copy(5)
    t0 = time.time()
    oks = Counter()
    for it in list(d.GetItemListInTrack("video", 1) or []):
        p = links(it)
        if p:
            oks[safe(lambda: d.SetClipsLinked([it] + list(p), False), "error")] += 1
    say(f"  per pair: results {dict(oks)} in {time.time() - t0:.1f}s; linked clips left {linked_count(d)}")

    say("\nResult on the copies (what's still linked):")
    for d in copies:
        say(f"  {d.GetName()}: {linked_count(d)} linked")
except Exception:  # noqa: BLE001 — the report must say why it stopped (the console traceback isn't saved)
    import traceback
    say("\nSTOPPED with an error:")
    for line in traceback.format_exc().rstrip().splitlines():
        say(f"  {line}")
    if ON_SOURCE and not copies:
        try:
            on_source()
        except Exception:  # noqa: BLE001
            for line in traceback.format_exc().rstrip().splitlines():
                say(f"  {line}")
finally:
    project.SetCurrentTimeline(src)
    if copies and not KEEP:
        ok = safe(lambda: mp.DeleteTimelines(copies), False)
        say(f"\nScratch copies deleted: {ok}")
    elif copies:
        say(f"\nScratch copies kept: {[d.GetName() for d in copies]}")
    try:
        with open(REPORT, "w", encoding="utf-8") as fh:
            fh.write("\n".join(_out) + "\n")
        say(f"Report saved to {REPORT}")
    except Exception as e:  # noqa: BLE001
        print(f"(couldn't save report: {e})")
    for _k in ("TIMELINE", "KEEP", "ON_SOURCE"):
        globals().pop(_k, None)
