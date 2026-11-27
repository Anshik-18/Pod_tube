import { spawn } from 'child_process';
import {
  claimNextPendingProcessingJob,
  updateProcessingJobStatus,
  requeueStaleProcessingJobs,
  ProcessingJob,
} from '../db/queries/processing-jobs';
import { getEpisodeById, updateEpisodeState } from '../db/queries/episodes';
import { updateSessionState } from '../db/queries/sessions';
import { finishStalledSessions } from '../sessions/completion';
import { getProcessingResources } from './resources';

/** A session waiting on uploads that show no activity for this long is processed with what arrived. */
const STALLED_UPLOAD_MINUTES = 10;
import { processJob } from './process-job';
import { getFFmpegBin } from './ffmpeg';

export interface ProcessingWorkerOptions {
  /** Polling interval in milliseconds (default: 3000ms) */
  pollIntervalMs?: number;
}

/** Minimum gap between progress writes to the database. */
const PROGRESS_WRITE_INTERVAL_MS = 1500;
/** A 'processing' job with no progress heartbeat for this long belonged to a dead worker. */
const STALE_JOB_MINUTES = 15;
const STALE_SWEEP_INTERVAL_MS = 60_000;

/**
 * Verify that FFmpeg is installed and accessible. Fails fast if FFmpeg is not found.
 */
export function verifyFFmpegExists(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(getFFmpegBin(), ['-version'], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.on('error', (error) => {
      console.error('[Worker] ✗ FFmpeg not found. Install FFmpeg or set FFMPEG_PATH.', error.message);
      resolve(false);
    });
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[Worker] ✓ FFmpeg verified: ${stdout.split('\n')[0].trim()}`);
        resolve(true);
      } else {
        console.error(`[Worker] ✗ FFmpeg exited with code ${code}`);
        resolve(false);
      }
    });
  });
}

/** Keep the first line of an FFmpeg error readable for the UI; full detail stays in logs. */
function userFacingError(error: unknown): string {
  const message = (error as Error)?.message || 'Unknown processing error';
  return message.length > 1000 ? `${message.slice(0, 1000)}…` : message;
}

export class ProcessingWorker {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;
  private isPolling = false;
  private lastStaleSweep = 0;

  constructor(options: ProcessingWorkerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
  }

  public async start(): Promise<boolean> {
    if (this.isRunning) {
      return true;
    }

    const ffmpegAvailable = await verifyFFmpegExists();
    if (!ffmpegAvailable) {
      console.error('[Worker] Aborting worker start due to missing FFmpeg dependency.');
      return false;
    }

    this.isRunning = true;
    console.log(`[Worker] Worker started (polling every ${this.pollIntervalMs}ms)`);
    const r = getProcessingResources();
    console.log(
      `[Worker] Resources: ${r.cpus} CPU, ${r.memoryBytes ? `${Math.round(r.memoryBytes / 1048576)} MB` : 'no memory limit'} -> ` +
        `${r.threads} FFmpeg thread(s), exports up to '${r.maxQuality}'${r.maxQuality === 'low' ? ' (720p)' : ''}`
    );
    this.scheduleNextPoll(0);
    return true;
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[Worker] Worker stopped');
  }

  private async runJob(job: ProcessingJob): Promise<void> {
    console.log(`[Worker] Job claimed: ${job.id} (episode: ${job.episode_id})`);

    let lastWrite = 0;
    let lastPercent = -1;
    // Serialize progress writes so none can land after the final status update.
    let progressWrites: Promise<unknown> = Promise.resolve();
    const onProgress = (percent: number) => {
      const now = Date.now();
      if (percent <= lastPercent || now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
      lastPercent = percent;
      lastWrite = now;
      progressWrites = progressWrites
        .then(() => updateProcessingJobStatus(job.id, 'processing', null, percent))
        .catch(() => {});
    };

    try {
      await updateEpisodeState(job.episode_id, 'processing');
      await updateProcessingJobStatus(job.id, 'processing', null, 0);
      try {
        await processJob(job, onProgress);
      } finally {
        await progressWrites;
      }
      await updateProcessingJobStatus(job.id, 'completed', null, 100);
      console.log(`[Worker] Job completed: ${job.id}`);
    } catch (error) {
      const errorMessage = userFacingError(error);
      console.error(`[Worker] Job failed: ${job.id} -`, (error as Error)?.message || error);
      await updateProcessingJobStatus(job.id, 'failed', errorMessage).catch(() => {});
      await updateEpisodeState(job.episode_id, 'failed').catch(() => {});
      const episode = await getEpisodeById(job.episode_id).catch(() => null);
      if (episode) {
        await updateSessionState(episode.session_id, 'failed').catch(() => {});
      }
    }
  }

  public async poll(): Promise<void> {
    if (this.isPolling || !this.isRunning) return;
    this.isPolling = true;
    let claimed = false;

    try {
      if (Date.now() - this.lastStaleSweep > STALE_SWEEP_INTERVAL_MS) {
        this.lastStaleSweep = Date.now();
        const requeued = await requeueStaleProcessingJobs(STALE_JOB_MINUTES);
        if (requeued > 0) console.warn(`[Worker] Requeued ${requeued} stale job(s)`);
        const finished = await finishStalledSessions(STALLED_UPLOAD_MINUTES).catch(() => []);
        if (finished.length) console.warn(`[Worker] Finished ${finished.length} session(s) whose remaining uploads stalled: ${finished.join(', ')}`);
      }

      const job = await claimNextPendingProcessingJob();
      if (job) {
        claimed = true;
        await this.runJob(job);
      }
    } catch (error: any) {
      console.error(`[Worker] Error during poll cycle:`, error?.message || error);
    } finally {
      this.isPolling = false;
      // Drain the queue back-to-back; otherwise wait for the next poll interval.
      this.scheduleNextPoll(claimed ? 0 : this.pollIntervalMs);
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isRunning) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.poll(), delayMs);
  }
}

// Global worker instance for singleton usage
let globalWorker: ProcessingWorker | null = null;

export async function startProcessingWorker(
  options?: ProcessingWorkerOptions
): Promise<ProcessingWorker | null> {
  if (!globalWorker) {
    globalWorker = new ProcessingWorker(options);
  }
  const started = await globalWorker.start();
  if (!started) {
    globalWorker = null;
    return null;
  }
  return globalWorker;
}

export function stopProcessingWorker(): void {
  if (globalWorker) {
    globalWorker.stop();
    globalWorker = null;
  }
}
