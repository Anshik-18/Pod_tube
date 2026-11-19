import type { Socket } from 'socket.io-client';
import type { WebRTCConfig } from './config';

/**
 * PeerMesh — one RTCPeerConnection per remote participant (full mesh).
 *
 * Every connection has the same three transceivers, always in this order:
 *   0 audio (microphone)   1 video (camera)   2 video (screen share)
 * so tracks are identified by position, and switching devices or starting a screen share is a
 * replaceTrack() — no renegotiation, no glare.
 *
 * Exactly one side of each pair creates the offer (the one with the smaller participant id).
 * Each offer carries a connection id; answers and ICE candidates for an older connection are
 * dropped, so rebuilding a broken connection can't be confused by late messages.
 */

export type PeerConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed';
export type ConnectionQuality = 'good' | 'fair' | 'poor' | 'unknown';

export interface RemoteMedia {
  camera: MediaStream;
  screen: MediaStream | null;
}

export interface PeerMeshCallbacks {
  onMedia: (socketId: string, media: RemoteMedia) => void;
  onState: (socketId: string, state: PeerConnectionState) => void;
  onQuality: (socketId: string, quality: ConnectionQuality) => void;
}

interface RemoteInfo {
  socketId: string;
  participantId: string;
}

interface PeerEntry {
  remote: RemoteInfo;
  pc: RTCPeerConnection;
  connId: string;
  initiator: boolean;
  transceivers: RTCRtpTransceiver[];
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescriptionSet: boolean;
  camera: MediaStream;
  screen: MediaStream | null;
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  lastStats: { lost: number; received: number } | null;
}

/** How long a disconnected connection may stay down before it is rebuilt. */
const RECOVER_AFTER_MS = 4000;
const STATS_INTERVAL_MS = 4000;

const newConnId = () => Math.random().toString(36).slice(2, 10);

/**
 * Outgoing camera budget per connection. In a mesh everyone encodes and uploads a stream per
 * peer, so the live call stays light — a 1080p call encode on top of the 1080p local recording
 * starves the CPU and the video stutters. Recordings are made locally and are unaffected.
 */
export function cameraSendBudget(peerCount: number, captureHeight: number): { maxBitrate: number; scaleResolutionDownBy: number } {
  const [targetHeight, maxBitrate] =
    peerCount <= 1 ? [720, 1_500_000] : peerCount <= 3 ? [540, 900_000] : peerCount <= 5 ? [360, 550_000] : [270, 350_000];
  const height = captureHeight > 0 ? captureHeight : 1080;
  return { maxBitrate, scaleResolutionDownBy: Math.max(1, height / targetHeight) };
}

export class PeerMesh {
  private peers = new Map<string, PeerEntry>();
  private audioTrack: MediaStreamTrack | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(
    private socket: Socket,
    private sessionId: string,
    private selfParticipantId: string,
    private config: WebRTCConfig,
    private callbacks: PeerMeshCallbacks
  ) {
    this.statsTimer = setInterval(() => this.sampleQuality(), STATS_INTERVAL_MS);
  }

  /** Local camera + mic sent to everyone. */
  setLocalStream(stream: MediaStream) {
    this.audioTrack = stream.getAudioTracks()[0] ?? null;
    this.videoTrack = stream.getVideoTracks()[0] ?? null;
    for (const peer of this.peers.values()) this.applyLocalTracks(peer);
    this.tuneSenders();
  }

  /** Screen share sent to everyone (null stops sharing). */
  setScreenTrack(track: MediaStreamTrack | null) {
    this.screenTrack = track;
    for (const peer of this.peers.values()) {
      peer.transceivers[2]?.sender.replaceTrack(track).catch(() => {});
    }
  }

  /** A participant is in the studio: connect to them (or wait for their offer). */
  connect(remote: RemoteInfo) {
    if (this.destroyed || this.peers.has(remote.socketId)) return;
    if (this.isInitiator(remote)) {
      this.startOffer(remote).catch((err) => console.error('[Mesh] Failed to create offer:', err));
    } else {
      // The other side offers; until then show them as connecting.
      this.callbacks.onState(remote.socketId, 'connecting');
    }
  }

