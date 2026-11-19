import type { VideoPacket } from './ffmpeg';

export interface TrackGap {
  /** Last good frame before the gap (seconds, track time). */
  start: number;
  /** First frame after the gap. */
  end: number;
  /** First keyframe at or after `end`; frames before it can't be decoded cleanly. */
  resumeAt: number | null;
}

export interface GapRepairPlan {
  gaps: TrackGap[];
  /** Seconds of media lost (sum of gap lengths). */
  missingSeconds: number;
  /** `noise` bitstream-filter expression that drops undecodable video packets, or null if none. */
  dropExpression: string | null;
}

/** A jump between consecutive video frames longer than this is a missing piece, not a dropped frame. */
const MIN_GAP_SEC = 0.5;
/** Frames this close before a gap may have been cut off at the chunk boundary. */
const PRE_GAP_TRIM_SEC = 0.15;
const MAX_GAPS = 500;

const f = (n: number) => n.toFixed(3);

/**
 * Plan how to clean up a track assembled around missing chunks. After a gap the decoder needs a
 * keyframe (Chrome emits one every ~5 s), and the last frames before a gap can be truncated, so
 * those non-key frames are dropped. The merge stage then holds the last good frame across the gap
 * and pads the audio with silence, keeping everything after it in sync.
 */
export function planGapRepair(packets: VideoPacket[]): GapRepairPlan {
  const sorted = [...packets].sort((a, b) => a.pts - b.pts);
  const gaps: TrackGap[] = [];
  for (let i = 1; i < sorted.length && gaps.length < MAX_GAPS; i++) {
    if (sorted[i].pts - sorted[i - 1].pts <= MIN_GAP_SEC) continue;
    const end = sorted[i].pts;
    const resume = sorted.slice(i).find((p) => p.key);
    gaps.push({ start: sorted[i - 1].pts, end, resumeAt: resume ? resume.pts : null });
  }

  const missingSeconds = gaps.reduce((n, g) => n + (g.end - g.start), 0);
  if (gaps.length === 0) return { gaps, missingSeconds: 0, dropExpression: null };

  const windows = gaps.map((g) => {
    const before = `between(pts*tb,${f(g.start - PRE_GAP_TRIM_SEC)},${f(g.start + 0.0005)})`;
    const after = g.resumeAt === null ? `gte(pts*tb,${f(g.end)})` : `gte(pts*tb,${f(g.end)})*lt(pts*tb,${f(g.resumeAt)})`;
    return `${before}+${after}`;
  });
  return { gaps, missingSeconds, dropExpression: `not(key)*gt(${windows.join('+')},0)` };
}
