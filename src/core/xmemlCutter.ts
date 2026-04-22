import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  getIntChildText,
  listChildNodes,
  localTagName,
  parseXmlDocument,
  setIntChildText,
  writeXmlDocument,
  xpathElements,
} from "./xmlUtils.js";

export interface ClipEditResult {
  clipId: string;
  removedFrames: number;
  originalDurationFrames: number;
  createdSegments: number;
  skippedReason?: string | null;
}

export interface XmlProcessResult {
  trackIndex: number;
  clipResults: ClipEditResult[];
  totalRemovedFrames: number;
  totalSegmentsCreated: number;
}

export class XmlCutterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlCutterError";
  }
}

export function parsePosixPathurl(pathurl: string): string | null {
  if (!pathurl) return null;
  try {
    let normalized = pathurl.trim();
    if (normalized.startsWith("file://localhost")) {
      normalized = "file://" + normalized.slice("file://localhost".length);
    }
    const u = new URL(normalized);
    if (u.protocol !== "file:") return null;
    return fileURLToPath(u);
  } catch {
    return null;
  }
}

export function fpsFromSequence(sequenceNode: Element): number {
  const rate = findChildElement(sequenceNode, "rate");
  const timebaseNode = rate ? findChildElement(rate, "timebase") : null;
  const ntscNode = rate ? findChildElement(rate, "ntsc") : null;
  const tbText = timebaseNode?.textContent?.trim() ?? "";
  if (!timebaseNode || !tbText) return 24.0;
  const fps = Number.parseFloat(tbText);
  const ntsc =
    ntscNode?.textContent != null ? ntscNode.textContent.trim().toUpperCase() === "TRUE" : false;
  if (ntsc && Math.trunc(fps) === 30) return 29.97;
  if (ntsc && Math.trunc(fps) === 60) return 59.94;
  return fps;
}

function clipSourcePath(clipitem: Element, fileIdToPath: Map<string, string>): string | null {
  const fileNode = findChildElement(clipitem, "file");
  if (!fileNode) return null;

  const fileId = fileNode.getAttribute("id");
  if (fileId && fileIdToPath.has(fileId)) {
    return fileIdToPath.get(fileId)!;
  }

  const pathurlNode = findChildElement(fileNode, "pathurl");
  if (!pathurlNode || pathurlNode.textContent == null) return null;

  const path = parsePosixPathurl(pathurlNode.textContent.trim());
  if (path && fileId) {
    fileIdToPath.set(fileId, path);
  }
  return path;
}

function collectFilePathMap(root: Element): Map<string, string> {
  const pathMap = new Map<string, string>();
  for (const fileNode of xpathElements(".//*[local-name()='file']", root)) {
    const fileId = fileNode.getAttribute("id");
    if (!fileId) continue;
    const pathurlNode = findChildElement(fileNode, "pathurl");
    if (!pathurlNode || pathurlNode.textContent == null) continue;
    const path = parsePosixPathurl(pathurlNode.textContent.trim());
    if (path) pathMap.set(fileId, path);
  }
  return pathMap;
}

function secondsToFrameRanges(
  rangesSeconds: { start: number; end: number }[],
  fps: number,
  clipDurationFrames: number,
): FrameRange[] {
  const ranges: FrameRange[] = [];
  for (const rng of rangesSeconds) {
    const start = Math.max(0, Math.min(clipDurationFrames, Math.round(rng.start * fps)));
    const end = Math.max(start, Math.min(clipDurationFrames, Math.round(rng.end * fps)));
    if (end > start) ranges.push(new FrameRange(start, end));
  }
  return mergeFrameRanges(ranges);
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
  const keepRanges = secondsToFrameRanges(filteredKeepSeconds, fps, clipDurationFrames);
  const removeRanges = secondsToFrameRanges(removeSeconds, fps, clipDurationFrames);
  return [keepRanges, removeRanges];
}

export type KeepRangesAnalyzer = (
  sourcePath: string,
  sourceInFrame: number,
  sourceOutFrame: number,
  fps: number,
  settings: SilenceSettings,
) => Promise<[FrameRange[], FrameRange[]]>;

export function splitClipitemByKeepRanges(
  clipitem: Element,
  keepRanges: FrameRange[],
  clipIdx: number,
): Element[] {
  const start = getIntChildText(clipitem, "start");
  const end = getIntChildText(clipitem, "end");
  const inFrame = getIntChildText(clipitem, "in");
  if (start === null || end === null || inFrame === null) {
    return [clipitem];
  }

  const clipId = clipitem.getAttribute("id") ?? `clipitem_${clipIdx}`;
  const newNodes: Element[] = [];
  let segIdx = 0;
  for (const keep of keepRanges) {
    segIdx += 1;
    if (keep.end <= keep.start) continue;
    const segment = clipitem.cloneNode(true) as Element;
    segment.setAttribute("id", `${clipId}_sc${segIdx}`);
    const newStart = start + keep.start;
    const newEnd = start + keep.end;
    const newIn = inFrame + keep.start;
    const newOut = inFrame + keep.end;
    setIntChildText(segment, "start", newStart);
    setIntChildText(segment, "end", newEnd);
    setIntChildText(segment, "in", newIn);
    setIntChildText(segment, "out", newOut);
    setIntChildText(segment, "duration", newEnd - newStart);
    newNodes.push(segment);
  }
  return newNodes;
}

