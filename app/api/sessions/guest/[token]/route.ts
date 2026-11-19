import { NextRequest, NextResponse } from 'next/server';
import { getParams } from '@/lib/auth/route-helpers';
import { getSessionByGuestToken } from '@/lib/db/queries/sessions';
import { getUserById } from '@/lib/db/queries/users';
import { randomBytes } from 'crypto';
import { signGuestToken } from '@/lib/auth/jwt';
import { guestParticipantId, isGuestKey } from '@/lib/participants';

/**
 * GET /api/sessions/guest/:token[?guest=<key>] — resolve an invite link. Returns a token scoped to
 * this one session and one guest, valid only for joining the studio and uploading that guest's tracks.
 *
 * The browser remembers its guest key per session and sends it back, so a refresh (or rejoin)
 * keeps the same identity and continues the same track instead of appearing as a new person.
 */
export async function GET(
  req: NextRequest,
  context?: { params?: Promise<{ token: string }> | { token: string } }
) {
  try {
    const params = await getParams<{ token: string }>(context);
    if (!/^[a-f0-9]{64}$/i.test(params.token)) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const session = await getSessionByGuestToken(params.token);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const requestedKey = req.nextUrl.searchParams.get('guest');
    const guestKey = isGuestKey(requestedKey) ? requestedKey : randomBytes(6).toString('hex');

    const host = await getUserById(session.host_id);
    const ended = session.state === 'processing' || session.state === 'ready' || session.state === 'failed';

    return NextResponse.json({
      session: {
        id: session.id,
        state: session.state,
        title: session.title,
        host_name: host?.name || session.participant_names?.host || null,
        ended,
      },
      token: ended ? null : signGuestToken(session.id, guestKey),
      guestKey,
      participantId: guestParticipantId(guestKey),
    });
  } catch (error) {
    console.error('Get guest session error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
