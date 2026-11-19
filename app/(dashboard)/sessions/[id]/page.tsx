'use client';

import { sortParticipantIds } from '@/lib/participants';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ChevronRight, Copy, Check, Mail, Video, ArrowRight } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { PageLoader } from '@/components/ui/Spinner';
import { Avatar } from '@/components/ui/Avatar';
import { api } from '@/lib/client/api';
import { formatDateTime, formatClock } from '@/lib/client/format';

interface Session {
  id: string;
  title?: string | null;
  guest_token: string;
  state: string;
  recording_started_at: string | null;
  created_at: string;
  markers?: Array<{ id: string; time: number; label: string }>;
  participant_names?: Record<string, string>;
}

interface Episode {
  id: string;
  session_id: string;
  title: string | null;
  state: string;
  created_at: string;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function SessionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;
  const [session, setSession] = useState<Session | null>(null);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<{ session: Session }>(`/api/sessions/${sessionId}`);
        if (cancelled) return;
        setSession(data.session);
        const episodes = await api<{ episodes: Episode[] }>('/api/episodes').catch(() => ({ episodes: [] as Episode[] }));
        if (!cancelled) setEpisode(episodes.episodes.find((ep) => ep.session_id === sessionId) ?? null);
      } catch {
        router.push('/sessions');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, router]);

  if (loading) return <PageLoader label="Loading session…" />;
  if (!session) return null;

  const inviteLink = typeof window !== 'undefined' ? `${window.location.origin}/join/${session.guest_token}` : '';
  const title = session.title || 'Untitled recording';
  const canJoin = session.state === 'idle' || session.state === 'recording';
  const names = session.participant_names ?? {};
  const markers = session.markers ?? [];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore: link is selectable
    }
  };

  const email = () => {
    const subject = encodeURIComponent(`Join me in the studio: ${title}`);
    const body = encodeURIComponent(`Hi,\n\nJoin my recording session here: ${inviteLink}\n\nNo account needed — just open the link in Chrome or Edge.\n`);
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
  };

  const timeline = [
    { label: 'Session Created', at: session.created_at, color: 'bg-brand' },
    ...(session.recording_started_at ? [{ label: 'Recording Started', at: session.recording_started_at, color: 'bg-rec' }] : []),
    ...(episode ? [{ label: 'Episode Created', at: episode.created_at, color: 'bg-emerald-400' }] : []),
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <nav className="mb-1 flex items-center gap-1 text-xs text-ink-faint">
        <Link href="/sessions" className="hover:text-ink">Studios</Link>
        <ChevronRight className="h-3 w-3" />
        <span>Session Details</span>
      </nav>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <StatusBadge state={session.state} />
        </div>
        {session.state === 'idle' && (
          <ButtonLink href={`/record/${session.id}`} variant="record">
            <Video className="h-4 w-4" />
            Enter studio
          </ButtonLink>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Session Information">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs text-ink-faint">Session ID</dt>
              <dd className="mt-0.5 font-mono text-xs text-ink-muted">{session.id}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-faint">Created</dt>
              <dd className="mt-0.5">{formatDateTime(session.created_at)}</dd>
            </div>
            {Object.keys(names).length > 0 && (
              <div>
                <dt className="text-xs text-ink-faint">Participants</dt>
                <dd className="mt-1.5 flex flex-wrap gap-3">
                  {sortParticipantIds(Object.keys(names)).filter((id) => names[id]).map((id) => (
                    <span key={id} className="flex items-center gap-2">
                      <Avatar name={names[id]} size={24} />
                      <span>{names[id]}</span>
                      <span className="text-xs text-ink-faint">{id === 'host' ? 'Host' : 'Guest'}</span>
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        </Card>

        <Card title="Associated Episode">
          {episode ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium">{episode.title || 'Untitled recording'}</h3>
                <p className="mt-0.5 text-xs text-ink-faint">Created {formatDateTime(episode.created_at)}</p>
              </div>
              <ButtonLink href={`/episodes/${episode.id}`} size="sm">
                View Episode
                <ArrowRight className="h-3.5 w-3.5" />
              </ButtonLink>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">No episode has been created from this session yet.</p>
          )}
        </Card>

        <Card title="Guest Invitation Link">
          <div className="flex gap-2">
            <input readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} className="input font-mono text-xs" />
            <Button variant="secondary" onClick={copy} disabled={!canJoin}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="secondary" size="icon" onClick={email} title="Send via email" disabled={!canJoin}>
              <Mail className="h-4 w-4" />
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-faint">
            {canJoin ? 'Guests join from their browser — no account or download needed.' : 'This session has finished recording, so the link no longer admits guests.'}
          </p>
        </Card>

        <Card title="Session Timeline">
          <ol className="relative space-y-4 border-l border-line pl-5">
            {timeline.map((item) => (
              <li key={item.label} className="relative">
                <span className={`absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-surface ${item.color}`} />
                <p className="text-sm font-medium">{item.label}</p>
                <p className="text-xs text-ink-faint">{formatDateTime(item.at)}</p>
              </li>
            ))}
          </ol>
          {markers.length > 0 && (
            <div className="mt-5 border-t border-line pt-4">
              <p className="mb-2 text-xs text-ink-faint">{markers.length} marker{markers.length === 1 ? '' : 's'}</p>
              <ul className="space-y-1 text-sm">
                {markers.map((m) => (
                  <li key={m.id} className="flex gap-3">
                    <span className="font-mono text-xs text-brand-light">{formatClock(m.time)}</span>
                    <span className="truncate text-ink-muted">{m.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
