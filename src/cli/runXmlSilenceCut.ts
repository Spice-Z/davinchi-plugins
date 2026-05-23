import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Command, Option } from "commander";
import { z } from "zod";
import { silenceSettings, type SilenceSettings } from "../core/config.js";
import { processXmemlFile, XmlCutterError } from "../core/xmemlCutter.js";
import {
  FcpXmlCutterError,
  getFcpxmlTrackLanes,
  processFcpxmlFile,
} from "../core/fcpxmlCutter.js";
import { localTagName, parseXmlDocument } from "../core/xmlUtils.js";

const DEFAULT_THRESHOLD_DB = -28.0;
const DEFAULT_MIN_SILENCE_MS = 500;
const DEFAULT_PRE_ATTACK_MS = 60;
const DEFAULT_POST_RELEASE_MS = 60;
const DEFAULT_ANALYSIS_FRAME_MS = 10;
const DEFAULT_MIN_KEEP_MS = 120;
const DEFAULT_ZERO_CROSSING_MS = 12;

interface TrackRunConfig {
  track: number;
  thresholdDb: number;
  minSilenceMs: number;
  preAttackMs: number;
  postReleaseMs: number;
  /** RMS analysis window; larger values smooth out dips at word tails (e.g. 15–25 for speech). */
  analysisFrameMs: number;
  /** Drop tiny non-silent islands that otherwise create micro-clips and hard-looking cuts. */
  minKeepMs: number;
  /** Search radius (ms) to snap cut boundaries to nearest zero-crossing. */
  zeroCrossingMs: number;
}

/** Parsed `--track-config` line before global smoothing params are merged in. */
type ParsedTrackConfigLine = Omit<
  TrackRunConfig,
  "analysisFrameMs" | "zeroCrossingMs"
>;

function collectString(
  value: string,
  previous: string[] | undefined,
): string[] {
  return (previous ?? []).concat(value);
}

function detectXmlRootTag(inputPath: string): string {
  const doc = parseXmlDocument(inputPath);
  return localTagName(doc.documentElement!);
}

function validateOutputPath(outputPath: string): void {
  const outputDir = dirname(outputPath);
  if (existsSync(outputDir)) {
    return;
  }
  if (outputPath.startsWith("/Users/you/")) {
    throw new Error(
      `Output directory does not exist: ${outputDir}. ` +
        `Looks like a placeholder path was used. Replace '/Users/you' with '${homedir()}' ` +
        "or use $HOME in your command.",
    );
  }
  throw new Error(
    `Output directory does not exist: ${outputDir}. ` +
      "Create the directory first or choose an existing output path.",
  );
}

function parseTrackConfig(value: string): ParsedTrackConfigLine {
  const parts = value.split(":").map((p) => p.trim());
  if (parts.length < 1 || parts.length > 6) {
    throw new Error(
      `Invalid --track-config '${value}'. Expected ` +
        "'track[:thresholdDb[:minSilenceMs[:preAttackMs[:postReleaseMs[:minKeepMs]]]]]'.",
    );
  }
  const track = z.number().int().parse(Number.parseInt(parts[0]!, 10));
  if (track < 1) {
    throw new Error(`Track must be >= 1 in --track-config '${value}'.`);
  }
  while (parts.length < 6) {
    parts.push("");
  }
  const tail = parts.slice(1, 6);
  const thresholdDb =
    tail[0] !== ""
      ? z.number().parse(Number.parseFloat(tail[0]!))
      : DEFAULT_THRESHOLD_DB;
  const minSilenceMs =
    tail[1] !== ""
      ? z.number().int().parse(Number.parseInt(tail[1]!, 10))
      : DEFAULT_MIN_SILENCE_MS;
  const preAttackMs =
    tail[2] !== ""
      ? z.number().int().parse(Number.parseInt(tail[2]!, 10))
      : DEFAULT_PRE_ATTACK_MS;
  const postReleaseMs =
    tail[3] !== ""
      ? z.number().int().parse(Number.parseInt(tail[3]!, 10))
      : DEFAULT_POST_RELEASE_MS;
  const minKeepMs =
    tail[4] !== ""
      ? z.number().int().parse(Number.parseInt(tail[4]!, 10))
      : DEFAULT_MIN_KEEP_MS;

  return {
    track,
    thresholdDb,
    minSilenceMs: Math.max(1, minSilenceMs),
    preAttackMs: Math.max(0, preAttackMs),
    postReleaseMs: Math.max(0, postReleaseMs),
    minKeepMs: Math.max(0, minKeepMs),
  };
}

