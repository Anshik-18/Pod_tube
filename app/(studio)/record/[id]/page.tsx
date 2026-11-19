'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useAuth } from '@/components/providers/AuthProvider';
import { Lobby, LobbyResult } from '@/components/studio/Lobby';
import { Studio } from '@/components/studio/Studio';
import { PageLoader } from '@/components/ui/Spinner';
import { api, getAuthToken } from '@/lib/client/api';

interface SessionInfo {
  id: string;
  title: string | null;
  guest_token: string;
  state: string;
}

function HostStudio() {
  const { id: sessionId } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [lobby, setLobby] = useState<LobbyResult | null>(null);

  useEffect(() => {
    api<{ session: SessionInfo }>(`/api/sessions/${sessionId}`)
      .then((data) => setSession(data.session))
      .catch(() => router.replace('/sessions'));
  }, [sessionId, router]);

  useEffect(() => {
    if (session) document.title = `${session.title || 'Studio'} · PodNow`;
  }, [session]);

  if (!session) return <PageLoader label="Opening studio…" />;

  const title = session.title || 'Untitled recording';

  if (!lobby) {
    return (
      <Lobby
        role="host"
        title={title}
        subtitle={session.state === 'idle' ? 'Check your camera and mic, then join to start recording.' : 'This session already has a recording. You can still meet here, or start a new session for another take.'}
        initialName={user?.name || ''}
        onJoin={setLobby}
      />
    );
  }

  return (
    <Studio
      sessionId={session.id}
      role="host"
      participantId="host"
      authToken={getAuthToken() || ''}
      title={title}
      initialSessionState={session.state}
      inviteToken={session.guest_token}
      lobby={lobby}
      onRename={async (next) => {
        await api(`/api/sessions/${session.id}`, { method: 'PATCH', json: { title: next } });
      }}
    />
  );
}

export default function RecordPage() {
  return (
    <ProtectedRoute>
      <HostStudio />
    </ProtectedRoute>
  );
}
