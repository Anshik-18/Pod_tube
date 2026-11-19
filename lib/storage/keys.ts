import type { ParticipantId } from '@/lib/participants';

export type ParticipantType = ParticipantId;

export function chunkStorageKey(sessionId: string, participantType: ParticipantType, chunkIndex: number): string {
  return `sessions/${sessionId}/${participantType}/chunks/${chunkIndex}.webm`;
}

/** Consolidated, untouched source recording for one participant ("separate track"). */
export function trackStorageKey(sessionId: string, participantType: ParticipantType, extension = 'webm'): string {
  return `sessions/${sessionId}/${participantType}/track.${extension}`;
}
