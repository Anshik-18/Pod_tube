/**
 * Tests for the episode compositor's pure planning logic (scenes, layouts, FFmpeg passes).
 */

jest.mock('@/lib/db/client');

import { buildRenderPlan, planScenes, gridLayout, screenLayout, MergeInput, ABSENCE_GRACE_SEC, FPS } from '@/lib/worker/scenes';
import { contiguousPrefix } from '@/lib/worker/download-chunks';

const cam = (participantType: string, offsetSec: number, durationSec: number, extra: Partial<MergeInput> = {}): MergeInput => ({
  participantType,
  file: `${participantType}.webm`,
  offsetSec,
  durationSec,
  hasVideo: true,
  hasAudio: true,
  group: participantType.split('.')[0],
  ...extra,
});
const screen = (owner: string, offsetSec: number, durationSec: number): MergeInput => ({
  ...cam(`${owner}.screen1`, offsetSec, durationSec),
  isScreen: true,
  hasAudio: false,
});
const shape = (scenes: ReturnType<typeof planScenes>) =>
  scenes.map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}:${s.slots.join('+')}${s.screen ? '+screen' : ''}`);

describe('planScenes — who is on screen when', () => {
  it('keeps one scene when everyone is there the whole time', () => {
    expect(shape(planScenes([cam('host', 0, 60), cam('guest-a', 0, 60)], 0, 60))).toEqual(['0.0-60.0:host+guest-a']);
  });

  it('adds a late joiner to the layout when they join (no empty slot before)', () => {
    expect(shape(planScenes([cam('host', 0, 60), cam('guest-c', 25, 35)], 0, 60))).toEqual(['0.0-25.0:host', '25.0-60.0:host+guest-c']);
  });

  it('reflows when someone is gone longer than the grace period, and brings them back in their segment', () => {
    const inputs = [cam('host', 0, 120), cam('guest-b', 0, 30), cam('guest-b.part2', 70, 50, { group: 'guest-b' })];
    expect(shape(planScenes(inputs, 0, 120))).toEqual(['0.0-30.0:host+guest-b', '30.0-70.0:host', '70.0-120.0:host+guest-b']);
  });

  it('keeps the slot through a short drop so the layout does not jump', () => {
    const inputs = [cam('host', 0, 120), cam('guest-b', 0, 30), cam('guest-b.part2', 30 + ABSENCE_GRACE_SEC - 5, 75, { group: 'guest-b' })];
    expect(shape(planScenes(inputs, 0, 120))).toEqual(['0.0-120.0:host+guest-b']);
  });

  it('removes someone who leaves for good at the moment they leave', () => {
    expect(shape(planScenes([cam('host', 0, 100), cam('guest-a', 0, 40)], 0, 100))).toEqual(['0.0-40.0:host+guest-a', '40.0-100.0:host']);
  });

  it('switches to the screen layout only while a screen is shared', () => {
    const scenes = planScenes([cam('host', 0, 60), cam('guest-a', 0, 60), screen('guest-a', 20, 15)], 0, 60);
    expect(shape(scenes)).toEqual(['0.0-20.0:host+guest-a', '20.0-35.0:host+guest-a+screen', '35.0-60.0:host+guest-a']);
  });

  it('folds scenes too short to read into a neighbour', () => {
    // Guest appears 0.4 s after the host: no 0.4 s solo scene.
    expect(shape(planScenes([cam('host', 0, 60), cam('guest-a', 0.4, 59.6)], 0, 60))).toEqual(['0.0-60.0:host+guest-a']);
  });

  it('snaps scene boundaries to whole frames', () => {
    const scenes = planScenes([cam('host', 0, 60), cam('guest-c', 25.0123, 34.9877)], 0, 60);
    for (const s of scenes) {
      expect(Math.abs(s.start * FPS - Math.round(s.start * FPS))).toBeLessThan(1e-6);
      expect(Math.abs(s.end * FPS - Math.round(s.end * FPS))).toBeLessThan(1e-6);
    }
  });

  it('clips scenes to the trim range', () => {
    expect(shape(planScenes([cam('host', 0, 100), cam('guest-c', 50, 50)], 30, 80))).toEqual(['30.0-50.0:host', '50.0-80.0:host+guest-c']);
  });
});

describe('buildRenderPlan', () => {
  const plan = (inputs: MergeInput[], trim?: any, extra: any = {}) => buildRenderPlan(inputs, { workDir: '/w', outputFile: '/w/out.mp4', trim, ...extra });
  const graph = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

  it('renders a solo recording at full length with the default (medium) preset', () => {
    const p = plan([cam('host', 0, 60)]);
    expect(p.outputDurationSec).toBeCloseTo(60);
    expect(p.width).toBe(1920);
    expect(p.scenes).toHaveLength(1);
    expect(p.scenes[0].frames).toBe(60 * FPS);
    expect(p.scenes[0].pass.args).toContain('-crf');
    expect(p.mux.args[p.mux.args.length - 1]).toBe('/w/out.mp4');
  });

  it('uses a 720p canvas for a solo 720p source', () => {
    const p = plan([cam('host', 0, 60)], undefined, { sourceHeight: 720 });
    expect([p.width, p.height]).toEqual([1280, 720]);
  });

  it('decodes each input only for its scenes: seeks into earlier segments, delays later ones', () => {
    const p = plan([cam('host', 0, 120), cam('guest-b', 0, 30), cam('guest-b.part2', 70, 50, { group: 'guest-b' })]);
    const last = p.scenes[2].pass.args;
    // Host seeks 70 s in; Bob's part 2 starts exactly at the scene start (no seek, no delay).
    expect(last.slice(0, 6)).toEqual(['-ss', '70.000', '-t', '50.500', '-i', 'host.webm']);
    expect(last).toContain('guest-b.part2.webm');
    expect(last).not.toContain('guest-b.webm');
    expect(p.scenes[1].pass.args.filter((a) => a.endsWith('.webm'))).toEqual(['host.webm']);
  });

  it('draws a placeholder card in a slot held through a short drop', () => {
    const inputs = [cam('host', 0, 60), cam('guest-b', 0, 20), cam('guest-b.part2', 30, 30, { group: 'guest-b' })];
    const p = plan(inputs);
    expect(p.scenes).toHaveLength(1);
    const g = graph(p.scenes[0].pass.args);
    expect(g.match(/drawbox=/g)).toHaveLength(2);
    expect(g).toContain('setpts=PTS+30.000/TB');
  });

  it('mixes every voice once over the whole timeline, delayed to each track’s start', () => {
    const p = plan([cam('host', 0, 60), cam('guest-a', 1.5, 50), cam('guest-c', 20, 40)]);
    const g = graph(p.audio.args);
    expect(g).toContain('amix=inputs=3');
    expect(g).toContain('adelay=1500|1500');
    expect(g).toContain('adelay=20000|20000');
  });

  it('applies the trim range and the chosen quality preset', () => {
    const p = plan([cam('host', 0, 60), cam('guest-a', 0, 60)], { trimStart: 5, trimEnd: 25, quality: 'high' });
    expect(p.outputDurationSec).toBeCloseTo(20);
    expect(p.scenes[0].pass.args.slice(0, 2)).toEqual(['-ss', '5.000']);
    expect(p.scenes[0].pass.args[p.scenes[0].pass.args.indexOf('-crf') + 1]).toBe('18');
    expect(graph(p.audio.args)).toContain('atrim=start=5.000:end=25.000');
  });

  it('uses OpenH264 with a bitrate target when x264 is unavailable', () => {
    const args = plan([cam('host', 0, 30)], undefined, { videoEncoder: 'libopenh264' }).scenes[0].pass.args;
    expect(args).toContain('libopenh264');
    expect(args).not.toContain('-crf');
    expect(args[args.indexOf('-b:v') + 1]).toBe('6000k');
  });

  it('lists scenes for the concat demuxer with exact durations', () => {
    const p = plan([cam('host', 0, 60), cam('guest-c', 25, 35)]);
    expect(p.concatList).toBe("file '/w/scene_0000.ts'\nduration 25.000\nfile '/w/scene_0001.ts'\nduration 35.000\n");
  });

  it('rejects more than eight people, an empty trim and unknown durations', () => {
    const nine = Array.from({ length: 9 }, (_, i) => cam(`guest-n${i}aaaaa`, 0, 10));
    expect(() => plan(nine)).toThrow(/at most 8/);
    expect(() => plan([cam('host', 0, 60)], { trimStart: 59.9, trimEnd: 60 })).toThrow(/too short/);
    expect(() => plan([cam('host', 0, 0)])).toThrow(/duration/);
  });
});

describe('layouts', () => {
  const inside = (r: { x: number; y: number; w: number; h: number }) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1920 && r.y + r.h <= 1080;

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('fits %i tiles on the canvas without overlap', (n) => {
    const rects = gridLayout(n, 1920, 1080, 24);
    expect(rects).toHaveLength(n);
    rects.forEach((r) => expect(inside(r)).toBe(true));
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const A = rects[a], B = rects[b];
        expect(A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h).toBe(false);
      }
    }
  });

  it('centers a partly filled last row', () => {
    const [a, b, c] = gridLayout(3, 1920, 1080, 24);
    expect(a.y).toBe(b.y);
    expect(c.x + c.w / 2).toBeCloseTo(960, -1);
  });

  it('keeps the screen and the camera sidebar on the canvas', () => {
    const { main, tiles } = screenLayout(6, 1920, 1080, 24);
    expect(inside(main)).toBe(true);
    tiles.forEach((t) => {
      expect(inside(t)).toBe(true);
      expect(t.x).toBeGreaterThan(main.x + main.w);
    });
  });
});

describe('contiguousPrefix', () => {
  const chunk = (chunk_index: number, status = 'completed') => ({ chunk_index, status, storage_key: `k${chunk_index}` }) as any;

  it('keeps every chunk when there are no gaps', () => {
    expect(contiguousPrefix([chunk(2), chunk(0), chunk(1)]).map((c) => c.chunk_index)).toEqual([0, 1, 2]);
  });

  it('stops at the first missing or incomplete chunk', () => {
    expect(contiguousPrefix([chunk(0), chunk(1), chunk(3)]).map((c) => c.chunk_index)).toEqual([0, 1]);
  });
});
