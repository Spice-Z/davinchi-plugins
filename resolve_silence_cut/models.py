from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class TimeRangeSeconds:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass(frozen=True)
class FrameRange:
    start: int
    end: int

    @property
    def duration(self) -> int:
        return max(0, self.end - self.start)


@dataclass
class ClipAnalysis:
    timeline_item: Any
    media_pool_item: Any
    file_path: str
    timeline_start: int
    timeline_end: int
    source_start: int
    source_end: int
    keep_ranges: list[FrameRange]
    removed_ranges: list[FrameRange]


@dataclass
class AppendClipInfo:
    media_pool_item: Any
    start_frame: int
    end_frame: int
    record_frame: int
    track_index: int

