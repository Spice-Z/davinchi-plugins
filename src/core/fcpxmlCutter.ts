import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fraction from "fraction.js";
import type { SilenceSettings } from "./config.js";
import { extractClipSliceToWav } from "./audioExtract.js";
import {
  applyAttackReleaseToSilenceRanges,
  detectSilenceRanges,
  invertRanges,
  pruneShortKeepRanges,
  snapRangesToZeroCrossings,
  readWavPcm,
} from "./silence.js";
import { FrameRange } from "./models.js";
import {
  findChildElement,
  listChildNodes,
  localTagName,
  parseXmlDocument,
  writeXmlDocument,
  xpathElements,
} from "./xmlUtils.js";

export interface FcpClipEditResult {
  clipName: string;
  removedFrames: number;
  createdSegments: number;
  skippedReason?: string | null;
}

export interface FcpXmlProcessResult {
  trackIndex: number;
  clipResults: FcpClipEditResult[];
  totalRemovedFrames: number;
  totalSegmentsCreated: number;
}

export class FcpXmlCutterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FcpXmlCutterError";
  }
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/** Match Python Fraction.limit_denominator(max_denominator). */
function limitDenominatorInts(n0: number, d0: number, maxDen: number): { n: number; d: number } {
  if (maxDen < 1) throw new Error("max_denominator must be >= 1");
  if (d0 === 0) throw new Error("denominator must not be 0");

  let n = n0;
  let d = d0;
  const neg = n < 0 !== d < 0;
  n = Math.abs(n);
  d = Math.abs(d);

  if (d <= maxDen) {
    const g = gcd(n, d);
    return { n: (neg ? -1 : 1) * (n / g), d: d / g };
  }

  let p0 = 0,
    q0 = 1,
    p1 = 1,
    q1 = 0;
  let nn = n;
  let dd = d;

  while (true) {
    const a = Math.floor(nn / dd);
    const p2 = p0 + a * p1;
    const q2 = q0 + a * q1;
    if (q2 > maxDen) break;
    p0 = p1;
    q0 = q1;
    p1 = p2;
    q1 = q2;
    const r = nn % dd;
    if (r === 0) break;
    nn = dd;
    dd = r;
  }

  const k = Math.floor((maxDen - q0) / q1);
  const n1 = p0 + k * p1;
  const d1 = q0 + k * q1;
  const n2 = p1;
  const d2 = q1;

  const x = n / d;
  const err1 = Math.abs(x - n1 / d1);
  const err2 = Math.abs(x - n2 / d2);
  const bestN = err1 <= err2 ? n1 : n2;
  const bestD = err1 <= err2 ? d1 : d2;
  const g = gcd(Math.abs(bestN), bestD);
  return { n: (neg ? -1 : 1) * (bestN / g), d: bestD / g };
}

export function parseFcpxTime(value: string): Fraction {
  const text = (value || "").trim();
  if (!text.endsWith("s")) {
    throw new Error(`Invalid FCPXML time: ${value}`);
  }
  const raw = text.slice(0, -1);
  if (raw.includes("/")) {
    const [numerator, denominator] = raw.split("/", 2);
    return new Fraction(Number.parseInt(numerator!, 10), Number.parseInt(denominator!, 10));
  }
  return new Fraction(raw);
}

export function formatFcpxTime(value: Fraction): string {
  const lim = limitDenominatorInts(value.n, value.d, 48000);
  return `${lim.n}/${lim.d}s`;
}

export function parseAssetSrcToPath(src: string): string | null {
  try {
    const u = new URL(src);
    if (u.protocol !== "file:") return null;
    return fileURLToPath(u);
  } catch {
    return null;
  }
}

function sequenceFps(sequenceNode: Element): number {
  const tcFormat = (sequenceNode.getAttribute("tcFormat") ?? "").toLowerCase();
  if (tcFormat === "ndf") {
    return 30.0;
  }
  const frameDuration = sequenceNode.getAttribute("frameDuration");
  if (frameDuration) {
    const sec = parseFcpxTime(frameDuration);
    if (sec.compare(0) > 0) {
      return new Fraction(1).div(sec).valueOf();
    }
  }
  return 24.0;
}

