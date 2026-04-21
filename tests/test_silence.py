import struct
import unittest

from resolve_silence_cut.config import SilenceSettings
from resolve_silence_cut.silence import detect_silence_ranges, expand_with_padding, invert_ranges


def make_pcm(
    sample_rate: int,
    segments: list[tuple[float, int]],
) -> bytes:
    raw = bytearray()
    for duration_sec, sample_value in segments:
        sample_count = int(sample_rate * duration_sec)
        raw.extend(struct.pack("<h", sample_value) * sample_count)
    return bytes(raw)


class SilenceDetectionTests(unittest.TestCase):
    def test_detect_and_expand_and_invert(self) -> None:
        sample_rate = 1000
        sample_width = 2
        raw = make_pcm(
            sample_rate,
            [
                (0.2, 8000),
                (0.5, 0),
                (0.2, 8000),
            ],
        )
        settings = SilenceSettings(
            silence_threshold_db=-35.0,
            min_silence_duration_ms=200,
            padding_before_ms=50,
            padding_after_ms=50,
            analysis_frame_ms=10,
        )

        silence = detect_silence_ranges(sample_rate, sample_width, raw, settings)
        self.assertEqual(1, len(silence))
        self.assertAlmostEqual(0.2, silence[0].start, places=2)
        self.assertAlmostEqual(0.7, silence[0].end, places=2)

        expanded = expand_with_padding(silence, 0.9, 50, 50)
        self.assertAlmostEqual(0.15, expanded[0].start, places=2)
        self.assertAlmostEqual(0.75, expanded[0].end, places=2)

        kept = invert_ranges(expanded, 0.9)
        self.assertEqual(2, len(kept))
        self.assertAlmostEqual(0.15, kept[0].end, places=2)
        self.assertAlmostEqual(0.75, kept[1].start, places=2)


if __name__ == "__main__":
    unittest.main()

