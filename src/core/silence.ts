import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { SilenceSettings } from "./config.js";
import { timeRangeSeconds, type TimeRangeSeconds, timeRangeDuration } from "./models.js";

const require = createRequire(import.meta.url);
const { decode } = require("node-wav") as {
  decode: (buffer: Buffer) => { sampleRate: number; channelData: Float32Array[] };
};

/** Decode WAV to mono int16 PCM (matches Python wave + to_mono for silence analysis). */
export function readWavPcm(path: string): { sampleRate: number; sampleWidth: number; raw: Buffer } {
  const buf = readFileSync(path);
  const decoded = decode(buf);
  const channels = decoded.channelData.length;
  const n = decoded.channelData[0]?.length ?? 0;
  const raw = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) {
      s += decoded.channelData[c][i]!;
    }
    s /= channels;
    const int16 = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    raw.writeInt16LE(int16, i * 2);
  }
  return { sampleRate: decoded.sampleRate, sampleWidth: 2, raw };
}

export function rmsToDb(rmsValue: number): number {
  if (rmsValue <= 0) return -120.0;
  const max16Bit = 32768.0;
  const normalized = Math.min(1.0, rmsValue / max16Bit);
  return 20.0 * Math.log10(Math.max(normalized, 1e-9));
}

export function detectSilenceRanges(
  sampleRate: number,
  sampleWidth: number,
  rawPcm: Buffer,
  settings: SilenceSettings,
): TimeRangeSeconds[] {
  const frameSamples = Math.max(1, Math.floor((sampleRate * settings.analysisFrameMs) / 1000.0));
  const frameBytes = frameSamples * sampleWidth;
  const minSilenceSeconds = settings.minSilenceDurationMs / 1000.0;

  const frameLoudnessDb: number[] = [];
  for (let idx = 0; idx < rawPcm.length; idx += frameBytes) {
    const chunk = rawPcm.subarray(idx, idx + frameBytes);
    if (chunk.length === 0) continue;
    const rmsVal = rmsChunk(chunk, sampleWidth);
    frameLoudnessDb.push(rmsToDb(rmsVal));
  }

  const silentRanges: TimeRangeSeconds[] = [];
  let currentStart: number | null = null;
  const frameMs = settings.analysisFrameMs;

  for (let frameIndex = 0; frameIndex < frameLoudnessDb.length; frameIndex++) {
    const loudnessDb = frameLoudnessDb[frameIndex]!;
    const isSilent = loudnessDb <= settings.silenceThresholdDb;
    if (isSilent && currentStart === null) {
      currentStart = frameIndex;
    }
    if (!isSilent && currentStart !== null) {
      const startSec = (currentStart * frameMs) / 1000.0;
      const endSec = (frameIndex * frameMs) / 1000.0;
      if (endSec - startSec >= minSilenceSeconds) {
        silentRanges.push(timeRangeSeconds(startSec, endSec));
      }
      currentStart = null;
    }
  }

  if (currentStart !== null) {
    const startSec = (currentStart * frameMs) / 1000.0;
    const endSec = (frameLoudnessDb.length * frameMs) / 1000.0;
    if (endSec - startSec >= minSilenceSeconds) {
      silentRanges.push(timeRangeSeconds(startSec, endSec));
    }
  }

  return mergeRanges(silentRanges);
}

export function mergeRanges(ranges: TimeRangeSeconds[]): TimeRangeSeconds[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: TimeRangeSeconds[] = [sorted[0]!];
  for (const rng of sorted.slice(1)) {
    const prev = merged[merged.length - 1]!;
    if (rng.start <= prev.end) {
      merged[merged.length - 1] = timeRangeSeconds(prev.start, Math.max(prev.end, rng.end));
    } else {
      merged.push(rng);
    }
  }
  return merged;
}

export function applyAttackReleaseToSilenceRanges(
  ranges: TimeRangeSeconds[],
  clipDurationSeconds: number,
  preAttackMs: number,
  postReleaseMs: number,
): TimeRangeSeconds[] {
  const preAttack = Math.max(0.0, preAttackMs / 1000.0);
  const postRelease = Math.max(0.0, postReleaseMs / 1000.0);
  const adjusted = ranges
    .map((rng) =>
      timeRangeSeconds(
        Math.max(0.0, rng.start + postRelease),
        Math.min(clipDurationSeconds, rng.end - preAttack),
      ),
    )
    .filter((rng) => timeRangeDuration(rng) > 0.0);
  return mergeRanges(adjusted);
}

/**
 * @deprecated Use applyAttackReleaseToSilenceRanges. Kept for compatibility.
 */
