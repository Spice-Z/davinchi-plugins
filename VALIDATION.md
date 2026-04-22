# Validation

## Automated

### TypeScript (Vitest)

- Unit tests: `tests/silence.test.ts`, `tests/freeXmlCutter.test.ts`, `tests/fcpxmlCutter.test.ts`
- Command: `pnpm test`
- Optional emit: `pnpm run build` (not required to run the CLI; default is `tsx` on `src/`)

## Regression spot-check

On a known timeline export, run with `--dry-run`, confirm counts, then run without `--dry-run` and import the XML into Resolve.

## Manual Resolve validation (XML mode)

1. Export timeline from Resolve as Final Cut Pro 7 XML (`xmeml`) or FCPXML (`fcpxml`).
2. Run the CLI with `--dry-run` first.
3. Verify summary reports expected edited clip counts.
4. Run without `--dry-run` to write output XML.
5. Import modified XML into Resolve and verify:
   - Only target audio track changed
   - Silence segments removed within clips
   - Absolute timeline spacing remains unchanged
