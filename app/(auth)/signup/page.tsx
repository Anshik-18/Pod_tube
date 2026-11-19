'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { api, setAuthToken } from '@/lib/client/api';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    try {
      const data = await api<{ token: string }>('/api/auth/signup', { method: 'POST', json: { name: name.trim() || undefined, email, password }, token: null });
      setAuthToken(data.token);
      router.push('/dashboard');
    } catch (err) {
      setError((err as Error).message || 'Sign up failed');
      setLoading(false);
    }
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-ink-muted">Start recording studio-quality conversations in minutes.</p>

      <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
        {error && <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">{error}</div>}
        <div>
          <label htmlFor="name" className="label">Name</label>
          <input id="name" autoComplete="name" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} className="input h-10" placeholder="Alex Rivera" />
        </div>
        <div>
          <label htmlFor="email" className="label">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="input h-10" placeholder="you@example.com" />
        </div>
        <div>
          <label htmlFor="password" className="label">Password</label>
          <input id="password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="input h-10" />
          <p className="mt-1.5 text-xs text-ink-faint">At least 8 characters.</p>
        </div>
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          Create account
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand-light hover:underline">Sign in</Link>
      </p>
    </>
  );
}