export async function processXmemlFile(
  inputPath: string,
  outputPath: string,
  targetTrackIndex: number,
  settings: SilenceSettings,
  dryRun: boolean,
  analyzer: KeepRangesAnalyzer | null = null,
  log: ((message: string) => void) | null = null,
): Promise<XmlProcessResult> {
  const emit = (message: string) => {
    if (log) log(message);
  };

  if (!existsSync(inputPath)) {
    throw new XmlCutterError(`Input XML does not exist: ${inputPath}`);
  }

  const doc = parseXmlDocument(inputPath);
  const root = doc.documentElement!;
  if (localTagName(root) !== "xmeml") {
    throw new XmlCutterError("Only FCP7 XML (xmeml) is currently supported.");
  }

  const sequence = findChildElement(root, "sequence");
  if (!sequence) {
    throw new XmlCutterError("Could not find <sequence> in xmeml.");
  }
  const fps = fpsFromSequence(sequence);

  const media = findChildElement(sequence, "media");
  const audio = media ? findChildElement(media, "audio") : null;
  if (!audio) {
    throw new XmlCutterError("No audio tracks found in XML sequence.");
  }
  const tracks: Element[] = [];
  for (const c of listChildNodes(audio)) {
    if (c.nodeType === 1 && localTagName(c as Element) === "track") {
      tracks.push(c as Element);
    }
  }
  if (tracks.length === 0) {
    throw new XmlCutterError("No audio tracks found in XML sequence.");
  }
  if (targetTrackIndex < 1 || targetTrackIndex > tracks.length) {
    throw new XmlCutterError(
      `Track index ${targetTrackIndex} out of range. Audio tracks: 1..${tracks.length}`,
    );
  }

  const targetTrack = tracks[targetTrackIndex - 1]!;
  const filePathMap = collectFilePathMap(root);
  const analyzerFn = analyzer ?? analyzeKeepRanges;

  const clipNodes = listChildNodes(targetTrack).filter(
    (n) => n.nodeType === 1 && localTagName(n as Element) === "clipitem",
  ) as Element[];

  emit(`[xmeml] Processing track A${targetTrackIndex}: ${clipNodes.length} clipitems detected.`);

  const clipResults: ClipEditResult[] = [];
  let totalRemovedFrames = 0;
  let totalSegmentsCreated = 0;

  const newChildren: Element[] = [];
  let clipCounter = 0;

  for (const child of listChildNodes(targetTrack)) {
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (localTagName(el) !== "clipitem") {
      newChildren.push(el);
      continue;
    }

    clipCounter += 1;
    const clipId = el.getAttribute("id") ?? `clipitem_${clipCounter}`;
    emit(`[xmeml] [${clipCounter}/${clipNodes.length}] Analyzing clip '${clipId}'...`);

    const start = getIntChildText(el, "start");
    const end = getIntChildText(el, "end");
    const inFrame = getIntChildText(el, "in");
    const outFrame = getIntChildText(el, "out");

    if (start === null || end === null || inFrame === null || outFrame === null) {
      clipResults.push({
        clipId,
        removedFrames: 0,
        originalDurationFrames: 0,
        createdSegments: 1,
        skippedReason: "Missing start/end/in/out fields.",
      });
      emit(`[xmeml]   Skipped '${clipId}': missing timing fields.`);
      newChildren.push(el);
      continue;
    }

    const sourcePath = clipSourcePath(el, filePathMap);
    if (!sourcePath || !existsSync(sourcePath)) {
      clipResults.push({
        clipId,
        removedFrames: 0,
        originalDurationFrames: end - start,
        createdSegments: 1,
        skippedReason: "Missing or unreadable source media path.",
      });
      emit(`[xmeml]   Skipped '${clipId}': source media path unavailable.`);
      newChildren.push(el);
      continue;
    }

    let keepRanges: FrameRange[];
    let removeRanges: FrameRange[];
    try {
      [keepRanges, removeRanges] = await analyzerFn(sourcePath, inFrame, outFrame, fps, settings);
    } catch (exc) {
      clipResults.push({
        clipId,
        removedFrames: 0,
        originalDurationFrames: end - start,
        createdSegments: 1,
        skippedReason: `Analysis failed: ${exc}`,
      });
      emit(`[xmeml]   Skipped '${clipId}': analysis failed (${exc}).`);
      newChildren.push(el);
      continue;
    }

    const removedFrames = removeRanges.reduce((s, r) => s + r.duration, 0);
    const originalDuration = Math.max(0, end - start);
    if (removedFrames <= 0) {
      clipResults.push({
        clipId,
        removedFrames: 0,
        originalDurationFrames: originalDuration,
        createdSegments: 1,
      });
      emit(`[xmeml]   No silence cut for '${clipId}'.`);
      newChildren.push(el);
      continue;
    }

    const splitNodes = splitClipitemByKeepRanges(el, keepRanges, clipCounter);
    totalSegmentsCreated += splitNodes.length;
    totalRemovedFrames += removedFrames;
    clipResults.push({
      clipId,
      removedFrames: removedFrames,
      originalDurationFrames: originalDuration,
      createdSegments: splitNodes.length,
    });
    emit(
      `[xmeml]   Cut '${clipId}': removed ${removedFrames} frames, created ${splitNodes.length} segments.`,
    );
    newChildren.push(...splitNodes);
  }

  if (!dryRun) {
    emit("[xmeml] Writing modified XML...");
    while (targetTrack.firstChild) {
      targetTrack.removeChild(targetTrack.firstChild);
    }
    for (const ch of newChildren) {
      targetTrack.appendChild(ch);
    }
    writeXmlDocument(doc, outputPath);
    emit(`[xmeml] Wrote output: ${outputPath}`);
  } else {
    emit("[xmeml] Dry run enabled; no file written.");
  }

  return {
    trackIndex: targetTrackIndex,
    clipResults,
    totalRemovedFrames,
    totalSegmentsCreated,
  };
}
