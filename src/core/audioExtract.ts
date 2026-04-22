import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";

export interface ExtractedAudio {
  wavPath: string;
  durationSeconds: number;
}

export async function extractClipSliceToWav(
  filePath: string,
  sourceStartFrame: number,
  sourceEndFrame: number,
  fps: number,
): Promise<ExtractedAudio> {
  if (sourceEndFrame <= sourceStartFrame) {
    throw new Error("Invalid source frame bounds for extraction.");
  }

  const startSec = sourceStartFrame / fps;
  const durationSec = (sourceEndFrame - sourceStartFrame) / fps;
  if (durationSec <= 0) {
    throw new Error("Clip duration is zero during extraction.");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "resolve_silence_cut_"));
  const wavPath = join(tempDir, "clip.wav");

  const args = [
    "-v",
    "error",
    "-ss",
    startSec.toFixed(6),
    "-i",
    filePath,
    "-t",
    durationSec.toFixed(6),
    "-ac",
    "1",
    "-ar",
    "48000",
    "-vn",
    "-y",
    wavPath,
  ];

  const result = await execa("ffmpeg", args, { reject: false });
  if (result.exitCode !== 0) {
    const err = (result.stderr || result.stdout || "").toString().trim();
    throw new Error(`ffmpeg extraction failed for '${filePath}': ${err}`);
  }

  return { wavPath, durationSeconds: durationSec };
}
