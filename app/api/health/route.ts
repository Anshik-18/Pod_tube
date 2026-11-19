import { NextResponse } from 'next/server';
import { getDbPool } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

/** GET /api/health — liveness for the platform's health checks: the app is up and the database answers. */
export async function GET() {
  const started = Date.now();
  try {
    await getDbPool().query('SELECT 1');
    return NextResponse.json({ status: 'ok', db: 'ok', latencyMs: Date.now() - started });
  } catch {
    return NextResponse.json({ status: 'error', db: 'unreachable' }, { status: 503 });
  }
}