function buildRunConfigs(opts: {
  trackConfig: string[];
  track?: number;
  thresholdDb: number;
  minSilenceMs: number;
  preAttackMs: number;
  postReleaseMs: number;
  analysisFrameMs: number;
  minKeepMs: number;
  zeroCrossingMs: number;
}): TrackRunConfig[] {
  const analysisFrameMs = Math.max(1, opts.analysisFrameMs);
  const minKeepMs = Math.max(0, opts.minKeepMs);
  const zeroCrossingMs = Math.max(0, opts.zeroCrossingMs);
  if (opts.trackConfig.length > 0) {
    return opts.trackConfig.map((line) => ({
      ...parseTrackConfig(line),
      analysisFrameMs,
      zeroCrossingMs,
    }));
  }
  if (opts.track == null) {
    throw new Error(
      "Either --track or at least one --track-config is required.",
    );
  }
  return [
    {
      track: opts.track,
      thresholdDb: opts.thresholdDb,
      minSilenceMs: Math.max(1, opts.minSilenceMs),
      preAttackMs: Math.max(0, opts.preAttackMs),
      postReleaseMs: Math.max(0, opts.postReleaseMs),
      analysisFrameMs,
      minKeepMs,
      zeroCrossingMs,
    },
  ];
}

function toSilenceSettings(cfg: TrackRunConfig): SilenceSettings {
  return silenceSettings(
    cfg.thresholdDb,
    cfg.minSilenceMs,
    cfg.preAttackMs,
    cfg.postReleaseMs,
    cfg.analysisFrameMs,
    cfg.minKeepMs,
    cfg.zeroCrossingMs,
  );
}

type AnyClipResult = { removedFrames: number; skippedReason?: string | null };
type AnyProcessResult = {
  trackIndex: number;
  clipResults: AnyClipResult[];
  totalRemovedFrames: number;
};

