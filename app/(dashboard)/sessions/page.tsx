'use client';

import { sortParticipantIds } from '@/lib/participants';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Radio, Plus, Link2, Trash2, MoreHorizontal, Video, ExternalLink } from 'lucide-react';
import { PageHeader } from '@/components/layout/AppShell';
import { ButtonLink } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Menu } from '@/components/ui/Menu';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/client/api';
import { formatDuration, formatRelativeDate } from '@/lib/client/format';

interface SessionRow {
  id: string;
  title: string | null;
  guest_token: string;
  state: string;
  created_at: string;
  participant_names: Record<string, string>;
  episode_id: string | null;
  episode_title: string | null;
  episode_state: string | null;
  has_thumbnail: boolean;
  duration_ms: number | null;
}

export default function SessionsPage() {
  const { showToast } = useToast();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ sessions: SessionRow[] }>(`/api/sessions${showAll ? '?all=1' : ''}`);
      setSessions(data.sessions);
    } catch {
      setSessions([]);
      showToast('Couldn’t load your studios', 'error');
    }
  }, [showAll, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const copyInvite = async (token: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/join/${token}`);
      showToast('Invite link copied', 'success');
    } catch {
      showToast('Couldn’t copy the link', 'error');
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api(`/api/sessions/${pendingDelete.id}`, { method: 'DELETE' });
      showToast('Session deleted', 'success');
      setPendingDelete(null);
      load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Studios"
        description="Your recording sessions. Reopen an unused studio or jump to its project."
        actions={
          <ButtonLink href="/sessions/new" variant="record">
            <Plus className="h-4 w-4" />
            New recording
          </ButtonLink>
        }
      />

      <label className="mb-4 flex w-fit cursor-pointer items-center gap-2 text-sm text-ink-muted">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-[#7c5cff]" />
        Include studios that were never recorded
      </label>

      {sessions === null ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton h-[72px] rounded-xl" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<Radio className="h-5 w-5" />}
          title="No studio sessions yet"
          description="Create a studio, invite guests with one link, and record everyone in full local quality."
          action={<ButtonLink href="/sessions/new" variant="record">New recording</ButtonLink>}
        />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {sessions.map((s) => {
            const title = s.episode_title || s.title || 'Untitled recording';
            const names = sortParticipantIds(Object.keys(s.participant_names ?? {})).map((id) => s.participant_names[id]).filter(Boolean);
            const people = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
            return (
              <li key={s.id} className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-2">
                <div className="relative hidden h-12 w-20 shrink-0 overflow-hidden rounded-lg bg-surface-3 sm:block">
                  {s.has_thumbnail && s.episode_id ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/episodes/${s.episode_id}/thumbnail`} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <Radio className="h-4 w-4 text-ink-faint" />
                    </div>
                  )}
                </div>
                <Link href={`/sessions/${s.id}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{title}</span>
                    <StatusBadge state={s.episode_state || s.state} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-faint">
                    {formatRelativeDate(s.created_at)}
                    {s.duration_ms ? ` · ${formatDuration(s.duration_ms)}` : ''}
                    {people ? ` · ${people}` : ''}
                  </p>
                </Link>
                {s.state === 'idle' ? (
                  <ButtonLink href={`/record/${s.id}`} size="sm" variant="secondary">
                    <Video className="h-4 w-4" />
                    Enter studio
                  </ButtonLink>
                ) : s.episode_id ? (
                  <ButtonLink href={`/episodes/${s.episode_id}`} size="sm" variant="secondary">
                    Open project
                  </ButtonLink>
                ) : null}
                <Menu
                  items={[
                    { label: 'Session details', icon: <ExternalLink className="h-4 w-4" />, onSelect: () => (window.location.href = `/sessions/${s.id}`) },
                    { label: 'Copy invite link', icon: <Link2 className="h-4 w-4" />, disabled: s.state !== 'idle' && s.state !== 'recording', onSelect: () => copyInvite(s.guest_token) },
                    'separator',
                    { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, disabled: s.state === 'recording', onSelect: () => setPendingDelete(s) },
                  ]}
                  trigger={(props) => (
                    <button {...props} className="rounded-md p-1.5 text-ink-faint hover:bg-surface-3 hover:text-ink" aria-label="Session actions">
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  )}
                />
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Delete session?"
        description={pendingDelete?.episode_id ? 'This also deletes its project, exports and participant tracks.' : 'The invite link will stop working.'}
        confirmLabel="Delete"
      />
    </div>
  );
}
