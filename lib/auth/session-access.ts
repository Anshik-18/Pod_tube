import { NextResponse } from 'next/server';
import type { AuthenticatedRequest } from './middleware';
import { getSessionById, Session } from '@/lib/db/queries/sessions';

import type { ParticipantType } from '@/lib/storage/keys';
import { baseParticipant, isParticipantId } from '@/lib/participants';

export type { ParticipantType };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHUNK_INDEX = 100_000;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isParticipantType(value: unknown): value is ParticipantType {
  return isParticipantId(value);
}

export function isChunkIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < MAX_CHUNK_INDEX;
}

/** Sessions stop accepting media once the episode has been handed to the processing worker. */
const UPLOADABLE_STATES = new Set(['idle', 'recording', 'uploading']);

type AccessResult =
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse };

/**
 * Resolve the session and verify that the caller may write media for `participantType`:
 * the host's own account for host tracks, or a guest's invite token for that guest's own tracks
 * (camera and screen shares) in that session.
 */
export async function authorizeParticipantUpload(
  req: AuthenticatedRequest,
  sessionId: unknown,
  participantType: unknown,
  { requireUploadable = true }: { requireUploadable?: boolean } = {}
): Promise<AccessResult> {
  if (!isUuid(sessionId) || !isParticipantType(participantType)) {
    return { ok: false, response: NextResponse.json({ error: 'Invalid sessionId or participantType' }, { status: 400 }) };
  }

  const session = await getSessionById(sessionId);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Session not found' }, { status: 404 }) };
  }

  const owner = baseParticipant(participantType);
  const allowed =
    owner === 'host'
      ? req.role !== 'guest' && session.host_id === req.userId
      : req.role === 'guest' && req.guestSessionId === session.id && req.guestParticipantId === owner;

  if (!allowed) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  if (requireUploadable && !UPLOADABLE_STATES.has(session.state)) {
    return {
      ok: false,
      response: NextResponse.json({ error: `Session is ${session.state} and no longer accepts uploads` }, { status: 409 }),
    };
  }

  return { ok: true, session };
}

export { chunkStorageKey, trackStorageKey } from '@/lib/storage/keys';
