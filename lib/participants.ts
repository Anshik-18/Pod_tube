/**
 * Participant identity, shared by the browser and the server.
 *
 * Every recorded track is keyed by a participant id:
 *   - `host`                  the studio owner
 *   - `guest`                 legacy single-guest sessions (before multi-guest support)
 *   - `guest-<id>`            one invited guest; the id is stable for that browser
 *   - `<participant>.screen<n>` the n-th screen share recorded by that participant
 *   - `<participant>.part<n>`   the n-th camera segment, when someone rejoined mid-recording
 *                              (refresh, crash) — it continues the same person's tile
 *
 * Ids are safe to use as storage path segments and JSON keys.
 */

export type ParticipantId = string;

/** Most people on camera in one studio. Calls are peer-to-peer, so each person uploads to everyone else. */
export const MAX_PARTICIPANTS = 8;

const GUEST_KEY_RE = /^[a-z0-9]{6,24}$/;
const PARTICIPANT_RE = /^(host|guest(-[a-z0-9]{6,24})?)(\.(screen|part)[0-9]{1,3})?$/;

export function isParticipantId(value: unknown): value is ParticipantId {
  return typeof value === 'string' && PARTICIPANT_RE.test(value);
}

export function isGuestKey(value: unknown): value is string {
  return typeof value === 'string' && GUEST_KEY_RE.test(value);
}

export function guestParticipantId(guestKey: string): ParticipantId {
  return `guest-${guestKey}`;
}

/** The camera participant a track belongs to (`guest-ab12cd.screen1` -> `guest-ab12cd`). */
export function baseParticipant(id: ParticipantId): ParticipantId {
  const dot = id.indexOf('.');
  return dot === -1 ? id : id.slice(0, dot);
}

export function isScreenTrack(id: ParticipantId): boolean {
  return id.includes('.screen');
}

export function screenTrackId(owner: ParticipantId, index: number): ParticipantId {
  return `${owner}.screen${index}`;
}

/** A camera track: the participant's first recording or a later segment after rejoining. */
export function isCameraTrack(id: ParticipantId): boolean {
  return !isScreenTrack(id);
}

export function cameraSegmentId(owner: ParticipantId, index: number): ParticipantId {
  return index <= 1 ? owner : `${owner}.part${index}`;
}

export function isHostParticipant(id: ParticipantId): boolean {
  return baseParticipant(id) === 'host';
}

/** Host first, then guests, each camera followed by its screen shares. Stable for the same input. */
export function sortParticipantIds(ids: Iterable<ParticipantId>): ParticipantId[] {
  return Array.from(new Set(ids)).sort((a, b) => {
    const baseA = baseParticipant(a);
    const baseB = baseParticipant(b);
    if (baseA !== baseB) {
      if (baseA === 'host') return -1;
      if (baseB === 'host') return 1;
      return baseA < baseB ? -1 : 1;
    }
    if (isScreenTrack(a) !== isScreenTrack(b)) return isScreenTrack(a) ? 1 : -1;
    const n = (id: string) => Number(id.match(/[0-9]+$/)?.[0] ?? 0) * (id.includes('.') ? 1 : 0);
    return n(a) - n(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/** Human label for a track, using names captured in the studio. */
export function participantLabel(id: ParticipantId, names: Record<string, string | undefined> | null | undefined): string {
  const base = baseParticipant(id);
  const name = names?.[base] || (base === 'host' ? 'Host' : 'Guest');
  if (isScreenTrack(id)) return `${name} — screen ${id.split('.screen')[1] ?? ''}`.trim();
  if (id.includes('.part')) return `${name} — part ${id.split('.part')[1]}`;
  return name;
}
