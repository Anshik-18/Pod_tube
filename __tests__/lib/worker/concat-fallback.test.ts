jest.mock('@/lib/db/client');
jest.mock('@/lib/worker/ffmpeg', () => ({
  runFFmpeg: jest.fn(),
  probeMedia: jest.fn(async () => ({ durationSec: 10, hasVideo: true, hasAudio: true, width: 1920, height: 1080 })),
  probeVideoPackets: jest.fn(async () => []),
  getVideoEncoder: jest.fn(async () => 'libx264'),
}));

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { concatStage } from '@/lib/worker/concat-chunks';
import { runFFmpeg } from '@/lib/worker/ffmpeg';

describe('concatStage remux fallbacks', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'concat-'));
    await fs.writeFile(path.join(dir, 'c0.webm'), Buffer.from([0x1a]));
    await fs.writeFile(path.join(dir, 'c1.webm'), Buffer.from('rest-of-stream'));
    (runFFmpeg as jest.Mock).mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  const input = () => ({
    jobId: 'j', episodeId: 'e', sessionId: 's', workingDirectory: dir, episode: {} as any, unusable: [], totalDownloadedChunks: 2, totalSizeBytes: 15,
    participants: {
      'host.screen1': {
        participantType: 'host.screen1', directory: dir, source: 'chunks' as const, missingIndices: [], totalSizeBytes: 15,
        chunks: [0, 1].map((index) => ({ index, storageKey: `k${index}`, localPath: path.join(dir, `c${index}.webm`), sizeBytes: 1 })),
      },
    },
  });

  it('re-encodes the video instead of dropping it when stream copy is rejected', async () => {
    (runFFmpeg as jest.Mock).mockImplementation(async (args: string[]) => {
      const full = args.join(' ');
      if (/-c copy/.test(full) && !/-map 0:a /.test(full)) throw new Error('Could not write header');
      await fs.writeFile(args[args.length - 1], 'out');
    });
    const result = await concatStage(input() as any);
    const calls = (runFFmpeg as jest.Mock).mock.calls.map(([args]) => args.join(' '));
    expect(calls[0]).toContain('-map 0 -c copy');
    expect(calls[1]).toContain('-map 0:v -c copy');
    expect(calls[2]).toMatch(/-map 0:v -c:v libx264 .*-map 0:a\? -c:a copy/);
    expect(calls).toHaveLength(3);
    expect(result.participants['host.screen1'].outputFile).toMatch(/host\.screen1\.mkv$/);
  });

  it('copies straight through when the recording is clean', async () => {
    (runFFmpeg as jest.Mock).mockImplementation(async (args: string[]) => fs.writeFile(args[args.length - 1], 'out'));
    await concatStage(input() as any);
    expect((runFFmpeg as jest.Mock).mock.calls).toHaveLength(1);
  });
});
