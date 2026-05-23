# DaVinci Resolve Track Silence Cutter

CLI tool for cutting silence on a single selected audio track while preserving absolute timeline timing.

## Workflow

1. In **DaVinci Resolve**, export the timeline as **Final Cut Pro 7 XML** (`xmeml`) or **FCPXML** (`fcpxml`).
2. Run this CLI on the exported file (see below).
3. Import the written XML back into Resolve.

## What The Tool Does

- Lets you choose a target audio track (A1/A2/...).
- Detects silence per clip on that track using:
  - Silence threshold in dB
  - Minimum silence duration
  - Pre-attack / post-release context in milliseconds
- Removes silent regions inside each clip.
- Keeps global timeline spacing (no ripple shift).
- Optional: splits a chosen video track at the same cut boundaries while keeping all video segments.
- Supports dry-run preview.

## Project Layout

- `src/cli/runXmlSilenceCut.ts` — CLI entry (XML mode).
- `src/core/` — silence detection, FFmpeg extract, xmeml/fcpxml cutters.
- `tests/*.test.ts` — Vitest tests.

## Requirements

- **Node.js 20+** and [pnpm](https://pnpm.io) (see `packageManager` in `package.json` for the pinned version).
- `ffmpeg` on `PATH` (used to decode source clip audio).

Install dependencies:

`pnpm install`

## CLI (XML mode)

The CLI runs **tsx** on the TypeScript source (no `tsc` build required for normal use).

Single track (recommended — `pnpm start` runs tsx on `src/cli/runXmlSilenceCut.ts`). Pass flags **directly** after `pnpm start` (do not insert an extra `--`; pnpm can forward a literal `--` and confuse the parser):

`pnpm start --input "/path/in.xml" --output "/path/out.xml" --track 1 --threshold-db -40 --min-silence-ms 250 --pre-attack-ms 80 --post-release-ms 120 --min-keep-ms 120 --zero-crossing-ms 12`

Or run **tsx** on the entry file directly (same behavior):

`pnpm exec tsx src/cli/runXmlSilenceCut.ts --input "/path/in.xml" --output "/path/out.xml" --track 1 --threshold-db -40 --min-silence-ms 250 --pre-attack-ms 80 --post-release-ms 120 --min-keep-ms 120 --zero-crossing-ms 12`

CLI help:

`pnpm run start --help`

Dry-run example:

`pnpm start --input "/path/in.xml" --output "/path/out.xml" --track 1 --dry-run`

Multi-track with different settings in one run:

`pnpm exec tsx src/cli/runXmlSilenceCut.ts --input "/path/in.xml" --output "/path/out.xml" --track-config "1:-40:250:80:120" --track-config "2:-35:300:60:90"`

`--track-config` format is `track:thresholdDb:minSilenceMs:preAttackMs:postReleaseMs:minKeepMs`. Omitted values fall back to defaults (`-28:500:60:60:120` unless you change the `DEFAULT_*` constants in `src/cli/runXmlSilenceCut.ts`):

`pnpm exec tsx src/cli/runXmlSilenceCut.ts --input "/path/in.xml" --output "/path/out.xml" --track-config "1:-34" --track-config "2:::6"`

Optional global tuning (applies to every track run in the same command):

- `--analysis-frame-ms` — RMS loudness window in ms (default `10`). Try **`18`–`25`** for speech so short dips at the ends of words are less likely to be called “silence”.
- `--pre-attack-ms` — keep extra context right before speech starts (default `60`, legacy alias: `--pad-before-ms`).
- `--post-release-ms` — keep extra context right after speech ends (default `60`, legacy alias: `--pad-after-ms`).
- `--min-keep-ms` — minimum non-silent island to keep (default `120`). Increase to **`150`–`250`** when you see many tiny chopped blocks/noise islands.
- `--zero-crossing-ms` — snap each keep-segment boundary to the nearest waveform zero-crossing within this radius (default `12`, set `0` to disable). Helps reduce hard boundary clicks.
- `--split-video-track` — optional 1-based video track index (`V1=1`) to split at the same positions as audio cuts. Video clips are not deleted; they are only segmented.

Example with matching video cuts:

`pnpm start --input "ep10.xml" --output "ep10-cut.xml" --track 2 --split-video-track 1 --threshold-db -48 --min-silence-ms 900 --pre-attack-ms 80 --post-release-ms 200`

Optional: emit JavaScript with `pnpm run build` if you want a compiled `dist/` tree (not required for normal use).

### Speech / podcast (avoid cutting tails early)

If consonants, breath, or room decay sound clipped: use a **more negative** `--threshold-db` (e.g. **`-48`** to **`-55`**), **longer** `--min-silence-ms` (e.g. **`700`–`1200`** so only real pauses are removed), and tune **`--post-release-ms`** (e.g. **`120`–`250`**) and **`--pre-attack-ms`** (e.g. **`60`–`140`**) to preserve natural word boundaries. If you still see lots of tiny cut islands, raise `--min-keep-ms` to **`180`–`300`**. Keep `--zero-crossing-ms` around **`8`–`20`** for cleaner boundaries. Always **`--dry-run`** first and check the summary; hundreds of tiny segments per clip usually means the detector is still too aggressive.

Example:

`pnpm start --input "ep10.xml" --output "ep10-cut.xml" --analysis-frame-ms 20 --min-keep-ms 180 --zero-crossing-ms 12 --track-config "2:-50:900:80:200:180" --track-config "3:-50:900:80:200:180"`

Multi-track with shorter per-track config (`track:thresholdDb:minSilenceMs`; other values use defaults), analysis tuning, and splitting V1 at audio cut boundaries:

```bash
pnpm start \
  --input "$HOME/Desktop/ep10.xml" \
  --output "$HOME/Desktop/ep10_cut.xml" \
  --analysis-frame-ms 20 \
  --track-config "2:-32:600" \
  --track-config "3:-36:600" \
  --zero-crossing-ms 12 \
  --split-video-track 1
```

Run tests:

`pnpm test`

## Notes

- Supports FCP7 XML (`xmeml`) and FCPXML (`fcpxml`) timelines.
- If a clip has no readable source file path in XML, it is skipped with a warning.
- The CLI only modifies the selected audio track.
