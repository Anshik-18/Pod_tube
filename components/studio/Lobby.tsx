'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Mic, MicOff, Video, VideoOff, Volume2, AlertTriangle, Headphones } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { LogoMark } from '@/components/ui/Logo';
import { cn } from '@/lib/client/cn';
import { useAudioLevel } from './hooks';

export interface LobbyResult {
  stream: MediaStream;
  name: string;
  micOn: boolean;
  camOn: boolean;
  speakerId: string | null;
}

interface DeviceOption {
  deviceId: string;
  label: string;
}

export function buildConstraints(videoId?: string | null, audioId?: string | null): MediaStreamConstraints {
  return {
    video: {
      ...(videoId ? { deviceId: { exact: videoId } } : {}),
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: {
      ...(audioId ? { deviceId: { exact: audioId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1,
    },
  };
}

export function describeMediaError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera and microphone access is blocked. Click the camera icon in your browser’s address bar, allow access, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera or microphone was found. Connect a device and try again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Your camera or microphone is being used by another app. Close it and try again.';
    case 'OverconstrainedError':
      return 'The selected device is no longer available. Pick another device.';
    default:
      return 'We couldn’t access your camera and microphone.';
  }
}

function compatibilityIssues(): string[] {
  if (typeof window === 'undefined') return [];
  const issues: string[] = [];
  if (!window.MediaRecorder) issues.push('This browser can’t record locally. Use the latest Chrome, Edge or Firefox.');
  if (!window.RTCPeerConnection) issues.push('This browser doesn’t support real-time calls.');
  if (!navigator.mediaDevices?.getUserMedia) issues.push('Camera access requires a secure (https) connection.');
  return issues;
}

function SpeakerTest({ speakerId }: { speakerId: string | null }) {
  const [playing, setPlaying] = useState(false);

  const play = async () => {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return;
    const ctx: AudioContext = new Ctor();
    const destination = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.connect(destination);
    // Two-note chime
    [523.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      const start = ctx.currentTime + i * 0.35;
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
      osc.start(start);
      osc.stop(start + 0.34);
    });
    const audio = new Audio();
    audio.srcObject = destination.stream;
    if (speakerId && 'setSinkId' in audio) {
      await (audio as any).setSinkId(speakerId).catch(() => {});
    }
    setPlaying(true);
    await audio.play().catch(() => {});
    setTimeout(() => {
      setPlaying(false);
      audio.pause();
      ctx.close();
    }, 900);
  };

  return (
    <Button variant="secondary" size="sm" onClick={play} disabled={playing}>
      {playing ? 'Playing…' : 'Test'}
    </Button>
  );
}

function LevelMeter({ level }: { level: number }) {
  const bars = 12;
  const active = Math.round(level * bars);
  return (
    <div className="flex h-3 items-end gap-0.5" aria-hidden>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cn('w-1 rounded-sm transition-colors', i < active ? (i > 9 ? 'bg-amber-400' : 'bg-emerald-400') : 'bg-surface-4')}
          style={{ height: `${40 + (i / bars) * 60}%` }}
        />
      ))}
    </div>
  );
}

