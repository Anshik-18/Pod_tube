import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, toIdentity, TokenRole } from './jwt';

export interface AuthenticatedRequest extends NextRequest {
  userId?: string;
  userEmail?: string;
  role?: TokenRole;
  /** Set for guest tokens: the session the guest was invited to. */
  guestSessionId?: string;
  /** Set for guest tokens: the participant id this guest records under. */
  guestParticipantId?: string;
}

interface WithAuthOptions {
  /** Allow invite-link guest tokens. Off by default: guests may only upload their own track. */
  allowGuest?: boolean;
}

export function getRequestToken(req: NextRequest): string | undefined {
  const authHeader = req.headers.get('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : undefined;
  return bearer || req.cookies.get('token')?.value;
}

export function withAuth<T = any>(
  handler: (req: AuthenticatedRequest, context?: T) => Promise<NextResponse>,
  options: WithAuthOptions = {}
) {
  return async (req: NextRequest, context?: T): Promise<NextResponse> => {
    const token = getRequestToken(req);

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let identity;
    try {
      identity = toIdentity(verifyToken(token));
    } catch (error) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    if (identity.role === 'guest' && !options.allowGuest) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const authed = req as AuthenticatedRequest;
    authed.userId = identity.userId;
    authed.userEmail = identity.email;
    authed.role = identity.role;
    authed.guestSessionId = identity.sessionId;
    authed.guestParticipantId = identity.participantId;
    return handler(authed, context);
  };
}
