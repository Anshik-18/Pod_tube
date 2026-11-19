'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Film, MoreHorizontal, Download, Music, Trash2, ExternalLink, Check, AlertTriangle } from 'lucide-react';
import { StatusBadge } from '@/components/ui/Badge';
import { Menu } from '@/components/ui/Menu';
import { cn } from '@/lib/client/cn';
import { downloadFromUrl } from '@/lib/client/api';
import { episodeTitle, formatClock, formatRelativeDate } from '@/lib/client/format';

export interface EpisodeSummary {
  id: string;
  session_id: string;
  title: string | null;
  state: string;
  file_references: { thumbnail?: string; durationMs?: number; video?: string; audio?: string } | null;
  created_at: string;
}

export function EpisodeThumbnail({ episode, className }: { episode: EpisodeSummary; className?: string }) {
  const [failed, setFailed] = useState(false);
  const hasThumb = episode.state === 'ready' && !!episode.file_references?.thumbnail && !failed;
  const duration = episode.file_references?.durationMs;

  return (
    <div className={cn('relative aspect-video overflow-hidden rounded-xl bg-surface-3', className)}>
      {hasThumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/episodes/${episode.id}/thumbnail`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-3 to-surface-2">
          {episode.state === 'processing' ? (
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-amber-400/80 border-t-transparent" />
          ) : episode.state === 'failed' ? (
            <AlertTriangle className="h-7 w-7 text-red-400/70" />
          ) : (
            <Film className="h-7 w-7 text-ink-faint" />
          )}
        </div>
      )}
      {duration ? (
        <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white">{formatClock(duration / 1000)}</span>
      ) : null}
      {episode.state !== 'ready' && (
        <span className="absolute left-2 top-2">
          <StatusBadge state={episode.state} className="bg-black/60 backdrop-blur" />
        </span>
      )}
    </div>
  );
}

export function EpisodeCard({
  episode,
  onDelete,
  selectable,
  selected,
  onToggleSelect,
}: {
  episode: EpisodeSummary;
  onDelete?: (episode: EpisodeSummary) => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const ready = episode.state === 'ready';

  return (
    <div className={cn('group relative rounded-2xl p-1.5 transition-colors', selected ? 'bg-brand/10 ring-1 ring-brand/60' : 'hover:bg-surface')}>
      <Link href={`/episodes/${episode.id}`} className="block" onClick={(e) => {
        if (selectable && onToggleSelect) {
          e.preventDefault();
          onToggleSelect(episode.id);
        }
      }}>
        <EpisodeThumbnail episode={episode} />
      </Link>

      {selectable && onToggleSelect && (
        <button
          onClick={() => onToggleSelect(episode.id)}
          aria-label={selected ? 'Deselect' : 'Select'}
          className={cn(
            'absolute left-3.5 top-3.5 flex h-5 w-5 items-center justify-center rounded-md border transition-colors',
            selected ? 'border-brand bg-brand text-white' : 'border-white/60 bg-black/40 text-transparent hover:border-white'
          )}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      )}

      <div className="flex items-start gap-2 px-1 pb-1 pt-3">
        <div className="min-w-0 flex-1">
          <Link href={`/episodes/${episode.id}`} className="block truncate text-sm font-medium text-ink hover:text-brand-light">
            {episodeTitle(episode)}
          </Link>
          <p className="mt-0.5 text-xs text-ink-faint">{formatRelativeDate(episode.created_at)}</p>
        </div>
        <Menu
          items={[
            { label: 'Open project', icon: <ExternalLink className="h-4 w-4" />, onSelect: () => (window.location.href = `/episodes/${episode.id}`) },
            { label: 'Download MP4', icon: <Download className="h-4 w-4" />, disabled: !ready, onSelect: () => downloadFromUrl(`/api/episodes/${episode.id}/download?type=video`) },
            { label: 'Download MP3', icon: <Music className="h-4 w-4" />, disabled: !ready, onSelect: () => downloadFromUrl(`/api/episodes/${episode.id}/download?type=audio`) },
            ...(onDelete ? (['separator', { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, onSelect: () => onDelete(episode) }] as const) : []),
          ]}
          trigger={(props) => (
            <button {...props} className="rounded-md p-1 text-ink-faint opacity-0 transition-opacity hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100" aria-label="Project actions">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          )}
        />
      </div>
    </div>
  );
}

export function EpisodeCardSkeleton() {
  return (
    <div className="p-1.5">
      <div className="skeleton aspect-video rounded-xl" />
      <div className="skeleton mt-3 h-4 w-3/4" />
      <div className="skeleton mt-2 h-3 w-1/3" />
    </div>
  );
}
