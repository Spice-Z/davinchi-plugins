# Validation

## Automated (Completed)

- Unit tests:
  - `tests/test_silence.py`
  - `tests/test_free_xml_cutter.py`
  - `tests/test_fcpxml_cutter.py`
- Command used:
  - `PYTHONPATH="/Users/yugo/dev/davinchi-plugins" python3 -m unittest discover -s tests -p "test_*.py"`
- Result:
  - `OK`

## Manual Resolve Validation (Free XML Mode)

1. Export timeline from Resolve as Final Cut Pro 7 XML (`xmeml`) or FCPXML (`fcpxml`).
2. Run `scripts/run_xml_silence_cut.py` with `--dry-run` first.
3. Verify summary reports expected edited clip counts.
4. Run without `--dry-run` to write output XML.
5. Import modified XML into Resolve and verify:
   - Only target audio track changed
   - Silence segments removed within clips
   - Absolute timeline spacing remains unchanged

