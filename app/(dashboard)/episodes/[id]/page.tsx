'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Download,
  Film,
  Music,
  Trash2,
  Pencil,
  RotateCw,
  Scissors,
  Bookmark,
  FileText,
  Layers,
  AlertTriangle,
  Clock,
  Hourglass,
  ChevronRight,
  MoreHorizontal,
  MonitorUp,
} from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { StatusBadge, Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Menu } from '@/components/ui/Menu';
import { Avatar } from '@/components/ui/Avatar';
import { PageLoader, Spinner } from '@/components/ui/Spinner';
import { api, downloadFromUrl } from '@/lib/client/api';
import { cn } from '@/lib/client/cn';
import { participantLabel, sortParticipantIds, isScreenTrack } from '@/lib/participants';
import { episodeTitle, formatBytes, formatClock, formatDateTime, formatDuration } from '@/lib/client/format';

type Quality = 'low' | 'medium' | 'high';

interface Episode {
  id: string;
  session_id: string;
  title: string | null;
  description: string | null;
  state: 'processing' | 'ready' | 'failed';
  file_references: {
    video?: string;
    audio?: string;
    thumbnail?: string;
    tracks?: Record<string, string>;
    durationMs?: number;
    sourceDurationMs?: number;
    width?: number;
    height?: number;
    fileSizeBytes?: number;
    warnings?: Array<{ participant: string; kind: 'gaps' | 'unusable'; missingSeconds?: number; gaps?: Array<{ start: number; end: number }>; message?: string }>;
  } | null;
  trim_settings: { trimStart?: number; trimEnd?: number; quality?: Quality } | null;
  created_at: string;
}

interface EpisodeResponse {
  episode: Episode;
  processingJob: { status: string; error_message: string | null; progress: number | null; updated_at: string } | null;
  session: {
    title: string | null;
    state: string;
    markers: Array<{ id: string; time: number; label: string }>;
    participant_names: Record<string, string>;
  } | null;
  uploads: Array<{ participant_type: string; status: string }>;
}

type Tab = 'export' | 'tracks' | 'markers' | 'notes';

const QUALITY_LABELS: Record<Quality, { label: string; detail: string }> = {
  low: { label: 'Draft', detail: '720p · fastest' },
  medium: { label: 'Standard', detail: '1080p · recommended' },
  high: { label: 'High', detail: '1080p · best quality, slower' },
};

function stageLabel(progress: number): string {
  if (progress < 10) return 'Downloading tracks';
  if (progress < 15) return 'Assembling participant tracks';
  if (progress < 90) return 'Rendering video';
  return 'Preparing downloads';
}

function parseClock(value: string): number | null {
  const parts = value.trim().split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || Number.isNaN(Number(p)))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

