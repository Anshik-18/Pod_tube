import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import os from 'os';
import { ProcessingJob } from '../db/queries/processing-jobs';
import { Episode, getEpisodeById } from '../db/queries/episodes';
import { getSessionById } from '../db/queries/sessions';
import { getAllSessionChunks, RecordingChunk } from '../db/queries/chunks';
import { getStorageProvider } from '../storage';
import { isParticipantId, sortParticipantIds } from '../participants';

export type ParticipantType = string;

/** Chunks fetched from storage at once. */
const DOWNLOAD_CONCURRENCY = 6;
const DOWNLOAD_RETRIES = 3;
/**
 * Peak scratch space relative to the raw chunk bytes: chunks + joined track + remuxed track,
 * plus the encoded episode, MP3 and per-track copies. Chunk files are deleted as soon as they
 * are joined, so this is conservative.
 */
const DISK_FACTOR = 3.2;
const DISK_HEADROOM_BYTES = 512 * 1024 * 1024;

export interface DownloadedChunkInfo {
  index: number;
  storageKey: string;
  localPath: string;
  sizeBytes: number;
}

export interface ParticipantDownloadResult {
  participantType: ParticipantType;
  directory: string;
  /** 'chunks' for a fresh recording, 'track' when re-exporting from the saved source track. */
  source: 'chunks' | 'track';
  chunks: DownloadedChunkInfo[];
  /** Chunk indices that never arrived (between 0 and the last chunk that did). */
  missingIndices: number[];
  /** Set when source === 'track'. */
  trackPath?: string;
  totalSizeBytes: number;
}

/** A track that couldn't be used at all, reported to the host instead of failing the episode. */
export interface UnusableTrack {
  participantType: ParticipantType;
  reason: string;
}

export interface JobDownloadResult {
  jobId: string;
  episodeId: string;
  sessionId: string;
  episode: Episode;
  workingDirectory: string;
  participants: Record<ParticipantType, ParticipantDownloadResult>;
  unusable: UnusableTrack[];
  totalDownloadedChunks: number;
  totalSizeBytes: number;
}

export interface ChunkSelection {
  chunks: RecordingChunk[];
  missingIndices: number[];
  /** False when chunk 0 (the only one carrying the WebM header) is missing. */
  decodable: boolean;
}

/**
 * Pick the chunks to assemble for one track. Every uploaded chunk is used: a missing chunk
 * becomes a short gap (the demuxer resyncs at the next cluster) instead of discarding everything
 * after it. Chunk 0 is required — it holds the header that describes the codecs.
 */
export function selectChunks(chunks: RecordingChunk[]): ChunkSelection {
  const completed = new Map(chunks.filter((c) => c.status === 'completed').map((c) => [c.chunk_index, c]));
  const sorted = Array.from(completed.values()).sort((a, b) => a.chunk_index - b.chunk_index);
  const last = sorted.length ? sorted[sorted.length - 1].chunk_index : -1;
  const missingIndices: number[] = [];
  for (let i = 0; i <= last; i++) if (!completed.has(i)) missingIndices.push(i);
  return { chunks: sorted, missingIndices, decodable: completed.has(0) };
}

/** @deprecated kept for callers/tests that want only the gap-free run from chunk 0. */
export function contiguousPrefix(chunks: RecordingChunk[]): RecordingChunk[] {
  const { chunks: sorted } = selectChunks(chunks);
  const result: RecordingChunk[] = [];
  for (let i = 0; i < sorted.length && sorted[i].chunk_index === i; i++) result.push(sorted[i]);
  return result;
}

/**
 * Stream an object from storage to a local file without buffering it in the V8 heap.
 * Retries transient storage errors.
 */
async function downloadToFile(storageKey: string, destPath: string): Promise<number> {
  const storage = getStorageProvider();
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      const readStream = await storage.getStream(storageKey);
      await pipeline(readStream, createWriteStream(destPath));
      return (await fs.stat(destPath)).size;
    } catch (err) {
      lastError = err;
      await fs.rm(destPath, { force: true });
      if (attempt < DOWNLOAD_RETRIES) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(`Failed to download ${storageKey}: ${(lastError as Error)?.message ?? lastError}`);
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const TMPFS_MAGIC = 0x01021994;

/**
 * Scratch directory for processing. Long recordings need several GB, so never use a RAM-backed
 * tmpfs (Fedora's /tmp, some container setups): that would consume memory, not disk.
 * Override with PROCESSING_WORK_DIR.
 */
export async function resolveWorkRoot(): Promise<string> {
  if (process.env.PROCESSING_WORK_DIR) return process.env.PROCESSING_WORK_DIR;
  const tmp = process.env.TMPDIR || os.tmpdir();
  const statfs = (fs as unknown as { statfs?: (p: string) => Promise<{ type: number }> }).statfs;
  try {
    if (statfs && (await statfs(tmp)).type === TMPFS_MAGIC) {
      return path.join(process.cwd(), '.processing');
    }
  } catch {
    // Unknown filesystem: use the temp dir.
  }
  return tmp;
}

async function ensureDiskSpace(directory: string, neededBytes: number): Promise<void> {
  const statfs = (fs as unknown as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> }).statfs;
  if (!statfs) return;
  try {
    const stats = await statfs(directory);
    const free = stats.bavail * stats.bsize;
    if (free < neededBytes) {
      const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
      throw new Error(`Not enough disk space to process this recording: needs about ${gb(neededBytes)} GB, ${gb(free)} GB free.`);
    }
  } catch (err) {
    if ((err as Error).message.startsWith('Not enough disk space')) throw err;
    // statfs unsupported on this platform: proceed.
  }
}

