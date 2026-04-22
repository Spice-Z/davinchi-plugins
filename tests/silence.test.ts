import { describe, expect, it } from "vitest";
import { silenceSettings } from "../src/core/config.js";
import {
  applyAttackReleaseToSilenceRanges,
  detectSilenceRanges,
  invertRanges,
  pruneShortKeepRanges,
  snapRangesToZeroCrossings,
} from "../src/core/silence.js";

function makePcm(sampleRate: number, segments: [number, number][]): Buffer {
  const raw: number[] = [];
  for (const [durationSec, sampleValue] of segments) {
    const sampleCount = Math.floor(sampleRate * durationSec);
    for (let i = 0; i < sampleCount; i++) {
      raw.push(sampleValue & 0xff, (sampleValue >> 8) & 0xff);
    }
  }
  return Buffer.from(raw);
}

function makePcmFromSamples(samples: number[]): Buffer {
  const raw = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    raw.writeInt16LE(samples[i]!, i * 2);
  }
  return raw;
}

describe("silence detection", () => {
  it("detects silence and applies pre-attack/post-release context", () => {
    const sampleRate = 1000;
    const sampleWidth = 2;
    const raw = makePcm(sampleRate, [
      [0.2, 8000],
      [0.5, 0],
      [0.2, 8000],
    ]);
    const settings = silenceSettings(-35.0, 200, 50, 50, 10);

    const silence = detectSilenceRanges(sampleRate, sampleWidth, raw, settings);
    expect(silence.length).toBe(1);
    expect(silence[0]!.start).toBeCloseTo(0.2, 2);
    expect(silence[0]!.end).toBeCloseTo(0.7, 2);

    const adjusted = applyAttackReleaseToSilenceRanges(silence, 0.9, 50, 50);
    expect(adjusted[0]!.start).toBeCloseTo(0.25, 2);
    expect(adjusted[0]!.end).toBeCloseTo(0.65, 2);

    const kept = invertRanges(adjusted, 0.9);
    expect(kept.length).toBe(2);
    expect(kept[0]!.end).toBeCloseTo(0.25, 2);
    expect(kept[1]!.start).toBeCloseTo(0.65, 2);
  });

  it("drops tiny keep islands and keeps longer speech segments", () => {
    const kept = pruneShortKeepRanges(
      [
        { start: 0, end: 0.08 },
        { start: 0.2, end: 0.42 },
        { start: 0.5, end: 0.57 },
      ],
      120,
    );
    expect(kept).toEqual([{ start: 0.2, end: 0.42 }]);
  });

  it("snaps keep boundaries to nearby zero crossings", () => {
    const sampleRate = 1000;
    const raw = makePcmFromSamples([-5, -3, -1, 2, 5, 1, -2, -5]);
    const keep = snapRangesToZeroCrossings(
      [{ start: 0.002, end: 0.007 }],
      raw,
      sampleRate,
      2,
      2,
    );
    expect(keep.length).toBe(1);
    expect(keep[0]!.start).toBeCloseTo(0.003, 3);
    expect(keep[0]!.end).toBeCloseTo(0.006, 3);
  });
});
