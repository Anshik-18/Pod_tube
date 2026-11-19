'use client';

import { AuthProvider } from '@/components/providers/AuthProvider';
import { ToastProvider } from '@/components/ui/Toast';

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>{children}</ToastProvider>
    </AuthProvider>
  );
}
