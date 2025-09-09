from typing import Any, Dict


def handle_create_project_bins(_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Automatically create a standard project bin structure."""
    from .. import resolve_helper as rh

    if not rh.project:
        raise RuntimeError("No active project")

    media_pool = rh.project.GetMediaPool()
    root_folder = media_pool.GetRootFolder()

    bins_structure = {
        "FOOTAGE": ["BROLL", "ATEM", "4K"],
        "AUDIO": [],
        "SEQUENCES": ["MC"],
        "WORK": [],
        "MUSIC": [],
        "SFX": [],
        "GFX": [],
        "EXPORT": [],
    }

    rh.log("Starting project bin generation")

    for main_bin, sub_bins in bins_structure.items():
        main_folder = media_pool.AddSubFolder(root_folder, main_bin)
        if main_folder:
            rh.log(f"✅ Created bin: {main_bin}")
            for sub_bin in sub_bins:
                sub_folder = media_pool.AddSubFolder(main_folder, sub_bin)
                if sub_folder:
                    rh.log(f"    ✅ Created sub-bin: {sub_bin}")
                else:
                    rh.log(f"    ❌ Failed to create sub-bin: {sub_bin}")
        else:
            rh.log(f"❌ Failed to create bin: {main_bin}")

    rh.log("✔️ Project bin structure creation complete.")
    return {"result": True}
