'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/client/cn';

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * Lightweight dropdown menu. `trigger` receives the toggle handler so any element can open it.
 */
export function Menu({
  trigger,
  items,
  align = 'right',
  className,
}: {
  trigger: (props: { onClick: (e: React.MouseEvent) => void; 'aria-expanded': boolean }) => React.ReactNode;
  items: Array<MenuItem | 'separator'>;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {trigger({
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        },
        'aria-expanded': open,
      })}
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute z-50 mt-1.5 min-w-[184px] overflow-hidden rounded-xl border border-line bg-surface-2 p-1 shadow-elevated animate-scale-in',
            align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'
          )}
        >
          {items.map((item, i) =>
            item === 'separator' ? (
              <div key={`sep-${i}`} className="my-1 h-px bg-line" />
            ) : (
              <button
                key={item.label}
                role="menuitem"
                type="button"
                disabled={item.disabled}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors disabled:opacity-40',
                  item.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-ink hover:bg-surface-4'
                )}
              >
                {item.icon && <span className="flex h-4 w-4 items-center justify-center text-ink-muted">{item.icon}</span>}
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
