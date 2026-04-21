from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import unquote, urlparse
import xml.etree.ElementTree as ET

from .audio_extract import extract_clip_slice_to_wav
from .config import SilenceSettings
from .models import FrameRange
from .silence import detect_silence_ranges, expand_with_padding, invert_ranges, read_wav_pcm


@dataclass
class ClipEditResult:
    clip_id: str
    removed_frames: int
    original_duration_frames: int
    created_segments: int
    skipped_reason: str | None = None


@dataclass
class XmlProcessResult:
    track_index: int
    clip_results: list[ClipEditResult]
    total_removed_frames: int
    total_segments_created: int


class XmlCutterError(RuntimeError):
    pass


def parse_posix_pathurl(pathurl: str) -> str | None:
    if not pathurl:
        return None
    parsed = urlparse(pathurl)
    if parsed.scheme != "file":
        return None
    raw_path = unquote(parsed.path or "")
    if not raw_path:
        return None
    return raw_path


def fps_from_sequence(sequence_node: ET.Element) -> float:
    timebase_node = sequence_node.find("./rate/timebase")
    ntsc_node = sequence_node.find("./rate/ntsc")
    if timebase_node is None or not (timebase_node.text or "").strip():
        return 24.0
    fps = float((timebase_node.text or "24").strip())
    ntsc = ((ntsc_node.text or "").strip().upper() == "TRUE") if ntsc_node is not None else False
    if ntsc and int(fps) == 30:
        return 29.97
    if ntsc and int(fps) == 60:
        return 59.94
    return fps


def _int_child(node: ET.Element, tag: str) -> int | None:
    child = node.find(tag)
    if child is None or child.text is None:
        return None
    text = child.text.strip()
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def _set_int_child(node: ET.Element, tag: str, value: int) -> None:
    child = node.find(tag)
    if child is None:
        child = ET.SubElement(node, tag)
    child.text = str(int(value))


def _clip_source_path(clipitem: ET.Element, file_id_to_path: dict[str, str]) -> str | None:
    file_node = clipitem.find("file")
    if file_node is None:
        return None

    file_id = file_node.get("id")
    if file_id and file_id in file_id_to_path:
        return file_id_to_path[file_id]

    pathurl_node = file_node.find("pathurl")
    if pathurl_node is None or pathurl_node.text is None:
        return None

    path = parse_posix_pathurl(pathurl_node.text.strip())
    if path and file_id:
        file_id_to_path[file_id] = path
    return path


def _collect_file_path_map(root: ET.Element) -> dict[str, str]:
    path_map: dict[str, str] = {}
    for file_node in root.findall(".//file"):
        file_id = file_node.get("id")
        if not file_id:
            continue
        pathurl_node = file_node.find("pathurl")
        if pathurl_node is None or pathurl_node.text is None:
            continue
        path = parse_posix_pathurl(pathurl_node.text.strip())
        if path:
            path_map[file_id] = path
    return path_map


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
    keep_ranges = _seconds_to_frame_ranges(keep_seconds, fps, clip_duration_frames)
    remove_ranges = _seconds_to_frame_ranges(padded_silence, fps, clip_duration_frames)
    return keep_ranges, remove_ranges


def _seconds_to_frame_ranges(
    ranges_seconds: list,
    fps: float,
    clip_duration_frames: int,
) -> list[FrameRange]:
    ranges: list[FrameRange] = []
    for rng in ranges_seconds:
        start = max(0, min(clip_duration_frames, int(round(rng.start * fps))))
        end = max(start, min(clip_duration_frames, int(round(rng.end * fps))))
        if end > start:
            ranges.append(FrameRange(start, end))
    return _merge_ranges(ranges)


def _merge_ranges(ranges: list[FrameRange]) -> list[FrameRange]:
    if not ranges:
        return []
    ranges = sorted(ranges, key=lambda r: r.start)
    merged = [ranges[0]]
    for current in ranges[1:]:
        prev = merged[-1]
        if current.start <= prev.end:
            merged[-1] = FrameRange(prev.start, max(prev.end, current.end))
        else:
            merged.append(current)
    return merged


def split_clipitem_by_keep_ranges(
    clipitem: ET.Element,
    keep_ranges: list[FrameRange],
    clip_idx: int,
) -> list[ET.Element]:
    start = _int_child(clipitem, "start")
    end = _int_child(clipitem, "end")
    in_frame = _int_child(clipitem, "in")
    if start is None or end is None or in_frame is None:
        return [clipitem]

    clip_id = clipitem.get("id") or f"clipitem_{clip_idx}"
    new_nodes: list[ET.Element] = []
    for seg_idx, keep in enumerate(keep_ranges, start=1):
        if keep.end <= keep.start:
            continue
        segment = deepcopy(clipitem)
        segment.set("id", f"{clip_id}_sc{seg_idx}")
        new_start = start + keep.start
        new_end = start + keep.end
        new_in = in_frame + keep.start
        new_out = in_frame + keep.end
        _set_int_child(segment, "start", new_start)
        _set_int_child(segment, "end", new_end)
        _set_int_child(segment, "in", new_in)
        _set_int_child(segment, "out", new_out)
        _set_int_child(segment, "duration", new_end - new_start)
        new_nodes.append(segment)
    return new_nodes


