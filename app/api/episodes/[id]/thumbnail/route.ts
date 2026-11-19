import { NextResponse } from 'next/server';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { loadOwnedEpisode, RouteContext } from '@/lib/auth/episode-access';
import { resolveEpisodeMedia, serveStoredMedia } from '@/lib/media/serve';

/**
 * GET /api/episodes/:id/thumbnail — poster frame generated during processing.
 */
export const GET = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedEpisode(req, context);
    if (!access.ok) return access.response;

    const media = resolveEpisodeMedia(access.episode, 'thumbnail');
    if (!media) {
      return NextResponse.json({ error: 'No thumbnail' }, { status: 404 });
    }
    return await serveStoredMedia(req, media.key, { filename: media.filename, inline: true });
  } catch (error) {
    console.error('Thumbnail error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
