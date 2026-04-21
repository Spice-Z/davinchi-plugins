from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SilenceSettings:
    silence_threshold_db: float
    min_silence_duration_ms: int
    padding_before_ms: int
    padding_after_ms: int
    analysis_frame_ms: int = 10


@dataclass(frozen=True)
class RunOptions:
    target_track_index: int
    dry_run: bool
    include_linked_items: bool = False
