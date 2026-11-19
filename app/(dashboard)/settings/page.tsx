'use client';

import { useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { api } from '@/lib/client/api';

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-line py-8 first:pt-0 last:border-0 md:grid-cols-[240px_1fr]">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-ink-muted">{description}</p>
      </div>
      <div className="max-w-md">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  const { user, setUser, logout } = useAuth();
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState<'profile' | 'email' | 'password' | null>(null);

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setEmail(user.email || '');
    }
  }, [user]);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving('profile');
    try {
      const data = await api<{ user: { id: string; email: string; name: string | null } }>('/api/user/profile', { method: 'PUT', json: { name: name.trim() || null } });
      setUser(data.user);
      showToast('Profile updated', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(null);
    }
  };

  const saveEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving('email');
    try {
      await api('/api/user/email', { method: 'PUT', json: { email: email.trim() } });
      showToast('Email updated. Please sign in again.', 'success');
      setTimeout(logout, 1500);
    } catch (err) {
      showToast((err as Error).message, 'error');
      setSaving(null);
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) return showToast('New password must be at least 8 characters', 'error');
    if (newPassword !== confirmPassword) return showToast('New passwords don’t match', 'error');
    setSaving('password');
    try {
      await api('/api/user/password', { method: 'PUT', json: { currentPassword, newPassword } });
      showToast('Password updated', 'success');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Settings" description="Manage your profile and account security." />

      <div className="card px-6 py-8">
        <Section title="Profile" description="Your name is shown to guests in the studio and on participant tracks.">
          <form onSubmit={saveProfile} className="space-y-4">
            <div className="flex items-center gap-4">
              <Avatar name={name || user?.email} size={48} />
              <div className="flex-1">
                <label className="label" htmlFor="name">Display name</label>
                <input id="name" className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
              </div>
            </div>
            <Button type="submit" loading={saving === 'profile'} disabled={name.trim() === (user?.name || '')}>
              Save profile
            </Button>
          </form>
        </Section>

        <Section title="Email" description="Used to sign in. Changing it signs you out.">
          <form onSubmit={saveEmail} className="space-y-4">
            <div>
              <label className="label" htmlFor="email">Email address</label>
              <input id="email" type="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Button type="submit" loading={saving === 'email'} disabled={email.trim().toLowerCase() === user?.email?.toLowerCase()}>
              Update email
            </Button>
          </form>
        </Section>

        <Section title="Password" description="Use at least 8 characters.">
          <form onSubmit={savePassword} className="space-y-4">
            <div>
              <label className="label" htmlFor="current-password">Current password</label>
              <input id="current-password" type="password" autoComplete="current-password" required className="input" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="new-password">New password</label>
              <input id="new-password" type="password" autoComplete="new-password" required minLength={8} className="input" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="confirm-password">Confirm new password</label>
              <input id="confirm-password" type="password" autoComplete="new-password" required minLength={8} className="input" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </div>
            <Button type="submit" loading={saving === 'password'}>
              Change password
            </Button>
          </form>
        </Section>

        <Section title="Session" description="Sign out of PodNow on this device.">
          <Button variant="danger" onClick={logout}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </Section>
      </div>
    </div>
  );
}
