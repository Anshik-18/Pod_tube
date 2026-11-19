'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Lobby, LobbyResult } from '@/components/studio/Lobby';
import { Studio } from '@/components/studio/Studio';
import { PageLoader } from '@/components/ui/Spinner';
import { Logo } from '@/components/ui/Logo';

interface Invite {
  session: { id: string; state: string; title: string | null; host_name: string | null; ended: boolean };
  token: string | null;
  guestKey: string;
  participantId: string;
}

/** Each browser keeps one guest identity per invite, so a refresh continues the same track. */
const guestKeyStorage = (token: string) => `podnow:guest:${token.slice(0, 16)}`;

function readGuestKey(token: string): string | null {
  try {
    return localStorage.getItem(guestKeyStorage(token));
  } catch {
    return null;
  }
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 text-center">
      <Logo className="mb-10" />
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8">
        <AlertTriangle className="mx-auto mb-3 h-7 w-7 text-amber-400" />
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{body}</p>
      </div>
    </div>
  );
}

export default function JoinPage() {
  const { token } = useParams<{ token: string }>();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyResult | null>(null);

  useEffect(() => {
    const known = readGuestKey(token);
    fetch(`/api/sessions/guest/${token}${known ? `?guest=${encodeURIComponent(known)}` : ''}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'not-found' : 'error');
        const data: Invite = await res.json();
        try {
          localStorage.setItem(guestKeyStorage(token), data.guestKey);
        } catch {
          // Storage unavailable: a refresh joins as a new guest, which still works.
        }
        setInvite(data);
      })
      .catch((err) => setError(err.message));
  }, [token]);

  useEffect(() => {
    if (invite) document.title = `Join ${invite.session.title || 'recording'} · PodNow`;
  }, [invite]);

  if (error === 'not-found') {
    return <Notice title="Invite link not found" body="This link is invalid or the session was deleted. Ask the host for a new link." />;
  }
  if (error) {
    return <Notice title="Something went wrong" body="We couldn’t load this invitation. Check your connection and reload the page." />;
  }
  if (!invite) return <PageLoader label="Loading invitation…" />;
  if (invite.session.ended || !invite.token) {
    return <Notice title="This recording has ended" body="The host has already finished recording this session. Thanks for stopping by!" />;
  }

  const title = invite.session.title || 'Recording session';

  if (!lobby) {
    return (
      <Lobby
        role="guest"
        title={title}
        subtitle={`${invite.session.host_name ? `${invite.session.host_name} invited you` : 'You’ve been invited'} to record. No account or download needed.`}
        onJoin={setLobby}
      />
    );
  }

  return (
    <Studio
      sessionId={invite.session.id}
      role="guest"
      participantId={invite.participantId}
      authToken={invite.token}
      title={title}
      initialSessionState={invite.session.state}
      lobby={lobby}
    />
  );
}
