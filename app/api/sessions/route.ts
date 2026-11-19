import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { withAuth } from '@/lib/auth/middleware';
import { createSession, getSessionsByHostId } from '@/lib/db/queries/sessions';
import { getEpisodesByHostId } from '@/lib/db/queries/episodes';

const createSchema = z.object({ title: z.string().trim().max(255).optional().nullable() });

function generateGuestToken(): string {
  return randomBytes(32).toString('hex');
}

export const POST = withAuth(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const { title } = createSchema.parse(body ?? {});
    const session = await createSession(req.userId!, generateGuestToken(), title || null);

    return NextResponse.json({
      session: {
        id: session.id,
        title: session.title,
        guest_token: session.guest_token,
        state: session.state,
        created_at: session.created_at,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Title must be 255 characters or fewer' }, { status: 400 });
    }
    console.error('Create session error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

/**
 * GET — the host's studio sessions. Sessions that were opened but never recorded
 * are hidden unless ?all=1.
 */
export const GET = withAuth(async (req) => {
  try {
    const hostId = req.userId!;
    const includeEmpty = req.nextUrl.searchParams.get('all') === '1';
    const [sessions, episodes] = await Promise.all([getSessionsByHostId(hostId), getEpisodesByHostId(hostId)]);
    const episodeBySession = new Map(episodes.map((ep) => [ep.session_id, ep]));

    const result = sessions
      .map((session) => {
        const episode = episodeBySession.get(session.id);
        return {
          id: session.id,
          title: session.title,
          guest_token: session.guest_token,
          state: session.state,
          recording_started_at: session.recording_started_at,
          created_at: session.created_at,
          updated_at: session.updated_at,
          participant_names: session.participant_names ?? {},
          episode_id: episode?.id ?? null,
          episode_title: episode?.title ?? null,
          episode_state: episode?.state ?? null,
          has_thumbnail: !!episode?.file_references?.thumbnail,
          duration_ms: episode?.file_references?.durationMs ?? null,
        };
      })
      .filter((s) => includeEmpty || s.episode_id || s.state !== 'idle');

    return NextResponse.json({ sessions: result });
  } catch (error) {
    console.error('Get sessions error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
