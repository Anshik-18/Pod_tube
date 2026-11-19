'use client';

import { BrowserRecorder } from './recorder';
import { ChunkUploadQueue, UploadStats } from './upload-queue';
import { chunkStore, StoredTrack, trackKey } from './chunk-store';
import { api, ApiError } from '@/lib/client/api';

export type TrackUploadPhase = 'recording' | 'uploading' | 'finalizing' | 'done' | 'failed';

export interface TrackStatus {
  trackId: string;
  phase: TrackUploadPhase;
  stats: UploadStats | null;
  episodeId?: string;
  error?: string;
  /** This track is being finished after the tab that recorded it closed or crashed. */
  recovered?: boolean;
}

export interface TrackRecorderOptions {
  sessionId: string;
  /** Participant id this track is stored under (`host`, `guest-ab12cd`, `host.screen1`, …). */
  trackId: string;
  authToken: string;
  /** Server clock minus local clock, so start/end timestamps line up across machines. */
  clockOffsetMs: () => number;
  onStatus: (status: TrackStatus) => void;
}

/**
 * Chunk length. Whatever MediaRecorder hasn't handed over yet is lost if the tab dies, so this is
 * the most a crash or drop can cost (each chunk is saved to disk the moment it's produced).
 */
const CHUNK_MS = 5_000;

/** How many times finalize re-sends chunks the server reports missing before accepting the gap. */
const MAX_MISSING_RESENDS = 2;

/**
 * Records one media track locally and streams it to storage while recording:
 * MediaRecorder -> 5 s chunks -> local store (disk) -> upload queue -> finalize.
 *
 * Track metadata is kept in the local store as recording progresses, so if the tab dies the
 * track can be finished later with `TrackRecorder.recover`.
 */
export class TrackRecorder {
  private recorder = new BrowserRecorder();
  private queue: ChunkUploadQueue;
  private status: TrackStatus;
  private totalChunks = 0;
  private timestamps: { startedAt: string; endedAt: string } | null = null;
  private stopped = false;
  private storeKey: string;
  private meta: StoredTrack;
  private missingResends = 0;
  private acceptMissing = false;

  constructor(private options: TrackRecorderOptions, recovering = false) {
    this.storeKey = trackKey(options.sessionId, options.trackId);
    this.status = { trackId: options.trackId, phase: recovering ? 'uploading' : 'recording', stats: null, recovered: recovering };
    this.meta = { key: this.storeKey, sessionId: options.sessionId, trackId: options.trackId, state: 'recording', lastIndex: -1, updatedAt: Date.now() };
    this.queue = new ChunkUploadQueue({
      sessionId: options.sessionId,
      participantType: options.trackId,
      authToken: options.authToken,
      storeKey: this.storeKey,
      // One upload at a time while recording, so chunk uploads don't starve the live call.
      concurrency: recovering ? 3 : 1,
      onProgress: (stats) => this.update({ stats }),
      onAllUploadsComplete: (total) => {
        this.totalChunks = Math.max(this.totalChunks, total);
        this.finalize();
      },
      onUploadsFailed: (failed) => this.update({ phase: 'failed', error: `${failed} part${failed === 1 ? '' : 's'} failed to upload` }),
    });
    this.recorder.setChunkHandler({
      onChunk: (index, blob) => {
        this.queue.enqueue(index, blob);
        this.meta = { ...this.meta, lastIndex: index, lastChunkAt: this.serverNow() };
        chunkStore.putTrack(this.meta);
      },
    });
  }

  /**
   * Finish a track whose recording tab closed or crashed: upload the chunks still stored on this
   * device and finalize with the timing saved while it was recording. Chunks that were never
   * written are declared lost; the server assembles around them.
   */
  static async recover(options: TrackRecorderOptions, stored: StoredTrack): Promise<TrackRecorder> {
    const recorder = new TrackRecorder(options, true);
    recorder.stopped = true;
    recorder.acceptMissing = true;
    recorder.meta = stored;
    recorder.totalChunks = stored.totalChunks ?? stored.lastIndex + 1;
    const startedAt = stored.startedAt;
    const endedAt = stored.endedAt ?? stored.lastChunkAt;
    recorder.timestamps = startedAt && endedAt ? { startedAt, endedAt } : null;

    const indices = await chunkStore.listChunkIndices(recorder.storeKey);
    for (const index of indices) recorder.queue.enqueueStored(index);
    recorder.update({ phase: 'uploading' });
    recorder.queue.signalRecordingStopped();
    return recorder;
  }

  get trackId() {
    return this.options.trackId;
  }

  getStatus(): TrackStatus {
    return this.status;
  }