export function Lobby({
  title,
  subtitle,
  initialName,
  role,
  onJoin,
}: {
  title: string;
  subtitle?: string;
  initialName?: string;
  role: 'host' | 'guest';
  onJoin: (result: LobbyResult) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handedOff = useRef(false);
  const previewRequest = useRef(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameras, setCameras] = useState<DeviceOption[]>([]);
  const [mics, setMics] = useState<DeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<DeviceOption[]>([]);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [audioId, setAudioId] = useState<string | null>(null);
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const [name, setName] = useState(initialName || '');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [slowPrompt, setSlowPrompt] = useState(false);
  const [issues] = useState(compatibilityIssues);
  const level = useAudioLevel(stream, micOn);

  const refreshDevices = useCallback(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    const toOptions = (kind: MediaDeviceKind, fallback: string) =>
      list.filter((d) => d.kind === kind && d.deviceId).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
    setCameras(toOptions('videoinput', 'Camera'));
    setMics(toOptions('audioinput', 'Microphone'));
    setSpeakers(toOptions('audiooutput', 'Speaker'));
  }, []);

  const startPreview = useCallback(
    async (nextVideoId: string | null, nextAudioId: string | null) => {
      const requestId = ++previewRequest.current;
      setStarting(true);
      setError(null);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setNotice(null);
      try {
        let media: MediaStream;
        try {
          media = await navigator.mediaDevices.getUserMedia(buildConstraints(nextVideoId, nextAudioId));
        } catch (err) {
          // No usable camera (missing, busy, or unsupported): join with audio only rather than not at all.
          const name = (err as { name?: string })?.name;
          if (name !== 'NotFoundError' && name !== 'NotReadableError' && name !== 'OverconstrainedError') throw err;
          media = await navigator.mediaDevices.getUserMedia({ audio: buildConstraints(null, nextAudioId).audio });
          if (requestId === previewRequest.current) {
            setNotice('No camera is available, so you’ll join with audio only. Your voice is still recorded in full quality.');
          }
        }
        // A newer request (device switch or React's dev double-mount) superseded this one.
        if (requestId !== previewRequest.current || handedOff.current) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = media;
        media.getAudioTracks().forEach((t) => (t.enabled = micOn));
        media.getVideoTracks().forEach((t) => (t.enabled = camOn));
        setStream(media);
        setVideoId(media.getVideoTracks()[0]?.getSettings().deviceId ?? nextVideoId);
        setAudioId(media.getAudioTracks()[0]?.getSettings().deviceId ?? nextAudioId);
        await refreshDevices();
      } catch (err) {
        if (requestId !== previewRequest.current) return;
        setStream(null);
        setError(describeMediaError(err));
      } finally {
        if (requestId === previewRequest.current) setStarting(false);
      }
    },
    // micOn/camOn are applied to fresh tracks; toggles below update live tracks directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshDevices]
  );

  useEffect(() => {
    if (issues.length === 0) startPreview(null, null);
    else setStarting(false);
    const onChange = () => refreshDevices().catch(() => {});
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
      // Invalidate any in-flight preview request (it's a counter, not a DOM ref).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      previewRequest.current++;
      if (!handedOff.current) streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [issues.length, startPreview, refreshDevices]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  // If the camera takes a while, the browser is most likely waiting on its permission prompt.
  useEffect(() => {
    if (!starting) {
      setSlowPrompt(false);
      return;
    }
    const timer = setTimeout(() => setSlowPrompt(true), 1500);
    return () => clearTimeout(timer);
  }, [starting]);

  const toggleMic = () => {
    const next = !micOn;
    stream?.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicOn(next);
  };
  const hasVideo = !!stream?.getVideoTracks().length;
  const toggleCam = () => {
    if (!hasVideo) return;
    const next = !camOn;
    stream?.getVideoTracks().forEach((t) => (t.enabled = next));
    setCamOn(next);
  };

  const join = () => {
    if (!stream) return;
    handedOff.current = true;
    onJoin({ stream, name: name.trim() || (role === 'host' ? 'Host' : 'Guest'), micOn, camOn: camOn && hasVideo, speakerId });
  };

  const settings = stream?.getVideoTracks()[0]?.getSettings();
  const resolutionLabel = settings?.height ? `${settings.height}p` : null;

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="flex h-14 items-center gap-2 px-5">
        <LogoMark />
        <span className="text-sm font-semibold">PodNow</span>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 pb-10">
        <div className="grid w-full max-w-5xl gap-8 lg:grid-cols-[1.4fr_1fr] lg:items-center">
          <div className="space-y-3">
            <div className="relative aspect-video overflow-hidden rounded-2xl border border-line bg-surface">
              <video ref={videoRef} autoPlay muted playsInline className={cn('h-full w-full -scale-x-100 object-cover', (!camOn || !hasVideo) && 'invisible')} />
              {(!camOn || !stream || !hasVideo) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                  {starting ? (
                    <div className="max-w-xs px-6 text-center">
                      <Camera className="mx-auto mb-3 h-6 w-6 animate-pulse text-ink-faint" />
                      <p className="text-sm text-ink-muted">Starting camera…</p>
                      {slowPrompt && (
                        <p className="mt-2 text-xs text-ink-faint">
                          Your browser is asking for permission — click <span className="font-medium text-ink">Allow</span> to use your camera and microphone.
                        </p>
                      )}
                    </div>
                  ) : error ? (
                    <div className="max-w-sm px-6 text-center">
                      <AlertTriangle className="mx-auto mb-3 h-6 w-6 text-amber-400" />
                      <p className="text-sm text-ink">{error}</p>
                      <Button variant="secondary" size="sm" className="mt-4" onClick={() => startPreview(null, null)}>
                        Try again
                      </Button>
                    </div>
                  ) : (
                    <Avatar name={name || role} size={72} />
                  )}
                </div>
              )}
              {stream && (
                <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2">
                  <button
                    onClick={toggleMic}
                    aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
                    className={cn('flex h-10 w-10 items-center justify-center rounded-full backdrop-blur transition-colors', micOn ? 'bg-black/50 text-white hover:bg-black/70' : 'bg-rec text-white')}
                  >
                    {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={toggleCam}
                    disabled={!hasVideo}
                    aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
                    className={cn('flex h-10 w-10 items-center justify-center rounded-full backdrop-blur transition-colors', camOn ? 'bg-black/50 text-white hover:bg-black/70' : 'bg-rec text-white')}
                  >
                    {camOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
                  </button>
                </div>
              )}
              {resolutionLabel && camOn && (
                <span className="absolute right-3 top-3 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur">{resolutionLabel}</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-faint">
              <Headphones className="h-3.5 w-3.5" />
              Use headphones to prevent echo. Your audio and video are recorded locally in full quality.
            </div>
          </div>

          <div className="space-y-6">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-brand-light">{role === 'host' ? 'Your studio' : 'You’re invited'}</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
              {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
            </div>

            {notice && (
              <div className="rounded-lg border border-brand/25 bg-brand/10 p-3 text-sm text-brand-light">{notice}</div>
            )}

            {issues.length > 0 && (
              <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                {issues.map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="label" htmlFor="lobby-name">Your name</label>
                <input id="lobby-name" className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="How should others see you?" />
              </div>

              <div>
                <label className="label" htmlFor="lobby-camera">Camera</label>
                <div className="relative">
                  <Camera className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                  <select id="lobby-camera" className="input pl-9" value={videoId ?? ''} onChange={(e) => startPreview(e.target.value, audioId)} disabled={!cameras.length}>
                    {cameras.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="label" htmlFor="lobby-mic">Microphone</label>
                  <LevelMeter level={micOn ? level : 0} />
                </div>
                <div className="relative">
                  <Mic className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                  <select id="lobby-mic" className="input pl-9" value={audioId ?? ''} onChange={(e) => startPreview(videoId, e.target.value)} disabled={!mics.length}>
                    {mics.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="label" htmlFor="lobby-speaker">Speaker</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Volume2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                    <select
                      id="lobby-speaker"
                      className="input pl-9"
                      value={speakerId ?? ''}
                      onChange={(e) => setSpeakerId(e.target.value || null)}
                    >
                      <option value="">System default</option>
                      {speakers.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                      ))}
                    </select>
                  </div>
                  <SpeakerTest speakerId={speakerId} />
                </div>
              </div>
            </div>

            <Button size="lg" className="w-full" onClick={join} disabled={!stream || starting}>
              Join studio
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
