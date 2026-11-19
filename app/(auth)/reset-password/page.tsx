'use client';

import { useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/client/api';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { showToast } = useToast();
  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!token) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invalid reset link</h1>
        <p className="mt-2 text-sm text-ink-muted">This link is missing its token. Request a new one.</p>
        <Link href="/forgot-password" className="mt-6 inline-block text-sm font-medium text-brand-light hover:underline">Request a new link</Link>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Password must be at least 8 characters');
    if (password !== confirmPassword) return setError('Passwords don’t match');
    setLoading(true);
    try {
      await api('/api/auth/reset-password', { method: 'POST', json: { token, password }, token: null });
      showToast('Password updated. Sign in with your new password.', 'success');
      router.push('/login');
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-1 text-sm text-ink-muted">Use at least 8 characters.</p>
      <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
        {error && <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">{error}</div>}
        <div>
          <label htmlFor="password" className="label">New password</label>
          <input id="password" type="password" autoComplete="new-password" required minLength={8} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} className="input h-10" />
        </div>
        <div>
          <label htmlFor="confirmPassword" className="label">Confirm password</label>
          <input id="confirmPassword" type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="input h-10" />
        </div>
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          Update password
        </Button>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
