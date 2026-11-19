import fs from 'fs/promises';
import { getStorageProvider } from '../storage';
import { getAllSessionChunks, deleteSessionChunks } from '../db/queries/chunks';

/**
 * cleanupR2ChunksStage
 *
 * Deletes raw recording chunks once their consolidated per-participant track has been saved.
 * Re-exports read from those tracks, so the chunks are no longer needed.
 */
export async function cleanupR2ChunksStage(sessionId: string): Promise<void> {
  const storage = getStorageProvider();
  const chunks = await getAllSessionChunks(sessionId);

  for (const chunk of chunks) {
    if (!chunk.storage_key) continue;
    try {
      await storage.delete(chunk.storage_key);
    } catch (error: any) {
      throw new Error(`Failed to delete chunk object ${chunk.storage_key}: ${error?.message || error}`);
    }
  }

  const deletedCount = await deleteSessionChunks(sessionId);
  console.log(`[CleanupStage] Removed ${deletedCount} chunk(s) for session ${sessionId}`);
}

/**
 * cleanupStage
 *
 * Removes the temporary working directory (<tmp>/podnow/<jobId>).
 */
export async function cleanupStage(workingDirectory: string): Promise<void> {
  try {
    await fs.rm(workingDirectory, { recursive: true, force: true });
  } catch (error: any) {
    console.warn(`[CleanupStage] Failed to remove working directory ${workingDirectory}:`, error?.message || error);
  }
}