  disconnect(socketId: string) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    this.closePeer(peer);
    this.peers.delete(socketId);
    this.tuneSenders();
  }

  destroy() {
    this.destroyed = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    for (const peer of this.peers.values()) this.closePeer(peer);
    this.peers.clear();
  }

  // ── Signaling handlers (wired to socket events by the caller) ──

  async handleOffer(from: RemoteInfo, offer: RTCSessionDescriptionInit, connId: string) {
    if (this.destroyed) return;
    const existing = this.peers.get(from.socketId);
    if (existing) this.closePeer(existing);

    const peer = this.createPeer(from, connId, false);
    try {
      await peer.pc.setRemoteDescription(offer);
      peer.transceivers = peer.pc.getTransceivers().slice(0, 3);
      for (const t of peer.transceivers) t.direction = 'sendrecv';
      this.applyLocalTracks(peer);
      await this.flushCandidates(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.tuneSenders();
      this.emit('webrtc-answer', from.socketId, { answer, connId });
    } catch (err) {
      console.error('[Mesh] Failed to answer offer:', err);
    }
  }

  async handleAnswer(fromSocketId: string, answer: RTCSessionDescriptionInit, connId: string) {
    const peer = this.peers.get(fromSocketId);
    if (!peer || peer.connId !== connId || peer.pc.signalingState !== 'have-local-offer') return;
    try {
      await peer.pc.setRemoteDescription(answer);
      await this.flushCandidates(peer);
    } catch (err) {
      console.error('[Mesh] Failed to apply answer:', err);
    }
  }

  async handleCandidate(fromSocketId: string, candidate: RTCIceCandidateInit, connId: string) {
    const peer = this.peers.get(fromSocketId);
    if (!peer || peer.connId !== connId || !candidate) return;
    if (!peer.remoteDescriptionSet) {
      peer.pendingCandidates.push(candidate);
      return;
    }
    await peer.pc.addIceCandidate(candidate).catch(() => {});
  }

  /** The other side asked for a fresh connection (it detected a failure). */
  handleOfferRequest(from: RemoteInfo) {
    if (this.destroyed || !this.isInitiator(from)) return;
    this.startOffer(from).catch((err) => console.error('[Mesh] Failed to re-offer:', err));
  }

  getPeerConnection(socketId: string): RTCPeerConnection | null {
    return this.peers.get(socketId)?.pc ?? null;
  }

  // ── Internals ──

  private isInitiator(remote: RemoteInfo) {
    return this.selfParticipantId < remote.participantId;
  }

  private emit(event: string, to: string, payload: Record<string, unknown>) {
    this.socket.emit(event, { sessionId: this.sessionId, to, ...payload });
  }

  private async startOffer(remote: RemoteInfo) {
    const existing = this.peers.get(remote.socketId);
    if (existing) this.closePeer(existing);

    const peer = this.createPeer(remote, newConnId(), true);
    const pc = peer.pc;
    peer.transceivers = [
      pc.addTransceiver('audio', { direction: 'sendrecv' }),
      pc.addTransceiver('video', { direction: 'sendrecv' }),
      pc.addTransceiver('video', { direction: 'sendrecv' }),
    ];
    this.applyLocalTracks(peer);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.tuneSenders();
    this.emit('webrtc-offer', remote.socketId, { offer, connId: peer.connId });
  }

  private createPeer(remote: RemoteInfo, connId: string, initiator: boolean): PeerEntry {
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    const peer: PeerEntry = {
      remote,
      pc,
      connId,
      initiator,
      transceivers: [],
      pendingCandidates: [],
      remoteDescriptionSet: false,
      camera: new MediaStream(),
      screen: null,
      recoveryTimer: null,
      lastStats: null,
    };
    this.peers.set(remote.socketId, peer);
    this.callbacks.onState(remote.socketId, 'connecting');

    pc.onicecandidate = (event) => {
      if (event.candidate) this.emit('webrtc-ice-candidate', remote.socketId, { candidate: event.candidate.toJSON(), connId });
    };

    pc.ontrack = (event) => {
      if (this.peers.get(remote.socketId) !== peer) return;
      const index = pc.getTransceivers().indexOf(event.transceiver);
      if (index === 2) {
        peer.screen = new MediaStream([event.track]);
      } else {
        peer.camera.getTracks().filter((t) => t.kind === event.track.kind).forEach((t) => peer.camera.removeTrack(t));
        peer.camera.addTrack(event.track);
        // A new MediaStream object so React notices the change.
        peer.camera = new MediaStream(peer.camera.getTracks());
      }
      this.callbacks.onMedia(remote.socketId, { camera: peer.camera, screen: peer.screen });
    };

    pc.onconnectionstatechange = () => {
      if (this.peers.get(remote.socketId) !== peer) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        if (peer.recoveryTimer) clearTimeout(peer.recoveryTimer);
        peer.recoveryTimer = null;
        this.callbacks.onState(remote.socketId, 'connected');
        this.tuneSenders();
      } else if (state === 'disconnected' || state === 'failed') {
        this.callbacks.onState(remote.socketId, 'reconnecting');
        this.scheduleRecovery(peer, state === 'failed' ? 0 : RECOVER_AFTER_MS);
      }
    };

    return peer;
  }

  private scheduleRecovery(peer: PeerEntry, delayMs: number) {
    if (peer.recoveryTimer) return;
    peer.recoveryTimer = setTimeout(() => {
      peer.recoveryTimer = null;
      if (this.destroyed || this.peers.get(peer.remote.socketId) !== peer || peer.pc.connectionState === 'connected') return;
      if (peer.initiator) {
        this.startOffer(peer.remote).catch(() => {});
      } else {
        this.emit('webrtc-request-offer', peer.remote.socketId, {});
        // If no new offer arrives, keep asking.
        this.scheduleRecovery(peer, RECOVER_AFTER_MS * 2);
      }
    }, delayMs);
  }

  /** Apply the per-connection camera budget for the current room size (and screen-share detail). */
  private tuneSenders() {
    const budget = cameraSendBudget(this.peers.size, this.videoTrack?.getSettings().height ?? 0);
    for (const peer of this.peers.values()) {
      this.applyEncoding(peer.transceivers[1]?.sender, budget);
      // Screens carry text: keep resolution, cap bitrate a little higher.
      this.applyEncoding(peer.transceivers[2]?.sender, { maxBitrate: Math.max(budget.maxBitrate * 2, 1_500_000), scaleResolutionDownBy: 1 });
    }
  }

  private applyEncoding(sender: RTCRtpSender | undefined, encoding: { maxBitrate: number; scaleResolutionDownBy: number }) {
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const current = params.encodings[0];
    if (current.maxBitrate === encoding.maxBitrate && Math.abs((current.scaleResolutionDownBy ?? 1) - encoding.scaleResolutionDownBy) < 0.01) return;
    params.encodings[0] = { ...current, ...encoding };
    sender.setParameters(params).catch(() => {});
  }

  private applyLocalTracks(peer: PeerEntry) {
    const [audio, video, screen] = peer.transceivers;
    audio?.sender.replaceTrack(this.audioTrack).catch(() => {});
    video?.sender.replaceTrack(this.videoTrack).catch(() => {});
    screen?.sender.replaceTrack(this.screenTrack).catch(() => {});
  }

  private async flushCandidates(peer: PeerEntry) {
    peer.remoteDescriptionSet = true;
    const queued = peer.pendingCandidates.splice(0);
    for (const candidate of queued) {
      await peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  private closePeer(peer: PeerEntry) {
    if (peer.recoveryTimer) clearTimeout(peer.recoveryTimer);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
  }

  /** Round-trip time and packet loss of incoming media -> a simple quality grade per peer. */
  private async sampleQuality() {
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState !== 'connected') continue;
      try {
        const report = await peer.pc.getStats();
        let rtt: number | null = null;
        let lost = 0;
        let received = 0;
        report.forEach((stat: any) => {
          if (stat.type === 'candidate-pair' && stat.nominated && typeof stat.currentRoundTripTime === 'number') {
            rtt = stat.currentRoundTripTime;
          }
          if (stat.type === 'inbound-rtp') {
            lost += stat.packetsLost ?? 0;
            received += stat.packetsReceived ?? 0;
          }
        });
        const prev = peer.lastStats;
        peer.lastStats = { lost, received };
        const dLost = prev ? Math.max(0, lost - prev.lost) : 0;
        const dReceived = prev ? Math.max(0, received - prev.received) : 0;
        const lossRate = dReceived + dLost > 0 ? dLost / (dReceived + dLost) : 0;
        const rttMs = rtt !== null ? (rtt as number) * 1000 : 0;

        let quality: ConnectionQuality = 'good';
        if (lossRate > 0.08 || rttMs > 600) quality = 'poor';
        else if (lossRate > 0.02 || rttMs > 300) quality = 'fair';
        this.callbacks.onQuality(peer.remote.socketId, quality);
      } catch {
        // Stats are best-effort.
      }
    }
  }
}
