import { NextResponse } from 'next/server';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { authorizeParticipantUpload, chunkStorageKey, isChunkIndex } from '@/lib/auth/session-access';
import { getStorageProvider } from '@/lib/storage';
import { recordChunkMetadata } from '@/lib/db/queries/chunks';

/**
 * POST /api/upload/presigned-url
 *
 * Generates an upload target for a recording chunk.
 * For R2/S3 storage: returns a presigned PUT URL for direct client-to-cloud upload.
 * For local storage: returns the server chunk upload endpoint URL as fallback.
 *
 * Body: { sessionId, participantType, chunkIndex, sizeBytes }
 * Returns: { uploadUrl, storageKey, chunkIndex, method }
 */
export const POST = withAuth(async (req: AuthenticatedRequest) => {
  try {
    const body = await req.json();
    const { sessionId, participantType, chunkIndex, sizeBytes } = body;

    if (!isChunkIndex(chunkIndex)) {
      return NextResponse.json({ error: 'Invalid chunkIndex' }, { status: 400 });
    }

    const access = await authorizeParticipantUpload(req, sessionId, participantType);
    if (!access.ok) return access.response;

    const storageKey = chunkStorageKey(access.session.id, participantType, chunkIndex);
    const storage = getStorageProvider();

    let uploadUrl: string;
    let method: 'PUT' | 'POST';

    if (storage.getPresignedUploadUrl) {
      uploadUrl = await storage.getPresignedUploadUrl(storageKey, 3600);
      method = 'PUT';
    } else {
      uploadUrl = '/api/upload/chunk';
      method = 'POST';
    }

    // Pre-register chunk metadata so gaps are detectable before the upload lands
    await recordChunkMetadata(
      access.session.id,
      participantType,
      chunkIndex,
      storageKey,
      Number.isFinite(sizeBytes) ? sizeBytes : 0,
      'pending',
      0,
      null
    );

    return NextResponse.json({ uploadUrl, storageKey, chunkIndex, method });
  } catch (error) {
    console.error('[presigned-url] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}, { allowGuest: true });