/**
 * downloadChunksStage
 *
 * Fetches each participant's source media into <tmp>/podnow/<jobId>/<participant>/.
 * Fresh recordings come from uploaded chunks; re-exports (after chunks were consolidated
 * and cleaned up) come from the saved per-participant track.
 */
export async function downloadChunksStage(
  job: ProcessingJob,
  onProgress?: (fraction: number) => void
): Promise<JobDownloadResult> {
  const episode = await getEpisodeById(job.episode_id);
  if (!episode) {
    throw new Error(`Episode not found: ${job.episode_id}`);
  }

  const session = await getSessionById(episode.session_id);
  if (!session) {
    throw new Error(`Session not found for episode ${job.episode_id}`);
  }

  const allChunks = await getAllSessionChunks(session.id);
  const savedTracks = episode.file_references?.tracks ?? {};

  const plan: Array<{ participantType: ParticipantType; chunks: RecordingChunk[]; missingIndices: number[]; trackKey?: string }> = [];
  const unusable: UnusableTrack[] = [];
  const participantIds = sortParticipantIds(
    [...allChunks.map((c) => c.participant_type), ...Object.keys(savedTracks)].filter(isParticipantId)
  );
  for (const participantType of participantIds) {
    const selection = selectChunks(allChunks.filter((c) => c.participant_type === participantType));
    if (selection.chunks.length > 0 && selection.decodable) {
      if (selection.missingIndices.length) {
        console.warn(`[DownloadStage] ${participantType}: ${selection.missingIndices.length} chunk(s) missing (${selection.missingIndices.join(', ')}); assembling around the gaps`);
      }
      plan.push({ participantType, chunks: selection.chunks, missingIndices: selection.missingIndices });
    } else if (savedTracks[participantType]) {
      plan.push({ participantType, chunks: [], missingIndices: [], trackKey: savedTracks[participantType] });
    } else if (selection.chunks.length > 0) {
      console.warn(`[DownloadStage] ${participantType}: first chunk missing, track can't be decoded`);
      unusable.push({ participantType, reason: 'The start of this recording never uploaded, so it couldn’t be decoded.' });
    }
  }

  if (plan.length === 0) {
    throw new Error('No recording data found for this session. The upload may not have completed.');
  }

  const workingDirectory = path.join(await resolveWorkRoot(), 'podnow', job.id);
  await fs.rm(workingDirectory, { recursive: true, force: true });
  await fs.mkdir(workingDirectory, { recursive: true });

  // Fail fast with a clear message instead of dying halfway with ENOSPC.
  const storage = getStorageProvider();
  let expectedBytes = 0;
  for (const item of plan) {
    if (item.trackKey) expectedBytes += (await storage.size(item.trackKey).catch(() => null)) ?? 0;
    else expectedBytes += item.chunks.reduce((n, c) => n + Number(c.size_bytes || 0), 0);
  }
  await ensureDiskSpace(workingDirectory, expectedBytes * DISK_FACTOR + DISK_HEADROOM_BYTES);

  const totalFiles = plan.reduce((n, p) => n + (p.trackKey ? 1 : p.chunks.length), 0);
  let filesDone = 0;
  const participants: JobDownloadResult['participants'] = {};
  let totalDownloadedChunks = 0;
  let totalSizeBytes = 0;

  for (const item of plan) {
    const directory = path.join(workingDirectory, item.participantType);
    await fs.mkdir(directory, { recursive: true });

    if (item.trackKey) {
      const trackPath = path.join(directory, `track${path.extname(item.trackKey) || '.webm'}`);
      const size = await downloadToFile(item.trackKey, trackPath);
      participants[item.participantType] = {
        participantType: item.participantType,
        directory,
        source: 'track',
        chunks: [],
        missingIndices: [],
        trackPath,
        totalSizeBytes: size,
      };
      totalSizeBytes += size;
      onProgress?.(++filesDone / totalFiles);
      continue;
    }

    const downloaded = await mapLimit(item.chunks, DOWNLOAD_CONCURRENCY, async (chunk) => {
      const localPath = path.join(directory, `chunk_${String(chunk.chunk_index).padStart(5, '0')}.webm`);
      const sizeBytes = await downloadToFile(chunk.storage_key, localPath);
      onProgress?.(++filesDone / totalFiles);
      return { index: chunk.chunk_index, storageKey: chunk.storage_key, localPath, sizeBytes } satisfies DownloadedChunkInfo;
    });
    const participantSize = downloaded.reduce((n, c) => n + c.sizeBytes, 0);
    totalDownloadedChunks += downloaded.length;

    participants[item.participantType] = {
      participantType: item.participantType,
      directory,
      source: 'chunks',
      chunks: downloaded,
      missingIndices: item.missingIndices,
      totalSizeBytes: participantSize,
    };
    totalSizeBytes += participantSize;
  }

  console.log(`[DownloadStage] Downloaded ${filesDone} file(s), ${(totalSizeBytes / (1024 * 1024)).toFixed(2)} MB for job ${job.id}`);

  return {
    jobId: job.id,
    episodeId: episode.id,
    sessionId: session.id,
    episode,
    workingDirectory,
    participants,
    unusable,
    totalDownloadedChunks,
    totalSizeBytes,
  };
}
