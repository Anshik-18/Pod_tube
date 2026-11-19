/**
 * ChunkUploadQueue - Browser upload queue with bounded concurrency and resilient retries.
 *
 * Uploads chunks in the background without blocking MediaRecorder. Survives network drops:
 * while the browser is offline, chunks wait (without burning retry attempts) and resume on
 * reconnect. Chunks that exhaust their retries are kept so the user can retry them manually.
 *
 * With a `storeKey`, chunks are written to the durable local store (IndexedDB) and only their
 * index is kept in memory; the blob is read back just for its upload and deleted locally once the
 * server confirms it. Memory stays flat however far uploads fall behind, and a crashed tab's
 * leftovers can be uploaded later (see `enqueueStored`).
 */

import { chunkStore } from './chunk-store';

export interface ChunkTask {
  chunkIndex: number;
  /** In memory only when the local store is unavailable; otherwise read from the store. */
  blob?: Blob;
  size: number;
  attempts: number;
}

export interface UploadStats {
  uploaded: number;
  pending: number;
  failed: number;
  total: number;
  uploadedBytes: number;
  totalBytes: number;
}

export interface ChunkUploadQueueOptions {
  /** Session ID for this recording */
  sessionId: string;
  /** 'host' or 'guest' */
  participantType: string;
  /** Max parallel uploads (default: 3) */
  concurrency?: number;
  /** Max retry attempts per chunk while online (default: 8) */
  maxRetries?: number;
  /** Base backoff delay in ms between retries (default: 1000, doubling, capped at 30s) */
  retryDelayMs?: number;
  /** JWT auth token for API calls */
  authToken: string;
  /** Called when a chunk upload completes */
  onChunkUploaded?: (chunkIndex: number, totalPending: number) => void;
  /** Called when a chunk fails after all retries */
  onChunkFailed?: (chunkIndex: number, error: Error) => void;
  /** Called when ALL enqueued chunks have been uploaded successfully and recording has stopped */
  onAllUploadsComplete?: (totalChunks: number) => void;
  /** Called when one or more chunks permanently fail after all retries */
  onUploadsFailed?: (failedCount: number, totalChunks: number) => void;
  /** Called with upload progress stats */
  onProgress?: (stats: UploadStats) => void;
  /** Durable local store key for this track (`${sessionId}:${trackId}`); omit to keep chunks in memory. */
  storeKey?: string;
}

const MAX_BACKOFF_MS = 30_000;

export class ChunkUploadQueue {
  private queue: ChunkTask[] = [];
  private failedTasks: ChunkTask[] = [];
  private activeUploads = 0;
  private concurrency: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private sessionId: string;
  private participantType: string;
  private authToken: string;

  private uploadedCount = 0;
  private totalEnqueued = 0;
  private uploadedBytes = 0;
  private totalBytes = 0;
  private recordingStopped = false;
  private destroyed = false;
  private completed = false;
  private waitingForOnline = false;
  private storeKey?: string;
  /** Chunks being written to the local store; completion waits for them. */
  private pendingPersists = 0;
  /** Chunks that can no longer be uploaded (not in memory or the local store). */
  private lostChunks: number[] = [];

  private onChunkUploaded?: ChunkUploadQueueOptions['onChunkUploaded'];
  private onChunkFailed?: ChunkUploadQueueOptions['onChunkFailed'];
  private onAllUploadsComplete?: ChunkUploadQueueOptions['onAllUploadsComplete'];
  private onUploadsFailed?: ChunkUploadQueueOptions['onUploadsFailed'];
  private onProgress?: ChunkUploadQueueOptions['onProgress'];

  constructor(options: ChunkUploadQueueOptions) {
    this.sessionId = options.sessionId;
    this.participantType = options.participantType;
    this.concurrency = options.concurrency ?? 3;
    this.maxRetries = options.maxRetries ?? 8;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.authToken = options.authToken;
    this.onChunkUploaded = options.onChunkUploaded;
    this.onChunkFailed = options.onChunkFailed;
    this.onAllUploadsComplete = options.onAllUploadsComplete;
    this.onUploadsFailed = options.onUploadsFailed;
    this.onProgress = options.onProgress;
    this.storeKey = options.storeKey;
  }