function frameRangesFromSeconds(
  rangesSeconds: { start: number; end: number }[],
  fps: number,
  clipDurationFrames: number,
): FrameRange[] {
  const out: FrameRange[] = [];
  for (const rng of rangesSeconds) {
    const start = Math.max(0, Math.min(clipDurationFrames, Math.round(rng.start * fps)));
    const end = Math.max(start, Math.min(clipDurationFrames, Math.round(rng.end * fps)));
    if (end > start) out.push(new FrameRange(start, end));
  }
  return mergeFrameRanges(out);
}

function mergeFrameRanges(ranges: FrameRange[]): FrameRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: FrameRange[] = [sorted[0]!];
  for (const current of sorted.slice(1)) {
    const prev = merged[merged.length - 1]!;
    if (current.start <= prev.end) {
      merged[merged.length - 1] = new FrameRange(prev.start, Math.max(prev.end, current.end));
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function collectAssetPaths(root: Element): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const asset of xpathElements(".//*[local-name()='resources']/*[local-name()='asset']", root)) {
    const assetId = asset.getAttribute("id");
    const src = asset.getAttribute("src") ?? "";
    if (!assetId || !src) continue;
    const path = parseAssetSrcToPath(src);
    if (path) mapping.set(assetId, path);
  }
  return mapping;
}

function laneToTrackOrder(laneValue: string | null | undefined): [number, number] {
  if (laneValue == null || laneValue.trim() === "") return [0, 0];
  const lane = Number.parseInt(laneValue, 10);
  if (lane === 0) return [0, 0];
  if (lane < 0) return [1, Math.abs(lane)];
  return [2, lane];
}

function compareLaneStrings(a: string, b: string): number {
  const oa = laneToTrackOrder(a);
  const ob = laneToTrackOrder(b);
  if (oa[0] !== ob[0]) return oa[0] - ob[0];
  return oa[1] - ob[1];
}

function collectAudioTrackLanes(spine: Element): string[] {
  const laneValues = new Set<string>();
  for (const clip of xpathElements(".//*[local-name()='asset-clip']", spine)) {
    if (clip.getAttribute("ref") && clip.getAttribute("audioRole") != null) {
      laneValues.add(clip.getAttribute("lane") ?? "0");
    }
  }
  return [...laneValues].sort(compareLaneStrings);
}

async function analyzeKeepRanges(
  sourcePath: string,
  sourceInFrame: number,
  sourceOutFrame: number,
  fps: number,
  settings: SilenceSettings,
): Promise<[FrameRange[], FrameRange[]]> {
  const extracted = await extractClipSliceToWav(sourcePath, sourceInFrame, sourceOutFrame, fps);
  const { sampleRate, sampleWidth, raw } = readWavPcm(extracted.wavPath);
  const silenceRanges = detectSilenceRanges(sampleRate, sampleWidth, raw, settings);
  const adjustedSilence = applyAttackReleaseToSilenceRanges(
    silenceRanges,
    extracted.durationSeconds,
    settings.preAttackMs,
    settings.postReleaseMs,
  );
  const keepSeconds = snapRangesToZeroCrossings(
    pruneShortKeepRanges(
      invertRanges(adjustedSilence, extracted.durationSeconds),
      settings.minKeepDurationMs,
    ),
    raw,
    sampleRate,
    sampleWidth,
    settings.zeroCrossingSearchMs,
  );
  const filteredKeepSeconds = pruneShortKeepRanges(
    keepSeconds,
    settings.minKeepDurationMs,
  );
  const removeSeconds = invertRanges(filteredKeepSeconds, extracted.durationSeconds);
  const clipDurationFrames = Math.max(0, sourceOutFrame - sourceInFrame);
  const keepRanges = frameRangesFromSeconds(filteredKeepSeconds, fps, clipDurationFrames);
  const removeRanges = frameRangesFromSeconds(removeSeconds, fps, clipDurationFrames);
  return [keepRanges, removeRanges];
}

export type FcpKeepRangesAnalyzer = (
  sourcePath: string,
  sourceInFrame: number,
  sourceOutFrame: number,
  fps: number,
  settings: SilenceSettings,
) => Promise<[FrameRange[], FrameRange[]]>;

