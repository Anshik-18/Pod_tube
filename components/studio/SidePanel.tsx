'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Send, Bookmark, Mic, MicOff, Video, VideoOff, UserPlus, MoreHorizontal, Pin, UserMinus, MonitorUp, Circle, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Menu } from '@/components/ui/Menu';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/client/cn';
import { formatClock } from '@/lib/client/format';

export type PanelId = 'people' | 'chat' | 'markers' | 'notes';

export interface ChatMessage {
  id: string;
  socketId: string;
  participantId?: string;
  role: 'host' | 'guest';
  name: string;
  text: string;
  at: number;
}

export interface Marker {
  id: string;
  time: number;
  label: string;
}

export interface PersonRow {
  key: string;
  name: string;
  role: 'host' | 'guest';
  isSelf: boolean;
  micOn: boolean;
  camOn: boolean;
  screenOn?: boolean;
  /** Short connection/recording status line. */
  status?: string;
  quality?: 'good' | 'fair' | 'poor' | 'unknown';
  /** Recording upload state for this person, if they're recording. */
  upload?: { pct: number; done: boolean; failed: boolean } | null;
  pinned?: boolean;
}

export interface PeopleActions {
  canManage: boolean;
  onPin: (key: string) => void;
  onMute: (key: string) => void;
  onRemove: (key: string) => void;
}

const TITLES: Record<PanelId, string> = { people: 'People', chat: 'Chat', markers: 'Markers', notes: 'Notes' };

export function SidePanel({
  panel,
  onClose,
  people,
  canInvite,
  onInvite,
  messages,
  selfSocketId,
  onSendMessage,
  markers,
  canAddMarker,
  onAddMarker,
  actions,
  capacity,
  notesKey,
}: {
  panel: PanelId;
  onClose: () => void;
  people: PersonRow[];
  canInvite: boolean;
  onInvite: () => void;
  messages: ChatMessage[];
  selfSocketId: string | null;
  onSendMessage: (text: string) => void;
  markers: Marker[];
  canAddMarker: boolean;
  onAddMarker: () => void;
  actions: PeopleActions;
  capacity: number;
  /** localStorage key for this person's private notes in this studio. */
  notesKey: string;
}) {
  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[340px] flex-col border-l border-line bg-surface shadow-elevated animate-slide-in-right md:static md:z-auto md:w-80 md:shadow-none">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <h2 className="text-sm font-semibold">{TITLES[panel]}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel">
          <X className="h-4 w-4" />
        </Button>
      </div>
      {panel === 'people' && <PeopleList people={people} canInvite={canInvite} onInvite={onInvite} actions={actions} capacity={capacity} />}
      {panel === 'chat' && <Chat messages={messages} selfSocketId={selfSocketId} onSend={onSendMessage} />}
      {panel === 'markers' && <MarkerList markers={markers} canAdd={canAddMarker} onAdd={onAddMarker} />}
      {panel === 'notes' && <Notes storageKey={notesKey} />}
    </aside>
  );
}

const QUALITY_STYLE: Record<string, { bars: number; color: string; label: string }> = {
  good: { bars: 3, color: 'bg-emerald-400', label: 'Good connection' },
  fair: { bars: 2, color: 'bg-amber-400', label: 'Unstable connection' },
  poor: { bars: 1, color: 'bg-red-400', label: 'Poor connection' },
};

export function QualityBars({ quality, className }: { quality?: string; className?: string }) {
  const style = quality ? QUALITY_STYLE[quality] : undefined;
  if (!style) return null;
  return (
    <span className={cn('flex h-3 items-end gap-[2px]', className)} title={style.label} aria-label={style.label}>
      {[1, 2, 3].map((i) => (
        <span key={i} className={cn('w-[3px] rounded-sm', i <= style.bars ? style.color : 'bg-white/20')} style={{ height: `${i * 33}%` }} />
      ))}
    </span>
  );
}

function UploadState({ upload }: { upload: NonNullable<PersonRow['upload']> }) {
  if (upload.done) return <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-label="Recording uploaded" />;
  if (upload.failed) return <AlertTriangle className="h-4 w-4 text-amber-400" aria-label="Upload needs a retry" />;
  return <span className="font-mono text-[11px] text-ink-muted">{upload.pct}%</span>;
}

