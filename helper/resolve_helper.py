from pathlib import Path

def resolve_path(*segments):
    """Resolve a filesystem path from the given segments."""
    return str(Path(__file__).resolve().parent.joinpath(*segments))
