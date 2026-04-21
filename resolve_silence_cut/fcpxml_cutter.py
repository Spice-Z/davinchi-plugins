from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Callable
from urllib.parse import unquote, urlparse
import xml.etree.ElementTree as ET

from .audio_extract import extract_clip_slice_to_wav
from .config import SilenceSettings
from .models import FrameRange
from .silence import detect_silence_ranges, expand_with_padding, invert_ranges, read_wav_pcm


@dataclass
class FcpClipEditResult:
    clip_name: str
    removed_frames: int
    created_segments: int
    skipped_reason: str | None = None


@dataclass
class FcpXmlProcessResult:
    track_index: int
    clip_results: list[FcpClipEditResult]
    total_removed_frames: int
    total_segments_created: int


class FcpXmlCutterError(RuntimeError):
    pass


def parse_fcpx_time(value: str) -> Fraction:
    text = (value or "").strip()
    if not text.endswith("s"):
        raise ValueError(f"Invalid FCPXML time: {value}")
    raw = text[:-1]
    if "/" in raw:
        numerator, denominator = raw.split("/", 1)
        return Fraction(int(numerator), int(denominator))
    return Fraction(raw)


def format_fcpx_time(value: Fraction) -> str:
    value = value.limit_denominator(48000)
    return f"{value.numerator}/{value.denominator}s"


def parse_asset_src_to_path(src: str) -> str | None:
    parsed = urlparse(src)
    if parsed.scheme != "file":
        return None
    path = unquote(parsed.path or "")
    return path or None


def _sequence_fps(sequence_node: ET.Element) -> float:
    tc_format = sequence_node.get("tcFormat", "").lower()
    if tc_format == "ndf":
        # Fallback when explicit frameDuration is not present.
        return 30.0
    frame_duration = sequence_node.get("frameDuration")
    if frame_duration:
        sec = parse_fcpx_time(frame_duration)
        if sec > 0:
            return float(Fraction(1, 1) / sec)
    return 24.0


def _frame_ranges_from_seconds(
    ranges_seconds: list,
    fps: float,
    clip_duration_frames: int,
) -> list[FrameRange]:
    out: list[FrameRange] = []
    for rng in ranges_seconds:
        start = max(0, min(clip_duration_frames, int(round(rng.start * fps))))
        end = max(start, min(clip_duration_frames, int(round(rng.end * fps))))
        if end > start:
            out.append(FrameRange(start, end))
    return _merge_ranges(out)


def _merge_ranges(ranges: list[FrameRange]) -> list[FrameRange]:
    if not ranges:
        return []
    ranges = sorted(ranges, key=lambda r: r.start)
    merged: list[FrameRange] = [ranges[0]]
    for current in ranges[1:]:
        prev = merged[-1]
        if current.start <= prev.end:
            merged[-1] = FrameRange(prev.start, max(prev.end, current.end))
        else:
            merged.append(current)
    return merged


def _collect_asset_paths(root: ET.Element) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for asset in root.findall(".//resources/asset"):
        asset_id = asset.get("id")
        src = asset.get("src", "")
        if not asset_id or not src:
            continue
        path = parse_asset_src_to_path(src)
        if path:
            mapping[asset_id] = path
    return mapping


def _lane_to_track_order(lane_value: str | None) -> tuple[int, int]:
    # Stable and intuitive ordering:
    # lane 0 (or missing) first, then -1, -2, ... then +1, +2...
    if lane_value is None or lane_value.strip() == "":
        return (0, 0)
    lane = int(lane_value)
    if lane == 0:
        return (0, 0)
    if lane < 0:
        return (1, abs(lane))
    return (2, lane)


def _collect_audio_track_lanes(spine: ET.Element) -> list[str]:
    lane_values: set[str] = set()
    for clip in spine.findall(".//asset-clip"):
        if clip.get("ref") and clip.get("audioRole") is not None:
            lane_values.add(clip.get("lane", "0"))
    return sorted(lane_values, key=_lane_to_track_order)


