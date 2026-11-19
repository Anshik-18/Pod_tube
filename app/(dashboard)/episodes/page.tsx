'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, FolderOpen, Upload, Plus, CheckSquare, X, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/AppShell';
import { Button, ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { EpisodeCard, EpisodeCardSkeleton, EpisodeSummary } from '@/components/episodes/EpisodeCard';
import { useUploadRecording } from '@/components/episodes/UploadRecording';
import { api } from '@/lib/client/api';
import { cn } from '@/lib/client/cn';
import { episodeTitle } from '@/lib/client/format';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'ready', label: 'Ready' },
  { value: 'processing', label: 'Processing' },
  { value: 'failed', label: 'Failed' },
] as const;

type Sort = 'newest' | 'oldest' | 'title';

function ProjectsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { showToast } = useToast();
  const upload = useUploadRecording();

  const [query, setQuery] = useState(params.get('search') ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [filter, setFilter] = useState<string>(params.get('state') ?? 'all');
  const [sort, setSort] = useState<Sort>('newest');
  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<EpisodeSummary[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  // The sidebar search navigates here with ?search=; adopt URL changes we didn't make ourselves.
  const lastPushedSearch = useRef(params.get('search') ?? '');
  useEffect(() => {
    const fromUrl = params.get('search') ?? '';
    if (fromUrl !== lastPushedSearch.current) {
      lastPushedSearch.current = fromUrl;
      setQuery(fromUrl);
      setDebouncedQuery(fromUrl);
    }
  }, [params]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const next = new URLSearchParams();
    lastPushedSearch.current = debouncedQuery.trim();
    if (debouncedQuery.trim()) next.set('search', debouncedQuery.trim());
    if (filter !== 'all') next.set('state', filter);
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [debouncedQuery, filter, pathname, router]);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (debouncedQuery.trim()) qs.set('search', debouncedQuery.trim());
    if (filter !== 'all') qs.set('state', filter);
    try {
      const data = await api<{ episodes: EpisodeSummary[] }>(`/api/episodes${qs.toString() ? `?${qs}` : ''}`);
      setEpisodes(data.episodes);
    } catch {
      setEpisodes([]);
      showToast('Couldn’t load your projects', 'error');
    }
  }, [debouncedQuery, filter, showToast]);

  useEffect(() => {
    setEpisodes(null);
    load();
  }, [load]);

  const hasProcessing = episodes?.some((e) => e.state === 'processing');
  useEffect(() => {
    if (!hasProcessing) return;
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, [hasProcessing, load]);

  const sorted = useMemo(() => {
    if (!episodes) return null;
    const list = [...episodes];
    if (sort === 'oldest') list.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
    else if (sort === 'title') list.sort((a, b) => episodeTitle(a).localeCompare(episodeTitle(b)));
    return list;
  }, [episodes, sort]);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    const results = await Promise.allSettled(pendingDelete.map((ep) => api(`/api/episodes/${ep.id}`, { method: 'DELETE' })));
    const failed = results.filter((r) => r.status === 'rejected').length;
    const removed = pendingDelete.length - failed;
    if (removed > 0) showToast(`Deleted ${removed} project${removed === 1 ? '' : 's'}`, 'success');
    if (failed > 0) showToast(`Couldn’t delete ${failed} project${failed === 1 ? '' : 's'}`, 'error');
    setDeleting(false);
    setPendingDelete(null);
    exitSelect();
    load();
  };

  const isFiltered = !!debouncedQuery.trim() || filter !== 'all';

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Projects"
        description="Every recording and upload, with its exports and separate tracks."
        actions={
          <>
            <Button variant="secondary" onClick={upload.open} disabled={upload.busy}>
              <Upload className="h-4 w-4" />
              Upload
            </Button>
            <ButtonLink href="/sessions/new" variant="record">
              <Plus className="h-4 w-4" />
              New recording
            </ButtonLink>
          </>
        }
      />
      {upload.element}

      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative md:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects" aria-label="Search projects" className="input pl-9" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                filter === f.value ? 'border-brand/50 bg-brand/15 text-brand-light' : 'border-line text-ink-muted hover:border-line-strong hover:text-ink'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 md:ml-auto">
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="input h-9 w-auto py-0 text-xs" aria-label="Sort projects">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title A–Z</option>
          </select>
          {sorted && sorted.length > 0 && !selectMode && (
            <Button variant="ghost" size="sm" onClick={() => setSelectMode(true)}>
              <CheckSquare className="h-4 w-4" />
              Select
            </Button>
          )}
        </div>
      </div>

      {selectMode && (
        <div className="sticky top-16 z-20 mb-4 flex items-center gap-3 rounded-xl border border-line bg-surface-2/95 px-4 py-2.5 shadow-elevated backdrop-blur lg:top-4">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <button
            className="text-xs text-ink-muted hover:text-ink"
            onClick={() => setSelected(selected.size === sorted?.length ? new Set() : new Set(sorted?.map((e) => e.id)))}
          >
            {selected.size === sorted?.length ? 'Clear all' : 'Select all'}
          </button>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={selected.size === 0}
              onClick={() => setPendingDelete((sorted ?? []).filter((e) => selected.has(e.id)))}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={exitSelect}>
              <X className="h-4 w-4" />
              Done
            </Button>
          </div>
        </div>
      )}

      {sorted === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <EpisodeCardSkeleton key={i} />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        isFiltered ? (
          <EmptyState
            icon={<Search className="h-5 w-5" />}
            title="No matching projects"
            description="Try a different search or filter."
            action={
              <Button variant="secondary" onClick={() => { setQuery(''); setFilter('all'); }}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<FolderOpen className="h-5 w-5" />}
            title="No projects yet"
            description="Record in the studio or upload a file — finished episodes show up here."
            action={<ButtonLink href="/sessions/new" variant="record">Start recording</ButtonLink>}
          />
        )
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((ep) => (
            <EpisodeCard
              key={ep.id}
              episode={ep}
              selectable={selectMode}
              selected={selected.has(ep.id)}
              onToggleSelect={toggleSelect}
              onDelete={(episode) => setPendingDelete([episode])}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title={pendingDelete && pendingDelete.length > 1 ? `Delete ${pendingDelete.length} projects?` : 'Delete project?'}
        description={
          pendingDelete?.length === 1
            ? `“${episodeTitle(pendingDelete[0])}” and all its exports and tracks will be permanently deleted.`
            : 'These projects and all their exports and tracks will be permanently deleted.'
        }
        confirmLabel="Delete"
      />
    </div>
  );
}

export default function EpisodesPage() {
  return (
    <Suspense>
      <ProjectsView />
    </Suspense>
  );
}
