'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/client/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [resetLink, setResetLink] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api<{ resetLink?: string }>('/api/auth/forgot-password', { method: 'POST', json: { email }, token: null });
      setSent(true);
      setResetLink(data.resetLink ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div>
        <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10">
          <MailCheck className="h-5 w-5 text-emerald-400" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 text-sm text-ink-muted">If an account exists for {email}, you’ll receive a link to reset your password. It expires in one hour.</p>
        {resetLink && (
          <div className="mt-5 rounded-lg border border-line bg-surface-2 p-3 text-xs">
            <p className="mb-1 text-ink-faint">Development mode — reset link:</p>
            <a href={resetLink} className="break-all font-mono text-brand-light hover:underline">{resetLink}</a>
          </div>
        )}
        <Link href="/login" className="mt-8 inline-block text-sm text-ink-muted hover:text-ink">← Back to sign in</Link>
      </div>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-1 text-sm text-ink-muted">Enter your email and we’ll send you a reset link.</p>
      <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
        {error && <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">{error}</div>}
        <div>
          <label htmlFor="email" className="label">Email</label>
          <input id="email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="input h-10" placeholder="you@example.com" />
        </div>
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          Send reset link
        </Button>
      </form>
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="text-ink-muted hover:text-ink">← Back to sign in</Link>
      </p>
    </>
  );
}
