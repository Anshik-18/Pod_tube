'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../providers/AuthProvider';
import { LogoMark } from '@/components/ui/Logo';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) {
      router.replace(`/login${pathname && pathname !== '/dashboard' ? `?next=${encodeURIComponent(pathname)}` : ''}`);
    }
  }, [user, loading, router, pathname]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <LogoMark className="h-9 w-9 animate-pulse" />
      </div>
    );
  }

  return <>{children}</>;
}
