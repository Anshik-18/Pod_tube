import { getUploadsBySessionId } from '../db/queries/uploads';
import { getSessionById } from '../db/queries/sessions';

export interface ParticipantTimeline {
  participantType: string;
  recordingStartedAt: Date;
  recordingEndedAt: Date;
  offsetMs: number;
  durationMs: number;
}

export interface SessionTimeline {
  sessionId: string;
  timelineStart: Date;
  sessionStartTime: Date;
  /** Keyed by participant id (camera tracks and screen shares). */
  participants: Record<string, ParticipantTimeline>;
}

/**
 * resolveSessionTimeline
 *
 * Every track was timestamped in server time when it started and stopped (clients measure their
 * clock offset against the server), so tracks recorded on different machines share one timeline.
 *
 *   timelineStart = earliest recordingStartedAt across all tracks
 *   offsetMs      = track start - timelineStart
 *   durationMs    = track end - track start
 */
export async function resolveSessionTimeline(sessionId: string): Promise<SessionTimeline> {
  const uploads = await getUploadsBySessionId(sessionId);
  const session = await getSessionById(sessionId);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const raw: Record<string, { startedAt: Date; endedAt: Date }> = {};

  for (const upload of uploads) {
    const startedAt = upload.recording_started_at ? new Date(upload.recording_started_at) : new Date(upload.created_at);
    const endedAt = upload.recording_ended_at
      ? new Date(upload.recording_ended_at)
      : new Date(startedAt.getTime() + (upload.recording_duration || 0) * 1000);
    raw[upload.participant_type] = { startedAt, endedAt };
  }

  // Fallback: if the host upload record is missing, use the session's recording start.
  if (!raw.host && (session.recording_started_at || session.created_at)) {
    const hostStart = session.recording_started_at ? new Date(session.recording_started_at) : new Date(session.created_at);
    raw.host = { startedAt: hostStart, endedAt: new Date(hostStart.getTime() + (session.recording_duration || 0) * 1000) };
  }

  let timelineStart: Date | null = null;
  for (const info of Object.values(raw)) {
    if (!timelineStart || info.startedAt.getTime() < timelineStart.getTime()) timelineStart = info.startedAt;
  }
  if (!timelineStart) {
    timelineStart = session.recording_started_at ? new Date(session.recording_started_at) : new Date(session.created_at);
  }

  const participants: SessionTimeline['participants'] = {};
  for (const [participantType, info] of Object.entries(raw)) {
    participants[participantType] = {
      participantType,
      recordingStartedAt: info.startedAt,
      recordingEndedAt: info.endedAt,
      offsetMs: Math.max(0, info.startedAt.getTime() - timelineStart.getTime()),
      durationMs: Math.max(0, info.endedAt.getTime() - info.startedAt.getTime()),
    };
  }

  console.log(
    `[Timeline] Session ${sessionId} starts ${timelineStart.toISOString()}: ` +
      Object.values(participants)
        .map((p) => `${p.participantType}@+${p.offsetMs}ms (${p.durationMs}ms)`)
        .join(', ')
  );

  return { sessionId, timelineStart, sessionStartTime: timelineStart, participants };
}
