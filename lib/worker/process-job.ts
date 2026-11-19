import { ProcessingJob } from '../db/queries/processing-jobs';
import { downloadChunksStage } from './download-chunks';
import { concatStage, ConcatStageResult } from './concat-chunks';
import { resolveSessionTimeline, SessionTimeline } from './timeline';
import { mergeStage, MergeStageResult } from './merge-stage';
import { uploadStage, UploadStageResult } from './upload-stage';
import { cleanupStage, cleanupR2ChunksStage } from './cleanup-stage';

export interface ProcessJobPipelineResult {
  concatResult: ConcatStageResult;
  timeline: SessionTimeline;
  mergeResult: MergeStageResult;
  uploadResult: UploadStageResult;
}

/** Share of overall progress (0-100) allotted to each stage. */
const STAGES = {
  download: [0, 10],
  concat: [10, 15],
  merge: [15, 90],
  upload: [90, 99],
} as const;

export type ProgressReporter = (percent: number) => void;

function within(report: ProgressReporter | undefined, [from, to]: readonly [number, number]) {
  return (fraction: number) => report?.(Math.round(from + (to - from) * fraction));
}

/**
 * processJob
 *
 * End-to-end pipeline for a claimed ProcessingJob:
 * 1. Download: fetch chunks (fresh recording) or saved tracks (re-export) to a temp directory.
 * 2. Concat: byte-join chunks per participant and remux into seekable WebM tracks.
 * 3. Timeline: compute each participant's start offset for synchronization.
 * 4. Merge: composite, mix, trim and encode episode.mp4 using the episode's export settings.
 * 5. Upload: save MP4, MP3, thumbnail and per-participant tracks; mark the episode ready.
 * 6. Chunk cleanup: once tracks are persisted, delete the raw chunks.
 * 7. Always remove the temp directory.
 */
export async function processJob(job: ProcessingJob, onProgress?: ProgressReporter): Promise<ProcessJobPipelineResult> {
  console.log(`[Worker:processJob] Starting pipeline for job ${job.id} (episode: ${job.episode_id})`);

  const downloadResult = await downloadChunksStage(job, within(onProgress, STAGES.download));
  try {
    const concatResult = await concatStage(downloadResult);
    within(onProgress, STAGES.concat)(1);

    const timeline = await resolveSessionTimeline(downloadResult.sessionId);
    const mergeResult = await mergeStage(
      concatResult,
      timeline,
      downloadResult.episode.trim_settings,
      within(onProgress, STAGES.merge)
    );

    const uploadResult = await uploadStage(
      downloadResult.episode,
      concatResult,
      mergeResult,
      within(onProgress, STAGES.upload),
      downloadResult.unusable
    );

    const assembledFromChunks = Object.values(concatResult.participants).filter((p) => p?.isNewTrack).length;
    if (assembledFromChunks > 0 && uploadResult.persistedTracks.length === assembledFromChunks) {
      await cleanupR2ChunksStage(downloadResult.sessionId).catch((err) =>
        console.warn(`[Worker:processJob] Chunk cleanup failed (will not affect the episode):`, err.message)
      );
    }

    console.log(`[Worker:processJob] Pipeline completed for job ${job.id}`);
    return { concatResult, timeline, mergeResult, uploadResult };
  } finally {
    await cleanupStage(downloadResult.workingDirectory);
  }
}
