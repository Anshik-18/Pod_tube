import { NextResponse } from 'next/server';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { loadOwnedEpisode, RouteContext } from '@/lib/auth/episode-access';
import { getSessionById } from '@/lib/db/queries/sessions';
import { resolveEpisodeMedia, serveStoredMedia, MediaKind } from '@/lib/media/serve';

const KINDS: MediaKind[] = ['video', 'audio', 'track'];

/**
 * GET /api/episodes/:id/download?type=video|audio|track[&participant=<participant id>]
 * Downloads an export (as an attachment with a friendly filename).
 */
export const GET = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedEpisode(req, context);
    if (!access.ok) return access.response;
    const { episode } = access;

    if (!episode.file_references) {
      return NextResponse.json({ error: 'Episode not ready for download' }, { status: 400 });
    }

    const type = (req.nextUrl.searchParams.get('type') || 'video') as MediaKind;
    if (!KINDS.includes(type)) {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }

    const names = type === 'track' ? (await getSessionById(episode.session_id))?.participant_names : null;
    const media = resolveEpisodeMedia(episode, type, req.nextUrl.searchParams.get('participant'), names);
    if (!media) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    return await serveStoredMedia(req, media.key, { filename: media.filename, inline: false });
  } catch (error) {
    console.error('Download episode error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
