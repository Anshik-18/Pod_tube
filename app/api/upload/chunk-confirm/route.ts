import { NextResponse } from 'next/server';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { authorizeParticipantUpload, isChunkIndex, chunkStorageKey } from '@/lib/auth/session-access';
import { getStorageProvider } from '@/lib/storage';
import { updateChunkStatus } from '@/lib/db/queries/chunks';

/**
 * POST /api/upload/chunk-confirm
 *
 * Marks a directly-uploaded (presigned PUT) chunk as completed.
 * Body: { sessionId, participantType, chunkIndex, etag?, sizeBytes? }
 */
export const POST = withAuth(async (req: AuthenticatedRequest) => {
  try {
    const { sessionId, participantType, chunkIndex, etag } = await req.json();

    if (!isChunkIndex(chunkIndex)) {
      return NextResponse.json({ error: 'Invalid chunkIndex' }, { status: 400 });
    }

    // Confirmation may legitimately arrive after the session moved to processing; only authorize identity.
    const access = await authorizeParticipantUpload(req, sessionId, participantType, { requireUploadable: false });
    if (!access.ok) return access.response;

    // Don't take the browser's word for it: the object must really be in storage. A missing
    // object makes the client retry this chunk now instead of failing at finalize.
    const storedSize = await getStorageProvider().size(chunkStorageKey(access.session.id, participantType, chunkIndex));
    if (!storedSize) {
      return NextResponse.json({ error: 'Chunk not found in storage; upload it again' }, { status: 409 });
    }

    const updated = await updateChunkStatus(
      access.session.id,
      participantType,
      chunkIndex,
      'completed',
      undefined,
      typeof etag === 'string' ? etag : null
    );

    if (!updated) {
      return NextResponse.json({ error: 'Chunk record not found' }, { status: 404 });
    }

    return NextResponse.json({ chunkIndex, status: 'completed' });
  } catch (error) {
    console.error('[chunk-confirm] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}, { allowGuest: true });
