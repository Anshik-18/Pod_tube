import { cn } from '@/lib/client/cn';
import { initials } from '@/lib/client/format';

const PALETTE = ['#7c5cff', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#14b8a6', '#f97316', '#6366f1'];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function Avatar({ name, size = 32, className }: { name: string | null | undefined; size?: number; className?: string }) {
  const label = name || '?';
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', className)}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38), background: colorFor(label) }}
    >
      {initials(label)}
    </span>
  );
}
