/**
 * Storage cleanup utilities
 * Handles deletion of old episodes and raw recordings
 */

import { getStorageProvider } from '@/lib/storage';
import { getEpisodeById, deleteEpisode } from '@/lib/db/queries/episodes';
import { getAllSessionChunks } from '@/lib/db/queries/chunks';

/** Collect every storage key in a (possibly nested) file_references object. */
function collectStorageKeys(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (value.trim().length > 0 && value.includes('/')) into.add(value);
  } else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectStorageKeys(nested, into);
  }
}

export interface CleanupStats {
  episodesDeleted: number;
  filesDeleted: number;
  errors: number;
  totalSpaceFreed: number; // in bytes (approximate)
}

/**
 * Safely delete an episode and its referenced media files from storage (Cloudflare R2).
 * 
 * Requirement:
 * 1. Load episode from database.
 * 2. Read stored file reference(s).
 * 3. Delete every referenced object using StorageProvider.delete().
 * 4. Only after successful storage deletion, delete the episode database record.
 * 
 * If storage deletion fails:
 * - Do NOT delete the database row.
 * - Throw an error to prevent orphaned files or inconsistent state.
 */
export async function deleteEpisodeWithStorageCleanup(episodeId: string): Promise<void> {
  const episode = await getEpisodeById(episodeId);
  if (!episode) {
    throw new Error('Episode not found');
  }

  const storage = getStorageProvider();
  const keysToDelete = new Set<string>();

  // Every exported file and saved participant track referenced by the episode
  collectStorageKeys(episode.file_references, keysToDelete);

  // Standard output keys, in case file_references was never written
  keysToDelete.add(`episodes/${episodeId}/episode.mp4`);
  keysToDelete.add(`episodes/${episodeId}/audio.mp3`);
  keysToDelete.add(`episodes/${episodeId}/thumbnail.jpg`);

  // Raw chunks left behind by an unfinished or failed recording
  try {
    for (const chunk of await getAllSessionChunks(episode.session_id)) {
      keysToDelete.add(chunk.storage_key);
    }
  } catch (error) {
    console.warn(`[Episode Delete] Could not list chunks for session ${episode.session_id}:`, error);
  }


  // Step 3: Delete every referenced object using StorageProvider.delete()
  for (const storageKey of keysToDelete) {
    try {
      // delete() is a no-op for missing objects on both providers
      await storage.delete(storageKey);
    } catch (error: any) {
      console.error(`[Episode Delete] Failed to delete storage object ${storageKey}:`, error);
      throw new Error(`Storage deletion failed for ${storageKey}: ${error?.message || error}`);
    }
  }

  // Step 4: Only after successful storage deletion, delete the episode database record
  await deleteEpisode(episodeId);
}

/**
 * Clean up episodes older than the retention period
 * @param retentionDays Number of days to keep episodes (default: 7)
 * @returns Cleanup statistics
 */
export async function cleanupOldEpisodes(retentionDays: number = 7): Promise<CleanupStats> {
  const stats: CleanupStats = {
    episodesDeleted: 0,
    filesDeleted: 0,
    errors: 0,
    totalSpaceFreed: 0,
  };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  console.log(`[Cleanup] Starting cleanup of episodes older than ${retentionDays} days (before ${cutoffDate.toISOString()})`);

  try {
    const allEpisodes = await getAllEpisodes();
    
    for (const episode of allEpisodes) {
      if (episode.state === 'ready' && episode.created_at < cutoffDate) {
        try {
          await deleteEpisodeWithStorageCleanup(episode.id);
          stats.episodesDeleted++;
          console.log(`[Cleanup] Deleted episode: ${episode.id} (created: ${episode.created_at})`);
        } catch (error) {
          console.error(`[Cleanup] Error deleting episode ${episode.id}:`, error);
          stats.errors++;
        }
      }
    }
  } catch (error) {
    console.error('[Cleanup] Error during episode cleanup:', error);
    stats.errors++;
  }

  console.log(`[Cleanup] Completed: ${stats.episodesDeleted} episodes deleted, ${stats.errors} errors`);
  return stats;
}

/**
 * Get all episodes (helper function)
 */
async function getAllEpisodes() {
  const { getDbPool } = await import('@/lib/db/client');
  const pool = getDbPool();
  const result = await pool.query(
    'SELECT * FROM episodes WHERE state = $1 ORDER BY created_at',
    ['ready']
  );
  return result.rows;
}

/**
 * Mark episodes that have been stuck in 'processing' for too long as failed, so the owner
 * sees an error with a Retry button instead of an endless spinner. Nothing is deleted.
 */
export async function cleanupStuckEpisodes(maxProcessingHours: number = 24): Promise<CleanupStats> {
  const stats: CleanupStats = {
    episodesDeleted: 0,
    filesDeleted: 0,
    errors: 0,
    totalSpaceFreed: 0,
  };

  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - maxProcessingHours);

  try {
    const { getDbPool } = await import('@/lib/db/client');
    const pool = getDbPool();
    const result = await pool.query(
      `UPDATE episodes e SET state = 'failed'
       WHERE e.state = 'processing'
         AND e.created_at < $1
         AND NOT EXISTS (
           SELECT 1 FROM processing_jobs pj
           WHERE pj.episode_id = e.id AND pj.status IN ('pending', 'processing') AND pj.updated_at >= $1
         )
       RETURNING e.id`,
      [cutoffDate]
    );
    console.log(`[Cleanup] Marked ${result.rowCount ?? 0} stuck episode(s) as failed`);
  } catch (error) {
    console.error('[Cleanup] Error during stuck episode cleanup:', error);
    stats.errors++;
  }

  return stats;
}

/**
 * Delete a session and everything it owns: its episode's exports and tracks plus any raw chunks.
 */
export async function deleteSessionWithStorageCleanup(sessionId: string): Promise<void> {
  const { getEpisodeBySessionId } = await import('@/lib/db/queries/episodes');
  const { deleteSession } = await import('@/lib/db/queries/sessions');
  const episode = await getEpisodeBySessionId(sessionId);
  if (episode) {
    await deleteEpisodeWithStorageCleanup(episode.id);
  } else {
    const storage = getStorageProvider();
    for (const chunk of await getAllSessionChunks(sessionId)) {
      await storage.delete(chunk.storage_key);
    }
  }
  await deleteSession(sessionId);
}
