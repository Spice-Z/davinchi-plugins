from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

from .config import SilenceSettings
from .models import TimeRangeSeconds


def read_wav_pcm(path: str) -> tuple[int, int, bytes]:
    wav_path = Path(path)
    with wave.open(str(wav_path), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        sample_width = wav_file.getsampwidth()
        channels = wav_file.getnchannels()
        frames = wav_file.getnframes()
        raw = wav_file.readframes(frames)

    if channels > 1:
        raw = to_mono(raw, sample_width, channels)

    return sample_rate, sample_width, raw


def rms_to_db(rms_value: float) -> float:
    if rms_value <= 0:
        return -120.0
    max_16_bit = 32768.0
    normalized = min(1.0, rms_value / max_16_bit)
    return 20.0 * math.log10(max(normalized, 1e-9))


def detect_silence_ranges(
    sample_rate: int,
    sample_width: int,
    raw_pcm: bytes,
    settings: SilenceSettings,
) -> list[TimeRangeSeconds]:
    frame_samples = max(1, int(sample_rate * settings.analysis_frame_ms / 1000.0))
    frame_bytes = frame_samples * sample_width
    min_silence_seconds = settings.min_silence_duration_ms / 1000.0

    frame_loudness_db: list[float] = []
    for idx in range(0, len(raw_pcm), frame_bytes):
        chunk = raw_pcm[idx : idx + frame_bytes]
        if not chunk:
            continue
        rms_val = rms_chunk(chunk, sample_width)
        frame_loudness_db.append(rms_to_db(float(rms_val)))

    silent_ranges: list[TimeRangeSeconds] = []
    current_start: int | None = None
    for frame_index, loudness_db in enumerate(frame_loudness_db):
        is_silent = loudness_db <= settings.silence_threshold_db
        if is_silent and current_start is None:
            current_start = frame_index
        if not is_silent and current_start is not None:
            start_sec = current_start * settings.analysis_frame_ms / 1000.0
            end_sec = frame_index * settings.analysis_frame_ms / 1000.0
            if (end_sec - start_sec) >= min_silence_seconds:
                silent_ranges.append(TimeRangeSeconds(start=start_sec, end=end_sec))
            current_start = None

    if current_start is not None:
        start_sec = current_start * settings.analysis_frame_ms / 1000.0
        end_sec = len(frame_loudness_db) * settings.analysis_frame_ms / 1000.0
        if (end_sec - start_sec) >= min_silence_seconds:
            silent_ranges.append(TimeRangeSeconds(start=start_sec, end=end_sec))

    return merge_ranges(silent_ranges)


def merge_ranges(ranges: list[TimeRangeSeconds]) -> list[TimeRangeSeconds]:
    if not ranges:
        return []
    sorted_ranges = sorted(ranges, key=lambda r: r.start)
    merged: list[TimeRangeSeconds] = [sorted_ranges[0]]
    for rng in sorted_ranges[1:]:
        prev = merged[-1]
        if rng.start <= prev.end:
            merged[-1] = TimeRangeSeconds(start=prev.start, end=max(prev.end, rng.end))
        else:
            merged.append(rng)
    return merged


def expand_with_padding(
    ranges: list[TimeRangeSeconds],
    clip_duration_seconds: float,
    padding_before_ms: int,
    padding_after_ms: int,
) -> list[TimeRangeSeconds]:
    before = max(0.0, padding_before_ms / 1000.0)
    after = max(0.0, padding_after_ms / 1000.0)
    expanded = [
        TimeRangeSeconds(
            start=max(0.0, rng.start - before),
            end=min(clip_duration_seconds, rng.end + after),
        )
        for rng in ranges
    ]
    return merge_ranges(expanded)


def invert_ranges(
    remove_ranges: list[TimeRangeSeconds],
    total_duration_seconds: float,
) -> list[TimeRangeSeconds]:
    if total_duration_seconds <= 0:
        return []
    if not remove_ranges:
        return [TimeRangeSeconds(0.0, total_duration_seconds)]

    keeps: list[TimeRangeSeconds] = []
    cursor = 0.0
    for rng in remove_ranges:
        if rng.start > cursor:
            keeps.append(TimeRangeSeconds(cursor, min(rng.start, total_duration_seconds)))
        cursor = max(cursor, rng.end)

    if cursor < total_duration_seconds:
        keeps.append(TimeRangeSeconds(cursor, total_duration_seconds))

    return [k for k in keeps if k.duration > 0.0]


def to_mono(raw_pcm: bytes, sample_width: int, channels: int) -> bytes:
    if channels <= 1:
        return raw_pcm
    samples = decode_samples(raw_pcm, sample_width)
    mono_samples: list[int] = []
    for idx in range(0, len(samples), channels):
        channel_slice = samples[idx : idx + channels]
        if not channel_slice:
            continue
        mono_samples.append(int(sum(channel_slice) / len(channel_slice)))
    return encode_samples(mono_samples, sample_width)


def rms_chunk(chunk: bytes, sample_width: int) -> float:
    samples = decode_samples(chunk, sample_width)
    if not samples:
        return 0.0
    power = sum(float(sample) * float(sample) for sample in samples) / len(samples)
    return math.sqrt(power)


def decode_samples(raw_pcm: bytes, sample_width: int) -> list[int]:
    if sample_width == 1:
        return [value - 128 for value in raw_pcm]
    if sample_width == 2:
        count = len(raw_pcm) // 2
        return list(struct.unpack("<" + "h" * count, raw_pcm[: count * 2]))
    if sample_width == 3:
        samples: list[int] = []
        for idx in range(0, len(raw_pcm) - 2, 3):
            chunk = raw_pcm[idx : idx + 3]
            value = int.from_bytes(chunk + (b"\xff" if chunk[2] & 0x80 else b"\x00"), "little", signed=True)
            samples.append(value)
        return samples
    if sample_width == 4:
        count = len(raw_pcm) // 4
        return list(struct.unpack("<" + "i" * count, raw_pcm[: count * 4]))
    raise ValueError(f"Unsupported sample width: {sample_width}")


def encode_samples(samples: list[int], sample_width: int) -> bytes:
    if sample_width == 1:
        return bytes(max(0, min(255, sample + 128)) for sample in samples)
    if sample_width == 2:
        return struct.pack("<" + "h" * len(samples), *samples)
    if sample_width == 3:
        raw = bytearray()
        for sample in samples:
            sample = max(-(1 << 23), min((1 << 23) - 1, sample))
            raw.extend(int(sample).to_bytes(3, "little", signed=True))
        return bytes(raw)
    if sample_width == 4:
        return struct.pack("<" + "i" * len(samples), *samples)
    raise ValueError(f"Unsupported sample width: {sample_width}")

