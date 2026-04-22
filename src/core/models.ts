export interface TimeRangeSeconds {
  start: number;
  end: number;
}

export function timeRangeSeconds(start: number, end: number): TimeRangeSeconds {
  return { start, end };
}

export function timeRangeDuration(r: TimeRangeSeconds): number {
  return Math.max(0, r.end - r.start);
}

export class FrameRange {
  constructor(
    readonly start: number,
    readonly end: number,
  ) {}

  get duration(): number {
    return Math.max(0, this.end - this.start);
  }
}