async function run(): Promise<number> {
  const program = new Command();
  program
    .name("resolve-silence-cut")
    .description(
      "Cut silence on one audio track of an exported Resolve XML timeline (xmeml or fcpxml).",
    )
    .requiredOption("--input <path>", "Input XML path exported from Resolve.")
    .requiredOption("--output <path>", "Output XML path to write.")
    .addOption(
      new Option("--track <n>", "1-based audio track index (A1=1).").argParser(
        (v) => Number.parseInt(v, 10),
      ),
    )
    .option(
      "--threshold-db <n>",
      "Silence threshold in dB.",
      String(DEFAULT_THRESHOLD_DB),
    )
    .option(
      "--min-silence-ms <n>",
      "Minimum silence duration in ms.",
      String(DEFAULT_MIN_SILENCE_MS),
    )
    .option(
      "--pre-attack-ms <n>, --pad-before-ms <n>",
      "Keep context before speech attack in ms (legacy alias: --pad-before-ms).",
      String(DEFAULT_PRE_ATTACK_MS),
    )
    .option(
      "--post-release-ms <n>, --pad-after-ms <n>",
      "Keep context after speech release in ms (legacy alias: --pad-after-ms).",
      String(DEFAULT_POST_RELEASE_MS),
    )
    .option(
      "--analysis-frame-ms <n>",
      "RMS window for loudness (ms). Larger = smoother, fewer false silences at word tails.",
      String(DEFAULT_ANALYSIS_FRAME_MS),
    )
    .option(
      "--min-keep-ms <n>",
      "Minimum kept non-silent segment length in ms; shorter islands are dropped.",
      String(DEFAULT_MIN_KEEP_MS),
    )
    .option(
      "--zero-crossing-ms <n>",
      "Snap cut boundaries to nearest zero-crossing within this radius (ms). Set 0 to disable.",
      String(DEFAULT_ZERO_CROSSING_MS),
    )
    .option(
      "--track-config <value>",
      "Repeatable per-track config: track[:thresholdDb[:minSilenceMs[:preAttackMs[:postReleaseMs[:minKeepMs]]]]].",
      collectString,
      [] as string[],
    )
    .option(
      "--dry-run",
      "Analyze and print summary only, without writing modified XML.",
    )
    .addOption(
      new Option(
        "--split-video-track <n>",
        "Optional 1-based video track index to split at audio cut points (keeps all video segments).",
      ).argParser((v) => Number.parseInt(v, 10)),
    );

  program.parse(process.argv);
  const raw = program.opts<{
    input: string;
    output: string;
    track?: number;
    thresholdDb: string;
    minSilenceMs: string;
    preAttackMs: string;
    postReleaseMs: string;
    analysisFrameMs: string;
    minKeepMs: string;
    zeroCrossingMs: string;
    trackConfig: string[];
    dryRun?: boolean;
    splitVideoTrack?: number;
  }>();

  let runConfigs: TrackRunConfig[];
  try {
    runConfigs = buildRunConfigs({
      trackConfig: raw.trackConfig,
      track: raw.track,
      thresholdDb: Number.parseFloat(raw.thresholdDb),
      minSilenceMs: Number.parseInt(raw.minSilenceMs, 10),
      preAttackMs: Number.parseInt(raw.preAttackMs, 10),
      postReleaseMs: Number.parseInt(raw.postReleaseMs, 10),
      analysisFrameMs: Number.parseInt(raw.analysisFrameMs, 10),
      minKeepMs: Number.parseInt(raw.minKeepMs, 10),
      zeroCrossingMs: Number.parseInt(raw.zeroCrossingMs, 10),
    });
  } catch (e) {
    console.error(`Error: ${e}`);
    return 1;
  }

  const args = {
    input: raw.input,
    output: raw.output,
    dryRun: Boolean(raw.dryRun),
  };

  if (!args.dryRun) {
    try {
      validateOutputPath(args.output);
    } catch (e) {
      if (e instanceof Error) {
        console.error(`Error: ${e.message}`);
      } else {
        console.error(`Error: ${e}`);
      }
      return 1;
    }
  }

  console.log(
    `Starting silence cut: input='${args.input}', output='${args.output}', dry_run=${args.dryRun}`,
  );
  console.log(`Track runs: ${runConfigs.length}`);
  if (raw.splitVideoTrack != null) {
    console.log(
      `Video split enabled: V${raw.splitVideoTrack} will be cut at the same positions as detected audio cuts (video is not removed).`,
    );
  }

  const log = (message: string) => {
    console.log(message);
  };

  const tempOutputs: string[] = [];
  let results: AnyProcessResult[] = [];

  try {
    const rootTag = detectXmlRootTag(args.input);
    console.log(`Detected XML type: ${rootTag}`);
    if (rootTag !== "xmeml" && rootTag !== "fcpxml") {
      console.error(
        `Error: Unsupported XML root '${rootTag}'. Expected xmeml or fcpxml.`,
      );
      return 1;
    }

    let currentInput = args.input;
    const pinnedLanes = new Map<number, string>();

    if (rootTag === "fcpxml" && runConfigs.length > 1) {
      const lanes = getFcpxmlTrackLanes(args.input);
      for (const cfg of runConfigs) {
        if (cfg.track < 1 || cfg.track > lanes.length) {
          throw new FcpXmlCutterError(
            `Track index ${cfg.track} out of range for initial fcpxml tracks 1..${lanes.length}`,
          );
        }
        pinnedLanes.set(cfg.track, lanes[cfg.track - 1]!);
      }
      console.log(
        "Pinned initial fcpxml lanes: " +
          [...pinnedLanes.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([track, lane]) => `A${track}=lane${lane}`)
            .join(", "),
      );
    }

    for (let idx = 0; idx < runConfigs.length; idx++) {
      const cfg = runConfigs[idx]!;
      const settings = toSilenceSettings(cfg);
      let currentOutput: string;
      if (args.dryRun) {
        currentOutput = args.output;
      } else if (idx === runConfigs.length - 1) {
        currentOutput = args.output;
      } else {
        currentOutput = join(
          tmpdir(),
          `resolve_silence_cut_${randomBytes(8).toString("hex")}.xml`,
        );
        tempOutputs.push(currentOutput);
      }

      console.log(
        `--- Track run ${idx + 1}/${runConfigs.length}: A${cfg.track}, ` +
          `threshold=${cfg.thresholdDb}, min=${cfg.minSilenceMs}, ` +
          `pre_attack=${cfg.preAttackMs}, post_release=${cfg.postReleaseMs}, ` +
          `analysis_frame=${cfg.analysisFrameMs}ms, min_keep=${cfg.minKeepMs}ms, ` +
          `zero_crossing=${cfg.zeroCrossingMs}ms ---`,
      );

      if (rootTag === "xmeml") {
        const result = await processXmemlFile(
          currentInput,
          currentOutput,
          cfg.track,
          settings,
          args.dryRun,
          null,
          log,
          raw.splitVideoTrack ?? null,
        );
        results.push(result);
      } else {
        const result = await processFcpxmlFile(
          currentInput,
          currentOutput,
          cfg.track,
          settings,
          args.dryRun,
          null,
          log,
          pinnedLanes.get(cfg.track) ?? null,
          raw.splitVideoTrack ?? null,
        );
        results.push(result);
      }

      if (!args.dryRun) {
        currentInput = currentOutput;
      }
    }
  } catch (e) {
    if (e instanceof XmlCutterError || e instanceof FcpXmlCutterError) {
      console.error(`Error: ${e.message}`);
      return 1;
    }
    console.error(`Error: ${e}`);
    return 1;
  } finally {
    for (const tempPath of tempOutputs) {
      try {
        unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
    }
  }

  const totalVisited = results.reduce((s, r) => s + r.clipResults.length, 0);
  const totalEdited = results.reduce(
    (s, r) => s + r.clipResults.filter((c) => c.removedFrames > 0).length,
    0,
  );
  const totalSkipped = results.reduce(
    (s, r) => s + r.clipResults.filter((c) => Boolean(c.skippedReason)).length,
    0,
  );
  const totalRemovedFrames = results.reduce(
    (s, r) => s + r.totalRemovedFrames,
    0,
  );

  console.log("=== XML Silence Cut Summary ===");
  console.log(`Track runs: ${results.length}`);
  console.log(`Clips visited: ${totalVisited}`);
  console.log(`Clips edited: ${totalEdited}`);
  console.log(`Clips skipped: ${totalSkipped}`);
  console.log(`Total removed frames: ${totalRemovedFrames}`);
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const edited = result.clipResults.filter((c) => c.removedFrames > 0).length;
    const skipped = result.clipResults.filter((c) =>
      Boolean(c.skippedReason),
    ).length;
    console.log(
      `  - Run ${i + 1}: track A${result.trackIndex}, visited=${result.clipResults.length}, ` +
        `edited=${edited}, skipped=${skipped}, removed_frames=${result.totalRemovedFrames}`,
    );
  }
  if (args.dryRun) {
    if (results.length > 1) {
      console.log(
        "Dry run: no XML file was written (multi-track dry-run is per-run preview).",
      );
    } else {
      console.log("Dry run: no XML file was written.");
    }
  } else {
    console.log(`Modified XML written: ${args.output}`);
  }
  return 0;
}

await run().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
