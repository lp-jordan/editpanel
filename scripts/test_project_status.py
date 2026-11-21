"""Fake-Resolve test for helper/project_status.py (python3 scripts/test_project_status.py)."""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from helper import project_status as ps  # noqa: E402

ps._CHUNK_PAUSE_S = 0


class Item:
    def __init__(self, name, typ, flags=None):
        self.name, self.typ, self.flags = name, typ, flags or []
        self.type_asked = 0

    def GetName(self): return self.name
    def GetClipProperty(self, k):
        self.type_asked += 1
        return self.typ
    def GetFlagList(self): return list(self.flags)


class Folder:
    def __init__(self, name, clips=(), subs=()):
        self.name, self.clips, self.subs = name, list(clips), list(subs)

    def GetName(self): return self.name
    def GetClipList(self): return self.clips
    def GetSubFolderList(self): return self.subs


class Timeline:
    def __init__(self, name, uid, item): self.name, self.uid, self.item = name, uid, item
    def GetName(self): return self.name
    def GetUniqueId(self): return self.uid
    def GetMediaPoolItem(self): return self.item


tl_items = {n: Item(n, "Timeline", f) for n, f in [("A1", ["Green"]), ("A2", ["Yellow"]), ("A3_raw", [])]}
mc_real = Item("MC_1", "Multicam", [])
mc_test = Item("MC_1 TEST", "Multicam", ["Yellow"])
mc_orig = Item("MC_1_original", "Multicam", [])
root = Folder("Master", [Item("clip.mov", "Video + Audio")], [
    Folder("SEQUENCES", list(tl_items.values()), [Folder("MC", [mc_real, mc_test])]),
    Folder("MC ORIGINAL", [mc_orig]),
])


class MediaPool:
    def GetRootFolder(self): return root


class Project:
    def __init__(self): self.tls = [Timeline(n, f"uid-{n}", it) for n, it in tl_items.items()]
    def GetName(self): return "Fake"
    def GetTimelineCount(self): return len(self.tls)
    def GetTimelineByIndex(self, i): return self.tls[i - 1]
    def GetMediaPool(self): return MediaPool()


p = Project()
ps._building.set()
assert not ps.refresh_in_background(p)       # one at a time
ps._building.clear()
assert ps.refresh_in_background(p, multicams=True)
for _ in range(100):
    if not ps.snapshot()["building"]:
        break
    time.sleep(0.01)
snap = ps.snapshot()
assert snap["project"] == "Fake" and snap["error"] is None, snap
assert [(t["name"], t["uid"], t["flags"]) for t in snap["timelines"]] == [
    ("A1", "uid-A1", ["Green"]), ("A2", "uid-A2", ["Yellow"]), ("A3_raw", "uid-A3_raw", [])], snap["timelines"]
assert sorted(m["name"] for m in snap["multicams"]) == ["MC_1", "MC_1 TEST"], snap["multicams"]
assert [m for m in snap["multicams"] if m["name"] == "MC_1 TEST"][0]["flags"] == ["Yellow"]
assert mc_orig.type_asked == 0, "archive bins are skipped"
assert all(it.type_asked == 0 for it in tl_items.values()), "timeline items aren't asked their Type"

# A timelines-only read keeps the multicams from before
mc_real.type_asked = 0
assert ps.refresh_in_background(p, multicams=False)
while ps.snapshot()["building"]:
    time.sleep(0.01)
assert mc_real.type_asked == 0 and len(ps.snapshot()["multicams"]) == 2
print("project_status: all good")
