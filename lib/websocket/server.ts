import { randomUUID } from 'crypto';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { verifyToken, toIdentity, Identity } from '../auth/jwt';
import {
  getSessionById,
  updateSessionState,
  addSessionMarker,
  setSessionParticipantName,
} from '../db/queries/sessions';
import { getUploadsBySessionId, registerRecordingParticipant, settleAbandonedTracks } from '../db/queries/uploads';
import { getChunkParticipantTypes } from '../db/queries/chunks';
import { MAX_PARTICIPANTS, baseParticipant, cameraSegmentId, isParticipantId, screenTrackId } from '../participants';

type Role = 'host' | 'guest';

/** What every client knows about every other participant. */
export interface Participant {
  socketId: string;
  /** Stable across refreshes: `host` or `guest-<key>`. Tracks are recorded under this id. */
  participantId: string;
  role: Role;
  name: string;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  joinedAt: number;
}

interface RoomState {
  participants: Map<string, Participant>;
  recording: { active: boolean; startedAt: number | null };
  countdownTimer: NodeJS.Timeout | null;
  hostGoneTimer: NodeJS.Timeout | null;
  /** Guests the host removed; they can't rejoin while the studio is open. */
  removed: Set<string>;
}

interface SocketData {
  identity: Identity;
  sessionId?: string;
  role?: Role;
  participantId?: string;
}

const COUNTDOWN_MS = 3000;
/** Stop a recording automatically if the host has been gone this long. */
const HOST_GRACE_MS = 60_000;
const MAX_CHAT_LENGTH = 1000;
const MAX_NAME_LENGTH = 60;
const SIGNAL_EVENTS = ['webrtc-request-offer', 'webrtc-offer', 'webrtc-answer', 'webrtc-ice-candidate'] as const;

let io: SocketIOServer | null = null;
const rooms = new Map<string, RoomState>();

const roomKey = (sessionId: string) => `session:${sessionId}`;

function getRoom(sessionId: string): RoomState {
  let room = rooms.get(sessionId);
  if (!room) {
    room = {
      participants: new Map(),
      recording: { active: false, startedAt: null },
      countdownTimer: null,
      hostGoneTimer: null,
      removed: new Set(),
    };
    rooms.set(sessionId, room);
  }
  return room;
}

function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const name = value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name || fallback;
}

function publicParticipants(room: RoomState) {
  return Array.from(room.participants.values());
}

function maybeDeleteRoom(sessionId: string, room: RoomState) {
  if (room.participants.size === 0 && !room.recording.active && !room.hostGoneTimer && !room.countdownTimer) {
    rooms.delete(sessionId);
  }
}

async function stopRecording(sessionId: string, reason: 'host' | 'host-left') {
  const room = rooms.get(sessionId);
  if (!room || !room.recording.active) return;
  room.recording = { active: false, startedAt: null };
  io?.to(roomKey(sessionId)).emit('recording:stop', { sessionId, reason });
  maybeDeleteRoom(sessionId, room);
  try {
    await updateSessionState(sessionId, 'uploading');
  } catch (err) {
    console.error('[Socket.IO] Failed to mark session uploading:', err);
  }
}

async function startRecording(sessionId: string) {
  const room = rooms.get(sessionId);
  if (!room || room.recording.active) return;
  const startedAt = Date.now();
  room.recording = { active: true, startedAt };

  // Register every camera before announcing the start, so finalize always waits for all of them.
  try {
    const startDate = new Date(startedAt);
    await updateSessionState(sessionId, 'recording', startDate);
    const ids = new Set(publicParticipants(room).map((p) => p.participantId));
    await Promise.all(Array.from(ids, (id) => registerRecordingParticipant(sessionId, id, startDate)));
  } catch (err) {
    console.error('[Socket.IO] Failed to persist recording start:', err);
  }
  io?.to(roomKey(sessionId)).emit('recording:start', { sessionId, startedAt });
}

function inRoom(socket: Socket, sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && (socket.data as SocketData).sessionId === sessionId;
}

/** The participant on `socketId`, only if they're in the same studio as `socket`. */
function peerInRoom(socket: Socket, sessionId: string, socketId: unknown): Participant | null {
  if (typeof socketId !== 'string') return null;
  return rooms.get(sessionId)?.participants.get(socketId) ?? null;
}

