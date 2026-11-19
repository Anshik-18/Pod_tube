import { NextResponse } from 'next/server';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { loadOwnedEpisode, RouteContext } from '@/lib/auth/episode-access';
import { resolveEpisodeMedia, serveStoredMedia, MediaKind } from '@/lib/media/serve';

const KINDS: MediaKind[] = ['video', 'audio', 'track'];

/**
 * GET /api/episodes/:id/preview?type=video|audio|track[&participant=host|guest]
 * Streams media inline for playback. Supports HTTP Range on local storage; redirects to a
 * signed URL on R2/S3. Authenticated by the httpOnly session cookie so <video src> works.
 */
export const GET = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedEpisode(req, context);
    if (!access.ok) return access.response;
    const { episode } = access;

    if (!episode.file_references) {
      return NextResponse.json({ error: 'Episode not ready for preview' }, { status: 400 });
    }

    const type = (req.nextUrl.searchParams.get('type') || 'video') as MediaKind;
    if (!KINDS.includes(type)) {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }

    const media = resolveEpisodeMedia(episode, type, req.nextUrl.searchParams.get('participant'));
    if (!media) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    return await serveStoredMedia(req, media.key, { filename: media.filename, inline: true });
  } catch (error) {
    console.error('Preview episode error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