  async start(stream: MediaStream, quality: { videoBitsPerSecond?: number; audioBitsPerSecond?: number } = {}) {
    chunkStore.requestPersistence();
    await this.recorder.startRecording(stream, { timesliceMs: CHUNK_MS, ...quality });
    const started = this.recorder.getRecordingStartedAt();
    this.meta = { ...this.meta, state: 'recording', startedAt: started ? this.toServerTime(started) : this.serverNow() };
    chunkStore.putTrack(this.meta);
    this.update({ phase: 'recording' });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      const result = await this.recorder.stopRecording();
      this.timestamps = {
        startedAt: this.toServerTime(result.recordingStartedAt),
        endedAt: this.toServerTime(result.recordingEndedAt),
      };
      this.totalChunks = result.totalChunks;
      this.meta = { ...this.meta, state: 'stopped', totalChunks: result.totalChunks, ...this.timestamps };
      chunkStore.putTrack(this.meta);
    } catch (err) {
      console.error(`[TrackRecorder] ${this.trackId}: error stopping recorder`, err);
    }
    this.update({ phase: 'uploading' });
    // The take is over: finish the upload as fast as possible.
    this.queue.setConcurrency(3);
    this.queue.signalRecordingStopped();
  }

  /** Retry failed chunks, or the finalize call if every chunk already landed. */
  retry() {
    if (this.queue.getStats().failed > 0) {
      this.update({ phase: 'uploading', error: undefined });
      this.queue.retryFailed();
    } else {
      this.finalize();
    }
  }

  hasUnsavedWork() {
    return this.status.phase !== 'done';
  }

  destroy() {
    this.recorder.cleanupRecorderOnly();
    this.queue.destroy();
  }

  private serverNow(): string {
    return new Date(Date.now() + this.options.clockOffsetMs()).toISOString();
  }

  private toServerTime(local: Date): string {
    return new Date(local.getTime() + this.options.clockOffsetMs()).toISOString();
  }

  private async finalize(): Promise<void> {
    if (!this.stopped) return;
    // Zero chunks (e.g. a screen share stopped instantly) still finalizes, so the server stops
    // waiting for this track.
    this.update({ phase: 'finalizing', error: undefined });
    try {
      const data = await api<{ episodeId?: string }>('/api/upload/finalize', {
        method: 'POST',
        token: this.options.authToken,
        json: {
          sessionId: this.options.sessionId,
          participantType: this.trackId,
          totalChunks: this.totalChunks,
          recordingStartedAt: this.timestamps?.startedAt,
          recordingEndedAt: this.timestamps?.endedAt,
          acceptMissing: this.acceptMissing || this.queue.getLostChunks().length > 0,
        },
      });
      await chunkStore.deleteTrack(this.storeKey);
      this.update({ phase: 'done', episodeId: data.episodeId });
    } catch (err) {
      // The server is missing chunks we thought were uploaded: send them again from the local
      // copy if we still have it, otherwise accept the gap.
      const missing = err instanceof ApiError ? ((err.data as { missingIndices?: number[]; failedIndices?: number[] } | undefined) ?? {}) : {};
      const indices = [...(missing.missingIndices ?? []), ...(missing.failedIndices ?? [])];
      if (indices.length && this.missingResends < MAX_MISSING_RESENDS) {
        this.missingResends++;
        const stored = new Set(await chunkStore.listChunkIndices(this.storeKey));
        const resend = indices.filter((i) => stored.has(i));
        if (resend.length < indices.length) this.acceptMissing = true;
        if (resend.length) {
          this.queue = this.cloneQueueForResend();
          for (const i of resend) this.queue.enqueueStored(i);
          this.queue.signalRecordingStopped();
          return;
        }
        if (this.acceptMissing && !indices.includes(0)) return this.finalize();
      }
      this.update({ phase: 'failed', error: (err as Error).message || 'Could not finish the upload' });
    }
  }

  /** A fresh queue (the old one has completed) that re-sends specific stored chunks, then finalizes. */
  private cloneQueueForResend(): ChunkUploadQueue {
    this.queue.destroy();
    return new ChunkUploadQueue({
      sessionId: this.options.sessionId,
      participantType: this.trackId,
      authToken: this.options.authToken,
      storeKey: this.storeKey,
      concurrency: 3,
      onProgress: (stats) => this.update({ stats }),
      onAllUploadsComplete: () => this.finalize(),
      onUploadsFailed: (failed) => this.update({ phase: 'failed', error: `${failed} part${failed === 1 ? '' : 's'} failed to upload` }),
    });
  }

  private update(patch: Partial<TrackStatus>) {
    this.status = { ...this.status, ...patch };
    this.options.onStatus(this.status);
  }
}
