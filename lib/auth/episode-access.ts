import { NextResponse } from 'next/server';
import type { AuthenticatedRequest } from './middleware';
import { getParams } from './route-helpers';
import { getEpisodeById, Episode } from '@/lib/db/queries/episodes';

export type RouteContext = { params?: Promise<{ id: string }> | { id: string } };

/**
 * Load the episode named in the route and confirm the caller owns it.
 */
export async function loadOwnedEpisode(
  req: AuthenticatedRequest,
  context?: RouteContext
): Promise<{ ok: true; episode: Episode } | { ok: false; response: NextResponse }> {
  const { id } = await getParams<{ id: string }>(context);
  let episode: Episode | null;
  try {
    episode = await getEpisodeById(id);
  } catch (err) {
    // invalid_text_representation: the id is not a UUID
    if ((err as { code?: string })?.code === '22P02') episode = null;
    else throw err;
  }
  if (!episode) {
    return { ok: false, response: NextResponse.json({ error: 'Episode not found' }, { status: 404 }) };
  }
  if (episode.host_id !== req.userId) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 403 }) };
  }
  return { ok: true, episode };
}