function splitAssetClip(clip: Element, keepRanges: FrameRange[], fps: number): Element[] {
  const offset = parseFcpxTime(clip.getAttribute("offset") ?? "0s");
  const start = parseFcpxTime(clip.getAttribute("start") ?? "0s");
  const duration = parseFcpxTime(clip.getAttribute("duration") ?? "0s");
  if (duration.compare(0) <= 0) {
    return [clip];
  }

  const frameSec = new Fraction(1).div(new Fraction(String(fps)));
  const out: Element[] = [];
  let idx = 0;
  for (const keep of keepRanges) {
    idx += 1;
    if (keep.end <= keep.start) continue;
    const segment = clip.cloneNode(true) as Element;
    const name = clip.getAttribute("name") ?? "clip";
    segment.setAttribute("name", `${name}_sc${idx}`);

    const segOffset = offset.add(frameSec.mul(keep.start));
    const segStart = start.add(frameSec.mul(keep.start));
    const segDuration = frameSec.mul(keep.end - keep.start);

    segment.setAttribute("offset", formatFcpxTime(segOffset));
    segment.setAttribute("start", formatFcpxTime(segStart));
    segment.setAttribute("duration", formatFcpxTime(segDuration));
    out.push(segment);
  }
  return out;
}

export async function processFcpxmlFile(
  inputPath: string,
  outputPath: string,
  targetTrackIndex: number,
  settings: SilenceSettings,
  dryRun: boolean,
  analyzer: FcpKeepRangesAnalyzer | null = null,
  log: ((message: string) => void) | null = null,
  targetLane: string | null = null,
): Promise<FcpXmlProcessResult> {
  const emit = (message: string) => {
    if (log) log(message);
  };

  if (!existsSync(inputPath)) {
    throw new FcpXmlCutterError(`Input XML does not exist: ${inputPath}`);
  }

  const doc = parseXmlDocument(inputPath);
  const root = doc.documentElement!;
  if (localTagName(root) !== "fcpxml") {
    throw new FcpXmlCutterError("Root is not fcpxml.");
  }

  const sequences = xpathElements(".//*[local-name()='sequence']", root);
  const sequence = sequences[0];
  if (!sequence) {
    throw new FcpXmlCutterError("Could not find <sequence> in fcpxml.");
  }
  const spine = findChildElement(sequence, "spine");
  if (!spine) {
    throw new FcpXmlCutterError("Could not find <spine> in fcpxml sequence.");
  }

  const fps = sequenceFps(sequence);
  const frameSec = new Fraction(1).div(new Fraction(String(fps)));
  const assetPaths = collectAssetPaths(root);
  const analyzerFn = analyzer ?? analyzeKeepRanges;

  const lanes = collectAudioTrackLanes(spine);
  if (lanes.length === 0) {
    throw new FcpXmlCutterError("No audio asset-clip tracks found in fcpxml.");
  }

  let resolvedLane = targetLane;
  if (resolvedLane == null) {
    if (targetTrackIndex < 1 || targetTrackIndex > lanes.length) {
      throw new FcpXmlCutterError(
        `Track index ${targetTrackIndex} out of range. Audio tracks: 1..${lanes.length}`,
      );
    }
    resolvedLane = lanes[targetTrackIndex - 1]!;
  } else if (!lanes.includes(resolvedLane)) {
    throw new FcpXmlCutterError(
      `Target lane '${resolvedLane}' not found in current fcpxml track lanes: ${lanes.join(", ")}`,
    );
  }

  const targetTrackClips = listChildNodes(spine).filter((n) => {
    if (n.nodeType !== 1) return false;
    const el = n as Element;
    return (
      localTagName(el) === "asset-clip" &&
      el.getAttribute("audioRole") != null &&
      (el.getAttribute("lane") ?? "0") === resolvedLane
    );
  }) as Element[];

  emit(
    `[fcpxml] Processing track A${targetTrackIndex} (lane ${resolvedLane}): ${targetTrackClips.length} clips detected.`,
  );

  const clipResults: FcpClipEditResult[] = [];
  let totalRemovedFrames = 0;
  let totalSegmentsCreated = 0;
  const newChildren: Element[] = [];
  let processedIndex = 0;

  for (const child of listChildNodes(spine)) {
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (localTagName(el) !== "asset-clip") {
      newChildren.push(el);
      continue;
    }
    if (el.getAttribute("audioRole") == null) {
      newChildren.push(el);
      continue;
    }
    const lane = el.getAttribute("lane") ?? "0";
    if (lane !== resolvedLane) {
      newChildren.push(el);
      continue;
    }

    const name = el.getAttribute("name") ?? "asset-clip";
    processedIndex += 1;
    emit(`[fcpxml] [${processedIndex}/${targetTrackClips.length}] Analyzing clip '${name}'...`);

    const ref = el.getAttribute("ref");
    if (!ref || !assetPaths.has(ref)) {
      clipResults.push({
        clipName: name,
        removedFrames: 0,
        createdSegments: 1,
        skippedReason: "Missing asset ref/path.",
      });
      emit(`[fcpxml]   Skipped '${name}': missing asset ref/path.`);
      newChildren.push(el);
      continue;
    }

    const sourcePath = assetPaths.get(ref)!;
    if (!existsSync(sourcePath)) {
      clipResults.push({
        clipName: name,
        removedFrames: 0,
        createdSegments: 1,
        skippedReason: "Source media path not found.",
      });
      emit(`[fcpxml]   Skipped '${name}': source media path not found.`);
      newChildren.push(el);
      continue;
    }

    const start = parseFcpxTime(el.getAttribute("start") ?? "0s");
    const duration = parseFcpxTime(el.getAttribute("duration") ?? "0s");
    if (duration.compare(0) <= 0) {
      emit(`[fcpxml]   Skipped '${name}': zero/negative duration.`);
      newChildren.push(el);
      continue;
    }

    const sourceInFrame = Math.round(Number(start.div(frameSec)));
    const sourceOutFrame = Math.round(Number(start.add(duration).div(frameSec)));

    let keepRanges: FrameRange[];
    let removeRanges: FrameRange[];
    try {
      [keepRanges, removeRanges] = await analyzerFn(
        sourcePath,
        sourceInFrame,
        sourceOutFrame,
        fps,
        settings,
      );
    } catch (exc) {
      clipResults.push({
        clipName: name,
        removedFrames: 0,
        createdSegments: 1,
        skippedReason: `Analysis failed: ${exc}`,
      });
      emit(`[fcpxml]   Skipped '${name}': analysis failed (${exc}).`);
      newChildren.push(el);
      continue;
    }

    const removedFrames = removeRanges.reduce((s, r) => s + r.duration, 0);
    if (removedFrames <= 0) {
      clipResults.push({
        clipName: name,
        removedFrames: 0,
        createdSegments: 1,
      });
      emit(`[fcpxml]   No silence cut for '${name}'.`);
      newChildren.push(el);
      continue;
    }

    const segments = splitAssetClip(el, keepRanges, fps);
    totalSegmentsCreated += segments.length;
    totalRemovedFrames += removedFrames;
    clipResults.push({
      clipName: name,
      removedFrames,
      createdSegments: segments.length,
    });
    emit(`[fcpxml]   Cut '${name}': removed ${removedFrames} frames, created ${segments.length} segments.`);
    newChildren.push(...segments);
  }

  if (!dryRun) {
    emit("[fcpxml] Writing modified XML...");
    while (spine.firstChild) {
      spine.removeChild(spine.firstChild);
    }
    for (const ch of newChildren) {
      spine.appendChild(ch);
    }
    writeXmlDocument(doc, outputPath);
    emit(`[fcpxml] Wrote output: ${outputPath}`);
  } else {
    emit("[fcpxml] Dry run enabled; no file written.");
  }

  return {
    trackIndex: targetTrackIndex,
    clipResults,
    totalRemovedFrames,
    totalSegmentsCreated,
  };
}

export function getFcpxmlTrackLanes(inputPath: string): string[] {
  if (!existsSync(inputPath)) {
    throw new FcpXmlCutterError(`Input XML does not exist: ${inputPath}`);
  }
  const doc = parseXmlDocument(inputPath);
  const root = doc.documentElement!;
  if (localTagName(root) !== "fcpxml") {
    throw new FcpXmlCutterError("Root is not fcpxml.");
  }
  const sequences = xpathElements(".//*[local-name()='sequence']", root);
  const sequence = sequences[0];
  if (!sequence) {
    throw new FcpXmlCutterError("Could not find <sequence> in fcpxml.");
  }
  const spine = findChildElement(sequence, "spine");
  if (!spine) {
    throw new FcpXmlCutterError("Could not find <spine> in fcpxml sequence.");
  }
  const lanes = collectAudioTrackLanes(spine);
  if (lanes.length === 0) {
    throw new FcpXmlCutterError("No audio asset-clip tracks found in fcpxml.");
  }
  return lanes;
}
