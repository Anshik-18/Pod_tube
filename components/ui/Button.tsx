'use client';

import { forwardRef } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/client/cn';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'record' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover shadow-sm shadow-brand/20',
  secondary: 'bg-surface-3 text-ink hover:bg-surface-4 border border-line-strong/60',
  outline: 'border border-line-strong text-ink hover:bg-surface-3',
  ghost: 'text-ink-muted hover:text-ink hover:bg-surface-3',
  danger: 'bg-rec/10 text-red-400 border border-rec/25 hover:bg-rec/20',
  record: 'bg-rec text-white hover:bg-rec-hover shadow-sm shadow-rec/30',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-9 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-sm gap-2 rounded-xl',
  icon: 'h-9 w-9 rounded-lg',
  'icon-sm': 'h-8 w-8 rounded-lg',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export function buttonClasses(variant: Variant = 'primary', size: Size = 'md', className?: string) {
  return cn(
    'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-colors',
    'disabled:pointer-events-none disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    className
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, className, children, disabled, type = 'button', ...props },
  ref
) {
  return (
    <button ref={ref} type={type} className={buttonClasses(variant, size, className)} disabled={disabled || loading} {...props}>
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  className,
  children,
  ...props
}: { href: string; variant?: Variant; size?: Size } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <Link href={href} className={buttonClasses(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}