def _analyze_keep_ranges(
    source_path: str,
    source_in_frame: int,
    source_out_frame: int,
    fps: float,
    settings: SilenceSettings,
) -> tuple[list[FrameRange], list[FrameRange]]:
    extracted = extract_clip_slice_to_wav(
        file_path=source_path,
        source_start_frame=source_in_frame,
        source_end_frame=source_out_frame,
        fps=fps,
    )
    sample_rate, sample_width, raw_pcm = read_wav_pcm(extracted.wav_path)
    silence_ranges = detect_silence_ranges(sample_rate, sample_width, raw_pcm, settings)
    padded_silence = expand_with_padding(
        silence_ranges,
        extracted.duration_seconds,
        settings.padding_before_ms,
        settings.padding_after_ms,
    )
    keep_seconds = invert_ranges(padded_silence, extracted.duration_seconds)
    clip_duration_frames = max(0, source_out_frame - source_in_frame)
    keep_ranges = _frame_ranges_from_seconds(keep_seconds, fps, clip_duration_frames)
    remove_ranges = _frame_ranges_from_seconds(padded_silence, fps, clip_duration_frames)
    return keep_ranges, remove_ranges


def _split_asset_clip(
    clip: ET.Element,
    keep_ranges: list[FrameRange],
    fps: float,
) -> list[ET.Element]:
    offset = parse_fcpx_time(clip.get("offset", "0s"))
    start = parse_fcpx_time(clip.get("start", "0s"))
    duration = parse_fcpx_time(clip.get("duration", "0s"))
    if duration <= 0:
        return [clip]

    frame_sec = Fraction(1, 1) / Fraction(str(fps))
    out: list[ET.Element] = []
    for idx, keep in enumerate(keep_ranges, start=1):
        if keep.end <= keep.start:
            continue
        segment = deepcopy(clip)
        name = clip.get("name", "clip")
        segment.set("name", f"{name}_sc{idx}")

        seg_offset = offset + (frame_sec * keep.start)
        seg_start = start + (frame_sec * keep.start)
        seg_duration = frame_sec * (keep.end - keep.start)

        segment.set("offset", format_fcpx_time(seg_offset))
        segment.set("start", format_fcpx_time(seg_start))
        segment.set("duration", format_fcpx_time(seg_duration))
        out.append(segment)
    return out


