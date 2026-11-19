import Link from 'next/link';
import { cn } from '@/lib/client/cn';

export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand', className)}>
      <span className="h-2.5 w-2.5 rounded-full bg-white" />
      <span className="absolute inset-[5px] rounded-full border-2 border-white/40" />
    </span>
  );
}

export function Logo({ href = '/', className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn('inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight text-ink', className)}>
      <LogoMark />
      PodNow
    </Link>
  );
}
