#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cut-through Build for narration (audiobook): one audio timeline per plan, straight from Resolve's API.

No multicam, no FCPXML: each plan's kept pieces (plan["mics"][narrator], frames on the session
timeline's clock, from place_cuts.py) are mapped back to the source files (day_<LABEL>.json from
prepare_audio.py) and appended to a new empty timeline on A1, in order. Then:
  * a 2-frame "Cross Fade 0 dB" at every join (every join is an edit: the source jumps),
  * 8-frame fades at the head and tail,
  * the plan's review markers (retakes replaced, words cut off, Claude's "check" notes).
Each timeline is named "<chapter> (cut-through)" and made in SEQ_BIN. The session timeline is not
touched. Report: cut_through_<LABEL>.txt in OUT_DIR.

Run line (EditPanel's Resolve worker sets these):
    LABEL, OUT_DIR, DAY_FILE, PLAN_FILES=[[plan.json, name], ...], SEQ_BIN (optional)
"""
import json
import os
from typing import Any, Dict, List


def _common():
    import importlib.util
    here = (os.path.dirname(os.path.abspath(globals()["__file__"])) if globals().get("__file__")
            else r"C:\lp-app-ecosystem\editpanel\cut_through")
    spec = importlib.util.spec_from_file_location("cut_through_common", os.path.join(here, "common.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_c = _common()
_safe = _c._safe

LABEL = globals().get("LABEL", "Narration")
OUT_DIR = globals().get("OUT_DIR") or os.path.expanduser("~/Desktop")
DAY_FILE = globals().get("DAY_FILE") or os.path.join(OUT_DIR, f"day_{LABEL}.json")
PLAN_FILES = globals().get("PLAN_FILES") or []
SEQ_BIN = globals().get("SEQ_BIN")
CROSSFADE = {"type": "Cross Fade 0 dB", "category": "audio", "position": "end", "alignment": "center", "duration": 2}
FADE_FRAMES = 8
TAG = "cut-through"
_lines: List[str] = []


def say(msg: str = "") -> None:
    print(msg)
    _lines.append(msg)


def phase(text: str) -> None:
    print(f"▸ {text}", flush=True)


def norm(p: str) -> str:
    return os.path.normcase(os.path.normpath(str(p or "")))


def find_folder(root: Any, path: str):
    current = root
    segs = [x.strip() for x in str(path).split("/") if x.strip()]
    if segs and segs[0].lower() == str(_safe(lambda: root.GetName(), "")).lower():
        segs = segs[1:]
    for seg in segs:
        current = next((c for c in (_safe(lambda: current.GetSubFolderList(), []) or [])
                        if _safe(lambda: c.GetName()) == seg), None)
        if current is None:
            return None
    return current


def media_by_path(root: Any) -> Dict[str, Any]:
    out = {}
    for _, clip in _c.walk(root, skip=()):
        p = _safe(lambda: clip.GetClipProperty("File Path"))
        if p:
            out.setdefault(norm(p), clip)
    return out


def pieces_for(kept: List[List[int]], clips: List[dict], fsec: float) -> List[dict]:
    """Kept frame ranges on the session clock → per-file pieces: [a, b) split at clip edges, with
    the file's own frames (frame − the file's 0:00 on the session clock)."""
    out = []
    for a, b in kept:
        for c in clips:
            cf, ct = int(round(c["from_sec"] / fsec)), int(round(c["to_sec"] / fsec))
            x, y = max(a, cf), min(b, ct)
            if y <= x:
                continue
            zero = c["file_zero_sec"] / fsec
            out.append({"path": c["path"], "src_in": int(round(x - zero)), "src_out": int(round(y - zero)),
                        "rec_from": x, "rec_to": y, "kept_from": a})
    return out


def record_frame(f: int, pieces: List[dict]) -> int:
    """A session-clock frame → frames from the built timeline's start (a frame inside a removal
    lands on the join after it)."""
    t = 0
    for p in pieces:
        if f < p["rec_from"]:
            return t
        if f <= p["rec_to"]:
            return t + (f - p["rec_from"])
        t += p["rec_to"] - p["rec_from"]
    return max(0, t - 1)


def unique_name(project: Any, base: str) -> str:
    names = {_safe(lambda: project.GetTimelineByIndex(i).GetName())
             for i in range(1, int(project.GetTimelineCount() or 0) + 1)}
    name, k = base, 2
    while name in names:
        name, k = f"{base} {k}", k + 1
    return name


def append(mp: Any, tl: Any, pieces: List[dict], media: Dict[str, Any], inclusive: bool) -> List[Any]:
    infos = [{"mediaPoolItem": media[norm(p["path"])], "startFrame": p["src_in"],
              "endFrame": p["src_out"] - (1 if inclusive else 0), "mediaType": 2, "trackIndex": 1} for p in pieces]
    return _safe(lambda: mp.AppendToTimeline(infos), []) or []


def build_one(r: Any, project: Any, mp: Any, plan_path: str, name: str, day: dict, media: Dict[str, Any], seq: Any) -> str:
    plan = json.load(open(plan_path, encoding="utf-8"))
    fsec = day["frame_sec"][0] / day["frame_sec"][1]
    talker = (plan.get("audio") or {}).get("angle") or next(iter(plan.get("mics") or {}), None)
    kept = [list(map(int, k)) for k in (plan.get("mics") or {}).get(talker) or []]
    if not kept:
        raise RuntimeError(f"{name}: the plan keeps nothing")
    pieces = pieces_for(kept, day["mics"], fsec)
    missing = sorted({p["path"] for p in pieces if norm(p["path"]) not in media})
    if missing:
        raise RuntimeError(f"{name}: not in the media pool: {', '.join(os.path.basename(m) for m in missing)}")
    expected = sum(p["src_out"] - p["src_in"] for p in pieces)
    if seq:
        mp.SetCurrentFolder(seq)
    tl_name = unique_name(project, f"{name} (cut-through)")
    phase(f"Building {tl_name}")
    items, inclusive = [], False
    for inclusive in (False, True):
        tl = mp.CreateEmptyTimeline(tl_name)
        if not tl:
            raise RuntimeError(f"Couldn't make the timeline {tl_name!r}")
        project.SetCurrentTimeline(tl)
        items = append(mp, tl, pieces, media, inclusive)
        got = sum(int(_safe(lambda: it.GetDuration(), 0) or 0) for it in items)
        # Resolve's endFrame has been exclusive and inclusive across versions: one frame per
        # piece too many means inclusive — build again that way
        if inclusive or not items or got != expected + len(pieces):
            break
        _safe(lambda: mp.DeleteTimelines([tl]))
    got = sum(int(_safe(lambda: it.GetDuration(), 0) or 0) for it in items)
    out = [f"{tl_name}: {len(items)}/{len(pieces)} piece(s), {got / (1 / fsec) / 60:.1f} min"
           + ("" if got == expected else f" ✗ expected {expected} fr, got {got}")]
    items = sorted(items, key=lambda x: x.GetStart())
    xf = 0
    for a, b in zip(items, items[1:]):
        if int(a.GetEnd()) == int(b.GetStart()):
            xf += bool(_safe(lambda: a.AddTransition(CROSSFADE)))
    head = bool(items) and bool(_safe(lambda: items[0].AddTransition(
        {**CROSSFADE, "position": "start", "alignment": "right", "duration": FADE_FRAMES})))
    tail = bool(items) and bool(_safe(lambda: items[-1].AddTransition(
        {**CROSSFADE, "position": "end", "alignment": "left", "duration": FADE_FRAMES})))
    out.append(f"   {xf} crossfade(s) of {max(0, len(items) - 1)} join(s); fade in {'✓' if head else '✗'} out {'✓' if tail else '✗'}")
    rf = plan.get("review_file")
    marks = (json.load(open(rf, encoding="utf-8")).get("markers") or []) if rf and os.path.isfile(rf) else []
    placed, taken = 0, set()
    for m in marks:
        f = record_frame(int(m["frame"]), pieces)
        for nudge in range(4):
            if f + nudge in taken:
                continue
            if _safe(lambda: tl.AddMarker(f + nudge, m["color"], str(m["name"])[:60], str(m.get("note") or "")[:500], 1, TAG)):
                taken.add(f + nudge)
                placed += 1
                break
    if marks:
        out.append(f"   markers {placed}/{len(marks)}")
    return "\n".join(out)


def main() -> None:
    r = globals().get("resolve")
    if r is None:
        import DaVinciResolveScript as dvr  # type: ignore
        r = dvr.scriptapp("Resolve")
    project = r.GetProjectManager().GetCurrentProject()
    mp = project.GetMediaPool()
    say(f"Resolve {_safe(lambda: r.GetVersionString(), '?')} — project '{project.GetName()}' — narration build {LABEL}")
    day = json.load(open(DAY_FILE, encoding="utf-8"))
    if day.get("source") != "audio_timeline":
        raise RuntimeError("Not a narration run (the day file is from a multicam)")
    seq = find_folder(mp.GetRootFolder(), SEQ_BIN) if SEQ_BIN else None
    if SEQ_BIN and not seq:
        say(f"   no bin {SEQ_BIN!r}: the timelines go in the current bin")
    phase("Finding the session's files in the media pool")
    media = media_by_path(mp.GetRootFolder())
    built = failed = 0
    for plan_path, name in PLAN_FILES:
        try:
            say(build_one(r, project, mp, plan_path, str(name), day, media, seq))
            built += 1
        except Exception as exc:
            say(f"✗ {name}: {exc}")
            failed += 1
    say(f"Built {built} of {len(PLAN_FILES)} timeline(s)" + (f"; {failed} failed" if failed else ""))
    if not built:
        raise RuntimeError("Nothing was built")


try:
    main()
except Exception as exc:
    say(f"\n✗ STOPPED: {exc}")
finally:
    try:
        with open(os.path.join(OUT_DIR, f"cut_through_{LABEL}.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(_lines) + "\n")
    except Exception as exc:
        print(f"(Couldn't save report: {exc})")
    for _k in ("LABEL", "OUT_DIR", "DAY_FILE", "PLAN_FILES", "SEQ_BIN"):
        globals().pop(_k, None)
