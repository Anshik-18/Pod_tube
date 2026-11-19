import { getDbPool } from '../client';

export interface RecordingChunk {
  id: string;
  session_id: string;
  participant_type: string;
  chunk_index: number;
  storage_key: string;
  size_bytes: number;
  etag: string | null;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  attempts: number;
  created_at: string;
  updated_at: string;
}

/**
 * Upsert chunk record in recording_chunks
 */
export async function recordChunkMetadata(
  sessionId: string,
  participantType: string,
  chunkIndex: number,
  storageKey: string,
  sizeBytes: number,
  status: 'pending' | 'uploading' | 'completed' | 'failed' = 'pending',
  attempts = 0,
  etag: string | null = null
): Promise<RecordingChunk> {
  const pool = getDbPool();

  const result = await pool.query<RecordingChunk>(
    `INSERT INTO recording_chunks (
      session_id, participant_type, chunk_index, storage_key, size_bytes, status, attempts, etag, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (session_id, participant_type, chunk_index)
    DO UPDATE SET
      storage_key = EXCLUDED.storage_key,
      size_bytes = EXCLUDED.size_bytes,
      status = EXCLUDED.status,
      attempts = EXCLUDED.attempts,
      etag = COALESCE(EXCLUDED.etag, recording_chunks.etag),
      updated_at = NOW()
    RETURNING *;`,
    [sessionId, participantType, chunkIndex, storageKey, sizeBytes, status, attempts, etag]
  );

  return result.rows[0];
}

/**
 * Update status and ETag of a chunk
 */
export async function updateChunkStatus(
  sessionId: string,
  participantType: string,
  chunkIndex: number,
  status: 'pending' | 'uploading' | 'completed' | 'failed',
  attempts?: number,
  etag?: string | null
): Promise<RecordingChunk | null> {
  const pool = getDbPool();

  const setClauses = ['status = $1', 'updated_at = NOW()'];
  const params: any[] = [status];
  let paramIdx = 2;

  if (attempts !== undefined) {
    setClauses.push(`attempts = $${paramIdx++}`);
    params.push(attempts);
  }

  if (etag !== undefined) {
    setClauses.push(`etag = $${paramIdx++}`);
    params.push(etag);
  }

  params.push(sessionId, participantType, chunkIndex);

  const sql = `
    UPDATE recording_chunks
    SET ${setClauses.join(', ')}
    WHERE session_id = $${paramIdx++} AND participant_type = $${paramIdx++} AND chunk_index = $${paramIdx}
    RETURNING *;
  `;

  const result = await pool.query<RecordingChunk>(sql, params);
  return result.rows[0] || null;
}

/**
 * Get all chunks for a session & participant
 */
export async function getSessionChunks(
  sessionId: string,
  participantType: string
): Promise<RecordingChunk[]> {
  const pool = getDbPool();

  const result = await pool.query<RecordingChunk>(
    `SELECT * FROM recording_chunks
     WHERE session_id = $1 AND participant_type = $2
     ORDER BY chunk_index ASC;`,
    [sessionId, participantType]
  );

  return result.rows;
}

/**
 * Get all chunks for a session across all participants, ordered by participant_type and chunk_index ASC.
 */
export async function getAllSessionChunks(sessionId: string): Promise<RecordingChunk[]> {
  const pool = getDbPool();

  const result = await pool.query<RecordingChunk>(
    `SELECT * FROM recording_chunks
     WHERE session_id = $1
     ORDER BY participant_type ASC, chunk_index ASC;`,
    [sessionId]
  );

  return result.rows;
}

/**
 * Verify chunk integrity: Check that all indices from 0 to expectedTotalChunks - 1 exist,
 * have status = 'completed', and have no missing gaps.
 */
export async function verifyChunkIntegrity(
  sessionId: string,
  participantType: string,
  expectedTotalChunks: number
): Promise<{ valid: boolean; missingIndices: number[]; failedIndices: number[]; totalFound: number }> {
  const chunks = await getSessionChunks(sessionId, participantType);
  const chunkMap = new Map<number, RecordingChunk>();

  for (const chunk of chunks) {
    chunkMap.set(chunk.chunk_index, chunk);
  }

  const missingIndices: number[] = [];
  const failedIndices: number[] = [];

  for (let i = 0; i < expectedTotalChunks; i++) {
    const chunk = chunkMap.get(i);
    if (!chunk) {
      missingIndices.push(i);
    } else if (chunk.status !== 'completed') {
      failedIndices.push(i);
    }
  }

  return {
    valid: missingIndices.length === 0 && failedIndices.length === 0,
    missingIndices,
    failedIndices,
    totalFound: chunkMap.size,
  };
}

/**
 * Delete all recording chunks for a session from database
 */
export async function deleteSessionChunks(sessionId: string): Promise<number> {
  const pool = getDbPool();

  const result = await pool.query(
    'DELETE FROM recording_chunks WHERE session_id = $1;',
    [sessionId]
  );

  return result.rowCount || 0;
}

/** Every track id that has (or had) chunks in this session. */
export async function getChunkParticipantTypes(sessionId: string): Promise<string[]> {
  const pool = getDbPool();
  const result = await pool.query<{ participant_type: string }>(
    'SELECT DISTINCT participant_type FROM recording_chunks WHERE session_id = $1',
    [sessionId]
  );
  return result.rows.map((r) => r.participant_type);
}
