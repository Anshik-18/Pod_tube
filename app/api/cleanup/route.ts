/**
 * Cleanup API endpoint — called by a scheduled job (see scripts/cleanup-cron.js).
 * Requires `Authorization: Bearer <CRON_SECRET>`; disabled when CRON_SECRET is unset.
 */

import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { cleanupOldEpisodes, cleanupStuckEpisodes } from '@/lib/cleanup/storage';

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const retentionPeriod = parseInt(process.env.EPISODE_RETENTION_DAYS || '7', 10);
    const shouldCleanupStuck = body?.cleanupStuck !== false;

    const results: Record<string, unknown> = {};

    try {
      results.oldEpisodes = await cleanupOldEpisodes(retentionPeriod);
    } catch (error) {
      console.error('[Cleanup API] Error cleaning old episodes:', error);
      results.oldEpisodes = { error: error instanceof Error ? error.message : 'Unknown error' };
    }

    if (shouldCleanupStuck) {
      try {
        const maxProcessingHours = parseInt(process.env.MAX_PROCESSING_HOURS || '24', 10);
        results.stuckEpisodes = await cleanupStuckEpisodes(maxProcessingHours);
      } catch (error) {
        console.error('[Cleanup API] Error cleaning stuck episodes:', error);
        results.stuckEpisodes = { error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }

    return NextResponse.json({ success: true, results, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[Cleanup API] Error:', error);
    return NextResponse.json({ success: false, error: 'Cleanup failed' }, { status: 500 });
  }
}
