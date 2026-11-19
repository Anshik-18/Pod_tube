import { getDbPool } from '../client';

export type SessionState = 'idle' | 'recording' | 'uploading' | 'processing' | 'ready' | 'failed';

export interface SessionMarker {
  id: string;
  /** Seconds since the recording started. */
  time: number;
  label: string;
  created_at: string;
}

export interface Session {
  id: string;
  host_id: string;
  guest_token: string;
  title: string | null;
  state: SessionState;
  markers: SessionMarker[];
  participant_names: Record<string, string>;
  recording_started_at: Date | null;
  total_chunks?: number | null;
  recording_duration?: number | null;
  created_at: Date;
  updated_at: Date;
}

export async function createSession(hostId: string, guestToken: string, title?: string | null): Promise<Session> {
  const pool = getDbPool();
  const result = await pool.query<Session>(
    'INSERT INTO sessions (host_id, guest_token, state, title) VALUES ($1, $2, $3, $4) RETURNING *',
    [hostId, guestToken, 'idle', title || null]
  );
  return result.rows[0];
}

export async function getSessionById(id: string): Promise<Session | null> {
  const pool = getDbPool();
  const result = await pool.query<Session>(
    'SELECT * FROM sessions WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function getSessionByGuestToken(guestToken: string): Promise<Session | null> {
  const pool = getDbPool();
  const result = await pool.query<Session>(
    'SELECT * FROM sessions WHERE guest_token = $1',
    [guestToken]
  );
  return result.rows[0] || null;
}

export async function updateSessionState(
  id: string,
  state: SessionState,
  recordingStartedAt?: Date
): Promise<Session> {
  const pool = getDbPool();
  let query: string;
  let params: any[];

  if (recordingStartedAt) {
    query = 'UPDATE sessions SET state = $1, recording_started_at = $2, updated_at = NOW() WHERE id = $3 RETURNING *';
    params = [state, recordingStartedAt, id];
  } else {
    query = 'UPDATE sessions SET state = $1, updated_at = NOW() WHERE id = $2 RETURNING *';
    params = [state, id];
  }

  const result = await pool.query<Session>(query, params);
  return result.rows[0];
}

export async function updateSessionTitle(id: string, title: string | null): Promise<Session> {
  const pool = getDbPool();
  const result = await pool.query<Session>(
    'UPDATE sessions SET title = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [title || null, id]
  );
  return result.rows[0];
}

export async function addSessionMarker(id: string, marker: SessionMarker): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE sessions SET markers = COALESCE(markers, '[]'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify([marker]), id]
  );
}

export async function setSessionParticipantName(id: string, participantId: string, name: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE sessions SET participant_names = COALESCE(participant_names, '{}'::jsonb) || jsonb_build_object($1::text, $2::text) WHERE id = $3`,
    [participantId, name, id]
  );
}

export async function getSessionsByHostId(hostId: string): Promise<Session[]> {
  const pool = getDbPool();
  const result = await pool.query<Session>(
    'SELECT * FROM sessions WHERE host_id = $1 ORDER BY created_at DESC',
    [hostId]
  );
  return result.rows;
}

export async function deleteSession(id: string): Promise<void> {
  const pool = getDbPool();
  await pool.query('DELETE FROM sessions WHERE id = $1', [id]);
}
