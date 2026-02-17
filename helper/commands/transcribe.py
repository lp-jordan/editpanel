import os
import re
import shutil
import subprocess
import sys
import tempfile
import site
import importlib
import ctypes
from datetime import datetime
from datetime import timedelta
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
SUPPORTED_ENGINES = {"local", "openai"}
DEFAULT_ENGINE = "local"
DEFAULT_LOCAL_MODEL = "small"
DEFAULT_OPENAI_MODEL = "whisper-1"
REQUIRED_CUDA_VERSION = "13.1.1"
CUDA_REQUIRED_PACKAGES = (
    "nvidia-cublas-cu12",
    "nvidia-cuda-runtime-cu12",
)

_CUDA_INIT_STATE: Dict[str, Any] = {
    "attempted": False,
    "packages_checked": False,
    "report": None,
}

_CUDA_DLL_DIRECTORY_HANDLES: List[Any] = []


class TranscriptionError(RuntimeError):
    """Raised when transcription cannot be completed."""


def _attempt_python_dependency_install(package_name: str) -> bool:
    """Try to install a missing python package for the active interpreter."""
    command = [sys.executable, "-m", "pip", "install", package_name]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
        return True
    except Exception:
        return False




def _is_pip_package_installed(package_name: str) -> bool:
    command = [sys.executable, "-m", "pip", "show", package_name]
    try:
        completed = subprocess.run(command, check=False, capture_output=True, text=True)
    except Exception:
        return False
    return completed.returncode == 0


def _discover_site_package_roots() -> List[Path]:
    roots: List[Path] = []
    for entry in site.getsitepackages() + [site.getusersitepackages()]:
        if not entry:
            continue
        candidate = Path(entry)
        if candidate.exists() and candidate not in roots:
            roots.append(candidate)
    return roots


def configure_cuda_dll_directories(log_func: Optional[Any] = None) -> Dict[str, Any]:
    """Prepare CUDA DLL lookup paths and report helper runtime environment."""
    report: Dict[str, Any] = {
        "python_executable": sys.executable,
        "dll_candidates": [],
        "dll_directories_added": [],
        "missing_dll_directories": [],
        "cublas_dll_found": False,
        "cublas_preload": {"ok": False, "error": None},
        "path_updated": False,
    }

    if log_func:
        log_func(f"Transcribe: python executable {sys.executable}")

    dll_relative_paths = [
        Path("nvidia") / "cublas" / "bin",
        Path("nvidia") / "cuda_runtime" / "bin",
    ]

    for site_root in _discover_site_package_roots():
        for rel_path in dll_relative_paths:
            candidate = site_root / rel_path
            report["dll_candidates"].append(str(candidate))
            if candidate.exists():
                if hasattr(os, "add_dll_directory"):
                    # Keep a strong reference to the returned handle for the life
                    # of the process; otherwise Python may remove the search path
                    # once the handle is garbage collected.
                    dll_handle = os.add_dll_directory(str(candidate))
                    _CUDA_DLL_DIRECTORY_HANDLES.append(dll_handle)
                    report["dll_directories_added"].append(str(candidate))
                    if log_func:
                        log_func(f"Transcribe: registered CUDA DLL directory {candidate}")
            else:
                report["missing_dll_directories"].append(str(candidate))

    cublas_exists = False
    for added_dir in report["dll_directories_added"]:
        dll_dir = Path(added_dir)
        if any(dll_dir.glob("cublas64*.dll")):
            cublas_exists = True
            break
    report["cublas_dll_found"] = cublas_exists

    if report["dll_directories_added"]:
        path_entries = os.environ.get("PATH", "").split(os.pathsep)
        added_to_path = False
        for added_dir in report["dll_directories_added"]:
            if added_dir not in path_entries:
                path_entries.insert(0, added_dir)
                added_to_path = True
        if added_to_path:
            os.environ["PATH"] = os.pathsep.join(path_entries)
            report["path_updated"] = True

    if cublas_exists and sys.platform == "win32":
        try:
            ctypes.WinDLL("cublas64_12.dll")
            report["cublas_preload"] = {"ok": True, "error": None}
        except Exception as exc:
            report["cublas_preload"] = {"ok": False, "error": str(exc)}
            if log_func:
                log_func(f"Transcribe: failed to preload cublas64_12.dll ({exc})")

    if log_func:
        log_func(f"Transcribe: cublas DLL present={cublas_exists}")
    return report