export function initializeSocketIO(httpServer: HTTPServer): SocketIOServer {
  if (io) {
    return io;
  }

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    maxHttpBufferSize: 1e6,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) {
      return next(new Error('unauthorized'));
    }
    try {
      (socket.data as SocketData).identity = toIdentity(verifyToken(token));
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;

    // NTP-style clock sync: clients timestamp recordings in server time so tracks recorded on
    // different machines line up even when their system clocks disagree.
    socket.on('time:sync', (_payload: unknown, ack?: (serverTime: number) => void) => {
      if (typeof ack === 'function') ack(Date.now());
    });

    socket.on(
      'join-session',
      async (
        payload:
          | string
          | { sessionId: string; name?: string; micOn?: boolean; camOn?: boolean; alreadyRecording?: boolean; recovering?: unknown }
      ) => {
      const request = typeof payload === 'string' ? { sessionId: payload } : payload || ({} as any);
      const sessionId = request.sessionId;
      const identity = data.identity;

      try {
        if (typeof sessionId !== 'string') throw new Error('Invalid session');

        let role: Role;
        let participantId: string;
        if (identity.role === 'guest') {
          if (identity.sessionId !== sessionId) throw new Error('This invite link is for a different session');
          role = 'guest';
          participantId = identity.participantId ?? 'guest';
        } else {
          const session = await getSessionById(sessionId);
          if (!session || session.host_id !== identity.userId) throw new Error('Session not found');
          role = 'host';
          participantId = 'host';
        }

        const room = getRoom(sessionId);
        if (room.removed.has(participantId)) {
          throw new Error('The host removed you from this studio.');
        }

        // One connection per participant: a refresh or second tab replaces the previous one.
        let replacing = false;
        for (const existing of publicParticipants(room)) {
          if (existing.participantId === participantId && existing.socketId !== socket.id) {
            replacing = true;
            room.participants.delete(existing.socketId);
            const stale = io?.sockets.sockets.get(existing.socketId);
            if (stale) {
              (stale.data as SocketData).sessionId = undefined;
              stale.emit('session-replaced');
              stale.leave(roomKey(sessionId));
            }
            socket.to(roomKey(sessionId)).emit('user-left', { socketId: existing.socketId, participantId });
          }
        }

        const others = new Set(publicParticipants(room).map((p) => p.participantId));
        if (!replacing && !others.has(participantId) && others.size >= MAX_PARTICIPANTS) {
          throw new Error(`This studio is full (${MAX_PARTICIPANTS} people max). Ask the host to make room.`);
        }

        const participant: Participant = {
          socketId: socket.id,
          participantId,
          role,
          name: cleanName(request.name, role === 'host' ? 'Host' : 'Guest'),
          micOn: request.micOn !== false,
          camOn: request.camOn !== false,
          screenOn: false,
          joinedAt: Date.now(),
        };

        data.sessionId = sessionId;
        data.role = role;
        data.participantId = participantId;
        room.participants.set(socket.id, participant);
        socket.join(roomKey(sessionId));

        if (role === 'host' && room.hostGoneTimer) {
          clearTimeout(room.hostGoneTimer);
          room.hostGoneTimer = null;
        }

        // Joining while recording: record a camera track for this person. Someone who was already
        // recorded (refresh, crash) gets a new segment so their earlier chunks stay intact; a client
        // that kept recording through a network blip keeps its current track.
        let recordingTrackId: string | null = null;
        if (room.recording.active && room.recording.startedAt && !request.alreadyRecording) {
          try {
            const [uploads, chunkTracks] = await Promise.all([getUploadsBySessionId(sessionId), getChunkParticipantTypes(sessionId)]);
            const known = [...uploads.map((u) => u.participant_type), ...chunkTracks];
            const segmentNumbers = known
              .filter((id) => id === participantId || id.startsWith(`${participantId}.part`))
              .map((id) => (id === participantId ? 1 : Number(id.slice(`${participantId}.part`.length))));
            const lastSegment = segmentNumbers.length ? Math.max(...segmentNumbers) : 0;
            if (lastSegment > 0) {
              const recovering = Array.isArray(request.recovering)
                ? request.recovering.filter((id: unknown): id is string => isParticipantId(id) && baseParticipant(id) === participantId)
                : [];
              const settled = await settleAbandonedTracks(sessionId, participantId, recovering);
              if (settled.length) console.log(`[Socket.IO] ${participantId} rejoined mid-recording; settled ${settled.join(', ')}`);
            }
            recordingTrackId = cameraSegmentId(participantId, lastSegment + 1);
            await registerRecordingParticipant(sessionId, recordingTrackId, lastSegment === 0 ? new Date(room.recording.startedAt) : new Date());
          } catch (err) {
            console.error('[Socket.IO] Failed to register late joiner:', err);
          }
        }

        socket.emit('room-state', {
          self: participant,
          participants: publicParticipants(room).filter((p) => p.socketId !== socket.id),
          recording: room.recording,
          recordingTrackId,
          serverTime: Date.now(),
        });
        socket.to(roomKey(sessionId)).emit('user-joined', participant);
        setSessionParticipantName(sessionId, participantId, participant.name).catch(() => {});
      } catch (err) {
        socket.emit('session-error', { message: (err as Error).message || 'Unable to join session' });
      }
      }
    );

    socket.on('leave-session', (sessionId: string) => {
      if (!inRoom(socket, sessionId)) return;
      handleDeparture(socket);
    });

    // WebRTC signaling — each message is addressed to one participant in the caller's own studio.
    for (const event of SIGNAL_EVENTS) {
      socket.on(event, (payload: { sessionId: string; to: string }) => {
        if (!inRoom(socket, payload?.sessionId) || !peerInRoom(socket, payload.sessionId, payload.to)) return;
        io?.to(payload.to).emit(event, { ...payload, from: socket.id });
      });
    }

    socket.on('media-toggle', (payload: { sessionId: string; type: 'camera' | 'mic'; enabled: boolean }) => {
      if (!inRoom(socket, payload?.sessionId)) return;
      const participant = rooms.get(payload.sessionId)?.participants.get(socket.id);
      if (!participant) return;
      if (payload.type === 'camera') participant.camOn = !!payload.enabled;
      if (payload.type === 'mic') participant.micOn = !!payload.enabled;
      socket.to(roomKey(payload.sessionId)).emit('participant:updated', participant);
    });

    socket.on('participant:update', (payload: { sessionId: string; name?: string }) => {
      if (!inRoom(socket, payload?.sessionId)) return;
      const participant = rooms.get(payload.sessionId)?.participants.get(socket.id);
      if (!participant) return;
      participant.name = cleanName(payload.name, participant.name);
      io?.to(roomKey(payload.sessionId)).emit('participant:updated', participant);
      setSessionParticipantName(payload.sessionId, participant.participantId, participant.name).catch(() => {});
    });

    // Screen sharing. The picture travels over the existing peer connections; while recording,
    // each share is also recorded locally as its own track (`<participant>.screen<n>`).
    socket.on('screen:state', (payload: { sessionId: string; active: boolean }) => {
      if (!inRoom(socket, payload?.sessionId)) return;
      const participant = rooms.get(payload.sessionId)?.participants.get(socket.id);
      if (!participant) return;
      participant.screenOn = !!payload.active;
      socket.to(roomKey(payload.sessionId)).emit('participant:updated', participant);
    });

    socket.on('screen:track', async (payload: { sessionId: string }, ack?: (res: { trackId?: string; error?: string }) => void) => {
      if (typeof ack !== 'function') return;
      if (!inRoom(socket, payload?.sessionId) || !data.participantId) return ack({ error: 'Not in this studio' });
      const room = rooms.get(payload.sessionId);
      if (!room?.recording.active) return ack({ error: 'Not recording' });
      try {
        const prefix = `${data.participantId}.screen`;
        const existing = (await getUploadsBySessionId(payload.sessionId)).filter((u) => u.participant_type.startsWith(prefix));
        const trackId = screenTrackId(data.participantId, existing.length + 1);
        await registerRecordingParticipant(payload.sessionId, trackId, new Date());
        ack({ trackId });
      } catch (err) {
        console.error('[Socket.IO] Failed to register screen track:', err);
        ack({ error: 'Could not start recording your screen' });
      }
    });

    // Host controls
    socket.on('participant:mute', (payload: { sessionId: string; socketId: string }) => {
      if (!inRoom(socket, payload?.sessionId) || data.role !== 'host') return;
      const target = peerInRoom(socket, payload.sessionId, payload.socketId);
      if (target && target.socketId !== socket.id) io?.to(target.socketId).emit('control:mute', { by: 'host' });
    });

    socket.on('participant:remove', (payload: { sessionId: string; socketId: string }) => {
      if (!inRoom(socket, payload?.sessionId) || data.role !== 'host') return;
      const room = rooms.get(payload.sessionId);
      const target = peerInRoom(socket, payload.sessionId, payload.socketId);
      if (!room || !target || target.role === 'host') return;
      room.removed.add(target.participantId);
      const targetSocket = io?.sockets.sockets.get(target.socketId);
      targetSocket?.emit('control:removed');
      if (targetSocket) handleDeparture(targetSocket);
    });

    // Recording control — host only. The server owns the clock so every participant starts together.
    socket.on('recording:start', async (payload: { sessionId: string }) => {
      if (!inRoom(socket, payload?.sessionId) || data.role !== 'host') return;
      const sessionId = payload.sessionId;
      const room = getRoom(sessionId);
      if (room.recording.active || room.countdownTimer) return;

      const session = await getSessionById(sessionId).catch(() => null);
      if (!session || session.state !== 'idle') {
        socket.emit('session-error', {
          message: 'This session already has a recording. Start a new session to record another take.',
        });
        return;
      }

      io?.to(roomKey(sessionId)).emit('recording:countdown', { sessionId, durationMs: COUNTDOWN_MS });
      room.countdownTimer = setTimeout(() => {
        room.countdownTimer = null;
        startRecording(sessionId);
      }, COUNTDOWN_MS);
    });

    socket.on('recording:stop', (payload: { sessionId: string }) => {
      if (!inRoom(socket, payload?.sessionId) || data.role !== 'host') return;
      const room = rooms.get(payload.sessionId);
      if (room?.countdownTimer) {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
        io?.to(roomKey(payload.sessionId)).emit('recording:cancelled', { sessionId: payload.sessionId });
        return;
      }
      stopRecording(payload.sessionId, 'host');
    });

    socket.on('marker:add', async (payload: { sessionId: string; label?: string }) => {
      if (!inRoom(socket, payload?.sessionId)) return;
      const room = rooms.get(payload.sessionId);
      if (!room?.recording.active || !room.recording.startedAt) return;
      const participant = room.participants.get(socket.id);
      const marker = {
        id: randomUUID(),
        time: Math.max(0, (Date.now() - room.recording.startedAt) / 1000),
        label: cleanName(payload.label, `Marker by ${participant?.name ?? 'participant'}`),
        created_at: new Date().toISOString(),
      };
      io?.to(roomKey(payload.sessionId)).emit('marker:added', marker);
      addSessionMarker(payload.sessionId, marker).catch((err) => console.error('[Socket.IO] Failed to save marker:', err));
    });

    socket.on('chat:send', (payload: { sessionId: string; text: string }) => {
      if (!inRoom(socket, payload?.sessionId) || typeof payload.text !== 'string') return;
      const text = payload.text.trim().slice(0, MAX_CHAT_LENGTH);
      if (!text) return;
      const participant = rooms.get(payload.sessionId)?.participants.get(socket.id);
      io?.to(roomKey(payload.sessionId)).emit('chat:message', {
        id: randomUUID(),
        socketId: socket.id,
        participantId: participant?.participantId ?? data.participantId,
        role: participant?.role ?? data.role,
        name: participant?.name ?? 'Participant',
        text,
        at: Date.now(),
      });
    });

    socket.on(
      'upload-progress',
      (payload: { sessionId: string; uploaded: number; total: number; failed: number; done: boolean; uploadedBytes?: number; totalBytes?: number }) => {
        if (!inRoom(socket, payload?.sessionId)) return;
        const participant = rooms.get(payload.sessionId)?.participants.get(socket.id);
        socket.to(roomKey(payload.sessionId)).emit('upload-progress', {
          ...payload,
          role: data.role,
          socketId: socket.id,
          participantId: data.participantId,
          name: participant?.name,
        });
      }
    );

    socket.on('disconnecting', () => handleDeparture(socket));
  });

  return io;
}

function handleDeparture(socket: Socket) {
  const data = socket.data as SocketData;
  const sessionId = data.sessionId;
  if (!sessionId) return;
  const room = rooms.get(sessionId);
  data.sessionId = undefined;
  if (!room) return;

  const participant = room.participants.get(socket.id);
  room.participants.delete(socket.id);
  socket.leave(roomKey(sessionId));
  socket.to(roomKey(sessionId)).emit('user-left', { socketId: socket.id, participantId: participant?.participantId });

  if (participant?.role === 'host') {
    if (room.countdownTimer) {
      clearTimeout(room.countdownTimer);
      room.countdownTimer = null;
      io?.to(roomKey(sessionId)).emit('recording:cancelled', { sessionId });
    }
    if (room.recording.active && !room.hostGoneTimer) {
      room.hostGoneTimer = setTimeout(() => {
        room.hostGoneTimer = null;
        stopRecording(sessionId, 'host-left');
      }, HOST_GRACE_MS);
    }
  }

  maybeDeleteRoom(sessionId, room);
}

export function getSocketIO(): SocketIOServer | null {
  return io;
}

export function emitToSession(sessionId: string, event: string, data: any): void {
  if (io) {
    io.to(roomKey(sessionId)).emit(event, data);
  }
}
