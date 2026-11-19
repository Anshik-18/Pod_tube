'use client';

import { useEffect, useRef } from 'react';
import { MicOff, Loader2, Pin, PinOff, MonitorUp } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/client/cn';
import { useAudioLevel } from './hooks';
import { QualityBars } from './SidePanel';

const SPEAKING_THRESHOLD = 0.08;

export function ParticipantTile({
  stream,
  name,
  isLocal,
  micOn,
  camOn,
  mirror = true,
  connecting,
  speakerId,
  badge,
  quality,
  pinned,
  onTogglePin,
  onSpeaking,
  variant = 'camera',
  compact,
  className,
}: {
  stream: MediaStream | null;
  name: string;
  isLocal?: boolean;
  micOn: boolean;
  camOn: boolean;
  mirror?: boolean;
  connecting?: boolean;
  speakerId?: string | null;
  badge?: React.ReactNode;
  quality?: 'good' | 'fair' | 'poor' | 'unknown';
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Called when this person starts or stops speaking (for active-speaker layouts). */
  onSpeaking?: (speaking: boolean) => void;
  /** 'screen' shows the whole picture (letterboxed) and never plays audio. */
  variant?: 'camera' | 'screen';
  /** Small filmstrip tile: smaller labels and avatar. */
  compact?: boolean;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const isScreen = variant === 'screen';
  const level = useAudioLevel(isScreen ? null : stream, micOn);
  const speaking = !isScreen && micOn && level > SPEAKING_THRESHOLD;

  const onSpeakingRef = useRef(onSpeaking);
  onSpeakingRef.current = onSpeaking;
  useEffect(() => {
    onSpeakingRef.current?.(speaking);
  }, [speaking]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) {
      el.play().catch(() => {
        // Autoplay with sound can be blocked until the user interacts; muted local tiles always play.
      });
    }
  }, [stream]);

  useEffect(() => {
    const el = videoRef.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!el || isLocal || isScreen || !speakerId || !el.setSinkId) return;
    el.setSinkId(speakerId).catch(() => {});
  }, [speakerId, isLocal, isScreen]);

  const showVideo = !!stream && (isScreen || camOn) && stream.getVideoTracks().length > 0;

  return (
    <div
      className={cn(
        'group relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-surface-2 ring-2 transition-shadow duration-150',
        speaking ? 'ring-brand' : 'ring-transparent',
        isScreen && 'bg-black',
        className
      )}
      data-testid={isScreen ? 'screen-tile' : 'participant-tile'}
      data-name={name}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal || isScreen}
        className={cn(
          'h-full w-full',
          isScreen ? 'object-contain' : 'object-cover',
          isLocal && mirror && !isScreen && '-scale-x-100',
          !showVideo && 'invisible'
        )}
      />

      {!showVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          {connecting ? (
            <div className="flex flex-col items-center gap-3 text-ink-muted">
              <Loader2 className="h-6 w-6 animate-spin" />
              {!compact && <span className="text-sm">Connecting to {name}…</span>}
            </div>
          ) : (
            <div className={cn('rounded-full p-1 transition-shadow', speaking && 'shadow-[0_0_0_4px_rgba(124,92,255,0.5)]')}>
              <Avatar name={name} size={compact ? 44 : 84} />
            </div>
          )}
        </div>
      )}

      <div className="absolute right-2.5 top-2.5 flex items-center gap-1.5">
        {badge}
        {onTogglePin && (
          <button
            type="button"
            onClick={onTogglePin}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-lg bg-black/55 text-white backdrop-blur transition-opacity hover:bg-black/75',
              pinned ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
            )}
            aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
            title={pinned ? 'Unpin' : 'Pin to stage'}
          >
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      <div
        className={cn(
          'absolute bottom-2.5 left-2.5 flex max-w-[calc(100%-1.25rem)] items-center gap-1.5 rounded-lg bg-black/55 px-2 py-1 font-medium text-white backdrop-blur',
          compact ? 'text-[11px]' : 'text-xs'
        )}
      >
        {isScreen && <MonitorUp className="h-3.5 w-3.5 shrink-0 text-brand-light" />}
        {!isScreen && !micOn && <MicOff className="h-3.5 w-3.5 shrink-0 text-red-400" />}
        <span className="truncate">
          {isScreen ? `${name}’s screen` : name}
          {isLocal && !isScreen ? ' (you)' : ''}
        </span>
        {!isLocal && !isScreen && <QualityBars quality={quality} className="ml-0.5" />}
      </div>
    </div>
  );
}
