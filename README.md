# DaVinci Resolve Track Silence Cutter

CLI tool for cutting silence on a single selected audio track while preserving absolute timeline timing.

## Workflow

- CLI XML mode:
  - `scripts/run_xml_silence_cut.py`
  - Works on exported FCP7 XML (`xmeml`) and FCPXML (`fcpxml`) timeline files and writes a modified XML to re-import.

## What The Tool Does

- Lets you choose a target audio track (A1/A2/...).
- Detects silence per clip on that track using:
  - Silence threshold in dB
  - Minimum silence duration
  - Pre/post padding in milliseconds
- Removes silent regions inside each clip.
- Keeps global timeline spacing (no ripple shift).
- Supports dry-run preview.

## Project Layout

- `resolve_silence_cut/free_xml_cutter.py` - free-user XML processing
- `resolve_silence_cut/fcpxml_cutter.py` - FCPXML processing
- `resolve_silence_cut/silence.py` - audio silence detection
- `scripts/run_xml_silence_cut.py` - XML-based CLI for free users
- `tests/` - unit tests for core logic

## Requirements

- Python 3.9+
- `ffmpeg` available on `PATH` (used to decode source clip audio)

## Free-User XML Workflow

1. In Resolve, export timeline as **Final Cut Pro 7 XML** (`xmeml`).
   - FCPXML exports are also supported now.
2. Run:

`python3 scripts/run_xml_silence_cut.py --input "/path/in.xml" --output "/path/out.xml" --track 1 --threshold-db -40 --min-silence-ms 250 --pad-before-ms 80 --pad-after-ms 120`

Multi-track with different settings in one run:

`python3 scripts/run_xml_silence_cut.py --input "/path/in.xml" --output "/path/out.xml" --track-config "1:-40:250:80:120" --track-config "2:-35:300:60:90"`

3. Import output XML back into Resolve.

Dry-run:

`python3 scripts/run_xml_silence_cut.py --input "/path/in.xml" --output "/path/out.xml" --track 1 --dry-run`

## Notes

- Supports FCP7 XML (`xmeml`) and FCPXML (`fcpxml`) timelines.
- If a clip has no readable source file path in XML, it is skipped with a warning.
- The CLI only modifies the selected audio track.
