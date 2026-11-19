/**
 * Short-lived TURN credentials from Cloudflare Calls TURN.
 *
 * Set CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_KEY_API_TOKEN (Cloudflare dashboard → Calls →
 * TURN keys). Credentials are issued for 24 h and reused for up to an hour, so anything handed
 * to a browser stays valid for at least 23 h — longer than any recording.
 */

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TTL_SEC = 24 * 60 * 60;
const REUSE_MS = 60 * 60 * 1000;

let cached: { iceServers: RTCIceServer[]; at: number } | null = null;
let inflight: Promise<RTCIceServer[] | null> | null = null;

export function cloudflareTurnConfigured(): boolean {
  return !!(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_KEY_API_TOKEN);
}

function normalize(data: unknown): RTCIceServer[] | null {
  // Current API: { iceServers: [ { urls: [...] }, { urls: [...], username, credential } ] }
  // Older API:   { iceServers: { urls: [...], username, credential } }
  const servers = (data as { iceServers?: unknown })?.iceServers;
  const list = Array.isArray(servers) ? servers : servers ? [servers] : [];
  const valid = list.filter((s): s is RTCIceServer => !!s && typeof s === 'object' && 'urls' in s);
  return valid.length ? valid : null;
}

async function request(path: string): Promise<RTCIceServer[] | null> {
  const res = await fetch(`${API}/${encodeURIComponent(process.env.CLOUDFLARE_TURN_KEY_ID!)}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: TTL_SEC }),
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  });
  if (!res.ok) throw Object.assign(new Error(`Cloudflare TURN responded ${res.status}`), { status: res.status });
  return normalize(await res.json());
}

/** ICE servers from Cloudflare, or null if not configured or unavailable (callers fall back). */
export async function getCloudflareIceServers(): Promise<RTCIceServer[] | null> {
  if (!cloudflareTurnConfigured()) return null;
  if (cached && Date.now() - cached.at < REUSE_MS) return cached.iceServers;
  if (!inflight) {
    inflight = (async () => {
      try {
        let servers: RTCIceServer[] | null;
        try {
          servers = await request('credentials/generate-ice-servers');
        } catch (err) {
          if ((err as { status?: number }).status !== 404) throw err;
          servers = await request('credentials/generate');
        }
        if (servers) cached = { iceServers: servers, at: Date.now() };
        return servers;
      } catch (err) {
        console.error('[TURN] Could not get Cloudflare TURN credentials:', (err as Error).message);
        // Keep using recent credentials if Cloudflare is briefly unreachable.
        return cached && Date.now() - cached.at < TTL_SEC * 1000 * 0.9 ? cached.iceServers : null;
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}
