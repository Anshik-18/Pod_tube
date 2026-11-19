import { getDbPool } from '@/lib/db/client';
import { Session } from '@/lib/db/queries/sessions';
import { getUploadsBySessionId } from '@/lib/db/queries/uploads';
import { createEpisode, getEpisodeBySessionId } from '@/lib/db/queries/episodes';
import { createProcessingJobIfAbsent } from '@/lib/db/queries/processing-jobs';
import { baseParticipant, isScreenTrack } from '@/lib/participants';

export interface CompletionResult {
  status: 'waiting_for_participants' | 'processing' | 'ready' | 'pending' | string;
  episodeId: string;
  processingJobId?: string;
  /** Tracks still uploading (participant ids). */
  pending: string[];
}

/**
 * Start processing once every registered track has finalized (and the host's camera is among them).
 *
 * With `force`, the host gives up on tracks that never finished — e.g. a guest whose browser
 * crashed: tracks with uploaded chunks are processed with what arrived; tracks with none are dropped.
 */
export async function completeSessionIfReady(session: Session, options: { force?: boolean; startedAt?: Date } = {}): Promise<CompletionResult> {
  const episode = (await getEpisodeBySessionId(session.id)) ?? (await createEpisode(session.id, session.host_id, session.title ?? undefined));

  if (options.force) {
    const pool = getDbPool();
    await pool.query(
      `DELETE FROM uploads u WHERE u.session_id = $1 AND u.status <> 'completed'
         AND NOT EXISTS (SELECT 1 FROM recording_chunks c WHERE c.session_id = u.session_id AND c.participant_type = u.participant_type AND c.status = 'completed')`,
      [session.id]
    );
    await pool.query(`UPDATE uploads SET status = 'completed', updated_at = NOW() WHERE session_id = $1 AND status <> 'completed'`, [session.id]);
  }

  const uploads = await getUploadsBySessionId(session.id);
  const pending = uploads.filter((u) => u.status !== 'completed').map((u) => u.participant_type);
  const hasCamera = uploads.some((u) => u.status === 'completed' && !isScreenTrack(u.participant_type));
  // Any of the host's camera segments (they may have rejoined mid-recording).
  const hostDone = uploads.some((u) => u.status === 'completed' && !isScreenTrack(u.participant_type) && baseParticipant(u.participant_type) === 'host');

  if (pending.length > 0 || (!options.force && !hostDone) || !hasCamera) {
    return { status: 'waiting_for_participants', episodeId: episode.id, pending };
  }

  // Several participants usually finalize at the same moment. Only the request that wins this
  // atomic state transition queues the processing job; the others report what's happening.
  const claimed = await getDbPool().query(
    `UPDATE sessions
        SET state = 'processing', recording_started_at = COALESCE(recording_started_at, $2), updated_at = NOW()
      WHERE id = $1 AND state NOT IN ('processing', 'ready')
      RETURNING id`,
    [session.id, options.startedAt ?? new Date()]
  );
  if (claimed.rowCount === 0) {
    return { status: 'processing', episodeId: episode.id, pending };
  }

  const job = await createProcessingJobIfAbsent(episode.id);
  return { status: job.status, episodeId: episode.id, processingJobId: job.id, pending };
}

/**
 * Safety net: sessions still waiting for uploads with no upload activity for `idleMinutes` are
 * finished with what arrived, so an episode never hangs on someone who left for good.
 */
export async function finishStalledSessions(idleMinutes = 10): Promise<string[]> {
  const pool = getDbPool();
  const stalled = await pool.query<Session>(
    `SELECT s.* FROM sessions s
      WHERE s.state = 'uploading'
        AND EXISTS (SELECT 1 FROM uploads u WHERE u.session_id = s.id AND u.status <> 'completed')
        AND s.updated_at < NOW() - make_interval(mins => $1)
        AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.session_id = s.id AND u.updated_at > NOW() - make_interval(mins => $1))
        AND NOT EXISTS (SELECT 1 FROM recording_chunks c WHERE c.session_id = s.id AND c.updated_at > NOW() - make_interval(mins => $1))`,
    [idleMinutes]
  );
  const finished: string[] = [];
  for (const session of stalled.rows) {
    const result = await completeSessionIfReady(session, { force: true }).catch((err) => {
      console.error(`[Completion] Could not finish stalled session ${session.id}:`, err);
      return null;
    });
    if (result && result.status !== 'waiting_for_participants') finished.push(session.id);
  }
  return finished;
}