def _ensure_cuda_runtime_packages(log_func: Optional[Any] = None) -> None:
    for package_name in CUDA_REQUIRED_PACKAGES:
        if _is_pip_package_installed(package_name):
            continue
        installed = _attempt_python_dependency_install(package_name)
        if log_func:
            status = "installed" if installed else "missing"
            log_func(f"Transcribe: CUDA package {package_name} status={status}")


def _get_cuda_diagnostics_snapshot() -> Dict[str, Any]:
    report = _CUDA_INIT_STATE.get("report") or {}
    initialized = bool(_CUDA_INIT_STATE["attempted"])
    return {
        "initialized": initialized,
        "cached": initialized and bool(report),
        "dll_paths": list(report.get("dll_directories_added") or []),
        "cublas_dll_found": bool(report.get("cublas_dll_found")),
        "cublas_preload": dict(report.get("cublas_preload") or {"ok": False, "error": None}),
        "path_updated": bool(report.get("path_updated")),
        "python_executable": report.get("python_executable", sys.executable),
    }


def ensure_cuda_environment(log_func: Optional[Any] = None) -> Dict[str, Any]:
    """Initialize CUDA runtime dependencies once per process and return diagnostics."""
    if not _CUDA_INIT_STATE["packages_checked"]:
        _ensure_cuda_runtime_packages(log_func)
        _CUDA_INIT_STATE["packages_checked"] = True

    if not _CUDA_INIT_STATE["attempted"]:
        _CUDA_INIT_STATE["report"] = configure_cuda_dll_directories(log_func)
        _CUDA_INIT_STATE["attempted"] = True

    return _get_cuda_diagnostics_snapshot()


def _format_srt_timestamp(seconds: float) -> str:
    safe_seconds = max(0.0, float(seconds))
    whole = timedelta(seconds=safe_seconds)
    total_ms = int(whole.total_seconds() * 1000)
    hours = total_ms // 3_600_000
    minutes = (total_ms % 3_600_000) // 60_000
    secs = (total_ms % 60_000) // 1_000
    millis = total_ms % 1_000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _segments_to_srt(segments: List[Dict[str, Any]]) -> str:
    if not segments:
        return ""

    chunks: List[str] = []
    for idx, segment in enumerate(segments, start=1):
        start = _format_srt_timestamp(segment.get("start", 0.0))
        end = _format_srt_timestamp(segment.get("end", segment.get("start", 0.0)))
        text = str(segment.get("text", "")).strip() or "..."
        chunks.append(f"{idx}\n{start} --> {end}\n{text}\n")
    return "\n".join(chunks).strip() + "\n"


def _write_transcription_output(
    output_path: Path,
    output_mode: str,
    transcript_text: str,
    segments: List[Dict[str, Any]],
    metadata: Dict[str, Any],
) -> None:
    if output_mode == "txt":
        output_path.write_text(transcript_text, encoding="utf-8")
        return

    if output_mode == "srt":
        srt_body = _segments_to_srt(segments)
        output_path.write_text(srt_body, encoding="utf-8")
        return

    payload = {
        "text": transcript_text,
        "segments": segments,
        "metadata": metadata,
    }
    import json

    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _build_transcript_text_file_content(
    transcript_text: str,
    source: Path,
    metadata: Dict[str, Any],
    include_header: bool,
) -> str:
    normalized_text = transcript_text.strip()
    if not include_header:
        return normalized_text

    generated_at = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    header_lines = [
        f"source: {source.name}",
        f"generated_at: {generated_at}",
        f"model: {metadata.get('model') or 'unknown'}",
    ]
    body = normalized_text
    return "\n".join(header_lines + ["", body]).rstrip() + "\n"


