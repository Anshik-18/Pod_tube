'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { io, Socket } from 'socket.io-client';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Bookmark,
  Users,
  MessageSquare,
  Settings,
  LogOut,
  LayoutGrid,
  GalleryVerticalEnd,
  UserPlus,
  Home,
  CloudUpload,
  CheckCircle2,
  AlertTriangle,
  WifiOff,
  Square,
  ArrowRight,
  MonitorUp,
  MonitorX,
  NotebookPen,
  BookmarkPlus,
} from 'lucide-react';
import { fetchWebRTCConfig } from '@/lib/webrtc/config';
import { PeerMesh, RemoteMedia, PeerConnectionState, ConnectionQuality } from '@/lib/webrtc/mesh';
import { TrackRecorder, TrackStatus } from '@/lib/recording/track-recorder';
import { chunkStore, StoredTrack } from '@/lib/recording/chunk-store';
import { MAX_PARTICIPANTS, baseParticipant, isScreenTrack } from '@/lib/participants';
import { api } from '@/lib/client/api';
import { cn } from '@/lib/client/cn';
import { formatClock, formatBytes } from '@/lib/client/format';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { LogoMark } from '@/components/ui/Logo';
import { ParticipantTile } from './ParticipantTile';
import { SidePanel, PanelId, ChatMessage, Marker, PersonRow } from './SidePanel';
import { InviteDialog } from './InviteDialog';
import { SettingsDialog } from './SettingsDialog';
import { buildConstraints, describeMediaError, LobbyResult } from './Lobby';
import { measureClockOffset, useElapsed } from './hooks';

type Role = 'host' | 'guest';

interface RemoteParticipant {
  socketId: string;
  participantId: string;
  role: Role;
  name: string;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  joinedAt: number;
}

interface RemoteUpload {
  participantId: string;
  name?: string;
  uploaded: number;
  total: number;
  failed: number;
  done: boolean;
}

type RecordingPhase = 'idle' | 'countdown' | 'recording' | 'stopped';
type UploadPhase = 'idle' | 'uploading' | 'done' | 'failed';
type Layout = 'grid' | 'speaker';

/** A tile on the stage: someone's camera or someone's screen share. */
interface StageTile {
  key: string;
  kind: 'camera' | 'screen';
  socketId: string | null;
  name: string;
  isLocal: boolean;
  stream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  connecting: boolean;
  reconnecting: boolean;
  quality?: ConnectionQuality;
}

export interface StudioProps {
  sessionId: string;
  role: Role;
  /** `host` or `guest-<key>`; tracks are recorded under this id. */
  participantId: string;
  authToken: string;
  title: string;
  /** Session state when the studio opened; only an 'idle' session can record. */
  initialSessionState: string;
  /** Host only: invite link token. */
  inviteToken?: string | null;
  lobby: LobbyResult;
  onRename?: (title: string) => Promise<void>;
}

const SELF = 'self';

function percent(stats: { uploaded: number; total: number } | null | undefined): number {
  if (!stats || stats.total === 0) return 0;
  return Math.round((stats.uploaded / stats.total) * 100);
}

/** Columns for an n-person grid: 1, 2, 2x2, 3x2, 3x3 — fewer on narrow screens. */
function gridColumns(n: number, narrow: boolean): number {
  if (narrow) return n <= 2 ? 1 : 2;
  return Math.ceil(Math.sqrt(n));
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}

