import { cn } from '@/lib/client/cn';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand' | 'live';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-ink-muted border-line-strong',
  success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  danger: 'bg-red-500/10 text-red-400 border-red-500/20',
  brand: 'bg-brand/10 text-brand-light border-brand/25',
  live: 'bg-rec text-white border-rec',
};

export function Badge({ tone = 'neutral', className, children, dot }: { tone?: Tone; className?: string; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4', TONES[tone], className)}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full bg-current', tone === 'warning' && 'animate-pulse')} />}
      {children}
    </span>
  );
}

const STATE_LABELS: Record<string, { label: string; tone: Tone }> = {
  ready: { label: 'Ready', tone: 'success' },
  completed: { label: 'Completed', tone: 'success' },
  processing: { label: 'Processing', tone: 'warning' },
  uploading: { label: 'Uploading', tone: 'warning' },
  recording: { label: 'Recording', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  idle: { label: 'Not recorded', tone: 'neutral' },
};

export function StatusBadge({ state, className }: { state: string; className?: string }) {
  const meta = STATE_LABELS[state] ?? { label: state, tone: 'neutral' as Tone };
  return (
    <Badge tone={meta.tone} dot className={className}>
      {meta.label}
    </Badge>
  );
}