def _normalize_engine(value: Optional[str]) -> str:
    if value is None:
        return DEFAULT_ENGINE
    engine = str(value).strip().lower()
    if engine not in SUPPORTED_ENGINES:
        raise ValueError(f"engine must be one of: {', '.join(sorted(SUPPORTED_ENGINES))}")
    return engine


def _normalize_model(value: Optional[str], engine: str) -> str:
    if value is not None and str(value).strip():
        return str(value).strip()
    if engine == "openai":
        return DEFAULT_OPENAI_MODEL
    return DEFAULT_LOCAL_MODEL


def _load_whisper_model_class() -> Any:
    try:
        module = importlib.import_module("faster_whisper")
    except ImportError as exc:
        installed = _attempt_python_dependency_install("faster-whisper")
        if not installed:
            raise TranscriptionError(
                "Missing dependency 'faster-whisper' and automatic install failed. "
                "Please ensure pip can install it for the python interpreter used by the app."
            ) from exc
        try:
            module = importlib.import_module("faster_whisper")
        except ImportError as retry_exc:
            raise TranscriptionError(
                "Dependency installation reported success, but 'faster-whisper' is still unavailable."
            ) from retry_exc
    return module.WhisperModel


def _build_local_whisper_model(model: str, prefer_gpu: bool, log_func: Optional[Any] = None) -> Tuple[Any, str]:
    WhisperModel = _load_whisper_model_class()

    if prefer_gpu:
        try:
            whisper_model = WhisperModel(model, device="cuda")
            return whisper_model, "cuda"
        except Exception as exc:
            if log_func:
                log_func(f"Transcribe: CUDA init failed ({exc}); retrying on CPU")

    try:
        whisper_model = WhisperModel(model, device="cpu", compute_type="int8")
        return whisper_model, "cpu"
    except Exception as exc:
        raise TranscriptionError(
            f"Unable to initialize faster-whisper model '{model}': {exc}"
        ) from exc


def _transcribe_with_local_engine(
    audio_path: Path,
    language: Optional[str],
    model: str,
    prefer_gpu: bool,
    log_func: Optional[Any] = None,
) -> Dict[str, Any]:
    whisper_model, active_device = _build_local_whisper_model(model, prefer_gpu=prefer_gpu, log_func=log_func)

    transcribe_kwargs: Dict[str, Any] = {}
    if language:
        transcribe_kwargs["language"] = language

    try:
        segments_iter, info = whisper_model.transcribe(str(audio_path), **transcribe_kwargs)
    except Exception as exc:
        raise TranscriptionError(f"faster-whisper runtime error: {exc}") from exc

    segments: List[Dict[str, Any]] = []
    full_text_chunks: List[str] = []
    for segment in segments_iter:
        text = (segment.text or "").strip()
        if text:
            full_text_chunks.append(text)
        segments.append({
            "id": int(getattr(segment, "id", len(segments))),
            "start": float(getattr(segment, "start", 0.0) or 0.0),
            "end": float(getattr(segment, "end", 0.0) or 0.0),
            "text": text,
        })

    return {
        "text": " ".join(full_text_chunks).strip(),
        "segments": segments,
        "metadata": {
            "engine": "local",
            "model": model,
            "device": active_device,
            "language": getattr(info, "language", language),
            "duration": float(getattr(info, "duration", 0.0) or 0.0),
            "required_cuda_version": REQUIRED_CUDA_VERSION,
        },
    }