def process_fcpxml_file(
    input_path: str,
    output_path: str,
    target_track_index: int,
    settings: SilenceSettings,
    dry_run: bool,
    analyzer: Callable[[str, int, int, float, SilenceSettings], tuple[list[FrameRange], list[FrameRange]]] | None = None,
    log: Callable[[str], None] | None = None,
    target_lane: str | None = None,
) -> FcpXmlProcessResult:
    def emit(message: str) -> None:
        if log is not None:
            log(message)

    xml_path = Path(input_path)
    if not xml_path.exists():
        raise FcpXmlCutterError(f"Input XML does not exist: {input_path}")

    tree = ET.parse(str(xml_path))
    root = tree.getroot()
    if root.tag.lower() != "fcpxml":
        raise FcpXmlCutterError("Root is not fcpxml.")

    sequence = root.find(".//sequence")
    if sequence is None:
        raise FcpXmlCutterError("Could not find <sequence> in fcpxml.")
    spine = sequence.find("spine")
    if spine is None:
        raise FcpXmlCutterError("Could not find <spine> in fcpxml sequence.")

    fps = _sequence_fps(sequence)
    frame_sec = Fraction(1, 1) / Fraction(str(fps))
    asset_paths = _collect_asset_paths(root)
    analyzer_fn = analyzer or _analyze_keep_ranges

    lanes = _collect_audio_track_lanes(spine)
    if not lanes:
        raise FcpXmlCutterError("No audio asset-clip tracks found in fcpxml.")
    if target_lane is None:
        if target_track_index < 1 or target_track_index > len(lanes):
            raise FcpXmlCutterError(
                f"Track index {target_track_index} out of range. Audio tracks: 1..{len(lanes)}"
            )
        target_lane = lanes[target_track_index - 1]
    elif target_lane not in lanes:
        raise FcpXmlCutterError(
            f"Target lane '{target_lane}' not found in current fcpxml track lanes: {', '.join(lanes)}"
        )
    target_track_clips = [
        node
        for node in list(spine)
        if node.tag == "asset-clip"
        and node.get("audioRole") is not None
        and node.get("lane", "0") == target_lane
    ]
    emit(
        f"[fcpxml] Processing track A{target_track_index} (lane {target_lane}): {len(target_track_clips)} clips detected."
    )

    clip_results: list[FcpClipEditResult] = []
    total_removed_frames = 0
    total_segments_created = 0
    new_children: list[ET.Element] = []
    processed_index = 0

    for child in list(spine):
        if child.tag != "asset-clip":
            new_children.append(child)
            continue
        if child.get("audioRole") is None:
            new_children.append(child)
            continue
        lane = child.get("lane", "0")
        if lane != target_lane:
            new_children.append(child)
            continue

        name = child.get("name", "asset-clip")
        processed_index += 1
        emit(
            f"[fcpxml] [{processed_index}/{len(target_track_clips)}] Analyzing clip '{name}'..."
        )
        ref = child.get("ref")
        if not ref or ref not in asset_paths:
            clip_results.append(
                FcpClipEditResult(
                    clip_name=name,
                    removed_frames=0,
                    created_segments=1,
                    skipped_reason="Missing asset ref/path.",
                )
            )
            emit(f"[fcpxml]   Skipped '{name}': missing asset ref/path.")
            new_children.append(child)
            continue

        source_path = asset_paths[ref]
        if not Path(source_path).exists():
            clip_results.append(
                FcpClipEditResult(
                    clip_name=name,
                    removed_frames=0,
                    created_segments=1,
                    skipped_reason="Source media path not found.",
                )
            )
            emit(f"[fcpxml]   Skipped '{name}': source media path not found.")
            new_children.append(child)
            continue

        start = parse_fcpx_time(child.get("start", "0s"))
        duration = parse_fcpx_time(child.get("duration", "0s"))
        if duration <= 0:
            emit(f"[fcpxml]   Skipped '{name}': zero/negative duration.")
            new_children.append(child)
            continue

        source_in_frame = int(round(float(start / frame_sec)))
        source_out_frame = int(round(float((start + duration) / frame_sec)))

        try:
            keep_ranges, remove_ranges = analyzer_fn(
                source_path,
                source_in_frame,
                source_out_frame,
                fps,
                settings,
            )
        except Exception as exc:
            clip_results.append(
                FcpClipEditResult(
                    clip_name=name,
                    removed_frames=0,
                    created_segments=1,
                    skipped_reason=f"Analysis failed: {exc}",
                )
            )
            emit(f"[fcpxml]   Skipped '{name}': analysis failed ({exc}).")
            new_children.append(child)
            continue

        removed_frames = sum(r.duration for r in remove_ranges)
        if removed_frames <= 0:
            clip_results.append(
                FcpClipEditResult(
                    clip_name=name,
                    removed_frames=0,
                    created_segments=1,
                )
            )
            emit(f"[fcpxml]   No silence cut for '{name}'.")
            new_children.append(child)
            continue

        segments = _split_asset_clip(child, keep_ranges, fps)
        total_segments_created += len(segments)
        total_removed_frames += removed_frames
        clip_results.append(
            FcpClipEditResult(
                clip_name=name,
                removed_frames=removed_frames,
                created_segments=len(segments),
            )
        )
        emit(
            f"[fcpxml]   Cut '{name}': removed {removed_frames} frames, created {len(segments)} segments."
        )
        new_children.extend(segments)

    if not dry_run:
        emit("[fcpxml] Writing modified XML...")
        spine.clear()
        for child in new_children:
            spine.append(child)
        tree.write(output_path, encoding="utf-8", xml_declaration=True)
        emit(f"[fcpxml] Wrote output: {output_path}")
    else:
        emit("[fcpxml] Dry run enabled; no file written.")

    return FcpXmlProcessResult(
        track_index=target_track_index,
        clip_results=clip_results,
        total_removed_frames=total_removed_frames,
        total_segments_created=total_segments_created,
    )


def get_fcpxml_track_lanes(input_path: str) -> list[str]:
    xml_path = Path(input_path)
    if not xml_path.exists():
        raise FcpXmlCutterError(f"Input XML does not exist: {input_path}")
    tree = ET.parse(str(xml_path))
    root = tree.getroot()
    if root.tag.lower() != "fcpxml":
        raise FcpXmlCutterError("Root is not fcpxml.")
    sequence = root.find(".//sequence")
    if sequence is None:
        raise FcpXmlCutterError("Could not find <sequence> in fcpxml.")
    spine = sequence.find("spine")
    if spine is None:
        raise FcpXmlCutterError("Could not find <spine> in fcpxml sequence.")
    lanes = _collect_audio_track_lanes(spine)
    if not lanes:
        raise FcpXmlCutterError("No audio asset-clip tracks found in fcpxml.")
    return lanes

