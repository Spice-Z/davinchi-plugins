from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from resolve_silence_cut.config import SilenceSettings
from resolve_silence_cut.fcpxml_cutter import (
    FrameRange,
    format_fcpx_time,
    parse_fcpx_time,
    process_fcpxml_file,
)


def _sample_fcpxml(path: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10">
  <resources>
    <asset id="r1" src="file://{path}" />
  </resources>
  <library>
    <event name="evt">
      <project name="proj">
        <sequence format="rfmt" frameDuration="1/30s" tcStart="0s" tcFormat="NDF">
          <spine>
            <asset-clip name="A1Clip" ref="r1" offset="0s" start="0s" duration="3s" lane="0" audioRole="dialogue"/>
            <asset-clip name="A2Clip" ref="r1" offset="0s" start="0s" duration="3s" lane="-1" audioRole="dialogue"/>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
"""


class FcpXmlCutterTests(unittest.TestCase):
    def test_time_roundtrip(self) -> None:
        self.assertEqual("1/30s", format_fcpx_time(parse_fcpx_time("1/30s")))

    def test_process_fcpxml_with_mock_analyzer(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            media_file = Path(tmpdir) / "source.wav"
            media_file.write_bytes(b"fake")
            input_xml = Path(tmpdir) / "in.fcpxml"
            output_xml = Path(tmpdir) / "out.fcpxml"
            input_xml.write_text(_sample_fcpxml(str(media_file)), encoding="utf-8")

            def fake_analyzer(_path, _in, _out, _fps, _settings):
                return [FrameRange(0, 30), FrameRange(60, 90)], [FrameRange(30, 60)]

            result = process_fcpxml_file(
                input_path=str(input_xml),
                output_path=str(output_xml),
                target_track_index=1,
                settings=SilenceSettings(-40.0, 200, 50, 50),
                dry_run=False,
                analyzer=fake_analyzer,
            )

            self.assertEqual(30, result.total_removed_frames)
            tree = ET.parse(str(output_xml))
            clips = tree.findall(".//sequence/spine/asset-clip")
            # target track clip should split into 2; other lane clip remains 1
            self.assertEqual(3, len(clips))
            first = clips[0]
            second = clips[1]
            self.assertEqual("0/1s", first.get("offset"))
            self.assertEqual("2/1s", second.get("offset"))
            self.assertEqual("1/1s", first.get("duration"))
            self.assertEqual("1/1s", second.get("duration"))


if __name__ == "__main__":
    unittest.main()

