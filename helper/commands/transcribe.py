import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

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

FFMPEG_REQUIRING_NORMALIZATION = {".mp3", ".mp4"}
INVALID_FILENAME_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def _normalize_output_mode(value: Optional[str]) -> str:
    mode = (value or "txt").strip().lower()
    if mode not in {"txt", "json", "srt"}:
        raise ValueError("output_mode must be one of: txt, json, srt")
    return mode


def _normalize_recursive_flag(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, bool):
        return value
    raise ValueError("recursive must be a boolean when provided")


def _sanitize_filename(value: str) -> str:
    sanitized = INVALID_FILENAME_CHARS.sub("_", value).strip("._")
    return sanitized or "output"


def _default_output_path(source: Path, output_mode: str) -> Path:
    safe_stem = _sanitize_filename(source.stem)
    normalized_parent = source.parent.resolve()
    return normalized_parent / f"{safe_stem}.{output_mode}"


def _discover_files(root: Path, recursive: bool) -> Iterable[Path]:
    entries = root.rglob("*") if recursive else root.glob("*")
    for candidate in sorted(entries):
        if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_EXTENSIONS:
            yield candidate.resolve()


def _run_ffmpeg_normalization(source: Path, temp_dir: Path) -> Tuple[bool, Optional[Path], str]:
    safe_stem = _sanitize_filename(source.stem)
    prepared_audio = temp_dir / f"{safe_stem}_16k_mono.wav"

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(prepared_audio),
    ]

    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return False, None, "ffmpeg executable not found in PATH"
    except Exception as exc:  # defensive: subprocess can raise OSError subclasses
        return False, None, f"ffmpeg invocation failed: {exc}"

    if completed.returncode != 0 or not prepared_audio.exists():
        details = [
            f"ffmpeg exited with code {completed.returncode}",
            f"stdout: {(completed.stdout or '').strip() or '<empty>'}",
            f"stderr: {(completed.stderr or '').strip() or '<empty>'}",
        ]
        return False, None, " | ".join(details)

    log_details = [
        "normalization complete",
        f"stdout: {(completed.stdout or '').strip() or '<empty>'}",
        f"stderr: {(completed.stderr or '').strip() or '<empty>'}",
    ]
    return True, prepared_audio, " | ".join(log_details)


def handle_transcribe(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Discover transcribable media files and return a structured work plan.

    Payload contract:
    - folder_path (required): folder that will be scanned.
    - recursive (optional): when true (default), scan subfolders recursively.
    - language (optional): BCP-47 language code or model-specific language hint.
    - model (optional): model identifier used by downstream transcription tooling.
    - output_mode (optional): one of txt, json, srt. Defaults to txt.
    - overwrite (optional): when false, existing output files are reported as failures.

    Notes:
    - .mp3 and .mp4 files are preprocessed with ffmpeg into mono 16k PCM WAV in a
      per-file temporary directory.
    - Intermediate audio is removed immediately after each file is prepared.
    """

    folder_path = payload.get("folder_path")
    if not folder_path or not isinstance(folder_path, str):
        raise ValueError("folder_path is required")

    root = Path(folder_path).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise ValueError(f"folder_path does not exist or is not a directory: {folder_path}")

    recursive = _normalize_recursive_flag(payload.get("recursive"))
    language = payload.get("language")
    model = payload.get("model")
    output_mode = _normalize_output_mode(payload.get("output_mode"))
    overwrite = bool(payload.get("overwrite", False))

    outputs: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []

    for source in _discover_files(root, recursive):
        output_path = _default_output_path(source, output_mode)

        if output_path.exists() and not overwrite:
            failures.append({
                "file": str(source),
                "output": str(output_path),
                "reason": "output exists and overwrite is false",
            })
            continue

        preprocess_info = {
            "required": source.suffix.lower() in FFMPEG_REQUIRING_NORMALIZATION,
            "status": "not_required",
            "details": "",
        }

        if preprocess_info["required"]:
            with tempfile.TemporaryDirectory(prefix="transcribe_audio_") as temp_dir_raw:
                temp_dir = Path(temp_dir_raw)
                ok, prepared_audio, details = _run_ffmpeg_normalization(source, temp_dir)

                if not ok:
                    failures.append({
                        "file": str(source),
                        "output": str(output_path),
                        "reason": f"audio normalization failed: {details}",
                    })
                    continue

                preprocess_info["status"] = "normalized"
                preprocess_info["details"] = details
                preprocess_info["temporary_audio"] = prepared_audio.name
                preprocess_info["cleanup"] = "temporary audio removed after preparation"

        outputs.append({
            "file": str(source),
            "output": str(output_path),
            "status": "ready",
            "language": language,
            "model": model,
            "output_mode": output_mode,
            "preprocess": preprocess_info,
        })

    return {
        "folder_path": str(root),
        "scan_mode": "recursive" if recursive else "top_level_only",
        "language": language,
        "model": model,
        "output_mode": output_mode,
        "overwrite": overwrite,
        "files_processed": len(outputs),
        "outputs": outputs,
        "failures": failures,
    }
