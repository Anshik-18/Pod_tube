import { NextResponse } from 'next/server';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { getParams } from '@/lib/auth/route-helpers';
import { getSessionById } from '@/lib/db/queries/sessions';
import { completeSessionIfReady } from '@/lib/sessions/completion';
import { isUuid } from '@/lib/auth/session-access';

/**
 * POST /api/sessions/:id/finish — host only.
 * Process the recording with the tracks that finished uploading, giving up on any participant
 * whose upload never completed (closed tab, crashed browser).
 */
export const POST = withAuth(async (req: AuthenticatedRequest, context?: { params?: Promise<{ id: string }> | { id: string } }) => {
  try {
    const { id } = await getParams<{ id: string }>(context);
    const session = isUuid(id) ? await getSessionById(id) : null;
    if (!session || session.host_id !== req.userId) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    if (session.state !== 'uploading' && session.state !== 'recording') {
      return NextResponse.json({ error: `Session is ${session.state}; nothing to finish` }, { status: 409 });
    }
    const result = await completeSessionIfReady(session, { force: true });
    if (result.status === 'waiting_for_participants') {
      return NextResponse.json({ error: 'No participant uploaded any recording yet' }, { status: 409 });
    }
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    console.error('Finish session error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