export function expandWithPadding(
  ranges: TimeRangeSeconds[],
  clipDurationSeconds: number,
  preAttackMs: number,
  postReleaseMs: number,
): TimeRangeSeconds[] {
  return applyAttackReleaseToSilenceRanges(
    ranges,
    clipDurationSeconds,
    preAttackMs,
    postReleaseMs,
  );
}

export function invertRanges(removeRanges: TimeRangeSeconds[], totalDurationSeconds: number): TimeRangeSeconds[] {
  if (totalDurationSeconds <= 0) return [];
  if (removeRanges.length === 0) {
    return [timeRangeSeconds(0.0, totalDurationSeconds)];
  }

  const keeps: TimeRangeSeconds[] = [];
  let cursor = 0.0;
  for (const rng of removeRanges) {
    if (rng.start > cursor) {
      keeps.push(timeRangeSeconds(cursor, Math.min(rng.start, totalDurationSeconds)));
    }
    cursor = Math.max(cursor, rng.end);
  }

  if (cursor < totalDurationSeconds) {
    keeps.push(timeRangeSeconds(cursor, totalDurationSeconds));
  }

  return keeps.filter((k) => timeRangeDuration(k) > 0.0);
}

export function pruneShortKeepRanges(
  keepRanges: TimeRangeSeconds[],
  minKeepDurationMs: number,
): TimeRangeSeconds[] {
  const minKeepSeconds = Math.max(0, minKeepDurationMs) / 1000.0;
  if (minKeepSeconds <= 0 || keepRanges.length === 0) {
    return keepRanges;
  }

  const filtered = keepRanges.filter((rng) => timeRangeDuration(rng) >= minKeepSeconds);
  if (filtered.length > 0) {
    return filtered;
  }

  // Safety valve: avoid deleting a clip entirely when all keeps are short.
  let longest = keepRanges[0]!;
  for (const rng of keepRanges.slice(1)) {
    if (timeRangeDuration(rng) > timeRangeDuration(longest)) {
      longest = rng;
    }
  }
  return [longest];
}

function sampleCount(rawPcm: Buffer, sampleWidth: number): number {
  if (sampleWidth <= 0) return 0;
  return Math.floor(rawPcm.length / sampleWidth);
}

function readSampleAt(rawPcm: Buffer, sampleWidth: number, index: number): number {
  if (sampleWidth === 1) {
    return rawPcm[index]! - 128;
  }
  if (sampleWidth === 2) {
    return rawPcm.readInt16LE(index * 2);
  }
  if (sampleWidth === 3) {
    const offset = index * 3;
    let v = rawPcm[offset]! | (rawPcm[offset + 1]! << 8) | (rawPcm[offset + 2]! << 16);
    if (v & 0x800000) v |= ~0xffffff;
    return v;
  }
  if (sampleWidth === 4) {
    return rawPcm.readInt32LE(index * 4);
  }
  throw new Error(`Unsupported sample width: ${sampleWidth}`);
}

function hasZeroCrossing(rawPcm: Buffer, sampleWidth: number, index: number): boolean {
  if (index <= 0) return false;
  const prev = readSampleAt(rawPcm, sampleWidth, index - 1);
  const curr = readSampleAt(rawPcm, sampleWidth, index);
  if (prev === 0 || curr === 0) return true;
  return (prev < 0 && curr > 0) || (prev > 0 && curr < 0);
}

function nearestZeroCrossingIndex(
  rawPcm: Buffer,
  sampleWidth: number,
  targetIndex: number,
  searchSamples: number,
  totalSamples: number,
): number {
  if (totalSamples < 2 || targetIndex <= 0 || targetIndex >= totalSamples) {
    return targetIndex;
  }
  const clampedTarget = Math.max(1, Math.min(totalSamples - 1, targetIndex));
  const lo = Math.max(1, clampedTarget - searchSamples);
  const hi = Math.min(totalSamples - 1, clampedTarget + searchSamples);

  let bestCrossingIndex = -1;
  let bestCrossingDistance = Number.POSITIVE_INFINITY;
  let bestNearZeroIndex = clampedTarget;
  let bestNearZeroAmplitude = Number.POSITIVE_INFINITY;

  for (let idx = lo; idx <= hi; idx++) {
    const distance = Math.abs(idx - clampedTarget);
    const amplitude = Math.abs(readSampleAt(rawPcm, sampleWidth, idx));
    if (
      amplitude < bestNearZeroAmplitude ||
      (amplitude === bestNearZeroAmplitude &&
        distance < Math.abs(bestNearZeroIndex - clampedTarget))
    ) {
      bestNearZeroAmplitude = amplitude;
      bestNearZeroIndex = idx;
    }
    if (hasZeroCrossing(rawPcm, sampleWidth, idx) && distance < bestCrossingDistance) {
      bestCrossingDistance = distance;
      bestCrossingIndex = idx;
    }
  }

  return bestCrossingIndex >= 0 ? bestCrossingIndex : bestNearZeroIndex;
}

