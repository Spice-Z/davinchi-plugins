from __future__ import annotations

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ExtractedAudio:
    wav_path: str
    duration_seconds: float


def extract_clip_slice_to_wav(
    file_path: str,
    source_start_frame: int,
    source_end_frame: int,
    fps: float,
) -> ExtractedAudio:
    if source_end_frame <= source_start_frame:
        raise ValueError("Invalid source frame bounds for extraction.")

    start_sec = source_start_frame / fps
    duration_sec = (source_end_frame - source_start_frame) / fps
    if duration_sec <= 0:
        raise ValueError("Clip duration is zero during extraction.")

    temp_dir = tempfile.mkdtemp(prefix="resolve_silence_cut_")
    wav_path = str(Path(temp_dir) / "clip.wav")

    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-ss",
        f"{start_sec:.6f}",
        "-i",
        file_path,
        "-t",
        f"{duration_sec:.6f}",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-vn",
        "-y",
        wav_path,
    ]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg extraction failed for '{file_path}': {proc.stderr.strip()}"
        )

    return ExtractedAudio(wav_path=wav_path, duration_seconds=duration_sec)

