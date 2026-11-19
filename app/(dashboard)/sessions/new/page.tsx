'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mic, Users, CloudUpload, Video } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/client/api';

const TIPS = [
  { icon: Video, title: 'Recorded locally', body: 'Each person is captured in up to 1080p on their own device — unaffected by call quality.' },
  { icon: CloudUpload, title: 'Uploads as you go', body: 'Recordings upload progressively, so you’re not waiting long after you stop.' },
  { icon: Users, title: 'Separate tracks', body: 'Get a mixed episode plus every participant’s original track for editing.' },
];

export default function NewSessionPage() {
  const router = useRouter();
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { session } = await api<{ session: { id: string } }>('/api/sessions', {
        method: 'POST',
        json: { title: title.trim() || null },
      });
      router.push(`/record/${session.id}`);
    } catch (err) {
      showToast((err as Error).message || 'Couldn’t create the studio', 'error');
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl py-6">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-rec/15">
          <Mic className="h-5 w-5 text-red-400" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">New recording</h1>
        <p className="mt-1 text-sm text-ink-muted">Name your session, check your setup, and invite guests from inside the studio.</p>
      </div>

      <form onSubmit={create} className="card p-6">
        <label className="label" htmlFor="session-title">Recording name</label>
        <input
          id="session-title"
          autoFocus
          className="input h-11 text-base"
          placeholder="e.g. Episode 12 — Interview with Sam"
          maxLength={255}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button type="submit" variant="record" size="lg" loading={loading} className="mt-5 w-full">
          Enter studio
        </Button>
      </form>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {TIPS.map(({ icon: Icon, title: tipTitle, body }) => (
          <div key={tipTitle} className="text-center sm:text-left">
            <Icon className="mx-auto mb-2 h-4 w-4 text-brand-light sm:mx-0" />
            <p className="text-sm font-medium">{tipTitle}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-faint">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