export function Studio({ sessionId, role, participantId, authToken, title, initialSessionState, inviteToken, lobby, onRename }: StudioProps) {
  const isHost = role === 'host';
  const { showToast } = useToast();
  const narrow = useNarrow();

  // ── Local media ───────────────────────────────────────────────
  const [localStream, setLocalStream] = useState<MediaStream>(lobby.stream);
  const localStreamRef = useRef<MediaStream>(lobby.stream);
  const [micOn, setMicOn] = useState(lobby.micOn);
  const [camOn, setCamOn] = useState(lobby.camOn);
  const [speakerId, setSpeakerId] = useState<string | null>(lobby.speakerId);
  const [mirror, setMirror] = useState(true);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const selfName = lobby.name;

  // ── Connection ────────────────────────────────────────────────
  const socketRef = useRef<Socket | null>(null);
  const meshRef = useRef<PeerMesh | null>(null);
  const clockOffsetRef = useRef(0);
  const joinedRef = useRef(false);
  const [selfSocketId, setSelfSocketId] = useState<string | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [remotes, setRemotes] = useState<Record<string, RemoteParticipant>>({});
  const remotesRef = useRef<Record<string, RemoteParticipant>>({});
  const [media, setMedia] = useState<Record<string, RemoteMedia>>({});
  const [peerStates, setPeerStates] = useState<Record<string, PeerConnectionState>>({});
  const [qualities, setQualities] = useState<Record<string, ConnectionQuality>>({});

  // ── Recording & upload ────────────────────────────────────────
  const cameraRecorderRef = useRef<TrackRecorder | null>(null);
  const screenRecorderRef = useRef<TrackRecorder | null>(null);
  const allRecordersRef = useRef<TrackRecorder[]>([]);
  const [trackStatuses, setTrackStatuses] = useState<Record<string, TrackStatus>>({});
  // A session that is recording right now can be (re)joined and recorded; one that already
  // finished recording can't record again.
  const [recordingPhase, setRecordingPhase] = useState<RecordingPhase>(
    initialSessionState === 'idle' || initialSessionState === 'recording' ? 'idle' : 'stopped'
  );
  const recordingPhaseRef = useRef<RecordingPhase>(recordingPhase);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [remoteUploads, setRemoteUploads] = useState<Record<string, RemoteUpload>>({});
  const [showUploadCard, setShowUploadCard] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const elapsed = useElapsed(recordingPhase === 'recording' ? recordingStartedAt : null, clockOffsetRef.current);

  // ── UI ────────────────────────────────────────────────────────
  const [panel, setPanel] = useState<PanelId | null>(null);
  const panelRef = useRef<PanelId | null>(null);
  const [layout, setLayout] = useState<Layout>('grid');
  const [pinned, setPinned] = useState<string | null>(null);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const speakingRef = useRef<Record<string, boolean>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RemoteParticipant | null>(null);
  const [studioTitle, setStudioTitle] = useState(title);
  const [editingTitle, setEditingTitle] = useState(false);

  const setPhase = (phase: RecordingPhase) => {
    recordingPhaseRef.current = phase;
    setRecordingPhase(phase);
  };
  const updateRemotes = (updater: (prev: Record<string, RemoteParticipant>) => Record<string, RemoteParticipant>) => {
    remotesRef.current = updater(remotesRef.current);
    setRemotes(remotesRef.current);
  };
  const dropRemoteState = (socketId: string) => {
    const without = <T,>(prev: Record<string, T>) => {
      if (!(socketId in prev)) return prev;
      const next = { ...prev };
      delete next[socketId];
      return next;
    };
    setMedia(without);
    setPeerStates(without);
    setQualities(without);
    delete speakingRef.current[socketId];
    setPinned((p) => (p === socketId || p === `screen:${socketId}` ? null : p));
    setActiveSpeaker((s) => (s === socketId ? null : s));
  };

  useEffect(() => {
    panelRef.current = panel;
    if (panel === 'chat') setUnread(0);
  }, [panel]);

  // ── Recording ─────────────────────────────────────────────────

  const emitUploadProgress = useCallback(
    (status: TrackStatus) => {
      if (isScreenTrack(status.trackId)) return;
      socketRef.current?.emit('upload-progress', {
        sessionId,
        uploaded: status.stats?.uploaded ?? 0,
        total: status.stats?.total ?? 0,
        failed: status.stats?.failed ?? 0,
        done: status.phase === 'done',
      });
    },
    [sessionId]
  );

  const recorderOptions = useCallback(
    (trackId: string) => ({
      sessionId,
      trackId,
      authToken,
      clockOffsetMs: () => clockOffsetRef.current,
      onStatus: (status: TrackStatus) => {
        setTrackStatuses((prev) => ({ ...prev, [status.trackId]: status }));
        emitUploadProgress(status);
        if (status.phase === 'failed' && status.error) showToast(`Upload problem: ${status.error}. Check your connection and retry.`, 'error', 8000);
      },
    }),
    [authToken, emitUploadProgress, sessionId, showToast]
  );

  const newRecorder = useCallback(
    (trackId: string) => {
      const recorder = new TrackRecorder(recorderOptions(trackId));
      allRecordersRef.current.push(recorder);
      return recorder;
    },
    [recorderOptions]
  );

  // Tracks from this session that this browser recorded but never finished uploading (the tab
  // crashed or was closed). Looked up before joining so the server keeps them open for us.
  const recoverableRef = useRef<Promise<StoredTrack[]> | null>(null);
  if (!recoverableRef.current && typeof window !== 'undefined') {
    chunkStore.pruneOld();
    recoverableRef.current = chunkStore
      .tracksForSession(sessionId)
      .then((tracks) => tracks.filter((t) => baseParticipant(t.trackId) === participantId))
      .catch(() => []);
  }
  const recoveryStartedRef = useRef(false);
  const startRecovery = useCallback(async () => {
    if (recoveryStartedRef.current) return;
    recoveryStartedRef.current = true;
    const tracks = (await recoverableRef.current) ?? [];
    if (tracks.length === 0) return;
    showToast(
      `Found ${tracks.length === 1 ? 'part of your earlier recording' : `${tracks.length} parts of your earlier recording`} on this device — uploading it now.`,
      'info',
      7000
    );
    for (const stored of tracks) {
      const recorder = await TrackRecorder.recover(recorderOptions(stored.trackId), stored);
      allRecordersRef.current.push(recorder);
    }
  }, [recorderOptions, showToast]);

  const startScreenRecording = useCallback(async () => {
    const stream = screenStreamRef.current;
    const socket = socketRef.current;
    if (!stream || !socket || screenRecorderRef.current || recordingPhaseRef.current !== 'recording') return;
    const res = await new Promise<{ trackId?: string; error?: string }>((resolve) => {
      socket.timeout(8000).emit('screen:track', { sessionId }, (err: unknown, response: { trackId?: string; error?: string }) =>
        resolve(err ? { error: 'No response from server' } : response)
      );
    });
    if (!res.trackId || screenStreamRef.current !== stream) {
      if (res.error && res.error !== 'Not recording') showToast(`Your screen isn’t being recorded: ${res.error}`, 'warning');
      return;
    }
    const recorder = newRecorder(res.trackId);
    try {
      await recorder.start(stream, { videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
      screenRecorderRef.current = recorder;
    } catch (err) {
      showToast(`Couldn’t record your screen: ${(err as Error).message}`, 'warning');
      recorder.stop();
    }
  }, [newRecorder, sessionId, showToast]);

  const stopScreenRecording = useCallback(() => {
    const recorder = screenRecorderRef.current;
    screenRecorderRef.current = null;
    recorder?.stop();
  }, []);

  const startLocalRecording = useCallback(
    async (startedAtServer: number, trackId?: string | null) => {
      if (cameraRecorderRef.current) return;
      const stream = localStreamRef.current;
      const height = stream.getVideoTracks()[0]?.getSettings().height ?? 720;
      const recorder = newRecorder(trackId || participantId);
      try {
        await recorder.start(stream, {
          videoBitsPerSecond: height >= 1080 ? 6_000_000 : 3_500_000,
          audioBitsPerSecond: 192_000,
        });
      } catch (err) {
        recorder.destroy();
        allRecordersRef.current = allRecordersRef.current.filter((r) => r !== recorder);
        showToast(`Couldn’t start recording on this device: ${(err as Error).message}`, 'error', 8000);
        return;
      }
      cameraRecorderRef.current = recorder;
      setRecordingStartedAt(startedAtServer);
      setCountdown(null);
      setPhase('recording');
      setShowUploadCard(false);
      if (screenStreamRef.current) startScreenRecording();
    },
    [newRecorder, participantId, showToast, startScreenRecording]
  );

  const stopLocalRecording = useCallback(async () => {
    stopScreenRecording();
    const recorder = cameraRecorderRef.current;
    cameraRecorderRef.current = null;
    setPhase('stopped');
    if (!recorder) return;
    setShowUploadCard(true);
    await recorder.stop();
  }, [stopScreenRecording]);

  // ── Socket + mesh lifecycle ───────────────────────────────────

  useEffect(() => {
    const socket = io(window.location.origin, {
      auth: { token: authToken },
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;
    let cancelled = false;

    const remoteInfo = (socketId: string) => {
      const p = remotesRef.current[socketId];
      return p ? { socketId, participantId: p.participantId } : null;
    };

    const configPromise = fetchWebRTCConfig(authToken);
    const ensureMesh = async () => {
      if (meshRef.current) return meshRef.current;
      const config = await configPromise;
      if (cancelled) return null;
      if (!meshRef.current) {
        meshRef.current = new PeerMesh(socket, sessionId, participantId, config, {
          onMedia: (socketId, m) => setMedia((prev) => ({ ...prev, [socketId]: m })),
          onState: (socketId, state) => setPeerStates((prev) => (prev[socketId] === state ? prev : { ...prev, [socketId]: state })),
          onQuality: (socketId, q) => setQualities((prev) => (prev[socketId] === q ? prev : { ...prev, [socketId]: q })),
        });
        meshRef.current.setLocalStream(localStreamRef.current);
        if (screenStreamRef.current) meshRef.current.setScreenTrack(screenStreamRef.current.getVideoTracks()[0] ?? null);
      }
      return meshRef.current;
    };

    const join = async () => {
      const tracks = localStreamRef.current;
      const recovering = recoveryStartedRef.current ? [] : ((await recoverableRef.current) ?? []).map((t) => t.trackId);
      socket.emit('join-session', {
        sessionId,
        name: selfName,
        micOn: tracks.getAudioTracks()[0]?.enabled ?? false,
        camOn: tracks.getVideoTracks()[0]?.enabled ?? false,
        alreadyRecording: !!cameraRecorderRef.current,
        recovering,
      });
    };

    socket.on('connect', async () => {
      setSocketConnected(true);
      setSelfSocketId(socket.id ?? null);
      clockOffsetRef.current = await measureClockOffset(socket).catch(() => 0);
      join();
    });

    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') {
        setFatalError('Your access to this studio has expired. Reload the page or use the invite link again.');
        socket.disconnect();
      }
    });

    socket.on('disconnect', () => setSocketConnected(false));

    socket.on('session-error', ({ message }: { message: string }) => {
      if (!joinedRef.current) setFatalError(message);
      else showToast(message, 'error', 6000);
    });

    socket.on('session-replaced', () => {
      setFatalError('You joined this studio from another tab or device, so this window was disconnected.');
      socket.disconnect();
    });

    socket.on(
      'room-state',
      async (state: {
        participants: RemoteParticipant[];
        recording: { active: boolean; startedAt: number | null };
        recordingTrackId?: string | null;
      }) => {
        joinedRef.current = true;
        startRecovery();
        // A (re)join gets fresh connections to everyone.
        for (const socketId of Object.keys(remotesRef.current)) {
          meshRef.current?.disconnect(socketId);
          dropRemoteState(socketId);
        }
        updateRemotes(() => Object.fromEntries(state.participants.map((p) => [p.socketId, p])));

        if (state.recording.active && state.recording.startedAt && !cameraRecorderRef.current && recordingPhaseRef.current !== 'stopped') {
          showToast('Recording is in progress — you’re now being recorded too.', 'info');
          startLocalRecording(state.recording.startedAt, state.recordingTrackId);
        }
        const mesh = await ensureMesh();
        for (const p of state.participants) mesh?.connect({ socketId: p.socketId, participantId: p.participantId });
      }
    );

    socket.on('user-joined', async (participant: RemoteParticipant) => {
      const known = Object.values(remotesRef.current).some((p) => p.participantId === participant.participantId);
      updateRemotes((prev) => ({ ...prev, [participant.socketId]: participant }));
      if (!known) showToast(`${participant.name} joined the studio`, 'info');
      const mesh = await ensureMesh();
      mesh?.connect({ socketId: participant.socketId, participantId: participant.participantId });
    });

    socket.on('user-left', ({ socketId }: { socketId: string }) => {
      const leaving = remotesRef.current[socketId];
      if (!leaving) return;
      meshRef.current?.disconnect(socketId);
      updateRemotes((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
      dropRemoteState(socketId);
      // A refresh shows up as leave + join; only announce people who are really gone.
      setTimeout(() => {
        const back = Object.values(remotesRef.current).some((p) => p.participantId === leaving.participantId);
        if (!back) showToast(`${leaving.name} left the studio`, 'warning');
      }, 2500);
    });

    socket.on('webrtc-request-offer', ({ from }: { from: string }) => {
      const info = remoteInfo(from);
      if (info) meshRef.current?.handleOfferRequest(info);
    });

    socket.on('webrtc-offer', async ({ from, offer, connId }: { from: string; offer: RTCSessionDescriptionInit; connId: string }) => {
      const info = remoteInfo(from);
      const mesh = await ensureMesh();
      if (info && mesh) mesh.handleOffer(info, offer, connId);
    });

    socket.on('webrtc-answer', ({ from, answer, connId }: { from: string; answer: RTCSessionDescriptionInit; connId: string }) => {
      meshRef.current?.handleAnswer(from, answer, connId);
    });

    socket.on('webrtc-ice-candidate', ({ from, candidate, connId }: { from: string; candidate: RTCIceCandidateInit; connId: string }) => {
      meshRef.current?.handleCandidate(from, candidate, connId);
    });

    socket.on('participant:updated', (participant: RemoteParticipant) => {
      if (participant.socketId === socket.id || !remotesRef.current[participant.socketId]) return;
      updateRemotes((prev) => ({ ...prev, [participant.socketId]: participant }));
      if (!participant.screenOn) setPinned((p) => (p === `screen:${participant.socketId}` ? null : p));
    });

    socket.on('control:mute', () => {
      const track = localStreamRef.current.getAudioTracks()[0];
      if (!track?.enabled) return;
      track.enabled = false;
      setMicOn(false);
      socket.emit('media-toggle', { sessionId, type: 'mic', enabled: false });
      showToast('The host muted your microphone. Unmute when you’re ready to speak.', 'info', 6000);
    });

    socket.on('control:removed', () => {
      setRemoved(true);
      meshRef.current?.destroy();
      meshRef.current = null;
      stopLocalRecording();
    });

    socket.on('recording:countdown', ({ durationMs }: { durationMs: number }) => {
      setPhase('countdown');
      const seconds = Math.round(durationMs / 1000);
      setCountdown(seconds);
      for (let i = 1; i < seconds; i++) {
        setTimeout(() => recordingPhaseRef.current === 'countdown' && setCountdown(seconds - i), i * 1000);
      }
    });

    socket.on('recording:cancelled', () => {
      setCountdown(null);
      setPhase('idle');
    });

    socket.on('recording:start', ({ startedAt }: { startedAt: number }) => {
      startLocalRecording(startedAt);
    });

    socket.on('recording:stop', ({ reason }: { reason?: string }) => {
      if (reason === 'host-left') showToast('The host left, so the recording was stopped.', 'warning');
      stopLocalRecording();
    });

    socket.on('marker:added', (marker: Marker) => {
      setMarkers((prev) => [...prev, marker]);
    });

    socket.on('chat:message', (message: ChatMessage) => {
      setMessages((prev) => [...prev.slice(-199), message]);
      if (panelRef.current !== 'chat' && message.socketId !== socket.id) setUnread((n) => n + 1);
    });

    socket.on('upload-progress', (progress: RemoteUpload) => {
      if (!progress.participantId) return;
      setRemoteUploads((prev) => ({ ...prev, [progress.participantId]: progress }));
    });

    return () => {
      cancelled = true;
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      meshRef.current?.destroy();
      meshRef.current = null;
    };
    // The socket lives for the whole studio visit; handlers read fresh values through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Release camera, mic and recorders when leaving the studio. Deferred a tick so React's
  // development double-mount (unmount + immediate remount) doesn't kill the live tracks.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (mountedRef.current) return;
        allRecordersRef.current.forEach((r) => r.destroy());
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      }, 0);
    };
  }, []);

  // ── Upload state (derived) ────────────────────────────────────

  const ownStatuses = Object.values(trackStatuses);
  const uploadPhase: UploadPhase =
    ownStatuses.length === 0
      ? 'idle'
      : ownStatuses.some((s) => s.phase === 'failed')
        ? 'failed'
        : ownStatuses.every((s) => s.phase === 'done')
          ? 'done'
          : 'uploading';
  const episodeId = ownStatuses.find((s) => s.episodeId)?.episodeId ?? null;
  const tookPart = ownStatuses.length > 0;
  const cameraStatus = cameraRecorderRef.current
    ? trackStatuses[cameraRecorderRef.current.trackId] ?? null
    : ownStatuses.filter((s) => !isScreenTrack(s.trackId)).slice(-1)[0] ?? null;

  // Warn before closing the tab while recording or while the recording is still uploading.
  const hasUnsavedWork = recordingPhase === 'recording' || uploadPhase === 'uploading' || uploadPhase === 'failed';
  useEffect(() => {
    if (!hasUnsavedWork) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedWork]);

  // ── Controls ──────────────────────────────────────────────────

  const toggleMic = useCallback(() => {
    const track = localStreamRef.current.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
    socketRef.current?.emit('media-toggle', { sessionId, type: 'mic', enabled: track.enabled });
  }, [sessionId]);

  const toggleCam = useCallback(() => {
    const track = localStreamRef.current.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
    socketRef.current?.emit('media-toggle', { sessionId, type: 'camera', enabled: track.enabled });
  }, [sessionId]);

  const stopScreenShare = useCallback(() => {
    const stream = screenStreamRef.current;
    if (!stream) return;
    screenStreamRef.current = null;
    setScreenStream(null);
    meshRef.current?.setScreenTrack(null);
    socketRef.current?.emit('screen:state', { sessionId, active: false });
    stopScreenRecording();
    stream.getTracks().forEach((t) => t.stop());
    setPinned((p) => (p === `screen:${SELF}` ? null : p));
  }, [sessionId, stopScreenRecording]);

  const startScreenShare = useCallback(async () => {
    if (screenStreamRef.current) return;
    const someoneSharing = Object.values(remotesRef.current).find((p) => p.screenOn);
    if (someoneSharing) {
      showToast(`${someoneSharing.name} is already sharing their screen.`, 'info');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: true,
      });
    } catch (err) {
      if ((err as DOMException)?.name !== 'NotAllowedError') showToast('Couldn’t share your screen.', 'error');
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    track.contentHint = 'detail';
    track.addEventListener('ended', () => stopScreenShare());
    screenStreamRef.current = stream;
    setScreenStream(stream);
    meshRef.current?.setScreenTrack(track);
    socketRef.current?.emit('screen:state', { sessionId, active: true });
    if (recordingPhaseRef.current === 'recording') startScreenRecording();
  }, [sessionId, showToast, startScreenRecording, stopScreenShare]);

  const addMarker = useCallback(() => {
    if (recordingPhaseRef.current !== 'recording') return;
    socketRef.current?.emit('marker:add', { sessionId });
    showToast('Marker added', 'success', 1500);
  }, [sessionId, showToast]);

  const startRecording = () => socketRef.current?.emit('recording:start', { sessionId });
  const stopRecording = () => socketRef.current?.emit('recording:stop', { sessionId });

  const changeDevice = async (kind: 'video' | 'audio', deviceId: string) => {
    if (cameraRecorderRef.current) return;
    try {
      const constraints = buildConstraints(kind === 'video' ? deviceId : null, kind === 'audio' ? deviceId : null);
      const fresh = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: constraints.video } : { audio: constraints.audio });
      const newTrack = kind === 'video' ? fresh.getVideoTracks()[0] : fresh.getAudioTracks()[0];
      newTrack.enabled = kind === 'video' ? camOn : micOn;
      const current = localStreamRef.current;
      const next = new MediaStream([...current.getTracks().filter((t) => t.kind !== newTrack.kind), newTrack]);
      current.getTracks().filter((t) => t.kind === newTrack.kind).forEach((t) => t.stop());
      localStreamRef.current = next;
      setLocalStream(next);
      meshRef.current?.setLocalStream(next);
    } catch (err) {
      showToast(describeMediaError(err), 'error');
    }
  };

  const retryUploads = () => {
    allRecordersRef.current.filter((r) => r.getStatus().phase === 'failed').forEach((r) => r.retry());
  };

  const finishWithoutPending = async () => {
    setFinishing(true);
    try {
      const data = await api<{ episodeId: string }>(`/api/sessions/${sessionId}/finish`, { method: 'POST', token: authToken });
      window.location.href = `/episodes/${data.episodeId}`;
    } catch (err) {
      showToast((err as Error).message || 'Could not start processing', 'error');
      setFinishing(false);
    }
  };

  const sendChat = (text: string) => socketRef.current?.emit('chat:send', { sessionId, text });

  const commitTitle = async (value: string) => {
    setEditingTitle(false);
    const next = value.trim() || 'Untitled recording';
    if (next === studioTitle || !onRename) return;
    const previous = studioTitle;
    setStudioTitle(next);
    try {
      await onRename(next);
    } catch {
      setStudioTitle(previous);
      showToast('Could not rename the studio', 'error');
    }
  };

  const leave = () => {
    socketRef.current?.emit('leave-session', sessionId);
    meshRef.current?.destroy();
    meshRef.current = null;
    localStreamRef.current.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    window.location.href = isHost ? (episodeId ? `/episodes/${episodeId}` : '/dashboard') : '/';
  };

  const requestLeave = () => {
    if (hasUnsavedWork) setLeaveOpen(true);
    else leave();
  };

  const togglePin = useCallback((key: string) => setPinned((p) => (p === key ? null : key)), []);

  const onSpeaking = useCallback((key: string, speaking: boolean) => {
    speakingRef.current[key] = speaking;
    if (speaking) setActiveSpeaker(key);
  }, []);

  // Keyboard shortcuts: M = marker, ⌘/Ctrl+D = mic, ⌘/Ctrl+E = camera
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        addMarker();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        toggleMic();
      } else if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        toggleCam();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addMarker, toggleCam, toggleMic]);

  // ── Derived view state ────────────────────────────────────────

  const isRecording = recordingPhase === 'recording';
  const canRecord = isHost && recordingPhase === 'idle' && socketConnected;
  const remoteList = useMemo(() => Object.values(remotes).sort((a, b) => (a.role === 'host' ? -1 : b.role === 'host' ? 1 : a.joinedAt - b.joinedAt)), [remotes]);

  const tiles: StageTile[] = useMemo(() => {
    const list: StageTile[] = [
      { key: SELF, kind: 'camera', socketId: null, name: selfName, isLocal: true, stream: localStream, micOn, camOn, connecting: false, reconnecting: false },
    ];
    for (const p of remoteList) {
      const state = peerStates[p.socketId];
      const m = media[p.socketId];
      list.push({
        key: p.socketId,
        kind: 'camera',
        socketId: p.socketId,
        name: p.name,
        isLocal: false,
        stream: m?.camera ?? null,
        micOn: p.micOn,
        camOn: p.camOn,
        connecting: state !== 'connected' && !m,
        reconnecting: state === 'reconnecting',
        quality: qualities[p.socketId],
      });
    }
    return list;
  }, [selfName, localStream, micOn, camOn, remoteList, peerStates, media, qualities]);

  const screenTiles: StageTile[] = useMemo(() => {
    const list: StageTile[] = [];
    if (screenStream) {
      list.push({ key: `screen:${SELF}`, kind: 'screen', socketId: null, name: selfName, isLocal: true, stream: screenStream, micOn: false, camOn: true, connecting: false, reconnecting: false });
    }
    for (const p of remoteList) {
      if (!p.screenOn) continue;
      list.push({
        key: `screen:${p.socketId}`,
        kind: 'screen',
        socketId: p.socketId,
        name: p.name,
        isLocal: false,
        stream: media[p.socketId]?.screen ?? null,
        micOn: false,
        camOn: true,
        connecting: !media[p.socketId]?.screen,
        reconnecting: false,
      });
    }
    return list;
  }, [screenStream, selfName, remoteList, media]);

  const allTiles = [...screenTiles, ...tiles];
  const pinnedTile = pinned ? allTiles.find((t) => t.key === pinned) ?? null : null;
  const speakerTile =
    (activeSpeaker && tiles.find((t) => t.key === activeSpeaker && !t.isLocal)) || tiles.find((t) => !t.isLocal) || null;
  const focusTile: StageTile | null =
    pinnedTile ?? screenTiles[0] ?? (layout === 'speaker' && tiles.length > 1 ? speakerTile : null);
  const filmstrip = focusTile ? allTiles.filter((t) => t.key !== focusTile.key) : [];

  const people: PersonRow[] = useMemo(() => {
    const uploadFor = (pid: string, local: boolean) => {
      if (local) {
        if (!cameraStatus) return null;
        return { pct: cameraStatus.phase === 'done' ? 100 : percent(cameraStatus.stats), done: cameraStatus.phase === 'done', failed: cameraStatus.phase === 'failed' };
      }
      const u = remoteUploads[pid];
      if (!u || recordingPhase !== 'stopped') return null;
      return { pct: u.done ? 100 : percent(u), done: u.done, failed: u.failed > 0 && !u.done };
    };
    const rows: PersonRow[] = [
      {
        key: SELF,
        name: selfName,
        role,
        isSelf: true,
        micOn,
        camOn,
        screenOn: !!screenStream,
        status: isRecording ? 'Recording locally' : isHost ? 'Host' : 'Guest',
        upload: recordingPhase === 'stopped' ? uploadFor(participantId, true) : null,
        pinned: pinned === SELF,
      },
    ];
    for (const p of remoteList) {
      const state = peerStates[p.socketId];
      rows.push({
        key: p.socketId,
        name: p.name,
        role: p.role,
        isSelf: false,
        micOn: p.micOn,
        camOn: p.camOn,
        screenOn: p.screenOn,
        status: state === 'connected' ? (isRecording ? 'Recording locally' : p.role === 'host' ? 'Host' : 'Guest') : state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…',
        quality: qualities[p.socketId],
        upload: uploadFor(p.participantId, false),
        pinned: pinned === p.socketId,
      });
    }
    return rows;
  }, [selfName, role, micOn, camOn, screenStream, isRecording, isHost, recordingPhase, participantId, cameraStatus, pinned, remoteList, peerStates, qualities, remoteUploads]);

  if (removed) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
        <LogoMark />
        <h1 className="text-lg font-semibold">The host removed you from the studio</h1>
        <p className="max-w-md text-sm text-ink-muted">
          {uploadPhase === 'uploading' ? 'Keep this tab open while your recording finishes uploading.' : 'You can close this tab.'}
        </p>
        {uploadPhase === 'uploading' && <Badge tone="warning">Uploading…</Badge>}
      </div>
    );
  }

  if (fatalError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
        <AlertTriangle className="h-8 w-8 text-amber-400" />
        <p className="max-w-md text-sm text-ink">{fatalError}</p>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }

  const renderTile = (tile: StageTile, opts: { compact?: boolean; className?: string } = {}) => (
    <ParticipantTile
      key={tile.key}
      stream={tile.stream}
      name={tile.name}
      isLocal={tile.isLocal}
      micOn={tile.micOn}
      camOn={tile.camOn}
      mirror={tile.isLocal ? mirror : false}
      connecting={tile.connecting}
      speakerId={speakerId}
      quality={tile.quality}
      variant={tile.kind}
      compact={opts.compact}
      className={opts.className}
      pinned={pinned === tile.key}
      onTogglePin={() => togglePin(tile.key)}
      onSpeaking={tile.kind === 'camera' ? (s) => onSpeaking(tile.key, s) : undefined}
      badge={
        tile.reconnecting ? (
          <Badge tone="warning">Reconnecting…</Badge>
        ) : isRecording && tile.kind === 'camera' ? (
          <span className="flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rec" /> REC
          </span>
        ) : undefined
      }
    />
  );

  const inviteTile =
    isHost && inviteToken && tiles.length < MAX_PARTICIPANTS ? (
      <button
        type="button"
        onClick={() => setInviteOpen(true)}
        className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line-strong text-center transition-colors hover:border-brand/60 hover:bg-surface"
      >
        <UserPlus className="h-6 w-6 text-ink-faint" />
        <div>
          <p className="text-sm font-medium">Invite guests</p>
          <p className="mt-0.5 text-xs text-ink-faint">Up to {MAX_PARTICIPANTS} people — they join from their browser.</p>
        </div>
      </button>
    ) : null;

  const waitingTile =
    !isHost && tiles.length === 1 ? (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-center">
        <p className="text-sm font-medium">Waiting for the host to join…</p>
        <p className="text-xs text-ink-faint">You’ll be connected automatically.</p>
      </div>
    ) : null;

  const gridItems = tiles.length === 1 ? [renderTile(tiles[0]), inviteTile ?? waitingTile].filter(Boolean) : tiles.map((t) => renderTile(t));
  const cols = gridColumns(gridItems.length, narrow);
  const rows = Math.ceil(gridItems.length / cols);
  const departedUploads = Object.values(remoteUploads).filter((u) => !remoteList.some((p) => p.participantId === u.participantId));
  const pendingNames =
    recordingPhase === 'stopped'
      ? [
          ...remoteList.filter((p) => remoteUploads[p.participantId] && !remoteUploads[p.participantId].done).map((p) => p.name),
          ...departedUploads.filter((u) => !u.done).map((u) => u.name ?? 'Guest'),
        ]
      : [];

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-canvas text-ink">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3 sm:px-4">
        {isHost ? (
          <Link
            href="/dashboard"
            className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-3 hover:text-ink"
            aria-label="Back to dashboard"
            onClick={(e) => {
              if (hasUnsavedWork) {
                e.preventDefault();
                setLeaveOpen(true);
              }
            }}
          >
            <Home className="h-4 w-4" />
          </Link>
        ) : (
          <LogoMark />
        )}
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              autoFocus
              defaultValue={studioTitle}
              maxLength={255}
              onBlur={(e) => commitTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="input h-8 max-w-xs text-sm font-medium"
            />
          ) : (
            <button
              disabled={!isHost}
              onClick={() => setEditingTitle(true)}
              className="max-w-full truncate rounded-md px-1.5 py-1 text-left text-sm font-medium hover:enabled:bg-surface-3"
              title={isHost ? 'Rename' : undefined}
            >
              {studioTitle}
            </button>
          )}
        </div>

        {(isRecording || recordingPhase === 'countdown') && (
          <div className="flex items-center gap-2 rounded-lg bg-rec/15 px-2.5 py-1 font-mono text-sm font-semibold text-red-400" data-testid="rec-timer">
            <span className="h-2 w-2 animate-pulse rounded-full bg-rec" />
            {isRecording ? formatClock(elapsed) : 'Starting…'}
          </div>
        )}

        <div className="flex flex-1 items-center justify-end gap-2">
          {!socketConnected && (
            <Badge tone="warning">
              <WifiOff className="h-3 w-3" /> Reconnecting
            </Badge>
          )}
          <span className="hidden items-center gap-1.5 text-xs text-ink-faint md:flex" data-testid="people-count">
            <Users className="h-3.5 w-3.5" />
            {tiles.length}/{MAX_PARTICIPANTS}
          </span>
          {uploadPhase === 'uploading' && (
            <button onClick={() => setShowUploadCard(true)} className="hidden items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-muted hover:bg-surface-3 sm:flex">
              <CloudUpload className="h-4 w-4" />
              {isRecording ? 'Uploading as you record' : `Uploading ${percent(cameraStatus?.stats)}%`}
            </button>
          )}
          {isHost && inviteToken && (
            <Button size="sm" variant="secondary" onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-4 w-4" />
              <span className="hidden sm:inline">Invite</span>
            </Button>
          )}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* Stage */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 p-3 sm:p-4">
            {focusTile ? (
              <div className={cn('flex h-full gap-3', narrow ? 'flex-col' : 'flex-row')}>
                <div className="min-h-0 min-w-0 flex-1">{renderTile(focusTile)}</div>
                {filmstrip.length > 0 && (
                  <div
                    className={cn('flex shrink-0 gap-3 overflow-auto', narrow ? 'h-24 flex-row' : 'w-48 flex-col lg:w-60')}
                    data-testid="filmstrip"
                  >
                    {filmstrip.map((t) => (
                      <div key={t.key} className={cn('shrink-0', narrow ? 'aspect-video h-full' : 'aspect-video w-full')}>
                        {renderTile(t, { compact: true })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex h-full flex-wrap content-center justify-center gap-3" data-testid="stage-grid">
                {gridItems.map((item, i) => (
                  <div
                    key={i}
                    className="min-h-0 min-w-0"
                    style={{
                      width: `calc((100% - ${(cols - 1) * 0.75}rem) / ${cols})`,
                      height: `calc((100% - ${(rows - 1) * 0.75}rem) / ${rows})`,
                    }}
                  >
                    {item}
                  </div>
                ))}
              </div>
            )}

            {countdown !== null && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/40">
                <span key={countdown} className="text-[120px] font-bold leading-none text-white drop-shadow-2xl animate-count-pop">
                  {countdown}
                </span>
              </div>
            )}
          </div>

          {/* Control dock */}
          <div className="flex shrink-0 items-center justify-center gap-1.5 px-3 pb-4 sm:gap-2">
            <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-line bg-surface p-1.5 shadow-elevated sm:gap-1.5">
              {isHost &&
                (isRecording || recordingPhase === 'countdown' ? (
                  <Button variant="secondary" onClick={stopRecording} className="h-10 shrink-0 gap-2 rounded-xl px-4" data-testid="stop-recording">
                    <Square className="h-3.5 w-3.5 fill-rec text-rec" />
                    Stop
                  </Button>
                ) : (
                  <Button
                    variant="record"
                    onClick={startRecording}
                    disabled={!canRecord}
                    className="h-10 shrink-0 gap-2 rounded-xl px-4"
                    title={recordingPhase === 'stopped' ? 'This session already has a recording' : 'Start recording for everyone'}
                    data-testid="start-recording"
                  >
                    <span className="h-3 w-3 rounded-full bg-white" />
                    Record
                  </Button>
                ))}
              <DockButton label={micOn ? 'Mute (⌘D)' : 'Unmute (⌘D)'} active={!micOn} danger onClick={toggleMic} disabled={!localStream.getAudioTracks().length}>
                {micOn ? <Mic className="h-[18px] w-[18px]" /> : <MicOff className="h-[18px] w-[18px]" />}
              </DockButton>
              <DockButton label={camOn ? 'Stop camera (⌘E)' : 'Start camera (⌘E)'} active={!camOn} danger onClick={toggleCam} disabled={!localStream.getVideoTracks().length}>
                {camOn ? <Video className="h-[18px] w-[18px]" /> : <VideoOff className="h-[18px] w-[18px]" />}
              </DockButton>
              {typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && (
                <DockButton
                  label={screenStream ? 'Stop sharing' : 'Share screen'}
                  active={!!screenStream}
                  onClick={screenStream ? stopScreenShare : startScreenShare}
                  className="hidden sm:flex"
                >
                  {screenStream ? <MonitorX className="h-[18px] w-[18px]" /> : <MonitorUp className="h-[18px] w-[18px]" />}
                </DockButton>
              )}
              {isRecording && (
                <DockButton label="Add marker (M)" onClick={addMarker}>
                  <BookmarkPlus className="h-[18px] w-[18px]" />
                </DockButton>
              )}
              <span className="mx-0.5 hidden h-6 w-px shrink-0 bg-line sm:block" />
              <DockButton
                label={layout === 'grid' ? 'Speaker view' : 'Grid view'}
                onClick={() => {
                  setPinned(null);
                  setLayout((l) => (l === 'grid' ? 'speaker' : 'grid'));
                }}
                className="hidden sm:flex"
                disabled={tiles.length < 2 && screenTiles.length === 0}
              >
                {layout === 'grid' ? <GalleryVerticalEnd className="h-[18px] w-[18px]" /> : <LayoutGrid className="h-[18px] w-[18px]" />}
              </DockButton>
              <DockButton label="People" active={panel === 'people'} onClick={() => setPanel((p) => (p === 'people' ? null : 'people'))}>
                <Users className="h-[18px] w-[18px]" />
              </DockButton>
              <DockButton label="Chat" active={panel === 'chat'} onClick={() => setPanel((p) => (p === 'chat' ? null : 'chat'))} badge={unread}>
                <MessageSquare className="h-[18px] w-[18px]" />
              </DockButton>
              <DockButton label="Notes" active={panel === 'notes'} onClick={() => setPanel((p) => (p === 'notes' ? null : 'notes'))} className="hidden sm:flex">
                <NotebookPen className="h-[18px] w-[18px]" />
              </DockButton>
              <DockButton
                label="Markers"
                active={panel === 'markers'}
                onClick={() => setPanel((p) => (p === 'markers' ? null : 'markers'))}
                badge={markers.length && panel !== 'markers' ? markers.length : 0}
                badgeTone="neutral"
                className="hidden sm:flex"
              >
                <Bookmark className="h-[18px] w-[18px]" />
              </DockButton>
              <DockButton label="Settings" onClick={() => setSettingsOpen(true)}>
                <Settings className="h-[18px] w-[18px]" />
              </DockButton>
              <span className="mx-0.5 h-6 w-px shrink-0 bg-line" />
              <DockButton label="Leave studio" danger onClick={requestLeave}>
                <LogOut className="h-[18px] w-[18px]" />
              </DockButton>
            </div>
          </div>
        </main>

        {panel && (
          <SidePanel
            panel={panel}
            onClose={() => setPanel(null)}
            people={people}
            canInvite={isHost && !!inviteToken}
            onInvite={() => setInviteOpen(true)}
            messages={messages}
            selfSocketId={selfSocketId}
            onSendMessage={sendChat}
            markers={markers}
            canAddMarker={isRecording}
            onAddMarker={addMarker}
            capacity={MAX_PARTICIPANTS}
            notesKey={`podnow:notes:${sessionId}:${participantId}`}
            actions={{
              canManage: isHost,
              onPin: togglePin,
              onMute: (key) => socketRef.current?.emit('participant:mute', { sessionId, socketId: key }),
              onRemove: (key) => setRemoveTarget(remotesRef.current[key] ?? null),
            }}
          />
        )}

        {/* Post-recording upload status */}
        {showUploadCard && tookPart && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-md rounded-2xl border border-line bg-surface-2 p-6 shadow-elevated animate-scale-in" data-testid="upload-card">
              <UploadSummary
                isHost={isHost}
                selfName={selfName}
                phase={uploadPhase}
                statuses={ownStatuses}
                remotes={isHost ? remoteList.map((p) => ({ name: p.name, upload: remoteUploads[p.participantId] ?? null })) : []}
                departed={isHost ? departedUploads : []}
                onRetry={retryUploads}
              />
              {isHost && uploadPhase === 'done' && pendingNames.length > 0 && (
                <p className="mt-4 text-xs text-ink-faint">
                  Still uploading: {pendingNames.join(', ')}. Processing starts automatically when they finish. If someone can’t finish,
                  you can process now with what has arrived.
                </p>
              )}
              <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
                {isHost ? (
                  <>
                    <Button className="flex-1" disabled={!episodeId} onClick={leave} data-testid="go-to-project">
                      {episodeId ? 'Go to project' : 'Preparing project…'}
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                    {uploadPhase === 'done' && pendingNames.length > 0 && (
                      <Button variant="secondary" onClick={finishWithoutPending} loading={finishing} title="Start processing without waiting for the remaining uploads">
                        Process now
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setShowUploadCard(false)} disabled={uploadPhase === 'failed'}>
                      Stay
                    </Button>
                  </>
                ) : (
                  <Button className="flex-1" variant={uploadPhase === 'done' ? 'primary' : 'secondary'} disabled={uploadPhase !== 'done'} onClick={leave}>
                    {uploadPhase === 'done' ? 'Leave studio' : 'Keep this tab open…'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {inviteToken && <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} inviteToken={inviteToken} title={studioTitle} />}
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        stream={localStream}
        speakerId={speakerId}
        mirror={mirror}
        locked={isRecording}
        onChangeDevice={changeDevice}
        onChangeSpeaker={setSpeakerId}
        onToggleMirror={() => setMirror((m) => !m)}
      />
      <ConfirmDialog
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        onConfirm={() => {
          setLeaveOpen(false);
          if (isRecording) {
            if (isHost) stopRecording();
            else stopLocalRecording();
          } else {
            leave();
          }
        }}
        title={isRecording ? (isHost ? 'Stop recording and leave?' : 'Leave the recording?') : 'Your recording is still uploading'}
        description={
          isRecording
            ? 'The recording will stop and finish uploading before you can leave. Keep this tab open until the upload completes.'
            : 'Leaving now will lose the parts of your recording that haven’t uploaded yet.'
        }
        confirmLabel={isRecording ? (isHost ? 'Stop recording' : 'Stop my recording') : 'Leave anyway'}
      />
      <ConfirmDialog
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) socketRef.current?.emit('participant:remove', { sessionId, socketId: removeTarget.socketId });
          setRemoveTarget(null);
        }}
        title={`Remove ${removeTarget?.name ?? 'this guest'}?`}
        description="They’ll be disconnected and can’t rejoin this studio while it’s open. Anything they already recorded still uploads."
        confirmLabel="Remove"
      />
    </div>
  );
}

function DockButton({
  label,
  onClick,
  children,
  active,
  danger,
  disabled,
  badge,
  badgeTone = 'brand',
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  badge?: number;
  badgeTone?: 'brand' | 'neutral';
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors disabled:opacity-40',
        active && danger ? 'bg-rec/15 text-red-400 hover:bg-rec/25' : active ? 'bg-surface-4 text-ink' : 'text-ink-muted hover:bg-surface-3 hover:text-ink',
        !active && danger && label.startsWith('Leave') && 'hover:bg-rec/15 hover:text-red-400',
        className
      )}
    >
      {children}
      {!!badge && (
        <span
          className={cn(
            'absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold',
            badgeTone === 'brand' ? 'bg-brand text-white' : 'bg-surface-4 text-ink'
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function UploadSummary({
  isHost,
  selfName,
  phase,
  statuses,
  remotes,
  departed,
  onRetry,
}: {
  isHost: boolean;
  selfName: string;
  phase: UploadPhase;
  statuses: TrackStatus[];
  remotes: Array<{ name: string; upload: RemoteUpload | null }>;
  departed: RemoteUpload[];
  onRetry: () => void;
}) {
  const heading =
    phase === 'done' ? (isHost ? 'Recording saved' : 'All done — thanks for joining!') : phase === 'failed' ? 'Upload interrupted' : 'Uploading your recording';

  return (
    <div>
      <div className="flex items-center gap-3">
        {phase === 'done' ? (
          <CheckCircle2 className="h-6 w-6 text-emerald-400" />
        ) : phase === 'failed' ? (
          <AlertTriangle className="h-6 w-6 text-amber-400" />
        ) : (
          <CloudUpload className="h-6 w-6 text-brand-light" />
        )}
        <h2 className="text-lg font-semibold">{heading}</h2>
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        {phase === 'done'
          ? isHost
            ? 'Your tracks are uploaded. The episode is processed as soon as every participant’s upload completes.'
            : 'Your high-quality tracks have been delivered to the host. You can close this tab.'
          : phase === 'failed'
            ? 'Part of your recording didn’t upload. It’s still saved in this tab — check your connection and retry.'
            : 'Keep this tab open until the upload finishes. Your local recording is full quality, so it may take a moment.'}
      </p>

      <ul className="mt-5 max-h-64 space-y-3 overflow-y-auto pr-1">
        {statuses.map((s) => (
          <UploadRow
            key={s.trackId}
            name={
              s.recovered
                ? `${selfName} (you) — recovered from before`
                : isScreenTrack(s.trackId)
                  ? `${selfName} (you) — screen`
                  : s.trackId.includes('.part')
                    ? `${selfName} (you) — after rejoining`
                    : `${selfName} (you)`
            }
            pct={s.phase === 'done' ? 100 : percent(s.stats)}
            detail={s.stats ? `${formatBytes(s.stats.uploadedBytes)} of ${formatBytes(s.stats.totalBytes)}` : undefined}
            done={s.phase === 'done'}
            failed={s.phase === 'failed'}
          />
        ))}
        {remotes.map((r) =>
          r.upload ? (
            <UploadRow key={r.upload.participantId} name={r.name} pct={r.upload.done ? 100 : percent(r.upload)} done={r.upload.done} failed={r.upload.failed > 0 && !r.upload.done} />
          ) : (
            <UploadRow key={r.name} name={r.name} pct={0} waiting />
          )
        )}
        {departed.map((u) => (
          <UploadRow key={u.participantId} name={u.name ?? 'Guest'} pct={u.done ? 100 : percent(u)} done={u.done} failed={!u.done} />
        ))}
      </ul>

      {phase === 'failed' && (
        <Button className="mt-5 w-full" onClick={onRetry}>
          Retry upload
        </Button>
      )}
    </div>
  );
}

function UploadRow({ name, pct, detail, done, failed, waiting }: { name: string; pct: number; detail?: string; done?: boolean; failed?: boolean; waiting?: boolean }) {
  return (
    <li>
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <span className="truncate font-medium">{name}</span>
        <span className={cn('text-xs', done ? 'text-emerald-400' : failed ? 'text-amber-400' : 'text-ink-muted')}>
          {done ? 'Uploaded' : failed ? 'Retry needed' : waiting ? 'Waiting…' : `${pct}%`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-4">
        <div
          className={cn('h-full rounded-full transition-all duration-500', done ? 'bg-emerald-400' : failed ? 'bg-amber-400' : 'bg-brand')}
          style={{ width: `${Math.max(pct, 3)}%` }}
        />
      </div>
      {detail && !done && <p className="mt-1 text-[11px] text-ink-faint">{detail}</p>}
    </li>
  );
}
