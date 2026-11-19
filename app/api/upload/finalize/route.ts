import { NextResponse } from 'next/server';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { authorizeParticipantUpload } from '@/lib/auth/session-access';
import { verifyChunkIntegrity } from '@/lib/db/queries/chunks';
import { recordParticipantTimeline, discardEmptyTrack } from '@/lib/db/queries/uploads';
import { isScreenTrack } from '@/lib/participants';
import { completeSessionIfReady } from '@/lib/sessions/completion';

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * POST /api/upload/finalize
 *
 * Called by each participant once all of their chunks are uploaded. Verifies chunk integrity,
 * stores the participant's timeline, and — once every participant who recorded has finalized —
 * idempotently creates exactly one ProcessingJob.
 *
 * Body: { sessionId, participantType, totalChunks, recordingStartedAt?, recordingEndedAt? }
 * A screen share (or, with acceptMissing, any track) may finalize with totalChunks = 0: nothing was recorded.
 * acceptMissing: true finalizes even if some chunks never arrived (they're lost on the client).
 * Response: 202 { processingJobId?, status, episodeId }
 */
export const POST = withAuth(async (req: AuthenticatedRequest) => {
  try {
    const { sessionId, participantType, totalChunks, recordingStartedAt, recordingEndedAt, acceptMissing } = await req.json();

    // An empty track: a screen share stopped instantly, or a recording the browser lost before its
    // first chunk (e.g. the tab died within seconds). The server stops waiting for it.
    const emptyScreenShare =
      totalChunks === 0 && typeof participantType === 'string' && (isScreenTrack(participantType) || acceptMissing === true);
    if (!Number.isInteger(totalChunks) || (totalChunks <= 0 && !emptyScreenShare)) {
      return NextResponse.json({ error: 'totalChunks must be a positive integer' }, { status: 400 });
    }

    const access = await authorizeParticipantUpload(req, sessionId, participantType, { requireUploadable: false });
    if (!access.ok) return access.response;
    const { session } = access;

    if (emptyScreenShare) {
      await discardEmptyTrack(session.id, participantType);
      return NextResponse.json(await completeSessionIfReady(session), { status: 202 });
    }

    const integrity = await verifyChunkIntegrity(session.id, participantType, totalChunks);
    // The browser can declare chunks lost for good (e.g. the last seconds before a crash). The
    // worker assembles around gaps, but it needs chunk 0, which carries the codec header.
    const recoverable = acceptMissing === true && !integrity.missingIndices.includes(0) && !integrity.failedIndices.includes(0);
    if (!integrity.valid && recoverable) {
      console.warn(
        `[finalize] ${session.id}/${participantType}: accepting with ${integrity.missingIndices.length + integrity.failedIndices.length} lost chunk(s)`
      );
    }
    if (!integrity.valid && !recoverable) {
      return NextResponse.json(
        {
          error: 'Some recording chunks are missing. Retrying upload may fix this.',
          missingIndices: integrity.missingIndices,
          failedIndices: integrity.failedIndices,
          totalExpected: totalChunks,
          totalFound: integrity.totalFound,
        },
        { status: 400 }
      );
    }

    const startedAt = parseDate(recordingStartedAt);
    const endedAt = parseDate(recordingEndedAt);
    const durationSec = startedAt && endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : undefined;

    await recordParticipantTimeline(session.id, participantType, totalChunks, durationSec, startedAt, endedAt);

    // Processing starts once every participant who recorded (has an uploads row) has finalized.
    const result = await completeSessionIfReady(session, { startedAt });
    return NextResponse.json(
      result.status === 'waiting_for_participants'
        ? { ...result, message: 'Your track is uploaded. Waiting for the other participants to finish uploading.' }
        : result,
      { status: 202 }
    );
  } catch (error) {
    console.error('Finalize upload error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}, { allowGuest: true });
