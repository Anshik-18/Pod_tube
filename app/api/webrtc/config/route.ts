import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/middleware';
import { getCloudflareIceServers } from '@/lib/webrtc/cloudflare-turn';

export const dynamic = 'force-dynamic';

function findEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  if (process.env[`NEXT_PUBLIC_${name}`]) return process.env[`NEXT_PUBLIC_${name}`];
  
  const lowerName = name.toLowerCase();
  const matchKey = Object.keys(process.env).find(k => {
    const lk = k.toLowerCase();
    return lk === lowerName || lk === `next_public_${lowerName}`;
  });
  return matchKey ? process.env[matchKey] : undefined;
}

// Parse a TURN URL into host and port, stripping any protocol prefix
function parseTurnUrl(rawUrl: string): { host: string; port: string } {
  // Strip turn:/turns: prefix if present
  let cleaned = rawUrl.replace(/^(turns?:\/\/|turns?:)/i, '').split('?')[0];
  
  // Split host and port
  const parts = cleaned.split(':');
  if (parts.length >= 2) {
    return { host: parts[0], port: parts[1] };
  }
  return { host: parts[0], port: '443' };
}

export const GET = withAuth(async () => {
  // 1. Cloudflare Calls TURN (short-lived credentials), when configured.
  const cloudflare = await getCloudflareIceServers();
  if (cloudflare) {
    return NextResponse.json({ iceServers: cloudflare, provider: 'cloudflare' }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // 2. A static TURN server from TURN_SERVER_* env, else 3. a public fallback.
  const turnServerUrl = findEnvVar('TURN_SERVER_URL');
  const turnUsername = findEnvVar('TURN_SERVER_USERNAME');
  const turnPassword = findEnvVar('TURN_SERVER_PASSWORD');


  const iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.services.mozilla.com' },
  ];


  if (turnServerUrl && turnUsername && turnPassword) {
    const { host, port } = parseTurnUrl(turnServerUrl);

    // Generate separate RTCIceServer entries per transport for maximum relay candidate generation
    iceServers.push(
      {
        urls: `turn:${host}:${port}`,
        username: turnUsername,
        credential: turnPassword,
      },
      {
        urls: `turn:${host}:${port}?transport=tcp`,
        username: turnUsername,
        credential: turnPassword,
      },
      {
        urls: `turn:${host}:443`,
        username: turnUsername,
        credential: turnPassword,
      },
      {
        urls: `turn:${host}:443?transport=tcp`,
        username: turnUsername,
        credential: turnPassword,
      },
      {
        urls: `turns:${host}:443?transport=tcp`,
        username: turnUsername,
        credential: turnPassword,
      }
    );
  } else {
    iceServers.push(
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:80?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turns:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      }
    );
  }

  return NextResponse.json({ iceServers }, { headers: { 'Cache-Control': 'no-store' } });
}, { allowGuest: true });
