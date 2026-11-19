import path from 'path';
import { getStorageProvider } from '../storage';
import { Episode, EpisodeFiles, TrackWarning, updateEpisodeState } from '../db/queries/episodes';
import { updateSessionState } from '../db/queries/sessions';
import { MergeStageResult } from './merge-stage';
import { ConcatStageResult } from './concat-chunks';
import { runFFmpeg } from './ffmpeg';
import { trackStorageKey } from '../storage/keys';

export interface UploadStageResult {
  storageKey: string;
  fileReferences: EpisodeFiles;
  /** Participants whose chunk-assembled track is now safely persisted. */
  persistedTracks: string[];
}

/**
 * uploadStage
 *
 * Derives the audio-only export and thumbnail from the merged video, uploads every artifact,
 * persists newly assembled per-participant source tracks, and marks the episode ready.
 */
export async function uploadStage(
  episode: Episode,
  concatResult: ConcatStageResult,
  mergeResult: MergeStageResult,
  onProgress?: (fraction: number) => void,
  unusable: Array<{ participantType: string; reason: string }> = []
): Promise<UploadStageResult> {
  const storage = getStorageProvider();
  const { workingDirectory, sessionId } = concatResult;
  const episodeId = episode.id;

  const audioFile = path.join(workingDirectory, 'audio.mp3');
  const thumbnailFile = path.join(workingDirectory, 'thumbnail.jpg');

  await runFFmpeg(['-i', mergeResult.outputFile, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', audioFile], {
    label: 'audio export',
  });
  onProgress?.(0.2);

  const thumbAt = Math.min(3, Math.max(0, mergeResult.durationMs / 1000 / 3));
  await runFFmpeg(['-ss', thumbAt.toFixed(2), '-i', mergeResult.outputFile, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', thumbnailFile], {
    label: 'thumbnail',
  }).catch((err) => console.warn('[UploadStage] Thumbnail generation failed:', err.message));
  onProgress?.(0.3);

  const keys = {
    video: `episodes/${episodeId}/episode.mp4`,
    audio: `episodes/${episodeId}/audio.mp3`,
    thumbnail: `episodes/${episodeId}/thumbnail.jpg`,
  };

  await storage.saveFile(keys.video, mergeResult.outputFile);
  onProgress?.(0.6);
  await storage.saveFile(keys.audio, audioFile);
  const hasThumbnail = await storage
    .saveFile(keys.thumbnail, thumbnailFile)
    .then(() => true)
    .catch(() => false);
  onProgress?.(0.7);

  const tracks: Record<string, string> = { ...(episode.file_references?.tracks ?? {}) };
  const persistedTracks: string[] = [];
  for (const [participantType, track] of Object.entries(concatResult.participants)) {
    if (track.isNewTrack) {
      const extension = path.extname(track.outputFile).slice(1) || 'webm';
      const key = trackStorageKey(sessionId, participantType, extension);
      await storage.saveFile(key, track.outputFile);
      persistedTracks.push(participantType);
      tracks[participantType] = key;
    }
  }
  onProgress?.(1);

  // Re-exports rebuild from saved tracks; keep what earlier runs learned about those tracks.
  const carried = (episode.file_references?.warnings ?? []).filter((w) => {
    const track = concatResult.participants[w.participant];
    return (track && !track.isNewTrack) || (w.kind === 'unusable' && !track);
  });
  const warnings: TrackWarning[] = [
    ...carried,
    ...Object.values(concatResult.participants)
      .filter((p) => p.missingSeconds > 0)
      .map((p) => ({
        participant: p.participantType,
        kind: 'gaps' as const,
        missingSeconds: Math.round(p.missingSeconds * 10) / 10,
        gaps: p.gaps.map((g) => ({ start: Math.round(g.start * 10) / 10, end: Math.round(g.end * 10) / 10 })),
      })),
    ...unusable
      .filter((u) => !carried.some((w) => w.participant === u.participantType))
      .map((u) => ({ participant: u.participantType, kind: 'unusable' as const, message: u.reason })),
  ];

  const fileReferences: EpisodeFiles = {
    video: keys.video,
    audio: keys.audio,
    ...(hasThumbnail ? { thumbnail: keys.thumbnail } : {}),
    tracks,
    durationMs: mergeResult.durationMs,
    sourceDurationMs: mergeResult.sourceDurationMs,
    width: mergeResult.width,
    height: mergeResult.height,
    fileSizeBytes: mergeResult.fileSizeBytes,
    ...(warnings.length ? { warnings } : {}),
  };

  await updateEpisodeState(episodeId, 'ready', fileReferences);
  await updateSessionState(sessionId, 'ready');
  console.log(`[UploadStage] Episode ${episodeId} ready (${(mergeResult.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB)`);

  return { storageKey: keys.video, fileReferences, persistedTracks };
}
