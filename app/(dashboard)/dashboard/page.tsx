'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Upload, ArrowRight, FolderOpen, Clock, CheckCircle2, Loader } from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/ui/Toast';
import { EmptyState } from '@/components/ui/EmptyState';
import { ButtonLink } from '@/components/ui/Button';
import { EpisodeCard, EpisodeCardSkeleton, EpisodeSummary } from '@/components/episodes/EpisodeCard';
import { useUploadRecording } from '@/components/episodes/UploadRecording';
import { api } from '@/lib/client/api';
import { displayNameFromEmail, formatDuration } from '@/lib/client/format';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-3 text-ink-muted">{icon}</div>
      <div>
        <p className="text-xs text-ink-faint">{label}</p>
        <p className="text-lg font-semibold tracking-tight">{value}</p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const upload = useUploadRecording();
  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null);

  useEffect(() => {
    api<{ episodes: EpisodeSummary[] }>('/api/episodes')
      .then((data) => setEpisodes(data.episodes))
      .catch(() => {
        setEpisodes([]);
        showToast('Couldn’t load your recordings', 'error');
      });
  }, [showToast]);

  // Keep processing cards fresh
  const hasProcessing = episodes?.some((e) => e.state === 'processing');
  useEffect(() => {
    if (!hasProcessing) return;
    const interval = setInterval(() => {
      api<{ episodes: EpisodeSummary[] }>('/api/episodes').then((data) => setEpisodes(data.episodes)).catch(() => {});
    }, 8000);
    return () => clearInterval(interval);
  }, [hasProcessing]);

  const stats = useMemo(() => {
    const list = episodes ?? [];
    return {
      total: list.length,
      ready: list.filter((e) => e.state === 'ready').length,
      processing: list.filter((e) => e.state === 'processing').length,
      minutes: list.reduce((sum, e) => sum + (e.file_references?.durationMs ?? 0), 0),
    };
  }, [episodes]);

  const name = user?.name?.split(' ')[0] || displayNameFromEmail(user?.email);

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting()}, {name}</h1>
        <p className="mt-1 text-sm text-ink-muted">Record studio-quality conversations, then download polished episodes.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:max-w-3xl">
        <Link href="/sessions/new" className="group card flex items-center gap-4 p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-rec/15">
            <span className="h-4 w-4 rounded-full bg-rec ring-4 ring-rec/25" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">Record</p>
            <p className="text-xs text-ink-muted">Open a studio and invite up to 7 guests</p>
          </div>
          <ArrowRight className="h-4 w-4 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
        </Link>
        <button onClick={upload.open} disabled={upload.busy} className="group card flex items-center gap-4 p-4 text-left transition-colors hover:border-line-strong hover:bg-surface-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand/15 text-brand-light">
            <Upload className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">Upload</p>
            <p className="text-xs text-ink-muted">Turn a video or audio file into a project</p>
          </div>
          <ArrowRight className="h-4 w-4 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
        </button>
      </div>
      {upload.element}

      {episodes && episodes.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat icon={<FolderOpen className="h-4 w-4" />} label="Projects" value={String(stats.total)} />
          <Stat icon={<CheckCircle2 className="h-4 w-4" />} label="Ready to download" value={String(stats.ready)} />
          <Stat icon={<Loader className="h-4 w-4" />} label="Processing" value={String(stats.processing)} />
          <Stat icon={<Clock className="h-4 w-4" />} label="Recorded" value={formatDuration(stats.minutes)} />
        </div>
      )}

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Recent projects</h2>
          {episodes && episodes.length > 0 && (
            <Link href="/episodes" className="text-sm text-ink-muted hover:text-ink">
              View all
            </Link>
          )}
        </div>

        {episodes === null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <EpisodeCardSkeleton key={i} />
            ))}
          </div>
        ) : episodes.length === 0 ? (
          <EmptyState
            icon={<FolderOpen className="h-5 w-5" />}
            title="No recordings yet"
            description="Start a studio session to record yourself and your guests in full local quality."
            action={<ButtonLink href="/sessions/new" variant="record">Start recording</ButtonLink>}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {episodes.slice(0, 6).map((ep) => (
              <EpisodeCard key={ep.id} episode={ep} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
