import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { loadOwnedEpisode, RouteContext } from '@/lib/auth/episode-access';
import { updateEpisodeState, updateEpisodeTrimSettings, updateEpisodeTitle } from '@/lib/db/queries/episodes';
import { deleteSession, getSessionById, updateSessionTitle } from '@/lib/db/queries/sessions';
import { getUploadsBySessionId } from '@/lib/db/queries/uploads';
import { deleteEpisodeWithStorageCleanup } from '@/lib/cleanup/storage';
import { queueProcessing } from '@/lib/processing/processor';
import { getProcessingJobByEpisodeId } from '@/lib/db/queries/processing-jobs';

const processSchema = z
  .object({
    trimStart: z.number().min(0).optional(),
    trimEnd: z.number().min(0).optional(),
    quality: z.enum(['low', 'medium', 'high']).optional(),
  })
  .refine((v) => !v.trimEnd || !v.trimStart || v.trimEnd > v.trimStart, {
    message: 'Trim end must be after trim start',
  });

const titleSchema = z.object({ title: z.string().max(255).nullable() });

export const GET = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedEpisode(req, context);
    if (!access.ok) return access.response;
    const { episode } = access;

    const [processingJob, session, uploads] = await Promise.all([
      getProcessingJobByEpisodeId(episode.id),
      getSessionById(episode.session_id),
      getUploadsBySessionId(episode.session_id),
    ]);

    return NextResponse.json({
      episode,
      processingJob: processingJob
        ? {
            status: processingJob.status,
            error_message: processingJob.error_message,
            progress: processingJob.progress,
            created_at: processingJob.created_at,
            updated_at: processingJob.updated_at,
          }
        : null,
      session: session
        ? {
            id: session.id,
            title: session.title,
            state: session.state,
            markers: session.markers ?? [],
            participant_names: session.participant_names ?? {},
            recording_started_at: session.recording_started_at,
          }
        : null,
      uploads: uploads.map((u) => ({
        participant_type: u.participant_type,
        status: u.status,
        recording_duration: u.recording_duration,
      })),
    });
  } catch (error) {
    console.error('Get episode error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

export const DELETE = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedEpisode(req, context);
    if (!access.ok) return access.response;

    // Delete storage objects first, then the database records (session delete cascades).
    await deleteEpisodeWithStorageCleanup(access.episode.id);
    await deleteSession(access.episode.session_id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete episode error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

/**
 * POST — save trim/quality settings and (re-)export. Also used to process an episode
 * immediately when a participant's upload never finished.
 */
export const POST = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedEpisode(req, context);
    if (!access.ok) return access.response;
    const { episode } = access;

    const { trimStart, trimEnd, quality } = processSchema.parse(await req.json());

    const processingJob = await getProcessingJobByEpisodeId(episode.id);
    if (processingJob?.status === 'processing') {
      return NextResponse.json({ error: 'An export is already in progress. Try again when it finishes.' }, { status: 409 });
    }

    await updateEpisodeTrimSettings(episode.id, trimStart, trimEnd, quality);
    if (episode.state !== 'processing') {
      await updateEpisodeState(episode.id, 'processing');
    }
    await queueProcessing(episode.id);

    return NextResponse.json({ success: true, message: 'Export queued' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0]?.message ?? 'Invalid request', details: error.errors }, { status: 400 });
    }
    console.error('Process episode error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

/** PUT — rename the episode (and its session, so the studio shows the same name). */
export const PUT = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedEpisode(req, context);
    if (!access.ok) return access.response;

    const { title } = titleSchema.parse(await req.json());
    const cleanTitle = title?.trim() || '';
    const updatedEpisode = await updateEpisodeTitle(access.episode.id, cleanTitle);
    await updateSessionTitle(access.episode.session_id, cleanTitle || null).catch(() => {});

    return NextResponse.json({ success: true, episode: updatedEpisode });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Title must be 255 characters or fewer' }, { status: 400 });
    }
    console.error('Update episode title error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

/** PATCH { action: 'retry' } — re-run a failed or stuck export with the saved settings. */
export const PATCH = withAuth(async (req: AuthenticatedRequest, context?: RouteContext) => {
  try {
    const access = await loadOwnedEpisode(req, context);
    if (!access.ok) return access.response;
    const { episode } = access;

    const body = await req.json();
    if (body?.action !== 'retry') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const processingJob = await getProcessingJobByEpisodeId(episode.id);
    if (processingJob?.status === 'processing') {
      return NextResponse.json({ error: 'Processing is already running' }, { status: 409 });
    }

    await updateEpisodeState(episode.id, 'processing');
    await queueProcessing(episode.id);
    return NextResponse.json({ success: true, message: 'Processing retried' });
  } catch (error) {
    console.error('Retry processing error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
