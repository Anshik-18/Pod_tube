/**
 * Tests for guest-token scoping and upload authorization
 */

jest.mock('@/lib/db/queries/sessions');

import { NextRequest, NextResponse } from 'next/server';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { signToken, signGuestToken, toIdentity, verifyToken } from '@/lib/auth/jwt';
import { authorizeParticipantUpload } from '@/lib/auth/session-access';
import { getSessionById } from '@/lib/db/queries/sessions';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';
const mockGetSessionById = getSessionById as jest.MockedFunction<typeof getSessionById>;

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
});

function requestWith(token: string) {
  return new NextRequest('http://localhost/api/test', { headers: { authorization: `Bearer ${token}` } });
}

const ok = async () => NextResponse.json({ ok: true });

describe('withAuth', () => {
  it('accepts user tokens', async () => {
    const res = await withAuth(ok)(requestWith(signToken({ userId: 'u1', email: 'a@b.c' })));
    expect(res.status).toBe(200);
  });

  it('rejects guest tokens unless the route opts in', async () => {
    const guest = signGuestToken(SESSION_ID, 'abc123def456');
    expect((await withAuth(ok)(requestWith(guest))).status).toBe(403);
    expect((await withAuth(ok, { allowGuest: true })(requestWith(guest))).status).toBe(200);
  });

  it('gives each invited guest their own participant id', () => {
    const a = toIdentity(verifyToken(signGuestToken(SESSION_ID, 'aaaaaa111111')));
    const b = toIdentity(verifyToken(signGuestToken(SESSION_ID, 'bbbbbb222222')));
    expect(a.participantId).toBe('guest-aaaaaa111111');
    expect(b.participantId).toBe('guest-bbbbbb222222');
  });

  it('treats legacy guest_* tokens as guests', () => {
    const legacy = signToken({ userId: `guest_${SESSION_ID}`, email: 'g@x' });
    expect(toIdentity(verifyToken(legacy))).toMatchObject({ role: 'guest', sessionId: SESSION_ID });
  });

  it('rejects missing and forged tokens', async () => {
    expect((await withAuth(ok)(new NextRequest('http://localhost/api/test'))).status).toBe(401);
    expect((await withAuth(ok)(requestWith('not-a-jwt'))).status).toBe(401);
  });
});

describe('authorizeParticipantUpload', () => {
  const session = { id: SESSION_ID, host_id: 'host-user', state: 'recording' } as any;

  const asUser = (userId: string) => ({ userId, role: 'user' }) as AuthenticatedRequest;
  const asGuest = (sessionId: string, participantId = 'guest') =>
    ({ userId: `guest_${sessionId}`, role: 'guest', guestSessionId: sessionId, guestParticipantId: participantId }) as AuthenticatedRequest;

  beforeEach(() => mockGetSessionById.mockResolvedValue(session));

  it('lets the host upload the host track only', async () => {
    expect((await authorizeParticipantUpload(asUser('host-user'), SESSION_ID, 'host')).ok).toBe(true);
    expect((await authorizeParticipantUpload(asUser('host-user'), SESSION_ID, 'guest')).ok).toBe(false);
  });

  it('lets an invited guest upload the guest track for their own session only', async () => {
    expect((await authorizeParticipantUpload(asGuest(SESSION_ID), SESSION_ID, 'guest')).ok).toBe(true);
    expect((await authorizeParticipantUpload(asGuest(SESSION_ID), SESSION_ID, 'host')).ok).toBe(false);
    expect((await authorizeParticipantUpload(asGuest(OTHER_SESSION), SESSION_ID, 'guest')).ok).toBe(false);
  });

  it('lets each of several guests upload only their own camera and screen tracks', async () => {
    const alice = asGuest(SESSION_ID, 'guest-aaaaaa111111');
    expect((await authorizeParticipantUpload(alice, SESSION_ID, 'guest-aaaaaa111111')).ok).toBe(true);
    expect((await authorizeParticipantUpload(alice, SESSION_ID, 'guest-aaaaaa111111.screen1')).ok).toBe(true);
    expect((await authorizeParticipantUpload(alice, SESSION_ID, 'guest-bbbbbb222222')).ok).toBe(false);
    expect((await authorizeParticipantUpload(alice, SESSION_ID, 'host.screen1')).ok).toBe(false);
    expect((await authorizeParticipantUpload(asUser('host-user'), SESSION_ID, 'host.screen2')).ok).toBe(true);
    expect((await authorizeParticipantUpload(asUser('host-user'), SESSION_ID, 'guest-aaaaaa111111')).ok).toBe(false);
  });

  it('blocks other users', async () => {
    const result = await authorizeParticipantUpload(asUser('someone-else'), SESSION_ID, 'host');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('validates identifiers before touching the database or storage paths', async () => {
    mockGetSessionById.mockClear();
    const bad = await authorizeParticipantUpload(asUser('host-user'), '../../etc', 'host');
    const badType = await authorizeParticipantUpload(asUser('host-user'), SESSION_ID, '../host');
    expect(bad.ok || badType.ok).toBe(false);
    expect(mockGetSessionById).not.toHaveBeenCalled();
  });

  it('refuses uploads once the session has moved to processing', async () => {
    mockGetSessionById.mockResolvedValue({ ...session, state: 'processing' });
    const result = await authorizeParticipantUpload(asUser('host-user'), SESSION_ID, 'host');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(409);
  });
});
