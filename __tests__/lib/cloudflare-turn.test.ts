import { getCloudflareIceServers, cloudflareTurnConfigured } from '@/lib/webrtc/cloudflare-turn';

describe('Cloudflare TURN credentials', () => {
  const fetchMock = jest.fn();
  beforeAll(() => {
    (global as any).fetch = fetchMock;
  });
  beforeEach(() => {
    jest.resetModules();
    fetchMock.mockReset();
    process.env.CLOUDFLARE_TURN_KEY_ID = 'key123';
    process.env.CLOUDFLARE_TURN_KEY_API_TOKEN = 'secret';
  });
  afterAll(() => {
    delete process.env.CLOUDFLARE_TURN_KEY_ID;
    delete process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
  });

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it('is off unless both variables are set', async () => {
    delete process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
    expect(cloudflareTurnConfigured()).toBe(false);
    const { getCloudflareIceServers: get } = await import('@/lib/webrtc/cloudflare-turn');
    expect(await get()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests 24 h credentials with the API token and returns the ICE servers', async () => {
    const { getCloudflareIceServers: get } = await import('@/lib/webrtc/cloudflare-turn');
    const servers = [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }];
    fetchMock.mockResolvedValueOnce(ok({ iceServers: servers }));
    expect(await get()).toEqual(servers);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers');
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body)).toEqual({ ttl: 86400 });
  });

  it('reuses credentials instead of calling Cloudflare on every studio join', async () => {
    const { getCloudflareIceServers: get } = await import('@/lib/webrtc/cloudflare-turn');
    fetchMock.mockResolvedValue(ok({ iceServers: [{ urls: ['turn:x'], username: 'u', credential: 'c' }] }));
    await get();
    await get();
    await Promise.all([get(), get()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts the older single-object response shape', async () => {
    const { getCloudflareIceServers: get } = await import('@/lib/webrtc/cloudflare-turn');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce(ok({ iceServers: { urls: ['turn:y'], username: 'u', credential: 'c' } }));
    expect(await get()).toEqual([{ urls: ['turn:y'], username: 'u', credential: 'c' }]);
  });

  it('returns null (so the app falls back) when Cloudflare fails', async () => {
    const { getCloudflareIceServers: get } = await import('@/lib/webrtc/cloudflare-turn');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await get()).toBeNull();
  });
});
void getCloudflareIceServers;