def handle_test_cuda(payload: Dict[str, Any], log_func: Optional[Any] = None) -> Dict[str, Any]:
    model = _normalize_model(payload.get("model"), "local")
    cuda_diag = ensure_cuda_environment(log_func=log_func)
    try:
        WhisperModel = _load_whisper_model_class()
        whisper_model = WhisperModel(model, device="cuda")
        if whisper_model is None:
            raise RuntimeError("model init returned no instance")
        return {
            "ok": True,
            "model": model,
            "cuda_init": cuda_diag,
            "dll_paths": cuda_diag.get("dll_paths", []),
            "device_selected": "cuda",
        }
    except Exception as exc:
        return {
            "ok": False,
            "reason": str(exc),
            "model": model,
            "cuda_init": cuda_diag,
            "dll_paths": cuda_diag.get("dll_paths", []),
            "device_selected": "cpu",
        }


def _transcribe_with_openai_engine(audio_path: Path, language: Optional[str], model: str) -> Dict[str, Any]:
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise TranscriptionError(
            "Missing dependency 'openai'. Install it to use engine='openai'."
        ) from exc

    try:
        client = OpenAI()
    except Exception as exc:
        raise TranscriptionError(
            f"Failed to initialize OpenAI client (check OPENAI_API_KEY and runtime): {exc}"
        ) from exc

    request: Dict[str, Any] = {
        "model": model,
        "response_format": "verbose_json",
    }
    if language:
        request["language"] = language

    try:
        with audio_path.open("rb") as audio_file:
            response = client.audio.transcriptions.create(file=audio_file, **request)
    except Exception as exc:
        raise TranscriptionError(f"OpenAI transcription request failed: {exc}") from exc

    response_dict = response.model_dump() if hasattr(response, "model_dump") else dict(response)
    raw_segments = response_dict.get("segments") or []
    segments: List[Dict[str, Any]] = []
    for idx, segment in enumerate(raw_segments):
        segments.append({
            "id": int(segment.get("id", idx)),
            "start": float(segment.get("start", 0.0) or 0.0),
            "end": float(segment.get("end", 0.0) or 0.0),
            "text": str(segment.get("text", "")).strip(),
        })

    text = str(response_dict.get("text", "")).strip()
    return {
        "text": text,
        "segments": segments,
        "metadata": {
            "engine": "openai",
            "model": model,
            "language": response_dict.get("language", language),
            "duration": float(response_dict.get("duration", 0.0) or 0.0),
        },
    }


def _validate_engine_dependencies(engine: str) -> None:
    """Fail fast when required transcription dependencies are unavailable."""
    if engine == "local":
        try:
            import faster_whisper  # noqa: F401
        except ImportError as exc:
            installed = _attempt_python_dependency_install("faster-whisper")
            if installed:
                try:
                    import faster_whisper  # noqa: F401
                except ImportError:
                    pass
                else:
                    return
            raise TranscriptionError(
                "Missing dependency 'faster-whisper' and automatic install failed. "
                "Please ensure pip can install it for the python interpreter used by the app."
            ) from exc
        return

    if engine == "openai":
        try:
            import openai  # noqa: F401
        except ImportError as exc:
            raise TranscriptionError(
                "Missing dependency 'openai'. Install it to use engine='openai'."
            ) from exc
        return


