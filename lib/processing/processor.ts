/**
 * Entry point for requesting episode processing. The actual FFmpeg pipeline runs in
 * the background ProcessingWorker (lib/worker), which claims jobs from PostgreSQL.
 */

import { enqueueProcessingJob } from '@/lib/db/queries/processing-jobs';

export interface ProcessingOptions {
  trimStart?: number; // seconds
  trimEnd?: number; // seconds
  quality?: 'low' | 'medium' | 'high';
}

export async function queueProcessing(episodeId: string): Promise<void> {
  await enqueueProcessingJob(episodeId);
}
