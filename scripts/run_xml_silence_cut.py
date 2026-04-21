#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import argparse
import sys
import tempfile
import xml.etree.ElementTree as ET

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from resolve_silence_cut.config import SilenceSettings
from resolve_silence_cut.free_xml_cutter import XmlCutterError, process_xmeml_file
from resolve_silence_cut.fcpxml_cutter import (
    FcpXmlCutterError,
    get_fcpxml_track_lanes,
    process_fcpxml_file,
)


class TrackRunConfig:
    def __init__(
        self,
        track: int,
        threshold_db: float,
        min_silence_ms: int,
        pad_before_ms: int,
        pad_after_ms: int,
    ) -> None:
        self.track = track
        self.threshold_db = threshold_db
        self.min_silence_ms = min_silence_ms
        self.pad_before_ms = pad_before_ms
        self.pad_after_ms = pad_after_ms


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Cut silence on one audio track of an exported Resolve XML timeline (xmeml or fcpxml)."
    )
    parser.add_argument("--input", required=True, help="Input XML path exported from Resolve.")
    parser.add_argument("--output", required=True, help="Output XML path to write.")
    parser.add_argument("--track", type=int, help="1-based audio track index (A1=1).")
    parser.add_argument("--threshold-db", type=float, default=-40.0, help="Silence threshold in dB.")
    parser.add_argument("--min-silence-ms", type=int, default=250, help="Minimum silence duration in ms.")
    parser.add_argument("--pad-before-ms", type=int, default=80, help="Padding before silence cut in ms.")
    parser.add_argument("--pad-after-ms", type=int, default=120, help="Padding after silence cut in ms.")
    parser.add_argument(
        "--track-config",
        action="append",
        default=[],
        help=(
            "Repeatable per-track config: "
            "'track:thresholdDb:minSilenceMs:padBeforeMs:padAfterMs'. "
            "Example: --track-config '1:-40:250:80:120' --track-config '2:-35:300:60:90'"
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Analyze and print summary only, without writing modified XML.",
    )
    return parser


def detect_xml_root(input_path: str) -> str:
    tree = ET.parse(input_path)
    return tree.getroot().tag.lower()


def parse_track_config(value: str) -> TrackRunConfig:
    parts = [part.strip() for part in value.split(":")]
    if len(parts) != 5:
        raise ValueError(
            f"Invalid --track-config '{value}'. Expected 'track:thresholdDb:minSilenceMs:padBeforeMs:padAfterMs'."
        )
    try:
        track = int(parts[0])
        threshold_db = float(parts[1])
        min_silence_ms = int(parts[2])
        pad_before_ms = int(parts[3])
        pad_after_ms = int(parts[4])
    except ValueError as exc:
        raise ValueError(f"Invalid numeric value in --track-config '{value}'.") from exc

    if track < 1:
        raise ValueError(f"Track must be >= 1 in --track-config '{value}'.")

    return TrackRunConfig(
        track=track,
        threshold_db=threshold_db,
        min_silence_ms=max(1, min_silence_ms),
        pad_before_ms=max(0, pad_before_ms),
        pad_after_ms=max(0, pad_after_ms),
    )


def build_run_configs(args: argparse.Namespace) -> list[TrackRunConfig]:
    if args.track_config:
        return [parse_track_config(cfg) for cfg in args.track_config]
    if args.track is None:
        raise ValueError("Either --track or at least one --track-config is required.")
    return [
        TrackRunConfig(
            track=args.track,
            threshold_db=args.threshold_db,
            min_silence_ms=max(1, args.min_silence_ms),
            pad_before_ms=max(0, args.pad_before_ms),
            pad_after_ms=max(0, args.pad_after_ms),
        )
    ]


def run() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        run_configs = build_run_configs(args)
    except ValueError as exc:
        print(f"Error: {exc}")
        return 1

    print(f"Starting silence cut: input='{args.input}', output='{args.output}', dry_run={bool(args.dry_run)}", flush=True)
    print(f"Track runs: {len(run_configs)}", flush=True)

    def log(message: str) -> None:
        print(message, flush=True)

    temp_outputs: list[str] = []
    try:
        root_tag = detect_xml_root(args.input)
        print(f"Detected XML type: {root_tag}", flush=True)
        if root_tag not in {"xmeml", "fcpxml"}:
            print(f"Error: Unsupported XML root '{root_tag}'. Expected xmeml or fcpxml.")
            return 1

        results = []
        current_input = args.input
        pinned_lanes: dict[int, str] = {}
        if root_tag == "fcpxml" and len(run_configs) > 1:
            lanes = get_fcpxml_track_lanes(args.input)
            for cfg in run_configs:
                if cfg.track < 1 or cfg.track > len(lanes):
                    raise FcpXmlCutterError(
                        f"Track index {cfg.track} out of range for initial fcpxml tracks 1..{len(lanes)}"
                    )
                pinned_lanes[cfg.track] = lanes[cfg.track - 1]
            print(
                "Pinned initial fcpxml lanes: "
                + ", ".join([f"A{track}=lane{lane}" for track, lane in sorted(pinned_lanes.items())]),
                flush=True,
            )

        for idx, cfg in enumerate(run_configs, start=1):
            settings = SilenceSettings(
                silence_threshold_db=cfg.threshold_db,
                min_silence_duration_ms=cfg.min_silence_ms,
                padding_before_ms=cfg.pad_before_ms,
                padding_after_ms=cfg.pad_after_ms,
            )
            if args.dry_run:
                current_output = args.output
            elif idx == len(run_configs):
                current_output = args.output
            else:
                temp_output = tempfile.NamedTemporaryFile(
                    prefix="resolve_silence_cut_",
                    suffix=".xml",
                    delete=False,
                )
                temp_output.close()
                current_output = temp_output.name
                temp_outputs.append(current_output)

            print(
                f"--- Track run {idx}/{len(run_configs)}: A{cfg.track}, "
                f"threshold={cfg.threshold_db}, min={cfg.min_silence_ms}, "
                f"pad_before={cfg.pad_before_ms}, pad_after={cfg.pad_after_ms} ---",
                flush=True,
            )

            if root_tag == "xmeml":
                result = process_xmeml_file(
                    input_path=current_input,
                    output_path=current_output,
                    target_track_index=cfg.track,
                    settings=settings,
                    dry_run=bool(args.dry_run),
                    log=log,
                )
            else:
                result = process_fcpxml_file(
                    input_path=current_input,
                    output_path=current_output,
                    target_track_index=cfg.track,
                    settings=settings,
                    dry_run=bool(args.dry_run),
                    log=log,
                    target_lane=pinned_lanes.get(cfg.track),
                )
            results.append(result)
            if not args.dry_run:
                current_input = current_output
    except (XmlCutterError, FcpXmlCutterError, ET.ParseError) as exc:
        print(f"Error: {exc}")
        return 1
    finally:
        for temp_path in temp_outputs:
            try:
                Path(temp_path).unlink(missing_ok=True)
            except OSError:
                pass

    total_visited = sum(len(result.clip_results) for result in results)
    total_edited = sum(
        len([clip for clip in result.clip_results if clip.removed_frames > 0])
        for result in results
    )
    total_skipped = sum(
        len([clip for clip in result.clip_results if clip.skipped_reason])
        for result in results
    )
    total_removed_frames = sum(result.total_removed_frames for result in results)

    print("=== XML Silence Cut Summary ===")
    print(f"Track runs: {len(results)}")
    print(f"Clips visited: {total_visited}")
    print(f"Clips edited: {total_edited}")
    print(f"Clips skipped: {total_skipped}")
    print(f"Total removed frames: {total_removed_frames}")
    for idx, result in enumerate(results, start=1):
        edited = len([clip for clip in result.clip_results if clip.removed_frames > 0])
        skipped = len([clip for clip in result.clip_results if clip.skipped_reason])
        print(
            f"  - Run {idx}: track A{result.track_index}, visited={len(result.clip_results)}, "
            f"edited={edited}, skipped={skipped}, removed_frames={result.total_removed_frames}"
        )
    if args.dry_run:
        if len(results) > 1:
            print("Dry run: no XML file was written (multi-track dry-run is per-run preview).")
        else:
            print("Dry run: no XML file was written.")
    else:
        print(f"Modified XML written: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())

