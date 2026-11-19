'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, FolderOpen, Radio, Settings, HelpCircle, LogOut, Menu as MenuIcon, X, Plus, Search, ChevronsUpDown } from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { Logo } from '@/components/ui/Logo';
import { Avatar } from '@/components/ui/Avatar';
import { Menu } from '@/components/ui/Menu';
import { buttonClasses } from '@/components/ui/Button';
import { cn } from '@/lib/client/cn';
import { displayNameFromEmail } from '@/lib/client/format';

const NAV = [
  { name: 'Home', href: '/dashboard', icon: Home },
  { name: 'Projects', href: '/episodes', icon: FolderOpen },
  { name: 'Studios', href: '/sessions', icon: Radio },
];

const SECONDARY = [
  { name: 'Settings', href: '/settings', icon: Settings },
  { name: 'Help', href: '/help', icon: HelpCircle },
];

function NavLink({ href, name, icon: Icon, active, onNavigate }: { href: string; name: string; icon: typeof Home; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
        active ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
      )}
    >
      <Icon className={cn('h-4 w-4', active ? 'text-brand-light' : '')} />
      {name}
    </Link>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() || '';
  const router = useRouter();
  const { user, logout } = useAuth();
  const [query, setQuery] = useState('');
  const displayName = user?.name || displayNameFromEmail(user?.email);

  const isActive = (href: string) => (href === '/dashboard' ? pathname === href : pathname.startsWith(href));

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center px-4">
        <Logo href="/dashboard" />
      </div>

      <div className="space-y-3 px-3">
        <Link href="/sessions/new" onClick={onNavigate} className={buttonClasses('record', 'md', 'w-full justify-start')}>
          <Plus className="h-4 w-4" />
          New recording
        </Link>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            router.push(`/episodes${query.trim() ? `?search=${encodeURIComponent(query.trim())}` : ''}`);
            onNavigate?.();
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search recordings"
            aria-label="Search recordings"
            className="input h-8 pl-8 text-xs"
          />
        </form>
      </div>

      <nav className="mt-4 flex-1 space-y-0.5 px-3">
        {NAV.map((item) => (
          <NavLink key={item.href} {...item} active={isActive(item.href)} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="space-y-0.5 px-3 pb-2">
        {SECONDARY.map((item) => (
          <NavLink key={item.href} {...item} active={isActive(item.href)} onNavigate={onNavigate} />
        ))}
      </div>

      <div className="border-t border-line p-3">
        <Menu
          align="left"
          className="w-full"
          items={[
            { label: 'Account settings', icon: <Settings className="h-4 w-4" />, onSelect: () => router.push('/settings') },
            'separator',
            { label: 'Sign out', icon: <LogOut className="h-4 w-4" />, onSelect: logout, danger: true },
          ]}
          trigger={(props) => (
            <button {...props} className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-surface-2">
              <Avatar name={displayName} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{displayName}</span>
                <span className="block truncate text-xs text-ink-faint">{user?.email}</span>
              </span>
              <ChevronsUpDown className="h-4 w-4 text-ink-faint" />
            </button>
          )}
        />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-line bg-surface/60 lg:block">
        <SidebarContent />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-line bg-surface shadow-elevated animate-slide-in-right">
            <button onClick={() => setMobileOpen(false)} className="absolute right-3 top-3.5 rounded-lg p-1.5 text-ink-muted hover:bg-surface-3" aria-label="Close menu">
              <X className="h-4 w-4" />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-3" aria-label="Open menu">
            <MenuIcon className="h-5 w-5" />
          </button>
          <Logo href="/dashboard" />
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1.5 text-xs text-ink-faint">{breadcrumb}</div>}
        <h1 className="truncate text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
