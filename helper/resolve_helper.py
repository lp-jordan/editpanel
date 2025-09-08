from pathlib import Path
import json
import sys


def resolve_path(*segments):
    """Resolve a filesystem path from the given segments."""
    return str(Path(__file__).resolve().parent.joinpath(*segments))


def main():
    """Read JSON requests from stdin and write responses to stdout."""
    for line in sys.stdin:
        try:
            payload = json.loads(line)
            segments = payload.get("segments", [])
            result = resolve_path(*segments)
            response = {"result": result}
        except Exception as exc:  # pragma: no cover - best effort error reporting
            response = {"error": str(exc)}
        json.dump(response, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
