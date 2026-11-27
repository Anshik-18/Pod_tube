import { clampQuality, detectResources } from '@/lib/worker/resources';
import { buildRenderPlan } from '@/lib/worker/scenes';

describe('processing resources', () => {
  it('lowers a requested quality to the machine limit, never raises it', () => {
    expect(clampQuality('high', 'low')).toBe('low');
    expect(clampQuality('medium', 'low')).toBe('low');
    expect(clampQuality('low', 'high')).toBe('low');
    expect(clampQuality(undefined, 'high')).toBe('medium');
  });

  it('honours explicit overrides', () => {
    const r = detectResources({ PROCESSING_THREADS: '2', PROCESSING_MAX_QUALITY: 'low' } as any);
    expect(r.threads).toBe(2);
    expect(r.maxQuality).toBe('low');
  });

  it('passes the thread cap to every decoder, the filter graph and the encoder', () => {
    const cam = (id: string) => ({ participantType: id, file: `${id}.webm`, offsetSec: 0, durationSec: 30, hasVideo: true, hasAudio: true });
    const plan = buildRenderPlan([cam('host'), cam('guest-a')], { workDir: '/w', outputFile: '/w/o.mp4', threads: 1 });
    const args = plan.scenes[0].pass.args;
    const inputs = args.filter((a) => a === '-i').length;
    expect(args.filter((a, i) => a === '-threads' && args[i + 1] === '1').length).toBe(inputs + 1);
    expect(args).toContain('-filter_complex_threads');
    expect(plan.audio.args.filter((a) => a === '-threads')).toHaveLength(2);
  });
});