function TimeField({ label, value, onChange, max }: { label: string; value: number; onChange: (seconds: number) => void; max: number }) {
  const [text, setText] = useState(formatClock(value));
  useEffect(() => setText(formatClock(value)), [value]);
  return (
    <div>
      <label className="label">{label}</label>
      <input
        className="input font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const parsed = parseClock(text);
          if (parsed === null) setText(formatClock(value));
          else onChange(Math.min(Math.max(parsed, 0), max));
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

export default function EpisodeDetailPage() {
  const { id: episodeId } = useParams<{ id: string }>();
  const router = useRouter();
  const { showToast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);

  const [data, setData] = useState<EpisodeResponse | null>(null);
  const [tab, setTab] = useState<Tab>('export');
  const [mediaVersion, setMediaVersion] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const [editingTitle, setEditingTitle] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [quality, setQuality] = useState<Quality>('medium');
  const [exporting, setExporting] = useState(false);
  const [notes, setNotes] = useState('');
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const lastStateRef = useRef<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await api<EpisodeResponse>(`/api/episodes/${episodeId}`);
      const previous = lastStateRef.current;
      lastStateRef.current = next.episode.state;
      if (previous && previous !== 'ready' && next.episode.state === 'ready') {
        setMediaVersion((v) => v + 1);
        showToast('Your episode is ready', 'success');
      }
      setData(next);
      return next;
    } catch {
      router.replace('/episodes');
      return null;
    }
  }, [episodeId, router, showToast]);

  useEffect(() => {
    load().then((initial) => {
      if (!initial) return;
      const ts = initial.episode.trim_settings;
      setTrimStart(ts?.trimStart ?? 0);
      setTrimEnd(ts?.trimEnd ?? 0);
      setQuality(ts?.quality ?? 'medium');
      setNotes(initial.episode.description ?? '');
      document.title = `${episodeTitle(initial.episode)} · PodNow`;
    });
  }, [load]);

  const isProcessing = data?.episode.state === 'processing';
  useEffect(() => {
    if (!isProcessing) return;
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [isProcessing, load]);

  const episode = data?.episode;
  const files = episode?.file_references ?? null;
  const sourceDuration = (files?.sourceDurationMs ?? files?.durationMs ?? 0) / 1000;
  const savedTrimStart = episode?.trim_settings?.trimStart ?? 0;
  const effectiveTrimEnd = trimEnd > 0 ? trimEnd : sourceDuration;
  const playheadSource = savedTrimStart + currentTime;
  const names = useMemo(() => data?.session?.participant_names ?? {}, [data?.session?.participant_names]);
  const markers = useMemo(() => [...(data?.session?.markers ?? [])].sort((a, b) => a.time - b.time), [data?.session?.markers]);

  const waitingFor = useMemo(() => {
    if (!data || data.episode.state !== 'processing' || data.processingJob) return [];
    return data.uploads.filter((u) => u.status !== 'completed').map((u) => participantLabel(u.participant_type, names));
  }, [data, names]);

  if (!data || !episode) return <PageLoader label="Loading project…" />;

  const title = episodeTitle(episode);
  const job = data.processingJob;
  const progress = job?.progress ?? 0;
  const ready = episode.state === 'ready';
  const trimChanged =
    Math.abs(trimStart - (episode.trim_settings?.trimStart ?? 0)) > 0.05 ||
    Math.abs(trimEnd - (episode.trim_settings?.trimEnd ?? 0)) > 0.05 ||
    quality !== (episode.trim_settings?.quality ?? 'medium');

  const seekSource = (sourceSeconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const local = sourceSeconds - savedTrimStart;
    if (local < 0 || (video.duration && local > video.duration)) {
      showToast('That moment is outside the current export. Widen the trim and re-export to include it.', 'info');
      return;
    }
    video.currentTime = local;
    video.play().catch(() => {});
  };

  const saveTitle = async (value: string) => {
    setEditingTitle(false);
    const next = value.trim();
    if (next === (episode.title ?? '')) return;
    try {
      const res = await api<{ episode: Episode }>(`/api/episodes/${episode.id}`, { method: 'PUT', json: { title: next || null } });
      setData({ ...data, episode: { ...episode, title: res.episode.title } });
      document.title = `${episodeTitle(res.episode)} · PodNow`;
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  const saveNotes = async () => {
    if (notes === (episode.description ?? '')) return;
    setNotesState('saving');
    try {
      await api(`/api/episodes/${episode.id}/description`, { method: 'PUT', json: { description: notes || null } });
      setData({ ...data, episode: { ...episode, description: notes } });
      setNotesState('saved');
      setTimeout(() => setNotesState('idle'), 1500);
    } catch {
      setNotesState('idle');
      showToast('Couldn’t save notes', 'error');
    }
  };

  const runExport = async () => {
    setExporting(true);
    try {
      await api(`/api/episodes/${episode.id}`, {
        method: 'POST',
        json: { trimStart: trimStart || undefined, trimEnd: trimEnd || undefined, quality },
      });
      showToast('Export started', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setExporting(false);
    }
  };

  const retry = async () => {
    try {
      await api(`/api/episodes/${episode.id}`, { method: 'PATCH', json: { action: 'retry' } });
      showToast('Retrying…', 'info');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  const deleteEpisode = async () => {
    setDeleting(true);
    try {
      await api(`/api/episodes/${episode.id}`, { method: 'DELETE' });
      showToast('Project deleted', 'success');
      router.push('/episodes');
    } catch (err) {
      setDeleting(false);
      showToast((err as Error).message, 'error');
    }
  };

  const download = (type: 'video' | 'audio' | 'track', participant?: string) =>
    downloadFromUrl(`/api/episodes/${episode.id}/download?type=${type}${participant ? `&participant=${encodeURIComponent(participant)}` : ''}`);

  const tracks = sortParticipantIds(Object.keys(files?.tracks ?? {}));
  const downloadAllTracks = () => tracks.forEach((p, i) => setTimeout(() => download('track', p), i * 800));

  return (
    <div className="mx-auto max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <nav className="mb-1 flex items-center gap-1 text-xs text-ink-faint">
            <Link href="/episodes" className="hover:text-ink">Projects</Link>
            <ChevronRight className="h-3 w-3" />
            <span className="truncate">{title}</span>
          </nav>
          <div className="flex items-center gap-3">
            {editingTitle ? (
              <input
                autoFocus
                defaultValue={episode.title ?? ''}
                placeholder="Untitled recording"
                maxLength={255}
                onBlur={(e) => saveTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
                className="input h-10 max-w-lg text-xl font-semibold"
              />
            ) : (
              <button onClick={() => setEditingTitle(true)} className="group flex min-w-0 items-center gap-2 text-left" title="Rename">
                <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
                <Pencil className="h-4 w-4 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            )}
            <StatusBadge state={episode.state} />
          </div>
          <p className="mt-1 text-sm text-ink-muted">
            Recorded {formatDateTime(episode.created_at)}
            {files?.durationMs ? ` · ${formatDuration(files.durationMs)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Menu
            items={[
              { label: 'Video (MP4)', icon: <Film className="h-4 w-4" />, disabled: !ready || !files?.video, onSelect: () => download('video') },
              { label: 'Audio (MP3)', icon: <Music className="h-4 w-4" />, disabled: !ready || !files?.audio, onSelect: () => download('audio') },
            ]}
            trigger={(props) => (
              <Button {...props} disabled={!ready}>
                <Download className="h-4 w-4" />
                Download
              </Button>
            )}
          />
          <Menu
            items={[
              { label: 'Rename', icon: <Pencil className="h-4 w-4" />, onSelect: () => setEditingTitle(true) },
              'separator',
              { label: 'Delete project', icon: <Trash2 className="h-4 w-4" />, danger: true, onSelect: () => setConfirmDelete(true) },
            ]}
            trigger={(props) => (
              <Button {...props} variant="secondary" size="icon" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            )}
          />
        </div>
      </div>

      {!!files?.warnings?.length && (
        <div className="mb-6 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-4" data-testid="track-warnings">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="min-w-0 space-y-1.5 text-sm">
              <p className="font-medium text-amber-200">Some recording didn’t reach the server</p>
              <ul className="space-y-1 text-ink-muted">
                {files.warnings.map((w) => (
                  <li key={w.participant}>
                    <span className="font-medium text-ink">{participantLabel(w.participant, names)}</span>
                    {w.kind === 'unusable'
                      ? ` — ${w.message ?? 'this track couldn’t be used.'}`
                      : ` — ${formatDuration((w.missingSeconds ?? 0) * 1000)} missing (${(w.gaps ?? [])
                          .slice(0, 4)
                          .map((g) => `at ${formatClock(g.start)}`)
                          .join(', ')}${(w.gaps?.length ?? 0) > 4 ? '…' : ''}). Everything else is intact and in sync; their picture holds and audio is silent during the gap.`}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Player column */}
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-line bg-black">
            {ready && files?.video ? (
              <video
                key={mediaVersion}
                ref={videoRef}
                controls
                playsInline
                preload="metadata"
                poster={files.thumbnail ? `/api/episodes/${episode.id}/thumbnail?v=${mediaVersion}` : undefined}
                src={`/api/episodes/${episode.id}/preview?type=video&v=${mediaVersion}`}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                className="aspect-video w-full bg-black"
              />
            ) : (
              <div className="flex aspect-video flex-col items-center justify-center gap-4 bg-surface px-6 text-center">
                {episode.state === 'failed' ? (
                  <>
                    <AlertTriangle className="h-8 w-8 text-red-400" />
                    <div>
                      <p className="font-medium">Processing failed</p>
                      <p className="mx-auto mt-1 max-w-md whitespace-pre-line text-sm text-ink-muted">{job?.error_message?.split('\n')[0] || 'Something went wrong while rendering this episode.'}</p>
                    </div>
                    <Button onClick={retry}>
                      <RotateCw className="h-4 w-4" />
                      Retry processing
                    </Button>
                  </>
                ) : waitingFor.length > 0 ? (
                  <>
                    <Hourglass className="h-8 w-8 text-amber-400" />
                    <div>
                      <p className="font-medium">
                        Waiting for {waitingFor.length > 2 ? `${waitingFor.slice(0, -1).join(', ')} and ${waitingFor[waitingFor.length - 1]}` : waitingFor.join(' and ')} to finish uploading
                      </p>
                      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
                        Their recording uploads from their own browser and must finish before we render. If they closed the tab, you can process what has arrived so far.
                      </p>
                    </div>
                    <Button variant="secondary" onClick={runExport} loading={exporting}>
                      Process now
                    </Button>
                  </>
                ) : (
                  <>
                    <Spinner className="h-7 w-7 text-amber-400" />
                    <div className="w-full max-w-sm">
                      <div className="mb-2 flex justify-between text-sm">
                        <span className="font-medium">{job?.status === 'pending' ? 'Queued for processing' : stageLabel(progress)}</span>
                        <span className="text-ink-muted">{progress}%</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-4">
                        <div className="h-full rounded-full bg-amber-400 transition-all duration-700" style={{ width: `${Math.max(progress, 2)}%` }} />
                      </div>
                      <p className="mt-3 text-xs text-ink-faint">You can leave this page — processing continues in the background.</p>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Timeline */}
          {sourceDuration > 0 && (
            <div className="card p-4">
              <div className="mb-3 flex items-center justify-between text-xs text-ink-faint">
                <span>Timeline</span>
                <span className="font-mono">
                  {formatClock(ready ? playheadSource : 0)} / {formatClock(sourceDuration)}
                </span>
              </div>
              <div
                className="relative h-10 cursor-pointer rounded-lg bg-surface-3"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  seekSource(((e.clientX - rect.left) / rect.width) * sourceDuration);
                }}
              >
                <div
                  className="absolute inset-y-0 rounded-lg bg-brand/20 ring-1 ring-inset ring-brand/50"
                  style={{ left: `${(trimStart / sourceDuration) * 100}%`, width: `${((effectiveTrimEnd - trimStart) / sourceDuration) * 100}%` }}
                />
                {markers.map((m) => (
                  <button
                    key={m.id}
                    title={`${formatClock(m.time)} · ${m.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      seekSource(m.time);
                    }}
                    className="absolute top-0 h-full w-0.5 -translate-x-1/2 bg-amber-400 hover:w-1"
                    style={{ left: `${(m.time / sourceDuration) * 100}%` }}
                  />
                ))}
                {ready && (
                  <div className="pointer-events-none absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 rounded bg-white" style={{ left: `${Math.min(100, (playheadSource / sourceDuration) * 100)}%` }} />
                )}
              </div>
              <div className="mt-2 flex items-center gap-4 text-[11px] text-ink-faint">
                <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-brand/40 ring-1 ring-brand/60" /> Export range</span>
                {markers.length > 0 && <span className="flex items-center gap-1.5"><span className="h-2.5 w-0.5 bg-amber-400" /> Markers</span>}
              </div>
            </div>
          )}

          {/* Details */}
          {ready && files && (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Duration', formatDuration(files.durationMs)],
                ['Resolution', files.width && files.height ? `${files.width}×${files.height}` : '—'],
                ['File size', formatBytes(files.fileSizeBytes)],
                ['Quality', QUALITY_LABELS[episode.trim_settings?.quality ?? 'medium'].label],
              ].map(([label, value]) => (
                <div key={label} className="card px-4 py-3">
                  <dt className="text-xs text-ink-faint">{label}</dt>
                  <dd className="mt-0.5 text-sm font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {/* Side panel */}
        <aside className="card h-fit overflow-hidden">
          <div className="flex border-b border-line">
            {([
              ['export', 'Export', Scissors],
              ['tracks', 'Tracks', Layers],
              ['markers', 'Markers', Bookmark],
              ['notes', 'Notes', FileText],
            ] as const).map(([value, label, Icon]) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 border-b-2 py-3 text-xs font-medium transition-colors',
                  tab === value ? 'border-brand text-ink' : 'border-transparent text-ink-muted hover:text-ink'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          <div className="p-4">
            {tab === 'export' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold">Trim</h3>
                  <p className="mt-0.5 text-xs text-ink-faint">Cut the intro and outro. Play to a moment and use the playhead buttons.</p>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <TimeField label="Start" value={trimStart} max={sourceDuration || 1e6} onChange={setTrimStart} />
                    <TimeField label="End" value={trimEnd > 0 ? trimEnd : sourceDuration} max={sourceDuration || 1e6} onChange={(v) => setTrimEnd(v >= sourceDuration - 0.05 ? 0 : v)} />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <Button size="sm" variant="ghost" disabled={!ready} onClick={() => setTrimStart(Math.min(playheadSource, effectiveTrimEnd - 1))}>
                      <Clock className="h-3.5 w-3.5" /> Start at playhead
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!ready} onClick={() => setTrimEnd(Math.max(playheadSource, trimStart + 1))}>
                      <Clock className="h-3.5 w-3.5" /> End at playhead
                    </Button>
                  </div>
                  {(trimStart > 0 || trimEnd > 0) && (
                    <button className="mt-1 text-xs text-ink-muted hover:text-ink" onClick={() => { setTrimStart(0); setTrimEnd(0); }}>
                      Reset to full length
                    </button>
                  )}
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold">Quality</h3>
                  <div className="space-y-1.5">
                    {(Object.keys(QUALITY_LABELS) as Quality[]).map((q) => (
                      <label key={q} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors', quality === q ? 'border-brand/60 bg-brand/10' : 'border-line hover:border-line-strong')}>
                        <input type="radio" name="quality" value={q} checked={quality === q} onChange={() => setQuality(q)} className="accent-[#7c5cff]" />
                        <span className="flex-1 text-sm font-medium">{QUALITY_LABELS[q].label}</span>
                        <span className="text-xs text-ink-faint">{QUALITY_LABELS[q].detail}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <Button className="w-full" onClick={runExport} loading={exporting} disabled={isProcessing || (!trimChanged && ready)}>
                  {isProcessing ? 'Processing…' : ready ? 'Re-export with changes' : 'Export'}
                </Button>

                <div className="space-y-2 border-t border-line pt-4">
                  <h3 className="text-sm font-semibold">Downloads</h3>
                  {[
                    { type: 'video' as const, icon: Film, label: 'Video', detail: `MP4${files?.height ? ` · ${files.height}p` : ''}${files?.fileSizeBytes ? ` · ${formatBytes(files.fileSizeBytes)}` : ''}` },
                    { type: 'audio' as const, icon: Music, label: 'Audio', detail: 'MP3 · 192 kbps' },
                  ].map(({ type, icon: Icon, label, detail }) => (
                    <button
                      key={type}
                      disabled={!ready}
                      onClick={() => download(type)}
                      className="flex w-full items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2 disabled:opacity-50"
                    >
                      <Icon className="h-4 w-4 text-ink-muted" />
                      <span className="flex-1">
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="block text-xs text-ink-faint">{detail}</span>
                      </span>
                      <Download className="h-4 w-4 text-ink-faint" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tab === 'tracks' && (
              <div className="space-y-3">
                <p className="text-xs text-ink-faint">
                  Each participant’s original local recording, untouched and in full quality — ideal for editing in your own software.
                </p>
                {tracks.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-sm text-ink-muted">
                    {isProcessing ? 'Tracks will be available after processing.' : 'No separate tracks for this project.'}
                  </p>
                ) : (
                  <>
                  {tracks.length > 1 && (
                    <Button variant="secondary" size="sm" className="w-full" onClick={downloadAllTracks}>
                      <Download className="h-4 w-4" />
                      Download all {tracks.length} tracks
                    </Button>
                  )}
                  {tracks.map((p) => {
                    const name = participantLabel(p, names);
                    const ext = files?.tracks?.[p]?.split('.').pop()?.toUpperCase() ?? 'WEBM';
                    const kind = isScreenTrack(p) ? 'Screen share' : p === 'host' ? 'Host' : 'Guest';
                    return (
                      <div key={p} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
                        {isScreenTrack(p) ? (
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand-light">
                            <MonitorUp className="h-4 w-4" />
                          </span>
                        ) : (
                          <Avatar name={name} size={32} />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{name}</p>
                          <p className="text-xs text-ink-faint">{kind} · {ext} · original quality</p>
                        </div>
                        <Button size="icon-sm" variant="secondary" onClick={() => download('track', p)} aria-label={`Download ${name}'s track`}>
                          <Download className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                  </>
                )}
              </div>
            )}

            {tab === 'markers' && (
              <div>
                {markers.length === 0 ? (
                  <p className="px-2 py-6 text-center text-sm text-ink-muted">
                    No markers. Press <kbd className="rounded border border-line-strong px-1 text-xs">M</kbd> while recording to mark great moments.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {markers.map((m) => (
                      <li key={m.id}>
                        <button onClick={() => seekSource(m.time)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-2">
                          <Badge tone="brand" className="font-mono">{formatClock(m.time)}</Badge>
                          <span className="truncate text-sm">{m.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {tab === 'notes' && (
              <div>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={saveNotes}
                  rows={10}
                  maxLength={5000}
                  placeholder="Show notes, guest details, links to mention…"
                  className="input resize-y leading-relaxed"
                />
                <p className="mt-1.5 text-right text-xs text-ink-faint">
                  {notesState === 'saving' ? 'Saving…' : notesState === 'saved' ? 'Saved' : 'Saves automatically'}
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={deleteEpisode}
        loading={deleting}
        title="Delete project?"
        description={`“${title}” and all its exports and participant tracks will be permanently deleted.`}
        confirmLabel="Delete"
      />
    </div>
  );
}