function PeopleList({
  people,
  canInvite,
  onInvite,
  actions,
  capacity,
}: {
  people: PersonRow[];
  canInvite: boolean;
  onInvite: () => void;
  actions: PeopleActions;
  capacity: number;
}) {
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4">
      {canInvite && (
        <Button variant="secondary" className="w-full" onClick={onInvite} disabled={people.length >= capacity}>
          <UserPlus className="h-4 w-4" />
          {people.length >= capacity ? 'Studio is full' : 'Invite people'}
        </Button>
      )}
      <div>
        <p className="mb-2 text-xs font-medium text-ink-faint">
          In the studio · {people.length} of {capacity}
        </p>
        <ul className="space-y-1">
          {people.map((p) => (
            <li key={p.key} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
              <Avatar name={p.name} size={32} />
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  <span className="min-w-0 truncate">
                    {p.name}
                    {p.isSelf && <span className="text-ink-faint"> (you)</span>}
                  </span>
                  {p.role === 'host' && <Badge tone="brand" className="shrink-0 px-1 py-0 text-[10px]">Host</Badge>}
                </p>
                <p className="flex items-center gap-1.5 text-xs text-ink-faint">
                  {p.screenOn && <MonitorUp className="h-3 w-3 text-brand-light" />}
                  <span className="truncate">{p.status ?? (p.role === 'host' ? 'Host' : 'Guest')}</span>
                </p>
              </div>
              {p.upload && <UploadState upload={p.upload} />}
              {!p.isSelf && <QualityBars quality={p.quality} />}
              <span className={cn('text-ink-faint', !p.micOn && 'text-red-400')}>{p.micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}</span>
              <span className={cn('text-ink-faint', !p.camOn && 'text-red-400')}>{p.camOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}</span>
              <Menu
                trigger={(props) => (
                  <button {...props} className="rounded-md p-1 text-ink-faint hover:bg-surface-4 hover:text-ink" aria-label={`Options for ${p.name}`}>
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                )}
                items={[
                  { label: p.pinned ? 'Unpin' : 'Pin to stage', icon: <Pin className="h-4 w-4" />, onSelect: () => actions.onPin(p.key) },
                  ...(actions.canManage && !p.isSelf
                    ? ([
                        { label: 'Ask to mute', icon: <MicOff className="h-4 w-4" />, onSelect: () => actions.onMute(p.key), disabled: !p.micOn },
                        'separator',
                        { label: 'Remove from studio', icon: <UserMinus className="h-4 w-4" />, onSelect: () => actions.onRemove(p.key), danger: true, disabled: p.role === 'host' },
                      ] as const)
                    : []),
                ] as any}
              />
            </li>
          ))}
        </ul>
      </div>
      <p className="flex items-start gap-2 text-xs text-ink-faint">
        <Circle className="mt-0.5 h-3 w-3 shrink-0" />
        Everyone is recorded on their own device in full quality. Each person becomes a separate track in the project.
      </p>
    </div>
  );
}

function Notes({ storageKey }: { storageKey: string }) {
  const [text, setText] = useState('');
  useEffect(() => {
    try {
      setText(localStorage.getItem(storageKey) ?? '');
    } catch {
      // Storage unavailable
    }
  }, [storageKey]);

  return (
    <div className="flex flex-1 flex-col p-4">
      <textarea
        className="input min-h-0 flex-1 resize-none py-3 text-[15px] leading-relaxed"
        value={text}
        placeholder={'Questions, talking points or a script.\n\nOnly you can see these notes — they stay in this browser.'}
        onChange={(e) => {
          setText(e.target.value);
          try {
            localStorage.setItem(storageKey, e.target.value);
          } catch {
            // Storage unavailable
          }
        }}
        aria-label="Private notes"
      />
    </div>
  );
}

function Chat({ messages, selfSocketId, onSend }: { messages: ChatMessage[]; selfSocketId: string | null; onSend: (text: string) => void }) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  return (
    <>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="pt-10 text-center text-sm text-ink-faint">Messages are visible to everyone in the studio and aren’t recorded.</p>
        ) : (
          messages.map((m) => {
            const mine = m.socketId === selfSocketId;
            return (
              <div key={m.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
                <span className="mb-1 text-[11px] text-ink-faint">
                  {mine ? 'You' : m.name} · {new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
                <p className={cn('max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm', mine ? 'bg-brand text-white' : 'bg-surface-3 text-ink')}>{m.text}</p>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>
      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          onSend(draft.trim());
          setDraft('');
        }}
      >
        <input className="input" value={draft} maxLength={1000} onChange={(e) => setDraft(e.target.value)} placeholder="Send a message" aria-label="Chat message" />
        <Button type="submit" size="icon" disabled={!draft.trim()} aria-label="Send">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </>
  );
}

function MarkerList({ markers, canAdd, onAdd }: { markers: Marker[]; canAdd: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-line p-4">
        <Button className="w-full" variant="secondary" onClick={onAdd} disabled={!canAdd}>
          <Bookmark className="h-4 w-4" />
          Add marker <kbd className="ml-1 rounded border border-line-strong px-1 text-[10px] text-ink-faint">M</kbd>
        </Button>
        {!canAdd && <p className="mt-2 text-center text-xs text-ink-faint">Markers can be added while recording.</p>}
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto p-3">
        {markers.length === 0 ? (
          <li className="pt-6 text-center text-sm text-ink-faint">Drop markers on great moments — they show up on your project’s timeline.</li>
        ) : (
          markers.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
              <Badge tone="brand" className="font-mono">{formatClock(m.time)}</Badge>
              <span className="truncate text-sm">{m.label}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