  /**
   * Enqueue a chunk for background upload. Never blocks. The chunk is saved locally first (when a
   * store is configured) and only its index stays in memory.
   */
  enqueue(chunkIndex: number, blob: Blob): void {
    if (this.destroyed) return;

    this.totalEnqueued++;
    this.totalBytes += blob.size;
    this.emitProgress();

    if (!this.storeKey) {
      this.queue.push({ chunkIndex, blob, size: blob.size, attempts: 0 });
      this.processQueue();
      return;
    }
    this.pendingPersists++;
    chunkStore.putChunk(this.storeKey, chunkIndex, blob).then((stored) => {
      this.pendingPersists--;
      if (this.destroyed) return;
      // If the store is unavailable or full, fall back to keeping this chunk in memory.
      this.queue.push({ chunkIndex, blob: stored ? undefined : blob, size: blob.size, attempts: 0 });
      this.processQueue();
      this.checkCompletion();
    });
  }

  /** Enqueue a chunk that is already in the local store (recovering an interrupted recording). */
  enqueueStored(chunkIndex: number, size = 0): void {
    if (this.destroyed || !this.storeKey) return;
    this.totalEnqueued++;
    this.totalBytes += size;
    this.queue.push({ chunkIndex, size, attempts: 0 });
    this.emitProgress();
    this.processQueue();
  }

  /** Chunk indices that couldn't be uploaded because their data no longer exists anywhere. */
  getLostChunks(): number[] {
    return [...this.lostChunks];
  }

  /**
   * Signal that recording has stopped and no more chunks will be enqueued.
   * When all pending uploads finish, onAllUploadsComplete or onUploadsFailed is called automatically.
   */
  signalRecordingStopped(): void {
    this.recordingStopped = true;
    this.checkCompletion();
  }