def transcribe_audio_file(path: Path, language: Optional[str], model: str, engine: str, use_gpu: bool = False, log_func: Optional[Any] = None) -> Dict[str, Any]:
    """Transcribe an audio file and return transcript text + segment timings."""
    if not path.exists() or not path.is_file():
        raise TranscriptionError(f"audio file does not exist: {path}")

    cuda_diag: Dict[str, Any] = {
        "initialized": False,
        "cached": False,
        "dll_paths": [],
        "cublas_dll_found": False,
        "python_executable": sys.executable,
    }

    if engine == "local":
        if use_gpu:
            cuda_diag = ensure_cuda_environment(log_func=log_func)
        result = _transcribe_with_local_engine(path, language, model, prefer_gpu=use_gpu, log_func=log_func)
        selected_device = result.get("metadata", {}).get("device", "cpu")
        result["diagnostics"] = {
            "cuda_init": cuda_diag,
            "dll_paths": cuda_diag.get("dll_paths", []),
            "device_selected": selected_device,
        }
        return result
    if engine == "openai":
        result = _transcribe_with_openai_engine(path, language, model)
        result["diagnostics"] = {
            "cuda_init": cuda_diag,
            "dll_paths": cuda_diag.get("dll_paths", []),
            "device_selected": "remote",
        }
        return result
    raise TranscriptionError(f"unsupported engine: {engine}")


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


def _resolve_output_root(source: Path, output_dir: Optional[str]) -> Path:
    if output_dir:
        root = Path(output_dir).expanduser().resolve()
        if not root.exists() or not root.is_dir():
            raise ValueError(f"output_dir does not exist or is not a directory: {output_dir}")
        return root
    return source.parent.resolve()


def _resolve_collision_path(candidate: Path, overwrite: bool) -> Path:
    if overwrite or not candidate.exists():
        return candidate

    index = 1
    while True:
        suffixed = candidate.with_name(f"{candidate.stem}_{index}{candidate.suffix}")
        if not suffixed.exists():
            return suffixed
        index += 1


def _resolve_output_paths(
    source: Path,
    output_mode: str,
    output_dir: Optional[str],
    overwrite: bool,
) -> Dict[str, Path]:
    safe_stem = _sanitize_filename(source.stem)
    root = _resolve_output_root(source, output_dir)

    txt_candidate = root / f"{safe_stem}.txt"
    txt_path = _resolve_collision_path(txt_candidate, overwrite)

    mode_path = txt_path if output_mode == "txt" else _resolve_collision_path(root / f"{safe_stem}.{output_mode}", overwrite)

    return {
        "txt": txt_path,
        "mode": mode_path,
    }


def _discover_files(root: Path, recursive: bool) -> Iterable[Path]:
    entries = root.rglob("*") if recursive else root.glob("*")
    for candidate in sorted(entries):
        if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_EXTENSIONS:
            yield candidate.resolve()


def _resolve_ffmpeg_executable() -> str:
    configured = (os.environ.get("FFMPEG_PATH") or "").strip()
    if configured:
        expanded = Path(configured).expanduser()
        if expanded.exists():
            return str(expanded)

    discovered = shutil.which("ffmpeg")
    if discovered:
        return discovered

    return "ffmpeg"


