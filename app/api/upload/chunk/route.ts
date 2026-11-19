import { NextResponse } from 'next/server';
import { withAuth, AuthenticatedRequest } from '@/lib/auth/middleware';
import { authorizeParticipantUpload, chunkStorageKey } from '@/lib/auth/session-access';
import { getStorageProvider } from '@/lib/storage';
import { recordChunkMetadata } from '@/lib/db/queries/chunks';

/**
 * POST /api/upload/chunk
 *
 * Local-storage fallback for chunk uploads (R2/S3 deployments upload directly via presigned PUT).
 */
export const POST = withAuth(async (req: AuthenticatedRequest) => {
  try {
    const formData = await req.formData();
    const chunk = formData.get('file');
    const sessionId = formData.get('sessionId');
    const participantType = formData.get('participantType');
    const chunkIndex = Number(formData.get('chunkIndex'));

    if (!(chunk instanceof Blob) || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const access = await authorizeParticipantUpload(req, sessionId, participantType);
    if (!access.ok) return access.response;

    const participant = participantType as string;
    const storage = getStorageProvider();
    const chunkReference = chunkStorageKey(access.session.id, participant, chunkIndex);
    const buffer = Buffer.from(await chunk.arrayBuffer());
    await storage.save(chunkReference, buffer);

    await recordChunkMetadata(access.session.id, participant, chunkIndex, chunkReference, buffer.length, 'completed');

    return NextResponse.json({ chunkIndex, received: true });
  } catch (error) {
    console.error('Chunk upload error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}, { allowGuest: true });
