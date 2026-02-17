from pathlib import Path
from typing import Any, Dict, List, Optional

SUPPORTED_EXTENSIONS = {
    ".aac",
    ".aif",
    ".aiff",
    ".flac",
    ".m4a",
    ".mp3",
    ".mp4",
    ".mov",
    ".mkv",
    ".wav",
}


def _normalize_output_mode(value: Optional[str]) -> str:
    mode = (value or "txt").strip().lower()
    if mode not in {"txt", "json", "srt"}:
        raise ValueError("output_mode must be one of: txt, json, srt")
    return mode


def _default_output_path(source: Path, output_mode: str) -> Path:
    return source.with_suffix(f".{output_mode}")


def handle_transcribe(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Discover transcribable media files and return a structured work plan.

    Payload contract:
    - folder_path (required): folder that will be scanned recursively.
    - language (optional): BCP-47 language code or model-specific language hint.
    - model (optional): model identifier used by downstream transcription tooling.
    - output_mode (optional): one of txt, json, srt. Defaults to txt.
    - overwrite (optional): when false, existing output files are reported as failures.
    """

    folder_path = payload.get("folder_path")
    if not folder_path or not isinstance(folder_path, str):
        raise ValueError("folder_path is required")

    root = Path(folder_path).expanduser()
    if not root.exists() or not root.is_dir():
        raise ValueError(f"folder_path does not exist or is not a directory: {folder_path}")

    language = payload.get("language")
    model = payload.get("model")
    output_mode = _normalize_output_mode(payload.get("output_mode"))
    overwrite = bool(payload.get("overwrite", False))

    outputs: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []

    for source in sorted(root.rglob("*")):
        if not source.is_file() or source.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue

        output_path = _default_output_path(source, output_mode)

        if output_path.exists() and not overwrite:
            failures.append({
                "file": str(source),
                "output": str(output_path),
                "reason": "output exists and overwrite is false",
            })
            continue

        outputs.append({
            "file": str(source),
            "output": str(output_path),
            "status": "ready",
            "language": language,
            "model": model,
            "output_mode": output_mode,
        })

    return {
        "folder_path": str(root),
        "language": language,
        "model": model,
        "output_mode": output_mode,
        "overwrite": overwrite,
        "files_processed": len(outputs),
        "outputs": outputs,
        "failures": failures,
    }
