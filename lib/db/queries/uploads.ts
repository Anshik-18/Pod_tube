import { getDbPool } from '../client';

export type UploadStatus = 'pending' | 'uploading' | 'completed' | 'failed';

export type ParticipantType = string;

export interface Upload {
  id: string;
  session_id: string;
  participant_type: ParticipantType;
  file_reference: string;
  status: UploadStatus;
  progress: number;
  total_chunks: number | null;
  recording_duration: number | null;
  recording_started_at: Date | null;
  recording_ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function createUpload(
  sessionId: string,
  participantType: ParticipantType,
  fileReference: string
): Promise<Upload> {
  const pool = getDbPool();
  const result = await pool.query<Upload>(
    'INSERT INTO uploads (session_id, participant_type, file_reference, status) VALUES ($1, $2, $3, $4) RETURNING *',
    [sessionId, participantType, fileReference, 'pending']
  );
  return result.rows[0];
}

export async function getUploadById(id: string): Promise<Upload | null> {
  const pool = getDbPool();
  const result = await pool.query<Upload>(
    'SELECT * FROM uploads WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function updateUploadStatus(
  id: string,
  status: UploadStatus,
  progress?: number
): Promise<Upload> {
  const pool = getDbPool();
  let query: string;
  let params: any[];

  if (progress !== undefined) {
    query = 'UPDATE uploads SET status = $1, progress = $2, updated_at = NOW() WHERE id = $3 RETURNING *';
    params = [status, progress, id];
  } else {
    query = 'UPDATE uploads SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *';
    params = [status, id];
  }

  const result = await pool.query<Upload>(query, params);
  return result.rows[0];
}

export async function getUploadsBySessionId(sessionId: string): Promise<Upload[]> {
  const pool = getDbPool();
  const result = await pool.query<Upload>(
    'SELECT * FROM uploads WHERE session_id = $1 ORDER BY created_at',
    [sessionId]
  );
  return result.rows;
}

/**
 * Register that a participant has started recording, so finalize waits for their track
 * even if none of their chunks has reached the server yet.
 */
export async function registerRecordingParticipant(
  sessionId: string,
  participantType: ParticipantType,
  recordingStartedAt: Date
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO uploads (session_id, participant_type, file_reference, status, recording_started_at)
     SELECT $1::uuid, $2::varchar, $3::varchar, 'uploading', $4::timestamptz
     WHERE NOT EXISTS (SELECT 1 FROM uploads WHERE session_id = $1::uuid AND participant_type = $2::varchar)`,
    [sessionId, participantType, `sessions/${sessionId}/${participantType}/recording.webm`, recordingStartedAt]
  );
}

/**
 * Record participant timeline timestamps (recording_started_at and recording_ended_at)
 * in the uploads table for synchronization.
 */
export async function recordParticipantTimeline(
  sessionId: string,
  participantType: ParticipantType,
  totalChunks: number,
  recordingDuration?: number,
  recordingStartedAt?: Date | string,
  recordingEndedAt?: Date | string
): Promise<Upload> {
  const pool = getDbPool();
  const fileRef = `sessions/${sessionId}/${participantType}/recording.webm`;
  const startDate = recordingStartedAt ? new Date(recordingStartedAt) : null;
  const endDate = recordingEndedAt ? new Date(recordingEndedAt) : null;

  const existing = await pool.query<Upload>(
    'SELECT * FROM uploads WHERE session_id = $1 AND participant_type = $2 LIMIT 1',
    [sessionId, participantType]
  );

  if (existing.rows.length > 0) {
    const updated = await pool.query<Upload>(
      `UPDATE uploads 
       SET total_chunks = $1,
           recording_duration = $2,
           recording_started_at = COALESCE($3, recording_started_at),
           recording_ended_at = COALESCE($4, recording_ended_at),
           status = 'completed',
           updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [totalChunks, recordingDuration || null, startDate, endDate, existing.rows[0].id]
    );
    return updated.rows[0];
  } else {
    const created = await pool.query<Upload>(
      `INSERT INTO uploads (session_id, participant_type, file_reference, status, total_chunks, recording_duration, recording_started_at, recording_ended_at)
       VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7) RETURNING *`,
      [sessionId, participantType, fileRef, totalChunks, recordingDuration || null, startDate, endDate]
    );
    return created.rows[0];
  }
}

/** Forget a registered track that ended up with no media (e.g. a screen share stopped instantly). */
export async function discardEmptyTrack(sessionId: string, participantType: ParticipantType): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `DELETE FROM uploads u WHERE u.session_id = $1 AND u.participant_type = $2
       AND NOT EXISTS (SELECT 1 FROM recording_chunks c WHERE c.session_id = $1 AND c.participant_type = $2)`,
    [sessionId, participantType]
  );
}

/**
 * A participant rejoined mid-recording, so the browser that recorded their earlier tracks is gone
 * and those tracks can never finalize. Keep what reached the server (marking it complete) and
 * drop tracks that never uploaded anything, so processing doesn't wait for them forever.
 */
export async function settleAbandonedTracks(sessionId: string, participantId: string, keepOpen: string[] = []): Promise<string[]> {
  const pool = getDbPool();
  const like = `${participantId}.%`;
  // Tracks the rejoining browser still holds locally and will finish uploading itself.
  const keep = keepOpen.length ? keepOpen : [''];
  const dropped = await pool.query<{ participant_type: string }>(
    `DELETE FROM uploads u
      WHERE u.session_id = $1 AND (u.participant_type = $2 OR u.participant_type LIKE $3) AND u.status <> 'completed'
        AND u.participant_type <> ALL($4::varchar[])
        AND NOT EXISTS (SELECT 1 FROM recording_chunks c
                         WHERE c.session_id = u.session_id AND c.participant_type = u.participant_type AND c.status = 'completed')
      RETURNING participant_type`,
    [sessionId, participantId, like, keep]
  );
  const kept = await pool.query<{ participant_type: string }>(
    `UPDATE uploads SET status = 'completed', recording_ended_at = COALESCE(recording_ended_at, NOW()), updated_at = NOW()
      WHERE session_id = $1 AND (participant_type = $2 OR participant_type LIKE $3) AND status <> 'completed'
        AND participant_type <> ALL($4::varchar[])
      RETURNING participant_type`,
    [sessionId, participantId, like, keep]
  );
  return [...dropped.rows, ...kept.rows].map((r) => r.participant_type);
}
