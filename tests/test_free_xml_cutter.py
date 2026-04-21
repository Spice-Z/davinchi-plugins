from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from resolve_silence_cut.config import SilenceSettings
from resolve_silence_cut.free_xml_cutter import (
    FrameRange,
    parse_posix_pathurl,
    process_xmeml_file,
    split_clipitem_by_keep_ranges,
)
import xml.etree.ElementTree as ET


def _sample_xmeml(path: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5">
  <sequence>
    <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <audio>
        <track>
          <clipitem id="a1c1">
            <name>Clip1</name>
            <start>0</start><end>90</end>
            <in>0</in><out>90</out>
            <duration>90</duration>
            <file id="f1"><pathurl>file://localhost{path}</pathurl></file>
          </clipitem>
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>
"""


class FreeXmlCutterTests(unittest.TestCase):
    def test_parse_posix_pathurl(self) -> None:
        self.assertEqual("/Users/test/a b.wav", parse_posix_pathurl("file://localhost/Users/test/a%20b.wav"))

    def test_split_clipitem_by_keep_ranges(self) -> None:
        clip = ET.fromstring(
            "<clipitem id='c1'><start>100</start><end>190</end><in>10</in><out>100</out><duration>90</duration></clipitem>"
        )
        pieces = split_clipitem_by_keep_ranges(
            clip,
            [FrameRange(0, 20), FrameRange(40, 60)],
            1,
        )
        self.assertEqual(2, len(pieces))
        self.assertEqual("100", pieces[0].find("start").text)
        self.assertEqual("120", pieces[0].find("end").text)
        self.assertEqual("10", pieces[0].find("in").text)
        self.assertEqual("30", pieces[0].find("out").text)
        self.assertEqual("140", pieces[1].find("start").text)
        self.assertEqual("160", pieces[1].find("end").text)

    def test_process_xml_with_mock_analyzer(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            media_file = Path(tmpdir) / "source.wav"
            media_file.write_bytes(b"fake")
            input_xml = Path(tmpdir) / "in.xml"
            output_xml = Path(tmpdir) / "out.xml"
            input_xml.write_text(_sample_xmeml(str(media_file)), encoding="utf-8")

            def fake_analyzer(_path, _in, _out, _fps, _settings):
                return [FrameRange(0, 20), FrameRange(40, 60)], [FrameRange(20, 40), FrameRange(60, 90)]

            result = process_xmeml_file(
                input_path=str(input_xml),
                output_path=str(output_xml),
                target_track_index=1,
                settings=SilenceSettings(-40.0, 250, 50, 50),
                dry_run=False,
                analyzer=fake_analyzer,
            )

            self.assertEqual(50, result.total_removed_frames)
            self.assertTrue(output_xml.exists())
            tree = ET.parse(str(output_xml))
            clips = tree.findall("./sequence/media/audio/track/clipitem")
            self.assertEqual(2, len(clips))
            self.assertEqual("0", clips[0].find("start").text)
            self.assertEqual("20", clips[0].find("end").text)
            self.assertEqual("40", clips[1].find("start").text)
            self.assertEqual("60", clips[1].find("end").text)


if __name__ == "__main__":
    unittest.main()

