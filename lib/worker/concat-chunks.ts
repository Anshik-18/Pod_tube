import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import { JobDownloadResult, ParticipantType } from './download-chunks';
import { runFFmpeg, probeMedia, probeVideoPackets, MediaInfo } from './ffmpeg';
import { planGapRepair, TrackGap } from './gap-repair';

export interface ParticipantConcatOutput {
  participantType: ParticipantType;
  /** Continuous, seekable source recording for this participant. */
  outputFile: string;
  sizeBytes: number;
  media: MediaInfo;
  /** True when this track was just assembled from chunks and still needs to be saved to storage. */
  isNewTrack: boolean;
  /** Missing stretches when some chunks never arrived. */
  gaps: TrackGap[];
  missingSeconds: number;
}

export interface ConcatStageResult {
  jobId: string;
  episodeId: string;
  sessionId: string;
  workingDirectory: string;
  participants: Record<ParticipantType, ParticipantConcatOutput>;
}

/**
 * MediaRecorder timeslice chunks are byte continuations of one WebM stream: only chunk 0
 * carries the EBML header. They must be joined byte-for-byte, not with the concat demuxer.
 */
async function joinChunks(chunkPaths: string[], outputPath: string): Promise<void> {
  const out = createWriteStream(outputPath);
  try {
    for (const chunkPath of chunkPaths) {
      await new Promise<void>((resolve, reject) => {
        const input = createReadStream(chunkPath);
        input.on('error', reject);
        input.on('end', resolve);
        input.pipe(out, { end: false });
      });
      // Free scratch space as we go: a long recording is several GB of chunks.
      await fs.rm(chunkPath, { force: true });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      out.end(resolve);
    });
  }
}

async function repairGaps(participantType: string, file: string): Promise<{ gaps: TrackGap[]; missingSeconds: number }> {
  const packets = await probeVideoPackets(file).catch((err) => {
    console.warn(`[ConcatStage] ${participantType}: could not read packets for gap repair:`, err.message);
    return [];
  });
  const plan = planGapRepair(packets);
  if (!plan.dropExpression) return { gaps: plan.gaps, missingSeconds: plan.missingSeconds };

  const ext = path.extname(file);
  const repaired = file.replace(new RegExp(`${ext}$`), `.repaired${ext}`);
  try {
    await runFFmpeg(['-i', file, '-map', '0', '-c', 'copy', '-bsf:v', `noise=drop='${plan.dropExpression}'`, repaired], {
      label: `gap repair ${participantType}`,
    });
    await fs.rename(repaired, file);
  } catch (err) {
    // Keep the unrepaired track: a few garbled frames beat losing the recording.
    await fs.rm(repaired, { force: true });
    console.warn(`[ConcatStage] ${participantType}: gap repair failed, using track as assembled:`, (err as Error).message.split('\n')[0]);
  }
  console.log(
    `[ConcatStage] ${participantType}: ${plan.gaps.length} gap(s), ${plan.missingSeconds.toFixed(1)}s missing (` +
      plan.gaps.map((g) => `${g.start.toFixed(1)}–${g.end.toFixed(1)}s`).join(', ') +
      ')'
  );
  return { gaps: plan.gaps, missingSeconds: plan.missingSeconds };
}

/**
 * concatStage
 *
 * Produces one continuous WebM per participant. Joined chunks are remuxed (stream copy, no
 * re-encode) so the file gets proper duration and cue metadata and is seekable when downloaded.
 */
export async function concatStage(downloadResult: JobDownloadResult): Promise<ConcatStageResult> {
  const { workingDirectory, jobId, episodeId, sessionId, participants } = downloadResult;
  const result: ConcatStageResult['participants'] = {};

  for (const [participantType, data] of Object.entries(participants)) {
    let outputFile: string;
    let isNewTrack = false;
    let gaps: TrackGap[] = [];
    let missingSeconds = 0;

    if (data.source === 'track' && data.trackPath) {
      outputFile = data.trackPath;
    } else {
      const sorted = [...data.chunks].sort((a, b) => a.index - b.index);
      const joined = path.join(workingDirectory, `${participantType}.joined.webm`);
      await joinChunks(sorted.map((c) => c.localPath), joined);

      // WebM for Chrome/Firefox (VP8/VP9/Opus); Matroska accepts Safari's H.264/AAC too.
      outputFile = '';
      for (const ext of ['webm', 'mkv']) {
        const candidate = path.join(workingDirectory, `${participantType}.${ext}`);
        try {
          await runFFmpeg(['-fflags', '+genpts', '-i', joined, '-map', '0', '-c', 'copy', candidate], {
            label: `remux ${participantType} to ${ext}`,
          });
          outputFile = candidate;
          break;
        } catch (err) {
          await fs.rm(candidate, { force: true });
          console.warn(`[ConcatStage] Remux to ${ext} failed for ${participantType}:`, (err as Error).message.split('\n')[0]);
        }
      }
      if (outputFile) {
        await fs.rm(joined, { force: true });
      } else {
        outputFile = path.join(workingDirectory, `${participantType}.webm`);
        await fs.rename(joined, outputFile);
      }
      isNewTrack = true;

      // Chunks were missing: the demuxer has resynced past each gap with timestamps intact.
      // Drop the frames around each gap that can't be decoded cleanly.
      if (data.missingIndices.length > 0) {
        const repaired = await repairGaps(participantType, outputFile);
        gaps = repaired.gaps;
        missingSeconds = repaired.missingSeconds;
      }
    }

    const stat = await fs.stat(outputFile);
    const media = await probeMedia(outputFile).catch((err) => {
      console.warn(`[ConcatStage] ffprobe failed for ${participantType}:`, err.message);
      return { durationSec: null, hasVideo: true, hasAudio: true, width: null, height: null } as MediaInfo;
    });

    console.log(
      `[ConcatStage] ${participantType}: ${(stat.size / (1024 * 1024)).toFixed(2)} MB, ` +
        `${media.durationSec?.toFixed(1) ?? '?'}s, video=${media.hasVideo} audio=${media.hasAudio}`
    );

    result[participantType] = { participantType, outputFile, sizeBytes: stat.size, media, isNewTrack, gaps, missingSeconds };
  }

  if (Object.keys(result).length === 0) {
    throw new Error('No participant media could be assembled');
  }

  return { jobId, episodeId, sessionId, workingDirectory, participants: result };
}
