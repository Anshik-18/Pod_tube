jest.mock('@/lib/db/client');

import { selectChunks } from '@/lib/worker/download-chunks';
import { planGapRepair } from '@/lib/worker/gap-repair';

const chunk = (chunk_index: number, status = 'completed') => ({ chunk_index, status, storage_key: `k${chunk_index}` }) as any;

describe('selectChunks', () => {
  it('uses every uploaded chunk and reports the missing ones', () => {
    const s = selectChunks([chunk(0), chunk(1), chunk(4), chunk(2), chunk(6)]);
    expect(s.chunks.map((c) => c.chunk_index)).toEqual([0, 1, 2, 4, 6]);
    expect(s.missingIndices).toEqual([3, 5]);
    expect(s.decodable).toBe(true);
  });

  it('treats chunks that never finished uploading as missing', () => {
    const s = selectChunks([chunk(0), chunk(1, 'pending'), chunk(2)]);
    expect(s.missingIndices).toEqual([1]);
  });

  it('flags a track whose first chunk (the WebM header) is missing as undecodable', () => {
    expect(selectChunks([chunk(1), chunk(2)]).decodable).toBe(false);
  });
});

/** Frames every 1/30 s from `from` to `to`, keyframe every 5 s (like Chrome's MediaRecorder). */
function frames(from: number, to: number) {
  const out = [];
  for (let t = from; t < to; t += 1 / 30) out.push({ pts: +t.toFixed(3), key: Math.abs(t / 5 - Math.round(t / 5)) < 1e-6 || +t.toFixed(3) % 5 < 0.02 });
  return out;
}

describe('planGapRepair', () => {
  it('does nothing for a continuous track', () => {
    expect(planGapRepair(frames(0, 20))).toEqual({ gaps: [], missingSeconds: 0, dropExpression: null });
  });

  it('finds a gap and drops frames until the next keyframe', () => {
    const plan = planGapRepair([...frames(0, 8.1), ...frames(12.2, 30)]);
    expect(plan.gaps).toHaveLength(1);
    expect(plan.gaps[0].start).toBeCloseTo(8.1, 1);
    expect(plan.gaps[0].end).toBeCloseTo(12.2, 1);
    expect(plan.gaps[0].resumeAt).toBeCloseTo(15, 1);
    expect(plan.missingSeconds).toBeCloseTo(4.1, 1);
    expect(plan.dropExpression).toMatch(/^not\(key\)\*gt\(/);
    expect(plan.dropExpression).toContain('lt(pts*tb,15.000)');
  });

  it('handles several gaps and a gap with no keyframe after it', () => {
    const plan = planGapRepair([...frames(0, 3), ...frames(6.4, 9), ...frames(11.3, 12)]);
    expect(plan.gaps).toHaveLength(2);
    expect(plan.gaps[1].resumeAt).toBeNull();
    expect(plan.dropExpression).toContain('gte(pts*tb,11.300)');
  });

  it('ignores ordinary dropped frames', () => {
    const jittery = frames(0, 10).filter((_, i) => i % 7 !== 0);
    expect(planGapRepair(jittery).gaps).toHaveLength(0);
  });
});
