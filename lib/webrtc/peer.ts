import { getWebRTCConfig, WebRTCConfig } from './config';

export class WebRTCPeer {
  private peerConnection: RTCPeerConnection;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private onRemoteStream: ((stream: MediaStream) => void) | null = null;
  private onIceCandidate: ((candidate: RTCIceCandidateInit) => void) | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(config?: WebRTCConfig) {
    const rtcConfig = config || getWebRTCConfig();
    this.peerConnection = new RTCPeerConnection({ iceServers: rtcConfig.iceServers });

    this.peerConnection.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0];
      } else {
        if (!this.remoteStream) {
          this.remoteStream = new MediaStream();
        }
        this.remoteStream.addTrack(event.track);
      }

      if (this.onRemoteStream && this.remoteStream) {
        this.onRemoteStream(this.remoteStream);
      }
    };

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        if (this.onIceCandidate) {
          this.onIceCandidate(event.candidate.toJSON());
        }
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      if (this.peerConnection.iceConnectionState === 'failed') {
        console.warn('[WebRTC] ICE connection failed. Retrying ICE candidate gathering...');
        try {
          if ('restartIce' in this.peerConnection) {
            (this.peerConnection as any).restartIce();
          }
        } catch (e) {
          console.warn('[WebRTC] Could not restart ICE:', e);
        }
      }
    };

  }

  async setLocalStream(stream: MediaStream): Promise<void> {
    this.localStream = stream;
    const senders = this.peerConnection.getSenders();
    stream.getTracks().forEach((track) => {
      const alreadyAdded = senders.some((sender) => sender.track?.id === track.id);
      if (!alreadyAdded) {
        this.peerConnection.addTrack(track, stream);
      }
    });
  }

  setOnRemoteStream(callback: (stream: MediaStream) => void): void {
    this.onRemoteStream = callback;
    if (this.remoteStream) {
      callback(this.remoteStream);
    }
  }

  setOnIceCandidate(callback: (candidate: RTCIceCandidateInit) => void): void {
    this.onIceCandidate = callback;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    const offer = await this.peerConnection.createOffer(options);
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(description));
    // Drain queued ICE candidates now that remote description is set
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (candidate) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('[WebRTC] Error adding queued ICE candidate:', e);
        }
      }
    }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.peerConnection.remoteDescription && this.peerConnection.remoteDescription.type) {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      this.pendingCandidates.push(candidate);
    }
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  getConnectionState(): RTCPeerConnectionState {
    return this.peerConnection.connectionState;
  }

  getPeerConnection(): RTCPeerConnection {
    return this.peerConnection;
  }

  /** Replace the outgoing track of one kind (device switch) without renegotiation. */
  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    const sender = this.peerConnection.getSenders().find((s) => s.track?.kind === track.kind);
    if (sender) await sender.replaceTrack(track);
  }

  /**
   * Close the connection. Local tracks are owned by the caller and keep running, so the same
   * camera/mic can be reused for a new connection when a participant rejoins.
   */
  close(): void {
    this.onRemoteStream = null;
    this.onIceCandidate = null;
    this.peerConnection.ontrack = null;
    this.peerConnection.onicecandidate = null;
    this.peerConnection.close();
  }
}