  /** Change how many chunks upload in parallel (e.g. fewer while a live call needs the bandwidth). */
  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, concurrency);
    this.processQueue();
  }

  /** Re-attempt every chunk that previously exhausted its retries. */
  retryFailed(): void {
    if (this.destroyed || this.failedTasks.length === 0) return;
    const tasks = this.failedTasks.splice(0);
    for (const task of tasks) {
      task.attempts = 0;
      this.queue.push(task);
    }
    this.emitProgress();
    this.processQueue();
  }

  getStats(): UploadStats & { active: number } {
    return { ...this.snapshot(), active: this.activeUploads };
  }

  /** True while any chunk is queued, uploading, or failed (i.e. leaving would lose data). */
  hasUnfinishedWork(): boolean {
    return this.pendingPersists > 0 || this.queue.length > 0 || this.activeUploads > 0 || this.failedTasks.length > 0 || (this.recordingStopped && !this.completed);
  }

  /**
   * Destroy the queue and release all blob references
   */
  destroy(): void {
    this.destroyed = true;
    this.queue = [];
    this.failedTasks = [];
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
    }
  }

  // --- Internal ---

  private handleOnline = () => {
    this.waitingForOnline = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
    }
    this.processQueue();
  };

  private isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  private waitForOnline(): void {
    if (this.waitingForOnline || typeof window === 'undefined') return;
    this.waitingForOnline = true;
    window.addEventListener('online', this.handleOnline);
  }

  private processQueue(): void {
    if (this.isOffline()) {
      this.waitForOnline();
      return;
    }
    while (this.activeUploads < this.concurrency && this.queue.length > 0 && !this.destroyed) {
      const task = this.queue.shift()!;
      this.activeUploads++;
      this.uploadChunk(task);
    }
  }

  private async uploadChunk(task: ChunkTask): Promise<void> {
    const blob = task.blob ?? (this.storeKey ? await chunkStore.getChunk(this.storeKey, task.chunkIndex) : null);
    if (!blob) {
      // The data is gone (storage cleared, or an in-memory chunk from a crashed tab). Nothing to retry.
      this.activeUploads--;
      this.lostChunks.push(task.chunkIndex);
      this.processQueue();
      this.checkCompletion();
      return;
    }
    if (!task.size) {
      task.size = blob.size;
      this.totalBytes += blob.size;
    }
    try {
      const presignedRes = await fetch('/api/upload/presigned-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({
          sessionId: this.sessionId,
          participantType: this.participantType,
          chunkIndex: task.chunkIndex,
          sizeBytes: blob.size,
        }),
      });

      if (!presignedRes.ok) {
        throw new Error(`Presigned URL request failed: HTTP ${presignedRes.status}`);
      }

      const { uploadUrl, method } = await presignedRes.json();

      let uploadRes: Response;
      let etag: string | null = null;

      if (method === 'PUT') {
        // Direct-to-R2/S3 presigned PUT
        uploadRes = await fetch(uploadUrl, {
          method: 'PUT',
          body: blob,
          headers: { 'Content-Type': blob.type || 'video/webm' },
        });
        etag = uploadRes.headers.get('etag') || null;
      } else {
        // Local storage: upload via the server chunk endpoint
        const formData = new FormData();
        formData.append('file', blob, `chunk-${task.chunkIndex}.webm`);
        formData.append('sessionId', this.sessionId);
        formData.append('participantType', this.participantType);
        formData.append('chunkIndex', String(task.chunkIndex));

        uploadRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.authToken}` },
          body: formData,
        });
      }

      if (!uploadRes.ok) {
        throw new Error(`Upload failed with HTTP ${uploadRes.status}`);
      }

      if (method === 'PUT') {
        const confirmRes = await fetch('/api/upload/chunk-confirm', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.authToken}`,
          },
          body: JSON.stringify({
            sessionId: this.sessionId,
            participantType: this.participantType,
            chunkIndex: task.chunkIndex,
            etag,
            sizeBytes: blob.size,
          }),
        });

        if (!confirmRes.ok) {
          throw new Error(`Chunk confirm failed with HTTP ${confirmRes.status}`);
        }
      }

      this.uploadedCount++;
      this.uploadedBytes += blob.size;
      this.activeUploads--;
      // Confirmed by the server: the local copy is no longer needed.
      task.blob = undefined;
      if (this.storeKey) chunkStore.deleteChunk(this.storeKey, task.chunkIndex);
      this.emitProgress();
      this.onChunkUploaded?.(task.chunkIndex, this.queue.length);
    } catch (error) {
      this.activeUploads--;

      if (this.isOffline()) {
        // Network is down: park the chunk without spending a retry attempt.
        this.queue.unshift(task);
        this.waitForOnline();
      } else if (task.attempts + 1 < this.maxRetries) {
        task.attempts++;
        const delay = Math.min(MAX_BACKOFF_MS, this.retryDelayMs * Math.pow(2, task.attempts - 1));
        setTimeout(() => {
          if (!this.destroyed) {
            this.queue.push(task);
            this.processQueue();
          }
        }, delay);
      } else {
        console.error(`[UploadQueue] Chunk ${task.chunkIndex} failed after ${this.maxRetries} attempts:`, error);
        this.failedTasks.push(task);
        this.emitProgress();
        this.onChunkFailed?.(task.chunkIndex, error as Error);
      }
    }

    this.processQueue();
    this.checkCompletion();
  }

  private snapshot(): UploadStats {
    return {
      uploaded: this.uploadedCount,
      pending: this.queue.length + this.activeUploads,
      failed: this.failedTasks.length,
      total: this.totalEnqueued,
      uploadedBytes: this.uploadedBytes,
      totalBytes: this.totalBytes,
    };
  }

  private emitProgress(): void {
    this.onProgress?.(this.snapshot());
  }

  private checkCompletion(): void {
    if (!this.recordingStopped || this.destroyed || this.completed) return;
    if (this.pendingPersists > 0 || this.queue.length > 0 || this.activeUploads > 0) return;

    if (this.failedTasks.length > 0) {
      this.onUploadsFailed?.(this.failedTasks.length, this.totalEnqueued);
    } else {
      this.completed = true;
      this.onAllUploadsComplete?.(this.totalEnqueued);
    }
  }
}