export function snapRangesToZeroCrossings(
  keepRanges: TimeRangeSeconds[],
  rawPcm: Buffer,
  sampleRate: number,
  sampleWidth: number,
  zeroCrossingSearchMs: number,
): TimeRangeSeconds[] {
  const totalSamples = sampleCount(rawPcm, sampleWidth);
  if (
    keepRanges.length === 0 ||
    sampleRate <= 0 ||
    totalSamples < 2 ||
    zeroCrossingSearchMs <= 0
  ) {
    return keepRanges;
  }
  const searchSamples = Math.max(
    1,
    Math.floor((Math.max(0, zeroCrossingSearchMs) * sampleRate) / 1000.0),
  );
  const clipDurationSeconds = totalSamples / sampleRate;

  const adjusted = keepRanges
    .map((rng) => {
      const startIdx = Math.max(0, Math.min(totalSamples, Math.round(rng.start * sampleRate)));
      const endIdx = Math.max(0, Math.min(totalSamples, Math.round(rng.end * sampleRate)));
      if (endIdx <= startIdx) {
        return null;
      }
      const snappedStartIdx =
        startIdx === 0
          ? 0
          : nearestZeroCrossingIndex(
              rawPcm,
              sampleWidth,
              startIdx,
              searchSamples,
              totalSamples,
            );
      const snappedEndIdx =
        endIdx === totalSamples
          ? totalSamples
          : nearestZeroCrossingIndex(
              rawPcm,
              sampleWidth,
              endIdx,
              searchSamples,
              totalSamples,
            );
      const adjustedStart = Math.max(0, Math.min(clipDurationSeconds, snappedStartIdx / sampleRate));
      const adjustedEnd = Math.max(0, Math.min(clipDurationSeconds, snappedEndIdx / sampleRate));
      if (adjustedEnd <= adjustedStart) {
        return null;
      }
      return timeRangeSeconds(adjustedStart, adjustedEnd);
    })
    .filter((rng): rng is TimeRangeSeconds => rng !== null);

  return mergeRanges(adjusted).filter((rng) => timeRangeDuration(rng) > 0.0);
}

export function rmsChunk(chunk: Buffer, sampleWidth: number): number {
  const samples = decodeSamples(chunk, sampleWidth);
  if (samples.length === 0) return 0.0;
  let power = 0;
  for (const sample of samples) {
    power += sample * sample;
  }
  power /= samples.length;
  return Math.sqrt(power);
}

export function decodeSamples(rawPcm: Buffer, sampleWidth: number): number[] {
  if (sampleWidth === 1) {
    return [...rawPcm].map((value) => value - 128);
  }
  if (sampleWidth === 2) {
    const count = Math.floor(rawPcm.length / 2);
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      out.push(rawPcm.readInt16LE(i * 2));
    }
    return out;
  }
  if (sampleWidth === 3) {
    const samples: number[] = [];
    for (let idx = 0; idx <= rawPcm.length - 3; idx += 3) {
      const b0 = rawPcm[idx]!;
      const b1 = rawPcm[idx + 1]!;
      const b2 = rawPcm[idx + 2]!;
      let v = b0 | (b1 << 8) | (b2 << 16);
      if (v & 0x800000) v |= ~0xffffff;
      samples.push(v);
    }
    return samples;
  }
  if (sampleWidth === 4) {
    const count = Math.floor(rawPcm.length / 4);
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      out.push(rawPcm.readInt32LE(i * 4));
    }
    return out;
  }
  throw new Error(`Unsupported sample width: ${sampleWidth}`);
}

export function encodeSamples(samples: number[], sampleWidth: number): Buffer {
  if (sampleWidth === 1) {
    return Buffer.from(samples.map((sample) => Math.max(0, Math.min(255, sample + 128))));
  }
  if (sampleWidth === 2) {
    const buf = Buffer.allocUnsafe(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      buf.writeInt16LE(samples[i]!, i * 2);
    }
    return buf;
  }
  if (sampleWidth === 3) {
    const buf = Buffer.allocUnsafe(samples.length * 3);
    let o = 0;
    for (let sample of samples) {
      sample = Math.max(-(1 << 23), Math.min((1 << 23) - 1, sample));
      buf.writeIntLE(sample, o, 3);
      o += 3;
    }
    return buf;
  }
  if (sampleWidth === 4) {
    const buf = Buffer.allocUnsafe(samples.length * 4);
    for (let i = 0; i < samples.length; i++) {
      buf.writeInt32LE(samples[i]!, i * 4);
    }
    return buf;
  }
  throw new Error(`Unsupported sample width: ${sampleWidth}`);
}
