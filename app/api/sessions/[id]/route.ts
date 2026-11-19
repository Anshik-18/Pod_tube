import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { getParams } from '@/lib/auth/route-helpers';
import { getSessionById, updateSessionTitle, Session } from '@/lib/db/queries/sessions';
import { deleteSessionWithStorageCleanup } from '@/lib/cleanup/storage';

type RouteContext = { params?: Promise<{ id: string }> | { id: string } };

async function loadOwnedSession(req: AuthenticatedRequest, context?: RouteContext) {
  const { id } = await getParams<{ id: string }>(context);
  let session: Session | null = null;
  try {
    session = await getSessionById(id);
  } catch (err) {
    // invalid_text_representation: the id is not a UUID
    if ((err as { code?: string })?.code !== '22P02') throw err;
  }
  if (!session) {
    return { ok: false as const, response: NextResponse.json({ error: 'Session not found' }, { status: 404 }) };
  }
  if (session.host_id !== req.userId) {
    return { ok: false as const, response: NextResponse.json({ error: 'Unauthorized' }, { status: 403 }) };
  }
  return { ok: true as const, session };
}

function toResponse(session: Session) {
  return {
    id: session.id,
    title: session.title,
    guest_token: session.guest_token,
    state: session.state,
    markers: session.markers ?? [],
    participant_names: session.participant_names ?? {},
    recording_started_at: session.recording_started_at,
    created_at: session.created_at,
  };
}

export const GET = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedSession(req, context);
    if (!access.ok) return access.response;
    return NextResponse.json({ session: toResponse(access.session) });
  } catch (error) {
    console.error('Get session error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

const updateSessionSchema = z.object({
  title: z.string().trim().max(255).nullable().optional(),
});

/**
 * PATCH — rename the studio. Recording state is owned by the realtime server and is not client-writable.
 */
export const PATCH = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedSession(req, context);
    if (!access.ok) return access.response;

    const validated = updateSessionSchema.parse(await req.json());
    const session =
      validated.title !== undefined ? await updateSessionTitle(access.session.id, validated.title || null) : access.session;

    return NextResponse.json({ session: toResponse(session) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request data', details: error.errors }, { status: 400 });
    }
    console.error('Update session error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

export const DELETE = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedSession(req, context);
    if (!access.ok) return access.response;

    if (access.session.state === 'recording') {
      return NextResponse.json({ error: 'Stop the recording before deleting this session' }, { status: 409 });
    }

    await deleteSessionWithStorageCleanup(access.session.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete session error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
