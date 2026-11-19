import jwt from 'jsonwebtoken';
import { guestParticipantId, isGuestKey } from '@/lib/participants';

export type TokenRole = 'user' | 'guest';

export interface JWTPayload {
  userId: string;
  email: string;
  /** Absent on tokens issued before roles existed; treated as 'user' unless userId is guest_*. */
  role?: TokenRole;
  /** For guest tokens: the only session this token may act on. */
  sessionId?: string;
  /** For guest tokens: identifies this guest among several in the same session. */
  guestKey?: string;
}

export interface Identity {
  role: TokenRole;
  userId: string;
  email: string;
  /** Set only for guests. */
  sessionId?: string;
  /** Set only for guests: `guest-<key>`, or `guest` for tokens issued before multi-guest support. */
  participantId?: string;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
}

export function signToken(payload: JWTPayload): string {
  return jwt.sign({ ...payload, role: payload.role ?? 'user' }, getJwtSecret(), {
    expiresIn: '7d',
  });
}

/** Short-lived token scoped to one guest in a single session, issued to invite-link guests. */
export function signGuestToken(sessionId: string, guestKey: string): string {
  return jwt.sign(
    { userId: `guest_${sessionId}`, email: `guest@session.${sessionId}`, role: 'guest', sessionId, guestKey },
    getJwtSecret(),
    { expiresIn: '24h' }
  );
}

export function verifyToken(token: string): JWTPayload {
  try {
    return jwt.verify(token, getJwtSecret()) as JWTPayload;
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
}

export function toIdentity(payload: JWTPayload): Identity {
  const legacyGuest = payload.userId?.startsWith('guest_');
  if (payload.role === 'guest' || legacyGuest) {
    return {
      role: 'guest',
      userId: payload.userId,
      email: payload.email,
      sessionId: payload.sessionId ?? payload.userId.slice('guest_'.length),
      participantId: isGuestKey(payload.guestKey) ? guestParticipantId(payload.guestKey) : 'guest',
    };
  }
  return { role: 'user', userId: payload.userId, email: payload.email };
}
