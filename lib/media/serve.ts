import fs from 'fs';
import { Readable } from 'stream';
import { NextRequest, NextResponse } from 'next/server';
import { getStorageProvider } from '@/lib/storage';
import { LocalStorageProvider } from '@/lib/storage/local';
import type { Episode } from '@/lib/db/queries/episodes';
import { isParticipantId, participantLabel } from '@/lib/participants';

export type MediaKind = 'video' | 'audio' | 'thumbnail' | 'track';

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  jpg: 'image/jpeg',
};

function contentTypeFor(key: string): string {
  return CONTENT_TYPES[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .toLowerCase()
      .slice(0, 80) || 'episode'
  );
}

/**
 * Resolve the storage key and a friendly download filename for one of an episode's assets.
 */
export function resolveEpisodeMedia(
  episode: Episode,
  kind: MediaKind,
  participant?: string | null,
  names?: Record<string, string> | null
): { key: string; filename: string } | null {
  const files = episode.file_references;
  if (!files) return null;
  const base = slugify(episode.title || `episode-${episode.id.slice(0, 8)}`);

  switch (kind) {
    case 'video':
      return files.video ? { key: files.video, filename: `${base}.mp4` } : null;
    case 'audio':
      return files.audio ? { key: files.audio, filename: `${base}.mp3` } : null;
    case 'thumbnail':
      return files.thumbnail ? { key: files.thumbnail, filename: `${base}.jpg` } : null;
    case 'track': {
      if (!isParticipantId(participant)) return null;
      const key = files.tracks?.[participant];
      const extension = key?.split('.').pop() || 'webm';
      const who = slugify(participantLabel(participant, names)) || participant;
      return key ? { key, filename: `${base}-${who}-track.${extension}` } : null;
    }
    default:
      return null;
  }
}

/**
 * Serve a stored object: redirect to a short-lived signed URL on R2/S3, or stream from local
 * disk with HTTP Range support so <video> seeking works.
 */
export async function serveStoredMedia(
  req: NextRequest,
  key: string,
  { filename, inline }: { filename: string; inline: boolean }
): Promise<NextResponse> {
  const storage = getStorageProvider();
  const contentType = contentTypeFor(key);

  if (storage.getSignedDownloadUrl) {
    const url = await storage.getSignedDownloadUrl(key, { filename, inline, contentType });
    return NextResponse.redirect(url, 302);
  }

  if (!(storage instanceof LocalStorageProvider)) {
    const buffer = await storage.read(key);
    return new NextResponse(new Uint8Array(buffer), {
      headers: { 'Content-Type': contentType, 'Content-Length': String(buffer.length) },
    });
  }

  const fullPath = storage.resolvePath(key);
  let size: number;
  try {
    size = (await fs.promises.stat(fullPath)).size;
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`;
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  };

  const range = req.headers.get('range');
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] || match[2])) {
    let start = match[1] ? parseInt(match[1], 10) : size - parseInt(match[2], 10);
    let end = match[1] && match[2] ? parseInt(match[2], 10) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const stream = Readable.toWeb(fs.createReadStream(fullPath, { start, end })) as ReadableStream;
    return new NextResponse(stream, {
      status: 206,
      headers: { ...baseHeaders, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(fullPath)) as ReadableStream;
  return new NextResponse(stream, { headers: { ...baseHeaders, 'Content-Length': String(size) } });
}