def _run_ffmpeg_normalization(source: Path, temp_dir: Path) -> Tuple[bool, Optional[Path], str]:
    safe_stem = _sanitize_filename(source.stem)
    prepared_audio = temp_dir / f"{safe_stem}_16k_mono.wav"

    ffmpeg_executable = _resolve_ffmpeg_executable()

    cmd = [
        ffmpeg_executable,
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


def handle_transcribe(payload: Dict[str, Any], log_func: Optional[Any] = None) -> Dict[str, Any]:
    """Discover transcribable media files and execute transcription.

    Payload contract:
    - folder_path (required): folder that will be scanned.
    - recursive (optional): when true (default), scan subfolders recursively.
    - language (optional): BCP-47 language code or model-specific language hint.
    - model (optional): model identifier used by downstream transcription tooling.
    - output_mode (optional): one of txt, json, srt. Defaults to txt.
    - output_dir (optional): when provided, write outputs to this directory.
    - include_txt_header (optional): prepend source/model/timestamp metadata to txt output.
    - overwrite (optional): when false, output filename collisions are resolved by suffixing (_1, _2, ...).

    Notes:
    - .mp3 and .mp4 files are preprocessed with ffmpeg into mono 16k PCM WAV in a
      per-file temporary directory.
    - Intermediate audio is removed immediately after each file is prepared.
    """

    if log_func is None:
        def log_func(_: str) -> None:
            return None

    folder_path = payload.get("folder_path")
    if not folder_path or not isinstance(folder_path, str):
        raise ValueError("folder_path is required")

    root = Path(folder_path).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise ValueError(f"folder_path does not exist or is not a directory: {folder_path}")

    recursive = _normalize_recursive_flag(payload.get("recursive"))
    language = payload.get("language")
    engine = _normalize_engine(payload.get("engine"))
    model = _normalize_model(payload.get("model"), engine)
    output_mode = _normalize_output_mode(payload.get("output_mode"))
    output_dir = payload.get("output_dir")
    include_txt_header = bool(payload.get("include_txt_header", False))
    overwrite = bool(payload.get("overwrite", False))
    use_gpu = bool(payload.get("use_gpu", False))

    outputs: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    discovered_sources = list(_discover_files(root, recursive))

    try:
        _validate_engine_dependencies(engine)
    except TranscriptionError as exc:
        reason = str(exc)
        log_func(f"Transcribe: aborted ({reason})")
        return {
            "folder_path": str(root),
            "scan_mode": "recursive" if recursive else "top_level_only",
            "language": language,
            "model": model,
            "engine": engine,
            "output_mode": output_mode,
            "output_dir": str(Path(output_dir).expanduser().resolve()) if output_dir else None,
            "include_txt_header": include_txt_header,
            "collision_strategy": "overwrite" if overwrite else "suffix",
            "overwrite": overwrite,
            "use_gpu": use_gpu,
            "cuda_init": _get_cuda_diagnostics_snapshot(),
            "dll_paths": _get_cuda_diagnostics_snapshot().get("dll_paths", []),
            "device_selected": None,
            "files_processed": 0,
            "outputs": [],
            "failures": [{
                "file": None,
                "output": None,
                "text_output": None,
                "reason": reason,
            }],
        }

    log_func(f"Transcribe: queued {len(discovered_sources)} file(s) from {root}")

    total_sources = len(discovered_sources)

    for index, source in enumerate(discovered_sources, start=1):
        log_func(f"Transcribe: queued {source}")
        log_func(f"Transcribe: [{index}/{total_sources}] processing {source}")
        output_paths = _resolve_output_paths(source, output_mode, output_dir, overwrite)
        output_path = output_paths["mode"]
        text_output_path = output_paths["txt"]

        preprocess_info = {
            "required": source.suffix.lower() in FFMPEG_REQUIRING_NORMALIZATION,
            "status": "not_required",
            "details": "",
        }

        if preprocess_info["required"]:
            log_func(f"Transcribe: extracting audio {source}")
            with tempfile.TemporaryDirectory(prefix="transcribe_audio_") as temp_dir_raw:
                temp_dir = Path(temp_dir_raw)
                ok, prepared_audio, details = _run_ffmpeg_normalization(source, temp_dir)

                if not ok:
                    short_reason = details.split(" | ")[0]
                    log_func(f"Transcribe: failed {source} ({short_reason})")
                    failures.append({
                        "file": str(source),
                        "output": str(output_path),
                        "reason": f"audio normalization failed: {details}",
                    })
                    continue

                preprocess_info["status"] = "normalized"
                preprocess_info["details"] = details
                preprocess_info["temporary_audio"] = prepared_audio.name
                preprocess_info["cleanup"] = "temporary audio removed after transcription"

                try:
                    log_func(f"Transcribe: transcribing {source}")
                    transcription = transcribe_audio_file(prepared_audio, language, model, engine, use_gpu=use_gpu, log_func=log_func)
                    _write_transcription_output(
                        output_path,
                        output_mode,
                        transcription["text"],
                        transcription["segments"],
                        transcription["metadata"],
                    )
                    log_func(f"Transcribe: writing txt {text_output_path}")
                    text_file_content = _build_transcript_text_file_content(
                        transcription["text"],
                        source,
                        transcription["metadata"],
                        include_txt_header,
                    )
                    text_output_path.write_text(text_file_content, encoding="utf-8")
                except TranscriptionError as exc:
                    short_reason = str(exc).splitlines()[0][:160]
                    log_func(f"Transcribe: failed {source} ({short_reason})")
                    failures.append({
                        "file": str(source),
                        "output": str(output_path),
                        "text_output": str(text_output_path),
                        "reason": str(exc),
                    })
                    continue

                log_func(f"Transcribe: done {source}")
                outputs.append({
                    "file": str(source),
                    "output": str(output_path),
                    "text_output": str(text_output_path),
                    "output_paths": [str(text_output_path)] if output_mode == "txt" else [str(text_output_path), str(output_path)],
                    "status": "transcribed",
                    "text": transcription["text"],
                    "segments": transcription["segments"],
                    "language": transcription["metadata"].get("language", language),
                    "model": transcription["metadata"].get("model", model),
                    "engine": engine,
                    "output_mode": output_mode,
                    "preprocess": preprocess_info,
                    "diagnostics": transcription.get("diagnostics", {}),
                })
                continue

        try:
            log_func(f"Transcribe: transcribing {source}")
            transcription = transcribe_audio_file(source, language, model, engine, use_gpu=use_gpu, log_func=log_func)
            _write_transcription_output(
                output_path,
                output_mode,
                transcription["text"],
                transcription["segments"],
                transcription["metadata"],
            )
            log_func(f"Transcribe: writing txt {text_output_path}")
            text_file_content = _build_transcript_text_file_content(
                transcription["text"],
                source,
                transcription["metadata"],
                include_txt_header,
            )
            text_output_path.write_text(text_file_content, encoding="utf-8")
        except TranscriptionError as exc:
            short_reason = str(exc).splitlines()[0][:160]
            log_func(f"Transcribe: failed {source} ({short_reason})")
            failures.append({
                "file": str(source),
                "output": str(output_path),
                "text_output": str(text_output_path),
                "reason": str(exc),
            })
            continue

        log_func(f"Transcribe: done {source}")
        outputs.append({
            "file": str(source),
            "output": str(output_path),
            "text_output": str(text_output_path),
            "output_paths": [str(text_output_path)] if output_mode == "txt" else [str(text_output_path), str(output_path)],
            "status": "transcribed",
            "text": transcription["text"],
            "segments": transcription["segments"],
            "language": transcription["metadata"].get("language", language),
            "model": transcription["metadata"].get("model", model),
            "engine": engine,
            "output_mode": output_mode,
            "preprocess": preprocess_info,
            "diagnostics": transcription.get("diagnostics", {}),
        })

    log_func(
        f"Transcribe: complete total={len(discovered_sources)} succeeded={len(outputs)} failed={len(failures)}"
    )

    return {
        "folder_path": str(root),
        "scan_mode": "recursive" if recursive else "top_level_only",
        "language": language,
        "model": model,
        "engine": engine,
        "use_gpu": use_gpu,
        "output_mode": output_mode,
        "output_dir": str(Path(output_dir).expanduser().resolve()) if output_dir else None,
        "include_txt_header": include_txt_header,
        "collision_strategy": "overwrite" if overwrite else "suffix",
        "overwrite": overwrite,
        "cuda_init": outputs[-1].get("diagnostics", {}).get("cuda_init") if outputs else _get_cuda_diagnostics_snapshot(),
        "dll_paths": outputs[-1].get("diagnostics", {}).get("dll_paths", []) if outputs else _get_cuda_diagnostics_snapshot().get("dll_paths", []),
        "device_selected": outputs[-1].get("diagnostics", {}).get("device_selected") if outputs else None,
        "files_processed": len(outputs),
        "outputs": outputs,
        "failures": failures,
    }
