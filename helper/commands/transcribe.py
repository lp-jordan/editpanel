import os
import re
import shutil
import subprocess
import tempfile
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
DEFAULT_LOCAL_MODEL = "tiny"
DEFAULT_OPENAI_MODEL = "whisper-1"


class TranscriptionError(RuntimeError):
    """Raised when transcription cannot be completed."""


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


def _transcribe_with_local_engine(audio_path: Path, language: Optional[str], model: str) -> Dict[str, Any]:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise TranscriptionError(
            "Missing dependency 'faster-whisper'. Install it to use engine='local'."
        ) from exc

    try:
        whisper_model = WhisperModel(model, device="auto", compute_type="auto")
    except Exception as exc:
        raise TranscriptionError(
            f"Unable to initialize faster-whisper model '{model}': {exc}"
        ) from exc

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
            "language": getattr(info, "language", language),
            "duration": float(getattr(info, "duration", 0.0) or 0.0),
        },
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
            raise TranscriptionError(
                "Missing dependency 'faster-whisper'. Install it to use engine='local'."
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


def transcribe_audio_file(path: Path, language: Optional[str], model: str, engine: str) -> Dict[str, Any]:
    """Transcribe an audio file and return transcript text + segment timings."""
    if not path.exists() or not path.is_file():
        raise TranscriptionError(f"audio file does not exist: {path}")

    if engine == "local":
        return _transcribe_with_local_engine(path, language, model)
    if engine == "openai":
        return _transcribe_with_openai_engine(path, language, model)
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


def handle_transcribe(payload: Dict[str, Any]) -> Dict[str, Any]:
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

    from .. import resolve_helper as rh

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

    outputs: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    discovered_sources = list(_discover_files(root, recursive))

    try:
        _validate_engine_dependencies(engine)
    except TranscriptionError as exc:
        reason = str(exc)
        rh.log(f"Transcribe: aborted ({reason})")
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
            "files_processed": 0,
            "outputs": [],
            "failures": [{
                "file": None,
                "output": None,
                "text_output": None,
                "reason": reason,
            }],
        }

    rh.log(f"Transcribe: queued {len(discovered_sources)} file(s) from {root}")

    for source in discovered_sources:
        rh.log(f"Transcribe: queued {source}")
        output_paths = _resolve_output_paths(source, output_mode, output_dir, overwrite)
        output_path = output_paths["mode"]
        text_output_path = output_paths["txt"]

        preprocess_info = {
            "required": source.suffix.lower() in FFMPEG_REQUIRING_NORMALIZATION,
            "status": "not_required",
            "details": "",
        }

        if preprocess_info["required"]:
            rh.log(f"Transcribe: extracting audio {source}")
            with tempfile.TemporaryDirectory(prefix="transcribe_audio_") as temp_dir_raw:
                temp_dir = Path(temp_dir_raw)
                ok, prepared_audio, details = _run_ffmpeg_normalization(source, temp_dir)

                if not ok:
                    short_reason = details.split(" | ")[0]
                    rh.log(f"Transcribe: failed {source} ({short_reason})")
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
                    rh.log(f"Transcribe: transcribing {source}")
                    transcription = transcribe_audio_file(prepared_audio, language, model, engine)
                    _write_transcription_output(
                        output_path,
                        output_mode,
                        transcription["text"],
                        transcription["segments"],
                        transcription["metadata"],
                    )
                    rh.log(f"Transcribe: writing txt {text_output_path}")
                    text_file_content = _build_transcript_text_file_content(
                        transcription["text"],
                        source,
                        transcription["metadata"],
                        include_txt_header,
                    )
                    text_output_path.write_text(text_file_content, encoding="utf-8")
                except TranscriptionError as exc:
                    short_reason = str(exc).splitlines()[0][:160]
                    rh.log(f"Transcribe: failed {source} ({short_reason})")
                    failures.append({
                        "file": str(source),
                        "output": str(output_path),
                        "text_output": str(text_output_path),
                        "reason": str(exc),
                    })
                    continue

                rh.log(f"Transcribe: done {source}")
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
                })
                continue

        try:
            rh.log(f"Transcribe: transcribing {source}")
            transcription = transcribe_audio_file(source, language, model, engine)
            _write_transcription_output(
                output_path,
                output_mode,
                transcription["text"],
                transcription["segments"],
                transcription["metadata"],
            )
            rh.log(f"Transcribe: writing txt {text_output_path}")
            text_file_content = _build_transcript_text_file_content(
                transcription["text"],
                source,
                transcription["metadata"],
                include_txt_header,
            )
            text_output_path.write_text(text_file_content, encoding="utf-8")
        except TranscriptionError as exc:
            short_reason = str(exc).splitlines()[0][:160]
            rh.log(f"Transcribe: failed {source} ({short_reason})")
            failures.append({
                "file": str(source),
                "output": str(output_path),
                "text_output": str(text_output_path),
                "reason": str(exc),
            })
            continue

        rh.log(f"Transcribe: done {source}")
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
        })

    rh.log(
        f"Transcribe: complete total={len(discovered_sources)} succeeded={len(outputs)} failed={len(failures)}"
    )

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
        "files_processed": len(outputs),
        "outputs": outputs,
        "failures": failures,
    }
