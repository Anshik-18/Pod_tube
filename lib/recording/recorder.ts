/**
 * Browser-based recording using MediaRecorder API
 *
 * Refactored to stream chunks directly to an upload queue without
 * accumulating video data in memory. Captures precise browser wall-clock
 * timeline timestamps (recordingStartedAt, recordingEndedAt) for multi-track synchronization.
 */

export interface RecordingOptions {
  mimeType?: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
  /** MediaRecorder timeslice in ms. Controls how frequently ondataavailable fires. Default: 30000 (30s). */
  timesliceMs?: number;
}

export interface ChunkHandler {
  /** Called synchronously when a new chunk is available. Must not block. */
  onChunk(chunkIndex: number, blob: Blob): void;
}

export interface RecordingResult {
  totalChunks: number;
  recordingStartedAt: Date;
  recordingEndedAt: Date;
}

export class BrowserRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunkIndex = 0;
  private chunkHandler: ChunkHandler | null = null;
  private timesliceMs: number = 30000;
  private recordingStartedAt: Date | null = null;
  private recordingEndedAt: Date | null = null;

  /**
   * Set the chunk handler that receives blobs as they are recorded.
   * The handler's onChunk method is called synchronously and must not block.
   */
  setChunkHandler(handler: ChunkHandler): void {
    this.chunkHandler = handler;
  }

  async startRecording(
    stream: MediaStream,
    options: RecordingOptions = {}
  ): Promise<void> {
    this.stream = stream;
    this.chunkIndex = 0;
    this.timesliceMs = options.timesliceMs ?? 30000;
    this.recordingStartedAt = new Date();
    this.recordingEndedAt = null;

    // Validate stream has active tracks
    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();

    if (videoTracks.length === 0 && audioTracks.length === 0) {
      throw new Error('Stream has no active tracks');
    }

    // Check that tracks are enabled
    const allTracks = [...videoTracks, ...audioTracks];
    const inactiveTracks = allTracks.filter(track => track.readyState !== 'live');
    if (inactiveTracks.length > 0) {
      throw new Error(`Stream has ${inactiveTracks.length} inactive track(s)`);
    }

    // Determine MIME type - try multiple if one fails
    const mimeTypes = options.mimeType
      ? [options.mimeType, ...this.getSupportedMimeTypes()]
      : this.getSupportedMimeTypes();

    if (mimeTypes.length === 0) {
      throw new Error('No supported MIME type found for recording');
    }

    let lastError: Error | null = null;

    // Try each MIME type until one works
    for (const mimeType of mimeTypes) {
      try {
        // Clean up previous attempt if any
        if (this.mediaRecorder) {
          try {
            if (this.mediaRecorder.state !== 'inactive') {
              this.mediaRecorder.stop();
            }
          } catch (e) {
            // Ignore cleanup errors
          }
          this.mediaRecorder = null;
        }

        this.mediaRecorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: options.videoBitsPerSecond,
          audioBitsPerSecond: options.audioBitsPerSecond,
        });

        this.mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            const currentIndex = this.chunkIndex++;

            // Fire-and-forget: enqueue chunk for background upload.
            // This NEVER awaits, blocks, or accumulates blobs in memory.
            if (this.chunkHandler) {
              this.chunkHandler.onChunk(currentIndex, event.data);
            }
          }
        };

        this.mediaRecorder.onerror = (event) => {
          console.error('MediaRecorder error:', event);
        };

        // Capture exact start timestamp before starting recorder
        this.recordingStartedAt = new Date();

        // Start recording with configurable timeslice
        this.mediaRecorder.start(this.timesliceMs);

        // If we get here, it worked!
        return;
      } catch (error) {
        lastError = error as Error;
        console.warn(`Failed to start recording with MIME type ${mimeType}:`, error);
        // Continue to next MIME type
      }
    }

    // If we get here, all MIME types failed
    throw new Error(`Failed to start recording with any supported MIME type. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Stop recording. Captures recordingEndedAt timestamp and returns session metadata.
   */
  stopRecording(): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      this.recordingEndedAt = new Date();

      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve({
          totalChunks: this.chunkIndex,
          recordingStartedAt: this.recordingStartedAt || new Date(),
          recordingEndedAt: this.recordingEndedAt,
        });
        return;
      }

      this.mediaRecorder.onstop = () => {
        this.recordingEndedAt = new Date();
        resolve({
          totalChunks: this.chunkIndex,
          recordingStartedAt: this.recordingStartedAt || new Date(),
          recordingEndedAt: this.recordingEndedAt,
        });
      };

      this.mediaRecorder.onerror = (event) => {
        reject(new Error('Recording error'));
      };

      this.mediaRecorder.stop();
    });
  }

  getRecordingStartedAt(): Date | null {
    return this.recordingStartedAt;
  }

  getRecordingEndedAt(): Date | null {
    return this.recordingEndedAt;
  }

  getTotalChunks(): number {
    return this.chunkIndex;
  }

  pause(): void {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
    }
  }

  resume(): void {
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
    }
  }

  getMimeType(): string {
    return this.mediaRecorder?.mimeType || '';
  }

  getState(): string {
    return this.mediaRecorder?.state || 'inactive';
  }

  /** Stop recording without stopping the source tracks (they're still used by the call). */
  cleanupRecorderOnly(): void {
    if (this.mediaRecorder) {
      try {
        if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
      } catch {
        // Ignore
      }
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder = null;
    }
    this.chunkHandler = null;
  }

  cleanup(): void {
    if (this.mediaRecorder) {
      try {
        if (this.mediaRecorder.state !== 'inactive') {
          this.mediaRecorder.stop();
        }
      } catch (e) {
        // Ignore
      }
      this.mediaRecorder = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.chunkHandler = null;
    this.recordingStartedAt = null;
    this.recordingEndedAt = null;
  }

  private getSupportedMimeTypes(): string[] {
    // H.264 first: Chrome/Edge encode it in hardware on most machines (and with OpenH264 in
    // software elsewhere, still cheaper than libvpx), leaving CPU for the live call. The worker
    // stores H.264 tracks as MKV. VP8 is the fallback; Safari only offers MP4.
    const types = [
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
    ];

    return types.filter(type => MediaRecorder.isTypeSupported(type));
  }
}