def process_xmeml_file(
    input_path: str,
    output_path: str,
    target_track_index: int,
    settings: SilenceSettings,
    dry_run: bool,
    analyzer: Callable[[str, int, int, float, SilenceSettings], tuple[list[FrameRange], list[FrameRange]]] | None = None,
    log: Callable[[str], None] | None = None,
) -> XmlProcessResult:
    def emit(message: str) -> None:
        if log is not None:
            log(message)

    xml_path = Path(input_path)
    if not xml_path.exists():
        raise XmlCutterError(f"Input XML does not exist: {input_path}")

    tree = ET.parse(str(xml_path))
    root = tree.getroot()
    if root.tag.lower() != "xmeml":
        raise XmlCutterError("Only FCP7 XML (xmeml) is currently supported.")

    sequence = root.find("./sequence")
    if sequence is None:
        raise XmlCutterError("Could not find <sequence> in xmeml.")
    fps = fps_from_sequence(sequence)

    tracks = sequence.findall("./media/audio/track")
    if not tracks:
        raise XmlCutterError("No audio tracks found in XML sequence.")
    if target_track_index < 1 or target_track_index > len(tracks):
        raise XmlCutterError(
            f"Track index {target_track_index} out of range. Audio tracks: 1..{len(tracks)}"
        )

    target_track = tracks[target_track_index - 1]
    file_path_map = _collect_file_path_map(root)
    analyzer_fn = analyzer or _analyze_keep_ranges
    clip_nodes = [node for node in list(target_track) if node.tag == "clipitem"]
    emit(
        f"[xmeml] Processing track A{target_track_index}: {len(clip_nodes)} clipitems detected."
    )
    clip_results: list[ClipEditResult] = []
    total_removed_frames = 0
    total_segments_created = 0

    new_children: list[ET.Element] = []
    clip_counter = 0
    for child in list(target_track):
        if child.tag != "clipitem":
            new_children.append(child)
            continue

        clip_counter += 1
        clip_id = child.get("id") or f"clipitem_{clip_counter}"
        emit(f"[xmeml] [{clip_counter}/{len(clip_nodes)}] Analyzing clip '{clip_id}'...")
        start = _int_child(child, "start")
        end = _int_child(child, "end")
        in_frame = _int_child(child, "in")
        out_frame = _int_child(child, "out")
        if None in (start, end, in_frame, out_frame):
            clip_results.append(
                ClipEditResult(
                    clip_id=clip_id,
                    removed_frames=0,
                    original_duration_frames=0,
                    created_segments=1,
                    skipped_reason="Missing start/end/in/out fields.",
                )
            )
            emit(f"[xmeml]   Skipped '{clip_id}': missing timing fields.")
            new_children.append(child)
            continue

        source_path = _clip_source_path(child, file_path_map)
        if not source_path or not Path(source_path).exists():
            clip_results.append(
                ClipEditResult(
                    clip_id=clip_id,
                    removed_frames=0,
                    original_duration_frames=end - start,
                    created_segments=1,
                    skipped_reason="Missing or unreadable source media path.",
                )
            )
            emit(f"[xmeml]   Skipped '{clip_id}': source media path unavailable.")
            new_children.append(child)
            continue

        try:
            keep_ranges, remove_ranges = analyzer_fn(
                source_path,
                in_frame,
                out_frame,
                fps,
                settings,
            )
        except Exception as exc:
            clip_results.append(
                ClipEditResult(
                    clip_id=clip_id,
                    removed_frames=0,
                    original_duration_frames=end - start,
                    created_segments=1,
                    skipped_reason=f"Analysis failed: {exc}",
                )
            )
            emit(f"[xmeml]   Skipped '{clip_id}': analysis failed ({exc}).")
            new_children.append(child)
            continue

        removed_frames = sum(r.duration for r in remove_ranges)
        original_duration = max(0, end - start)
        if removed_frames <= 0:
            clip_results.append(
                ClipEditResult(
                    clip_id=clip_id,
                    removed_frames=0,
                    original_duration_frames=original_duration,
                    created_segments=1,
                )
            )
            emit(f"[xmeml]   No silence cut for '{clip_id}'.")
            new_children.append(child)
            continue

        split_nodes = split_clipitem_by_keep_ranges(child, keep_ranges, clip_counter)
        total_segments_created += len(split_nodes)
        total_removed_frames += removed_frames
        clip_results.append(
            ClipEditResult(
                clip_id=clip_id,
                removed_frames=removed_frames,
                original_duration_frames=original_duration,
                created_segments=len(split_nodes),
            )
        )
        emit(
            f"[xmeml]   Cut '{clip_id}': removed {removed_frames} frames, created {len(split_nodes)} segments."
        )
        new_children.extend(split_nodes)

    if not dry_run:
        emit("[xmeml] Writing modified XML...")
        target_track.clear()
        for child in new_children:
            target_track.append(child)
        tree.write(output_path, encoding="utf-8", xml_declaration=True)
        emit(f"[xmeml] Wrote output: {output_path}")
    else:
        emit("[xmeml] Dry run enabled; no file written.")

    return XmlProcessResult(
        track_index=target_track_index,
        clip_results=clip_results,
        total_removed_frames=total_removed_frames,
        total_segments_created=total_segments_created,
    )

