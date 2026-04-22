export interface SilenceSettings {
  silenceThresholdDb: number;
  minSilenceDurationMs: number;
  preAttackMs: number;
  postReleaseMs: number;
  analysisFrameMs: number;
  minKeepDurationMs: number;
  zeroCrossingSearchMs: number;
}

export function silenceSettings(
  silenceThresholdDb: number,
  minSilenceDurationMs: number,
  preAttackMs: number,
  postReleaseMs: number,
  analysisFrameMs = 10,
  minKeepDurationMs = 0,
  zeroCrossingSearchMs = 12,
): SilenceSettings {
  return {
    silenceThresholdDb,
    minSilenceDurationMs,
    preAttackMs,
    postReleaseMs,
    analysisFrameMs,
    minKeepDurationMs,
    zeroCrossingSearchMs,
  };
}

export interface RunOptions {
  targetTrackIndex: number;
  dryRun: boolean;
  includeLinkedItems?: boolean;
}
